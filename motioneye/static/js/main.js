
var pushConfigs = {};
var pushConfigReboot = false;
var refreshDisabled = {}; /* dictionary indexed by cameraId, tells if refresh is disabled for a given camera */
var fullScreenCameraId = null;
var inProgress = false;
var refreshInterval = 50; /* milliseconds */
var username = '';
var password = '';
var basePath = null;
var signatureRegExp = new RegExp('[^a-zA-Z0-9/?_.=&{}\\[\\]":, _-]', 'g');
var initialConfigFetched = false; /* used to workaround browser extensions that trigger stupid change events */


    /* utils */

var sha1 = (function () {
    function hash(msg) {
        var K = [0x5a827999, 0x6ed9eba1, 0x8f1bbcdc, 0xca62c1d6];

        msg += String.fromCharCode(0x80);

        var l = msg.length / 4 + 2;
        var N = Math.ceil(l / 16);
        var M = new Array(N);

        for (var i = 0; i < N; i++) {
            M[i] = new Array(16);
            for (var j = 0; j < 16; j++) {
                M[i][j] = (msg.charCodeAt(i * 64 + j * 4) << 24) | (msg.charCodeAt(i * 64 + j * 4 + 1) << 16) | 
                (msg.charCodeAt(i * 64 + j * 4 + 2) << 8) | (msg.charCodeAt(i * 64 + j * 4 + 3));
            }
        }
        M[N-1][14] = ((msg.length-1) * 8) / Math.pow(2, 32);
        M[N-1][14] = Math.floor(M[N-1][14]);
        M[N-1][15] = ((msg.length-1) * 8) & 0xffffffff;

        var H0 = 0x67452301;
        var H1 = 0xefcdab89;
        var H2 = 0x98badcfe;
        var H3 = 0x10325476;
        var H4 = 0xc3d2e1f0;

        var W = new Array(80);
        var a, b, c, d, e;
        for (var i = 0; i < N; i++) {
            for (var t = 0; t < 16; t++) W[t] = M[i][t];
            for (var t = 16; t < 80; t++) W[t] = ROTL(W[t-3] ^ W[t-8] ^ W[t-14] ^ W[t-16], 1);

            a = H0; b = H1; c = H2; d = H3; e = H4;

            for (var t = 0; t < 80; t++) {
                var s = Math.floor(t / 20);
                var T = (ROTL(a, 5) + f(s, b, c, d) + e + K[s] + W[t]) & 0xffffffff;
                e = d;
                d = c;
                c = ROTL(b, 30);
                b = a;
                a = T;
            }

            H0 = (H0 + a) & 0xffffffff;
            H1 = (H1 + b) & 0xffffffff; 
            H2 = (H2 + c) & 0xffffffff; 
            H3 = (H3 + d) & 0xffffffff; 
            H4 = (H4 + e) & 0xffffffff;
        }

        return toHexStr(H0) + toHexStr(H1) + toHexStr(H2) + toHexStr(H3) + toHexStr(H4);
    }

    function f(s, x, y, z)  {
        switch (s) {
            case 0: return (x & y) ^ (~x & z);
            case 1: return x ^ y ^ z;
            case 2: return (x & y) ^ (x & z) ^ (y & z);
            case 3: return x ^ y ^ z;
        }
    }

    function ROTL(x, n) {
        return (x << n) | (x >>> (32 - n));
    }

    function toHexStr(n) {
        var s = "", v;
        for (var i = 7; i >= 0; i--) {
            v = (n >>> (i * 4)) & 0xf;
            s += v.toString(16);
        }
        return s;
    }
    
    return hash;
}());

function splitUrl(url) {
    if (!url) {
        url = window.location.href;
    }
    
    var parts = url.split('?');
    if (parts.length < 2 || parts[1].length === 0) {
        return {baseUrl: parts[0], params: {}};
    }
    
    var baseUrl = parts[0];
    var paramStr = parts[1];
    
    parts = paramStr.split('&');
    var params = {};
    
    for (var i = 0; i < parts.length; i++) {
        var pair = parts[i].split('=');
        params[pair[0]] = pair[1];
    }
    
    return {baseUrl: baseUrl, params: params};
}

function qualifyUrl(url) {
    var a = document.createElement('a');
    a.href = url;
    return a.href;
}

function qualifyPath(path) {
    var url = qualifyUrl(path);
    var pos = url.indexOf('//');
    if (pos === -1) { /* not a full url */
        return url;
    }
    
    url = url.substring(pos + 2);
    pos = url.indexOf('/');
    if (pos === -1) { /* root with no trailing slash */
        return '';
    }
    
    return url.substring(pos);
}
        
function computeSignature(method, path, body) {
    path = qualifyPath(path);
    
    var parts = splitUrl(path);
    var query = parts.params;
    var path = parts.baseUrl;
    path = '/' + path.substring(basePath.length);
    
    /* sort query arguments alphabetically */
    query = Object.keys(query).map(function (key) {return {key: key, value: decodeURIComponent(query[key])};});
    query = query.filter(function (q) {return q.key !== '_signature';});
    query.sortKey(function (q) {return q.key;});
    query = query.map(function (q) {return q.key + '=' + encodeURIComponent(q.value);}).join('&');
    path = path + '?' + query;
    path = path.replace(signatureRegExp, '-');
    body = body && body.replace(signatureRegExp, '-');
    var password = window.password.replace(signatureRegExp, '-');
    
    return sha1(method + ':' + path + ':' + (body || '') + ':' + password).toLowerCase();
}

function addAuthParams(method, url, body) {
    if (!window.username) {
        return url;
    }

    if (url.indexOf('?') < 0) {
        url += '?';
    }
    else {
        url += '&';
    }
    
    url += '_username=' + window.username;
    if (window._loginDialogSubmitted) {
        url += '&_login=true';
        delete _loginDialogSubmitted;
    }
    var signature = computeSignature(method, url, body);
    url += '&_signature=' + signature;

    return url;
}

function isAdmin() {
    return username === adminUsername;
}

function ajax(method, url, data, callback, error, timeout) {
    var origUrl = url;
    var origData = data;
    
    if (url.indexOf('?') < 0) {
        url += '?';
    }
    else {
        url += '&';
    }
    
    url += '_=' + new Date().getTime();

    var json = false;
    var processData = true;
    if (method == 'POST') {
        if (window.FormData && (data instanceof FormData)) {
            json = false;
            processData = false;
        }
        else if (typeof data == 'object') {
            data = JSON.stringify(data);
            json = true;
        }
    }
    else { /* assuming GET */
        if (data) {
            url += '&' + $.param(data);
            data = null;
        }
    }
    
    url = addAuthParams(method, url, processData ? data : null);
    
    var options = {
        type: method,
        url: url,
        data: data,
        timeout: timeout || 300 * 1000,
        success: function (data) {
            if (data && data.error == 'unauthorized') {
                if (data.prompt) {
                    runLoginDialog(function () {
                        ajax(method, origUrl, origData, callback, error);
                    });
                }
                
                window._loginRetry = true;
            }
            else {
                delete window._loginRetry;
                if (callback) {
                    $('body').toggleClass('admin', isAdmin());
                    callback(data);
                }
            }
        },
        contentType: json ? 'application/json' : false,
        processData: processData,
        error: error || function (request, options, error) {
            showErrorMessage();
            if (callback) {
                callback();
            }
        }
    };
    
    $.ajax(options);
}

Object.keys = Object.keys || (function () {
    var hasOwnProperty = Object.prototype.hasOwnProperty;
    var hasDontEnumBug = !({toString: null}).propertyIsEnumerable('toString');
    var dontEnums = [
        'toString',
        'toLocaleString',
        'valueOf',
        'hasOwnProperty',
        'isPrototypeOf',
        'propertyIsEnumerable',
        'constructor'
    ];
    var dontEnumsLength = dontEnums.length;

    return function (obj) {
        if (typeof obj !== 'object' && typeof obj !== 'function' || obj === null) {
            return [];
        }

        var result = [];
        for (var prop in obj) {
            if (hasOwnProperty.call(obj, prop)) {
                result.push(prop);
            }
        }

        if (hasDontEnumBug) {
            for (var i = 0; i < dontEnumsLength; i++) {
                if (hasOwnProperty.call(obj, dontEnums[i])) {
                    result.push(dontEnums[i]);
                }
            }
        }
        
        return result;
    };
})();

Object.update = function (dest, source) {
    for (var key in source) {
        if (!source.hasOwnProperty(key)) {
            continue;
        }
        
        dest[key] = source[key];
    }
};

Array.prototype.indexOf = Array.prototype.indexOf || function (obj) {
    for (var i = 0; i < this.length; i++) {
        if (this[i] === obj) {
            return i;
        }
    }
    
    return -1;
};

Array.prototype.forEach = Array.prototype.forEach || function (callback, thisArg) {
    for (var i = 0; i < this.length; i++) {
        callback.call(thisArg, this[i], i, this);
    }
};

Array.prototype.every = Array.prototype.every || function (callback, thisArg) {
    for (var i = 0; i < this.length; i++) {
        if (!callback.call(thisArg, this[i], i, this)) {
            return false;
        }
    }
    
    return true;
};

Array.prototype.unique = function (callback, thisArg) {
    var uniqueElements = [];
    this.forEach(function (element) {
        if (uniqueElements.indexOf(element, Utils.equals) === -1) {
            uniqueElements.push(element);
        }
    });
    
    return uniqueElements;
};

Array.prototype.filter = function (func, thisArg) {
    var filtered = [];
    for (var i = 0; i < this.length; i++) {
        if (func.call(thisArg, this[i], i, this)) {
            filtered.push(this[i]);
        }
    }
    
    return filtered;
};

Array.prototype.map = function (func, thisArg) {
    var mapped = [];
    for (var i = 0; i < this.length; i++) {
        mapped.push(func.call(thisArg, this[i], i, this));
    }
    
    return mapped;
};

Array.prototype.sortKey = function (keyFunc, reverse) {
    this.sort(function (e1, e2) {
        var k1 = keyFunc(e1);
        var k2 = keyFunc(e2);
        
        if ((k1 < k2 && !reverse) || (k1 > k2 && reverse)) {
            return -1;
        }
        else if ((k1 > k2 && !reverse) || (k1 < k2 && reverse)) {
            return 1;
        }
        else {
            return 0;
        }
    });
};

String.prototype.startsWith = String.prototype.startsWith || function (str) {
    return (this.substr(0, str.length) === str);
};

String.prototype.endsWith = String.prototype.endsWith || function (str) {
    return (this.substr(this.length - str.length) === str);
};

String.prototype.trim = String.prototype.trim || function () {
    return this.replace(new RegExp('^\\s*'), '').replace(new RegExp('\\s*$'), '');
};

String.prototype.replaceAll = String.prototype.replaceAll || function (oldStr, newStr) {
    var p, s = this;
    while ((p = s.indexOf(oldStr)) >= 0) {
        s = s.substring(0, p) + newStr + s.substring(p + oldStr.length, s.length);
    }
    
    return s.toString();
};

function getCookie(name) {
    if (document.cookie.length <= 0) {
        return null;
    }

    var start = document.cookie.indexOf(name + '=');
    if (start == -1) {
        return null;
    }
     
    var start = start + name.length + 1;
    var end = document.cookie.indexOf(';', start);
    if (end == -1) {
        end = document.cookie.length;
    }
    
    return unescape(document.cookie.substring(start, end));
}

function setCookie(name, value, days) {
    var date, expires;
    if (days) {
        date = new Date();
        date.setTime(date.getTime() + (days * 24 * 60 * 60 * 1000));
        expires = 'expires=' + date.toGMTString();
    }
    else {
        expires = '';
    }

    document.cookie = name + '=' + value + '; ' + expires + '; path=/';
}

function remCookie(name) {
    document.cookie = name + '=; expires=Thu, 01 Jan 1970 00:00:01 GMT;';
}

function showErrorMessage(message) {
    if (message == null || message == true) {
        message = 'An error occurred. Refreshing is recommended.';
    }
    
    showPopupMessage(message, 'error');
}

function doLogout() {
    setCookie('username', '_');
    window.location.reload(true);
}


/* UI initialization */

function initUI() {
    /* checkboxes */
    makeCheckBox($('input[type=checkbox].styled'));

    /* sliders */
    $('input[type=text].range.styled').each(function () {
        var $this = $(this);
        var $tr = $this.parent().parent();
        var ticks = null;
        var ticksAttr = $tr.attr('ticks');
        if (ticksAttr) {
            ticks = ticksAttr.split('|').map(function (t) {
                var parts = t.split(',');
                if (parts.length < 2) {
                    parts.push(parts[0]);
                }
                return {value: Number(parts[0]), label: parts[1]};
            });
        }
        makeSlider($this, Number($tr.attr('min')), Number($tr.attr('max')),
                Number($tr.attr('snap')), ticks, Number($tr.attr('ticksnum')), Number($tr.attr('decimals')), $tr.attr('unit'));
    });
    
    /* progress bars */
    makeProgressBar($('div.progress-bar'));

    /* text validators */
    makeTextValidator($('tr[required=true] input[type=text]'), true);
    makeTextValidator($('tr[required=true] input[type=password]'), true);

    /* number validators */
    $('input[type=text].number').each(function () {
        var $this = $(this);
        var $tr = $this.parent().parent();
        makeNumberValidator($this, Number($tr.attr('min')), Number($tr.attr('max')),
                Boolean($tr.attr('floating')), Boolean($tr.attr('sign')), Boolean($tr.attr('required')));
    });

    /* time validators */
    makeTimeValidator($('input[type=text].time'));
    
    /* custom validators */
    makeCustomValidator($('#deviceNameEntry'), function (value) {
        if (!value) {
            return 'this field is required';
        }

        if (!value.toLowerCase().match(new RegExp('^[a-z0-9\-\_\+\ ]*$'))) {
            return "special characters are not allowed in camera's name";
        }
        
        return true;
    }, '');
    makeCustomValidator($('#rootDirectoryEntry'), function (value) {
        if ($('#storageDeviceSelect').val() == 'custom-path' && String(value).trim() == '/') {
            return 'files cannot be created directly on the root of your system';
        }
        
        return true;
    }, '');
    makeCustomValidator($('#emailAddressesEntry'), function (value) {
        if (!value.toLowerCase().match(new RegExp('^[a-z0-9\-\_\+\.\@\^\~\, ]+$'))) {
            return 'enter a list of comma-separated valid email addresses';
        }
        
        return true;
    }, '');
    $('tr[validate] input[type=text]').each(function () {
        var $this = $(this);
        var $tr = $this.parent().parent();
        var required = $tr.attr('required');
        var validate = $tr.attr('validate');
        if (!validate) {
            return;
        }

        makeCustomValidator($this, function (value) {
            if (!value && required) {
                return 'this field is required';
            }

            if (!value.toLowerCase().match(new RegExp(validate))) {
                return 'enter a valid value';
            }

            return true;
        }, '');
    });
    
    /* input value processors */
    makeStrippedInput($('tr[strip=true] input[type=text]'));
    makeStrippedInput($('tr[strip=true] input[type=password]'));
    
    function checkMinimizeSection() {
        var $switch = $(this);
        var $sectionDiv = $switch.parents('div.settings-section-title:eq(0)');
        
        var $minimizeSpan = $switch.parent().find('span.minimize');
        if ($switch.is(':checked') && !$minimizeSpan.hasClass('open')) {
            $minimizeSpan.addClass('open');
        }
        else if (!$switch.is(':checked') && $minimizeSpan.hasClass('open') && !$sectionDiv.attr('minimize-switch-independent')) {
            $minimizeSpan.removeClass('open');
        }
    }

    /* ui elements that enable/disable other ui elements */
    $('#motionEyeSwitch').change(updateConfigUi);
    $('#showAdvancedSwitch').change(updateConfigUi);
    $('#storageDeviceSelect').change(updateConfigUi);
    $('#resolutionSelect').change(updateConfigUi);
    $('#leftTextSelect').change(updateConfigUi);
    $('#rightTextSelect').change(updateConfigUi);
    $('#captureModeSelect').change(updateConfigUi);
    $('#autoNoiseDetectSwitch').change(updateConfigUi);
    $('#videoDeviceSwitch').change(checkMinimizeSection).change(updateConfigUi);
    $('#textOverlaySwitch').change(checkMinimizeSection).change(updateConfigUi);
    $('#videoStreamingSwitch').change(checkMinimizeSection).change(updateConfigUi);
    $('#streamingServerResizeSwitch').change(updateConfigUi);
    $('#stillImagesSwitch').change(checkMinimizeSection).change(updateConfigUi);
    $('#preservePicturesSelect').change(updateConfigUi);
    $('#motionDetectionSwitch').change(checkMinimizeSection).change(updateConfigUi);
    $('#motionMoviesSwitch').change(checkMinimizeSection).change(updateConfigUi);
    $('#preserveMoviesSelect').change(updateConfigUi);
    $('#emailNotificationsSwitch').change(updateConfigUi);
    $('#webHookNotificationsSwitch').change(updateConfigUi);
    $('#commandNotificationsSwitch').change(updateConfigUi);
    $('#workingScheduleSwitch').change(checkMinimizeSection).change(updateConfigUi);
    
    $('#mondayEnabledSwitch').change(updateConfigUi);
    $('#tuesdayEnabledSwitch').change(updateConfigUi);
    $('#wednesdayEnabledSwitch').change(updateConfigUi);
    $('#thursdayEnabledSwitch').change(updateConfigUi);
    $('#fridayEnabledSwitch').change(updateConfigUi);
    $('#saturdayEnabledSwitch').change(updateConfigUi);
    $('#sundayEnabledSwitch').change(updateConfigUi);
    
    /* minimizable sections */
    $('span.minimize').click(function () {
        $(this).toggleClass('open');
        
        /* enable the section switch when unminimizing */
        if ($(this).hasClass('open')) {
            var sectionSwitch = $(this).parent().find('input[type=checkbox]');
            var sectionSwitchDiv = $(this).parent().find('div.check-box');
            var sectionDiv = $(this).parents('div.settings-section-title:eq(0)');
            if (sectionSwitch.length && !sectionSwitch.is(':checked') &&
                !sectionSwitchDiv[0]._hideNull && !sectionDiv.attr('minimize-switch-independent')) {

                sectionSwitch[0].checked = true;
                sectionSwitch.change();
            }
        }
            
        updateConfigUi();
    });

    $('a.settings-section-title').click(function () {
        $(this).parent().find('span.minimize').click();
    });

    /* additional configs */
    var seenDependNames = {};
    $('tr[depends]').each(function () {
        var $tr = $(this);
        var depends = $tr.attr('depends').split(' ');
        depends.forEach(function (depend) {
            depend = depend.split('=')[0];
            depend = depend.replace(new RegExp('[^a-zA-Z0-9_]', 'g'), '');
            
            if (depend in seenDependNames) {
                return;
            }
            
            seenDependNames[depend] = true;

            var control = $('#' + depend + 'Entry, #' + depend + 'Select, #' + depend + 'Slider, #' + depend + 'Switch');
            control.change(updateConfigUi);
        });
    });
    
    $('#storageDeviceSelect').change(function () {
        $('#rootDirectoryEntry').val('/');
    });
    
    $('#rootDirectoryEntry').change(function () {
        this.value = this.value.trim();
    });
    
    $('#rootDirectoryEntry').change(function () {
        if (this.value.charAt(0) !== '/') {
            this.value = '/' + this.value;
        }
    });
    
    /* fetch & push handlers */
    $('#cameraSelect').focus(function () {
        /* remember the previously selected index */
        this._prevSelectedIndex = this.selectedIndex;
    
    }).change(function () {
        if ($('#cameraSelect').val() === 'add') {
            runAddCameraDialog();
            this.selectedIndex = this._prevSelectedIndex;
        }
        else {
            this._prevSelectedIndex = this.selectedIndex;
            beginProgress([$(this).val()]);
            fetchCurrentCameraConfig(endProgress);
        }
    });
    $('input.main-config, select.main-config, textarea.main-config').change(function () {
        pushMainConfig($(this).parents('tr:eq(0)').attr('reboot') == 'true');
    });
    $('input.camera-config, select.camera-config, textarea.camera-config').change(function () {
        pushCameraConfig($(this).parents('tr:eq(0)').attr('reboot') == 'true');
    });
    
    /* streaming framerate must be >= device framerate */
    $('#framerateSlider').change(function (val) {
        var value = Number($('#framerateSlider').val());
        var streamingValue = Number($('#streamingFramerateSlider').val());
        
        if (streamingValue < value) {
            $('#streamingFramerateSlider').val(value).change();
        }
    });
    
    /* preview controls */
    $('#brightnessSlider').change(function () {pushPreview('brightness');});
    $('#contrastSlider').change(function () {pushPreview('contrast');});
    $('#saturationSlider').change(function () {pushPreview('saturation');});
    $('#hueSlider').change(function () {pushPreview('hue');});
    
    /* apply button */
    $('#applyButton').click(function () {
        if ($(this).hasClass('progress')) {
            return; /* in progress */
        }
        
        doApply();
    });
    
    /* shut down button */
    $('#shutDownButton').click(function () {
        doShutDown();
    });
    
    /* reboot button */
    $('#rebootButton').click(function () {
        doReboot();
    });
    
    /* whenever the window is resized,
     * if a modal dialog is visible, it should be repositioned */
    $(window).resize(updateModalDialogPosition);
    
    /* remove camera button */
    $('div.button.rem-camera-button').click(doRemCamera);
    
    /* logout button */
    $('div.button.logout-button').click(doLogout);
    
    /* autoselect urls in read-only entries */
    $('#streamingSnapshotUrlEntry:text, #streamingMjpgUrlEntry:text, #streamingEmbedUrlEntry:text').click(function () {
        this.select();
    });

    /* show a warning when enabling media files removal */
    var preserveSelects = $('#preservePicturesSelect, #preserveMoviesSelect');
    var rootDirectoryEntry = $('#rootDirectoryEntry');
    preserveSelects.focus(function () {
        this._prevValue = $(this).val();
    }).change(function () {
        var value = $(this).val();
        if (value != '0' && this._prevValue == '0') {
            var rootDir = rootDirectoryEntry.val();
            runAlertDialog(('This will recursively remove all old media files present in the directory "' + rootDir + 
                    '", not just those created by motionEye!'));
        }
    });
}


    /* settings */

function openSettings(cameraId) {
    if (cameraId != null) {
        $('#cameraSelect').val(cameraId).change();
    }
    
    $('div.settings').addClass('open').removeClass('closed');
    $('div.page-container').addClass('stretched');
    $('div.settings-top-bar').addClass('open').removeClass('closed');
    
    updateConfigUi();
}

function closeSettings() {
    hideApply();
    pushConfigs = {};
    pushConfigReboot = false;
    
    $('div.settings').removeClass('open').addClass('closed');
    $('div.page-container').removeClass('stretched');
    $('div.settings-top-bar').removeClass('open').addClass('closed');
}

function isSettingsOpen() {
    return $('div.settings').hasClass('open');   
}

function updateConfigUi() {
    var objs = $('tr.settings-item, div.advanced-setting, table.advanced-setting, div.settings-section-title, table.settings, ' +
            'div.check-box.camera-config, div.check-box.main-config');
    
    function markHideLogic() {
        this._hideLogic = true;
    }
    
    function markHideAdvanced() {
        this._hideAdvanced = true;
    }
    
    function markHideMinimized() {
        this._hideMinimized = true;
    }
    
    function unmarkHide() {
        this._hideLogic = false;
        this._hideAdvanced = false;
        this._hideMinimized = false;
    }
    
    objs.each(unmarkHide);
    
    /* hide sliders that, for some reason, don't have a value */
    $('input.range').each(function () {
        if  (this.value == '') {
            $(this).parents('tr:eq(0)').each(markHideLogic);
        }
    });

    /* minimizable sections */
    $('span.minimize').each(function () {
        var $this = $(this);
        if (!$this.hasClass('open')) {
            $this.parent().next('table.settings').find('tr').each(markHideMinimized);
        }
    });

    /* general enable switch */
    var motionEyeEnabled = $('#motionEyeSwitch').get(0).checked;
    if (!motionEyeEnabled) {
        objs.not($('#motionEyeSwitch').parents('div').get(0)).each(markHideLogic);
    }
    
    if ($('#cameraSelect').find('option').length < 2) { /* no camera configured */
        $('#videoDeviceSwitch').parent().each(markHideLogic);
        $('#videoDeviceSwitch').parent().nextAll('div.settings-section-title, table.settings').each(markHideLogic);
    }
    
    if ($('#videoDeviceSwitch')[0].error) { /* config error */
        $('#videoDeviceSwitch').parent().nextAll('div.settings-section-title, table.settings').each(markHideLogic);
    }
        
    /* advanced settings */
    var showAdvanced = $('#showAdvancedSwitch').get(0).checked;
    if (!showAdvanced) {
        $('tr.advanced-setting, div.advanced-setting, table.advanced-setting').each(markHideAdvanced);
    }
    
    /* hide resolution select if no resolution is selected (none matches) */
    if ($('#resolutionSelect')[0].selectedIndex == -1) {
        $('#resolutionSelect').parents('tr:eq(0)').each(markHideLogic);
    }

    /* storage device */
    if ($('#storageDeviceSelect').val() !== 'network-share') {
        $('#networkServerEntry').parents('tr:eq(0)').each(markHideLogic);
        $('#networkUsernameEntry').parents('tr:eq(0)').each(markHideLogic);
        $('#networkPasswordEntry').parents('tr:eq(0)').each(markHideLogic);
        $('#networkShareNameEntry').parents('tr:eq(0)').each(markHideLogic);
    }
    
    /* text */
    if ($('#leftTextSelect').val() !== 'custom-text') {
        $('#leftTextEntry').parents('tr:eq(0)').each(markHideLogic);
    }
    if ($('#rightTextSelect').val() !== 'custom-text') {
        $('#rightTextEntry').parents('tr:eq(0)').each(markHideLogic);
    }
    
    /* still images capture mode */
    if ($('#captureModeSelect').val() !== 'interval-snapshots') {
        $('#snapshotIntervalEntry').parents('tr:eq(0)').each(markHideLogic);
    }
    
    /* auto noise level */
    if ($('#autoNoiseDetectSwitch').get(0).checked) {
        $('#noiseLevelSlider').parents('tr:eq(0)').each(markHideLogic);
    }
    
    /* video device switch */
    if (!$('#videoDeviceSwitch').get(0).checked) {
        $('#videoDeviceSwitch').parent().nextAll('div.settings-section-title, table.settings').each(markHideLogic);
    }
    
    /* text overlay switch */
    if (!$('#textOverlaySwitch').get(0).checked) {
        $('#textOverlaySwitch').parent().next('table.settings').find('tr.settings-item').each(markHideLogic);
    }
    
    /* video streaming */
    if (!$('#videoStreamingSwitch').get(0).checked) {
        $('#videoStreamingSwitch').parent().next('table.settings').find('tr.settings-item').not('.localhost-streaming').each(markHideLogic);
    }
    if (!$('#streamingServerResizeSwitch').get(0).checked) {
        $('#streamingResolutionSlider').parents('tr:eq(0)').each(markHideLogic);
    }
    
    /* still images switch */
    if (!$('#stillImagesSwitch').get(0).checked) {
        $('#stillImagesSwitch').parent().next('table.settings').find('tr.settings-item').each(markHideLogic);
    }
    
    /* preserve pictures */
    if ($('#preservePicturesSelect').val() != '-1') {
        $('#picturesLifetimeEntry').parents('tr:eq(0)').each(markHideLogic);
    }
    
    /* motion detection switch */
    if (!$('#motionDetectionSwitch').get(0).checked) {
        $('#motionDetectionSwitch').parent().next('table.settings').find('tr.settings-item').each(markHideLogic);
        
        /* hide the entire motion movies section */
        $('#motionMoviesSwitch').parent().each(markHideLogic);
        $('#motionMoviesSwitch').parent().next('table.settings').each(markHideLogic);
        
        /* hide the entire notifications section */
        $('#emailNotificationsSwitch').parents('table.settings').prev().each(markHideLogic);
        $('#emailNotificationsSwitch').parents('table.settings').each(markHideLogic);
        
        /* hide the entire working schedule section */
        $('#workingScheduleSwitch').parent().each(markHideLogic);
        $('#workingScheduleSwitch').parent().next('table.settings').each(markHideLogic);
    }
    
    /* motion movies switch */
    if (!$('#motionMoviesSwitch').get(0).checked) {
        $('#motionMoviesSwitch').parent().next('table.settings').find('tr.settings-item').each(markHideLogic);
    }
    
    /* preserve movies */
    if ($('#preserveMoviesSelect').val() != '-1') {
        $('#moviesLifetimeEntry').parents('tr:eq(0)').each(markHideLogic);
    }
    
    /* event notifications */
    if (!$('#emailNotificationsSwitch').get(0).checked) {
        $('#emailAddressesEntry').parents('tr:eq(0)').each(markHideLogic);
        $('#smtpServerEntry').parents('tr:eq(0)').each(markHideLogic);
        $('#smtpPortEntry').parents('tr:eq(0)').each(markHideLogic);
        $('#smtpAccountEntry').parents('tr:eq(0)').each(markHideLogic);
        $('#smtpPasswordEntry').parents('tr:eq(0)').each(markHideLogic);
        $('#smtpTlsSwitch').parents('tr:eq(0)').each(markHideLogic);
        $('#emailPictureTimeSpanEntry').parents('tr:eq(0)').each(markHideLogic);
    }
    
    if (!$('#webHookNotificationsSwitch').get(0).checked) {
        $('#webHookUrlEntry').parents('tr:eq(0)').each(markHideLogic);
        $('#webHookHttpMethodSelect').parents('tr:eq(0)').each(markHideLogic);
    }

    if (!$('#commandNotificationsSwitch').get(0).checked) {
        $('#commandNotificationsEntry').parents('tr:eq(0)').each(markHideLogic);
    }

    /* working schedule */
    if (!$('#workingScheduleSwitch').get(0).checked) {
        $('#workingScheduleSwitch').parent().next('table.settings').find('tr.settings-item').each(markHideLogic);
    }
    
    /* additional configs */
    $('tr[depends]').each(function () {
        var $tr = $(this);
        var depends = $tr.attr('depends').split(' ');
        var conditionOk = true;
        depends.every(function (depend) {
            var neg = depend.indexOf('!') >= 0;
            var parts = depend.split('=');
            var boolCheck = parts.length == 1;
            depend = parts[0].replace(new RegExp('[^a-zA-Z0-9_$]', 'g'), '');

            var control = $('#' + depend + 'Entry, #' + depend + 'Select, #' + depend + 'Slider');
            var val = false;
            if (control.length) {
                val = control.val();
            }
            else { /* maybe it's a checkbox */
                control = $('#' + depend + 'Switch');
                if (control.length) {
                    val = control.get(0).checked;
                }
            }

            if (boolCheck) {
                if (neg) {
                    val = !val;
                }
                
                if (!val) {
                    conditionOk = false;
                    return false;
                }
            }
            else { /* comparison */
                var equal = parts[parts.length - 1] == val;
                if (equal == neg) {
                    conditionOk = false;
                    return false;
                }
            }

            return true;
        });
        
        if (!conditionOk) {
            $tr.each(markHideLogic);
        }
    });
    
    /* hide sections that have no visible configs and no switch */
    $('div.settings-section-title').each(function () {
        var $this = $(this);
        var $table = $this.next();
        var controls = $table.find('input, select');

        var switchButton = $this.children('div.check-box');
        if (switchButton.length && !switchButton[0]._hideNull) {
            return; /* has visible switch */
        }

        for (var i = 0; i < controls.length; i++) {
            var control = $(controls[i]);
            var tr = control.parents('tr:eq(0)')[0];
            if (!tr._hideLogic && !tr._hideAdvanced && !tr._hideNull) {
                return; /* has visible controls */
            }
        }

        $table.find('div.settings-item-separator').each(function () {
            $(this).parent().parent().each(markHideLogic);
        });

        $this.each(markHideLogic);
        $table.each(markHideLogic);
    });
    
    /* hide useless separators */
    $('div.settings-container table.settings').each(function () {
        var $table = $(this);
        
        /* filter visible rows */
        var visibleTrs = $table.find('tr').filter(function () {
            return !this._hideLogic && !this._hideAdvanced && !this._hideNull;
        }).map(function () {
            var $tr = $(this);
            $tr.isSeparator = $tr.find('div.settings-item-separator').length > 0;
            
            return $tr;
        }).get();

        for (var i = 1; i < visibleTrs.length; i++) {
            var $prevTr = visibleTrs[i - 1];
            var $tr = visibleTrs[i];
            if ($prevTr.isSeparator && $tr.isSeparator) {
                $tr.each(markHideLogic);
            }
        }

        /* filter visible rows again */
        visibleTrs = $table.find('tr').filter(function () {
            return !this._hideLogic && !this._hideAdvanced && !this._hideNull;
        }).map(function () {
            var $tr = $(this);
            $tr.isSeparator = $tr.find('div.settings-item-separator').length > 0;
            
            return $tr;
        }).get();

        if (visibleTrs.length) {
            /* test first row */
            if (visibleTrs[0].isSeparator) {
                visibleTrs[0].each(markHideLogic);
            }
            
            /* test last row */
            if (visibleTrs[visibleTrs.length - 1].isSeparator) {
                visibleTrs[visibleTrs.length - 1].each(markHideLogic);
            }
        }
    });
    
    var weekDays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
    weekDays.forEach(function (weekDay) {
        var check = $('#' + weekDay + 'EnabledSwitch');
        if (check.get(0).checked) {
            check.parent().find('.time').show();
        }
        else {
            check.parent().find('.time').hide();
        }
    });
    
    objs.each(function () {
        if (this._hideLogic || this._hideAdvanced || this._hideMinimized || this._hideNull /* from dict2ui */) {
            $(this).hide(200);
        }
        else {
            $(this).show(200);
        }
    });
    
    /* re-validate all the validators */
    $('div.settings').find('.validator').each(function () {
        this.validate();
    });
    
    /* update all checkboxes and sliders */
    $('div.settings').find('input[type=checkbox], input.range').each(function () {
        this.update();
    });
    
    /* select the first option for the selects with no current selection */
    $('div.settings').find('select').not('#cameraSelect').each(function () {
        if (this.selectedIndex === -1) {
            this.selectedIndex = 0;
        }
    });
}

function configUiValid() {
    /* re-validate all the validators */
    $('div.settings').find('.validator').each(function () {
        this.validate();
    });
    
    var valid = true;
    $('div.settings input, select').each(function () {
        if (this.invalid) {
            valid = false;
            return false;
        }
    });
    
    return valid;
}

function mainUi2Dict() {
    var dict = {
        'enabled': $('#motionEyeSwitch')[0].checked,
        
        'show_advanced': $('#showAdvancedSwitch')[0].checked,
        'admin_username': $('#adminUsernameEntry').val(),
        'admin_password': $('#adminPasswordEntry').val(),
        'normal_username': $('#normalUsernameEntry').val(),
        'normal_password': $('#normalPasswordEntry').val()
    };

    /* additional sections */
    $('input[type=checkbox].additional-section.main-config').each(function () {
        dict['_' + this.id.substring(0, this.id.length - 6)] = this.checked;
    });

    /* additional configs */
    $('tr.additional-config').each(function () {
        var $this = $(this);
        var control = $this.find('input, select');
        
        if (!control.hasClass('main-config')) {
            return;
        }
        
        var id = control.attr('id');
        var name, value;
        if (id.endsWith('Entry')) {
            name = id.substring(0, id.length - 5);
            value = control.val();
            if (control.hasClass('number')) {
                value = Number(value);
            }
        }
        else if (id.endsWith('Select')) {
            name = id.substring(0, id.length - 6);
            value = control.val();
        }
        else if (id.endsWith('Slider')) {
            name = id.substring(0, id.length - 6);
            value = Number(control.val());
        }
        else if (id.endsWith('Switch')) {
            name = id.substring(0, id.length - 6);
            value = control[0].checked;
        }
        
        dict['_' + name] = value;
    });

    return dict;
}

function dict2MainUi(dict) {
    function markHideIfNull(field, elemId) {
        var elem = $('#' + elemId);
        var sectionDiv = elem.parents('div.settings-section-title:eq(0)');
        var hideNull = (field === true) || (typeof field == 'string' && dict[field] == null);

        if (sectionDiv.length) { /* element is a section */
            sectionDiv.find('div.check-box').each(function () {this._hideNull = hideNull;});
            if (hideNull) {
                sectionDiv.find('input[type=checkbox]').each(function () {this.checked = true;});
            }
        }
        else { /* element is a config option */
            elem.parents('tr:eq(0)').each(function () {this._hideNull = hideNull;});
        }
    }
    
    $('#motionEyeSwitch')[0].checked = dict['enabled'];
    
    $('#showAdvancedSwitch')[0].checked = dict['show_advanced']; markHideIfNull('show_advanced', 'showAdvancedSwitch');
    $('#adminUsernameEntry').val(dict['admin_username']); markHideIfNull('admin_username', 'adminUsernameEntry');
    $('#adminPasswordEntry').val(dict['admin_password']); markHideIfNull('admin_password', 'adminPasswordEntry');
    $('#normalUsernameEntry').val(dict['normal_username']); markHideIfNull('normal_username', 'normalUsernameEntry');
    $('#normalPasswordEntry').val(dict['normal_password']); markHideIfNull('normal_password', 'normalPasswordEntry');

    /* additional sections */
    $('input[type=checkbox].additional-section.main-config').each(function () {
        var name = this.id.substring(0, this.id.length - 6);
        this.checked = dict[name];
        markHideIfNull(name, this.id);
    });

    /* additional configs */
    $('tr.additional-config').each(function () {
        var $this = $(this);
        var control = $this.find('input, select, textarea, div.html');
        
        if (!control.hasClass('main-config')) {
            return;
        }

        var id = control.attr('id');
        var name;
        if (id.endsWith('Entry')) {
            name = id.substring(0, id.length - 5);
            control.val(dict['_' + name]);
        }
        else if (id.endsWith('Select')) {
            name = id.substring(0, id.length - 6);
            control.val(dict['_' + name]);
        }
        else if (id.endsWith('Slider')) {
            name = id.substring(0, id.length - 6);
            control.val(dict['_' + name]);
        }
        else if (id.endsWith('Switch')) {
            name = id.substring(0, id.length - 6);
            control[0].checked = dict['_' + name];
        }
        else if (id.endsWith('Html')) {
            name = id.substring(0, id.length - 4);
            control.html(dict['_' + name]);
        }
        
        markHideIfNull('_' + name, id);
    });

    updateConfigUi();
}

function cameraUi2Dict() {
    if ($('#videoDeviceSwitch')[0].error) { /* config error */
        return {
            'enabled': $('#videoDeviceSwitch')[0].checked,
        };
    }
    
    var dict = {
        'enabled': $('#videoDeviceSwitch')[0].checked,
        'name': $('#deviceNameEntry').val(),
        'proto': $('#deviceTypeEntry')[0].proto,
        
        /* video device */
        'light_switch_detect': $('#lightSwitchDetectSlider').val(),
        'auto_brightness': $('#autoBrightnessSwitch')[0].checked,
        'rotation': $('#rotationSelect').val(),
        'framerate': $('#framerateSlider').val(),
        'extra_options': $('#extraOptionsEntry').val().split(new RegExp('(\n)|(\r\n)|(\n\r)')).map(function (o) {
            if (!o) {
                return null;
            }

            o = o.trim();
            if (!o.length) {
                return null;
            }

            var parts = o.replace(new RegExp('\\s+', 'g'), ' ').split(' ');
            if (parts.length < 2) {
                return [parts[0], ''];
            }
            else if (parts.length == 2) {
                return parts;
            }
            else {
                return [parts[0], parts.slice(1).join(' ')];
            }
        }).filter(function (e) {return e;}),

        /* file storage */
        'storage_device': $('#storageDeviceSelect').val(),
        'network_server': $('#networkServerEntry').val(),
        'network_share_name': $('#networkShareNameEntry').val(),
        'network_username': $('#networkUsernameEntry').val(),
        'network_password': $('#networkPasswordEntry').val(),
        'root_directory': $('#rootDirectoryEntry').val(),
        
        /* text overlay */
        'text_overlay': $('#textOverlaySwitch')[0].checked,
        'left_text': $('#leftTextSelect').val(),
        'custom_left_text': $('#leftTextEntry').val(),
        'right_text': $('#rightTextSelect').val(),
        'custom_right_text': $('#rightTextEntry').val(),
        
        /* video streaming */
        'video_streaming': $('#videoStreamingSwitch')[0].checked,
        'streaming_framerate': $('#streamingFramerateSlider').val(),
        'streaming_quality': $('#streamingQualitySlider').val(),
        'streaming_resolution': $('#streamingResolutionSlider').val(),
        'streaming_server_resize': $('#streamingServerResizeSwitch')[0].checked,
        'streaming_port': $('#streamingPortEntry').val(),
        'streaming_auth_mode': $('#streamingAuthModeSelect').val() || 'disabled', /* compatibility with old motion */
        'streaming_motion': $('#streamingMotion')[0].checked,
        
        /* still images */
        'still_images': $('#stillImagesSwitch')[0].checked,
        'image_file_name': $('#imageFileNameEntry').val(),
        'image_quality': $('#imageQualitySlider').val(),
        'capture_mode': $('#captureModeSelect').val(),
        'snapshot_interval': $('#snapshotIntervalEntry').val(),
        'preserve_pictures': $('#preservePicturesSelect').val() >= 0 ? $('#preservePicturesSelect').val() : $('#picturesLifetimeEntry').val(),
        
        /* motion detection */
        'motion_detection': $('#motionDetectionSwitch')[0].checked,
        'show_frame_changes': $('#showFrameChangesSwitch')[0].checked,
        'frame_change_threshold': $('#frameChangeThresholdSlider').val(),
        'auto_noise_detect': $('#autoNoiseDetectSwitch')[0].checked,
        'noise_level': $('#noiseLevelSlider').val(),
        'event_gap': $('#eventGapEntry').val(),
        'pre_capture': $('#preCaptureEntry').val(),
        'post_capture': $('#postCaptureEntry').val(),
        'minimum_motion_frames': $('#minimumMotionFramesEntry').val(),
        
        /* motion movies */
        'motion_movies': $('#motionMoviesSwitch')[0].checked,
        'movie_file_name': $('#movieFileNameEntry').val(),
        'movie_quality': $('#movieQualitySlider').val(),
        'max_movie_length': $('#maxMovieLengthEntry').val(),
        'preserve_movies': $('#preserveMoviesSelect').val() >= 0 ? $('#preserveMoviesSelect').val() : $('#moviesLifetimeEntry').val(),
        
        /* motion notifications */
        'email_notifications_enabled': $('#emailNotificationsSwitch')[0].checked,
        'email_notifications_addresses': $('#emailAddressesEntry').val(),
        'email_notifications_smtp_server': $('#smtpServerEntry').val(),
        'email_notifications_smtp_port': $('#smtpPortEntry').val(),
        'email_notifications_smtp_account': $('#smtpAccountEntry').val(),
        'email_notifications_smtp_password': $('#smtpPasswordEntry').val(),
        'email_notifications_smtp_tls': $('#smtpTlsSwitch')[0].checked,
        'email_notifications_picture_time_span': $('#emailPictureTimeSpanEntry').val(),
        'web_hook_notifications_enabled': $('#webHookNotificationsSwitch')[0].checked,
        'web_hook_notifications_url': $('#webHookUrlEntry').val(),
        'web_hook_notifications_http_method': $('#webHookHttpMethodSelect').val(),
        'command_notifications_enabled': $('#commandNotificationsSwitch')[0].checked,
        'command_notifications_exec': $('#commandNotificationsEntry').val(),
        
        /* working schedule */
        'working_schedule': $('#workingScheduleSwitch')[0].checked,
        'monday_from': $('#mondayEnabledSwitch')[0].checked ? $('#mondayFromEntry').val() : '',
        'monday_to':$('#mondayEnabledSwitch')[0].checked ? $('#mondayToEntry').val() : '',
        'tuesday_from': $('#tuesdayEnabledSwitch')[0].checked ? $('#tuesdayFromEntry').val() : '',
        'tuesday_to': $('#tuesdayEnabledSwitch')[0].checked ? $('#tuesdayToEntry').val() : '',
        'wednesday_from': $('#wednesdayEnabledSwitch')[0].checked ? $('#wednesdayFromEntry').val() : '',
        'wednesday_to': $('#wednesdayEnabledSwitch')[0].checked ? $('#wednesdayToEntry').val() : '',
        'thursday_from': $('#thursdayEnabledSwitch')[0].checked ? $('#thursdayFromEntry').val() : '',
        'thursday_to': $('#thursdayEnabledSwitch')[0].checked ? $('#thursdayToEntry').val() : '',
        'friday_from': $('#fridayEnabledSwitch')[0].checked ? $('#fridayFromEntry').val() : '',
        'friday_to': $('#fridayEnabledSwitch')[0].checked ? $('#fridayToEntry').val() :'',
        'saturday_from': $('#saturdayEnabledSwitch')[0].checked ? $('#saturdayFromEntry').val() : '',
        'saturday_to': $('#saturdayEnabledSwitch')[0].checked ? $('#saturdayToEntry').val() : '',
        'sunday_from': $('#sundayEnabledSwitch')[0].checked ? $('#sundayFromEntry').val() : '',
        'sunday_to': $('#sundayEnabledSwitch')[0].checked ? $('#sundayToEntry').val() : '',
        'working_schedule_type': $('#workingScheduleTypeSelect').val(),
    };

    if ($('#resolutionSelect')[0].selectedIndex != -1) {
        dict.resolution = $('#resolutionSelect').val();
    }

    if ($('#brightnessSlider').val() !== '') {
        dict.brightness = $('#brightnessSlider').val();
    }

    if ($('#contrastSlider').val() !== '') {
        dict.contrast = $('#contrastSlider').val();
    }
    
    if ($('#saturationSlider').val() !== '') {
        dict.saturation = $('#saturationSlider').val();
    }
    
    if ($('#hueSlider').val() !== '') {
        dict.hue = $('#hueSlider').val();
    }
    
    /* additional sections */
    $('input[type=checkbox].additional-section.camera-config').each(function () {
        dict['_' + this.id.substring(0, this.id.length - 6)] = this.checked;
    });

    /* additional configs */
    $('tr.additional-config').each(function () {
        var $this = $(this);
        var control = $this.find('input, select');
        
        if (!control.hasClass('camera-config')) {
            return;
        }
        
        var id = control.attr('id');
        var name, value;
        if (id.endsWith('Entry')) {
            name = id.substring(0, id.length - 5);
            value = control.val();
            if (control.hasClass('number')) {
                value = Number(value);
            }
        }
        else if (id.endsWith('Select')) {
            name = id.substring(0, id.length - 6);
            value = control.val();
        }
        else if (id.endsWith('Slider')) {
            name = id.substring(0, id.length - 6);
            value = Number(control.val());
        }
        else if (id.endsWith('Switch')) {
            name = id.substring(0, id.length - 6);
            value = control[0].checked;
        }
        
        dict['_' + name] = value;
    });

    return dict;
}

function dict2CameraUi(dict) {
    if (dict == null) {
        /* errors while getting the configuration */
        
        $('#videoDeviceSwitch')[0].error = true;
        $('#videoDeviceSwitch')[0].checked = true; /* so that the user can explicitly disable the camera */
        updateConfigUi();
        
        return;
    }
    else {
        $('#videoDeviceSwitch')[0].error = false;
    }

    function markHideIfNull(field, elemId) {
        var elem = $('#' + elemId);
        var sectionDiv = elem.parents('div.settings-section-title:eq(0)');
        var hideNull = (field === true) || (typeof field == 'string' && dict[field] == null);

        if (sectionDiv.length) { /* element is a section */
            sectionDiv.find('div.check-box').each(function () {this._hideNull = hideNull;});
            if (hideNull) {
                sectionDiv.find('input[type=checkbox]').each(function () {this.checked = true;});
            }
        }
        else { /* element is a config option */
            elem.parents('tr:eq(0)').each(function () {this._hideNull = hideNull;});
        }
    }
    
    /* video device */
    var prettyType = '';
    switch (dict['proto']) {
        case 'v4l2':
            prettyType = 'V4L2 Camera';
            break;

        case 'netcam':
            prettyType = 'Network Camera';
            break;

        case 'motioneye':
            prettyType = 'Remote motionEye Camera';
            break;

        case 'mjpeg':
            prettyType = 'Simple MJPEG Camera';
            break;
    }
    
    $('#videoDeviceSwitch')[0].checked = dict['enabled']; markHideIfNull('enabled', 'videoDeviceSwitch');
    $('#deviceNameEntry').val(dict['name']); markHideIfNull('name', 'deviceNameEntry');
    $('#deviceUrlEntry').val(dict['device_url']); markHideIfNull('device_url', 'deviceUrlEntry');
    $('#deviceTypeEntry').val(prettyType); markHideIfNull(!prettyType, 'deviceTypeEntry');
    $('#deviceTypeEntry')[0].proto = dict['proto'];
    $('#lightSwitchDetectSlider').val(dict['light_switch_detect']); markHideIfNull('light_switch_detect', 'lightSwitchDetectSlider');
    $('#autoBrightnessSwitch')[0].checked = dict['auto_brightness']; markHideIfNull('auto_brightness', 'autoBrightnessSwitch');
    
    $('#brightnessSlider').val(dict['brightness']); markHideIfNull('brightness', 'brightnessSlider');
    $('#contrastSlider').val(dict['contrast']); markHideIfNull('contrast', 'contrastSlider');
    $('#saturationSlider').val(dict['saturation']); markHideIfNull('saturation', 'saturationSlider');
    $('#hueSlider').val(dict['hue']); markHideIfNull('hue', 'hueSlider');

    $('#resolutionSelect').html('');
    if (dict['available_resolutions']) {
        dict['available_resolutions'].forEach(function (resolution) {
            $('#resolutionSelect').append('<option value="' + resolution + '">' + resolution + '</option>');
        });
    }
    $('#resolutionSelect').val(dict['resolution']); markHideIfNull('available_resolutions', 'resolutionSelect');
    
    $('#rotationSelect').val(dict['rotation']); markHideIfNull('rotation', 'rotationSelect');
    $('#framerateSlider').val(dict['framerate']); markHideIfNull('framerate', 'framerateSlider');
    $('#extraOptionsEntry').val(dict['extra_options'] ? (dict['extra_options'].map(function (o) {
        return o.join(' ');
    }).join('\r\n')) : ''); markHideIfNull('extra_options', 'extraOptionsEntry');
    
    /* file storage */
    $('#storageDeviceSelect').empty();
    dict['available_disks'] = dict['available_disks'] || [];
    var storageDeviceOptions = {'network-share': true};
    dict['available_disks'].forEach(function (disk) {
        disk.partitions.forEach(function (partition) {
            var target = partition.target.replaceAll('/', '-');
            var option = 'local-disk' + target;
            var label = partition.vendor;
            if (partition.model) {
                label += ' ' + partition.model;
            }
            if (disk.partitions.length > 1) {
                label += '/part' + partition.part_no;
            }
            label += ' (' + partition.target + ')';
            
            storageDeviceOptions[option] = true;
            
            $('#storageDeviceSelect').append('<option value="' + option + '">' + label + '</option>');
        });
    });
    $('#storageDeviceSelect').append('<option value="custom-path">Custom Path</option>');
    if (dict['smb_shares']) {
        $('#storageDeviceSelect').append('<option value="network-share">Network Share</option>');
    }

    if (storageDeviceOptions[dict['storage_device']]) {
        $('#storageDeviceSelect').val(dict['storage_device']);
    }
    else {
        $('#storageDeviceSelect').val('custom-path');
    }
    markHideIfNull('storage_device', 'storageDeviceSelect');
    $('#networkServerEntry').val(dict['network_server']); markHideIfNull('network_server', 'networkServerEntry');
    $('#networkShareNameEntry').val(dict['network_share_name']); markHideIfNull('network_share_name', 'networkShareNameEntry');
    $('#networkUsernameEntry').val(dict['network_username']); markHideIfNull('network_username', 'networkUsernameEntry');
    $('#networkPasswordEntry').val(dict['network_password']); markHideIfNull('network_password', 'networkPasswordEntry');
    $('#rootDirectoryEntry').val(dict['root_directory']); markHideIfNull('root_directory', 'rootDirectoryEntry');
    var percent = 0;
    if (dict['disk_total'] != 0) {
        percent = parseInt(dict['disk_used'] * 100 / dict['disk_total']);
    }
    
    $('#diskUsageProgressBar').each(function () {
        this.setProgress(percent);
        this.setText((dict['disk_used'] / 1073741824).toFixed(1)  + '/' + (dict['disk_total'] / 1073741824).toFixed(1) + ' GB (' + percent + '%)');
    }); markHideIfNull('disk_used', 'diskUsageProgressBar');
    
    /* text overlay */
    $('#textOverlaySwitch')[0].checked = dict['text_overlay']; markHideIfNull('text_overlay', 'textOverlaySwitch');
    $('#leftTextSelect').val(dict['left_text']); markHideIfNull('left_text', 'leftTextSelect');
    $('#leftTextEntry').val(dict['custom_left_text']); markHideIfNull('custom_left_text', 'leftTextEntry');
    $('#rightTextSelect').val(dict['right_text']); markHideIfNull('right_text', 'rightTextSelect');
    $('#rightTextEntry').val(dict['custom_right_text']); markHideIfNull('custom_right_text', 'rightTextEntry');
    
    /* video streaming */
    $('#videoStreamingSwitch')[0].checked = dict['video_streaming']; markHideIfNull('video_streaming', 'videoStreamingSwitch');
    $('#streamingFramerateSlider').val(dict['streaming_framerate']); markHideIfNull('streaming_framerate', 'streamingFramerateSlider');
    $('#streamingQualitySlider').val(dict['streaming_quality']); markHideIfNull('streaming_quality', 'streamingQualitySlider');
    $('#streamingResolutionSlider').val(dict['streaming_resolution']); markHideIfNull('streaming_resolution', 'streamingResolutionSlider');
    $('#streamingServerResizeSwitch')[0].checked = dict['streaming_server_resize']; markHideIfNull('streaming_server_resize', 'streamingServerResizeSwitch');
    $('#streamingPortEntry').val(dict['streaming_port']); markHideIfNull('streaming_port', 'streamingPortEntry');
    $('#streamingAuthModeSelect').val(dict['streaming_auth_mode']); markHideIfNull('streaming_auth_mode', 'streamingAuthModeSelect');
    $('#streamingMotion')[0].checked = dict['streaming_motion']; markHideIfNull('streaming_motion', 'streamingMotion');
    
    var cameraUrl = location.protocol + '//' + location.host + basePath + 'picture/' + dict.id + '/';
    
    var snapshotUrl = null;
    var mjpgUrl = null;
    var embedUrl = null;
    
    if (dict['proto'] == 'mjpeg') {
        mjpgUrl = dict['url'];
        mjpgUrl = mjpgUrl.replace('127.0.0.1', window.location.host.split(':')[0]);
        embedUrl = cameraUrl + 'frame/';
    }
    else {
        snapshotUrl = cameraUrl + 'current/';
        mjpgUrl = location.protocol + '//' + location.host.split(':')[0] + ':' + dict.streaming_port;
        embedUrl = cameraUrl + 'frame/';
    }

    if (dict.proto == 'motioneye') {
        /* cannot tell the mjpg streaming url for a remote motionEye camera */
        mjpgUrl = '';
    }

    if ($('#normalPasswordEntry').val()) { /* anonymous access is disabled */ 
        if (snapshotUrl) {
            snapshotUrl = addAuthParams('GET', snapshotUrl);
        }
    }
    
    $('#streamingSnapshotUrlEntry').val(snapshotUrl); markHideIfNull(!snapshotUrl, 'streamingSnapshotUrlEntry');
    $('#streamingMjpgUrlEntry').val(mjpgUrl); markHideIfNull(!mjpgUrl, 'streamingMjpgUrlEntry');
    $('#streamingEmbedUrlEntry').val(embedUrl); markHideIfNull(!embedUrl, 'streamingEmbedUrlEntry');
    
    /* still images */
    $('#stillImagesSwitch')[0].checked = dict['still_images']; markHideIfNull('still_images', 'stillImagesSwitch');
    $('#imageFileNameEntry').val(dict['image_file_name']); markHideIfNull('image_file_name', 'imageFileNameEntry');
    $('#imageQualitySlider').val(dict['image_quality']); markHideIfNull('image_quality', 'imageQualitySlider');
    $('#captureModeSelect').val(dict['capture_mode']); markHideIfNull('capture_mode', 'captureModeSelect');
    $('#snapshotIntervalEntry').val(dict['snapshot_interval']); markHideIfNull('snapshot_interval', 'snapshotIntervalEntry');
    $('#preservePicturesSelect').val(dict['preserve_pictures']);
    if ($('#preservePicturesSelect').val() == null) {
        $('#preservePicturesSelect').val('-1');
    }
    markHideIfNull('preserve_pictures', 'preservePicturesSelect');
    $('#picturesLifetimeEntry').val(dict['preserve_pictures']); markHideIfNull('preserve_pictures', 'picturesLifetimeEntry');
    
    /* motion detection */
    $('#motionDetectionSwitch')[0].checked = dict['motion_detection']; markHideIfNull('motion_detection', 'motionDetectionSwitch');
    $('#showFrameChangesSwitch')[0].checked = dict['show_frame_changes']; markHideIfNull('show_frame_changes', 'showFrameChangesSwitch');
    $('#frameChangeThresholdSlider').val(dict['frame_change_threshold']); markHideIfNull('frame_change_threshold', 'frameChangeThresholdSlider');
    $('#autoNoiseDetectSwitch')[0].checked = dict['auto_noise_detect']; markHideIfNull('auto_noise_detect', 'autoNoiseDetectSwitch');
    $('#noiseLevelSlider').val(dict['noise_level']); markHideIfNull('noise_level', 'noiseLevelSlider');
    $('#eventGapEntry').val(dict['event_gap']); markHideIfNull('event_gap', 'eventGapEntry');
    $('#preCaptureEntry').val(dict['pre_capture']); markHideIfNull('pre_capture', 'preCaptureEntry');
    $('#postCaptureEntry').val(dict['post_capture']); markHideIfNull('post_capture', 'postCaptureEntry');
    $('#minimumMotionFramesEntry').val(dict['minimum_motion_frames']); markHideIfNull('minimum_motion_frames', 'minimumMotionFramesEntry');
    
    /* motion movies */
    $('#motionMoviesSwitch')[0].checked = dict['motion_movies']; markHideIfNull('motion_movies', 'motionMoviesSwitch');
    $('#movieFileNameEntry').val(dict['movie_file_name']); markHideIfNull('movie_file_name', 'movieFileNameEntry');
    $('#movieQualitySlider').val(dict['movie_quality']); markHideIfNull('movie_quality', 'movieQualitySlider');
    $('#maxMovieLengthEntry').val(dict['max_movie_length']); markHideIfNull('max_movie_length', 'maxMovieLengthEntry');
    $('#preserveMoviesSelect').val(dict['preserve_movies']);
    if ($('#preserveMoviesSelect').val() == null) {
        $('#preserveMoviesSelect').val('-1');
    }
    markHideIfNull('preserve_movies', 'preserveMoviesSelect');
    $('#moviesLifetimeEntry').val(dict['preserve_movies']); markHideIfNull('preserve_movies', 'moviesLifetimeEntry');
    
    /* motion notifications */
    $('#emailNotificationsSwitch')[0].checked = dict['email_notifications_enabled']; markHideIfNull('email_notifications_enabled', 'emailNotificationsSwitch');
    $('#emailAddressesEntry').val(dict['email_notifications_addresses']);
    $('#smtpServerEntry').val(dict['email_notifications_smtp_server']);
    $('#smtpPortEntry').val(dict['email_notifications_smtp_port']);
    $('#smtpAccountEntry').val(dict['email_notifications_smtp_account']);
    $('#smtpPasswordEntry').val(dict['email_notifications_smtp_password']);
    $('#smtpTlsSwitch')[0].checked = dict['email_notifications_smtp_tls'];
    $('#emailPictureTimeSpanEntry').val(dict['email_notifications_picture_time_span']);
    $('#webHookNotificationsSwitch')[0].checked = dict['web_hook_notifications_enabled']; markHideIfNull('web_hook_notifications_enabled', 'webHookNotificationsSwitch');
    $('#webHookUrlEntry').val(dict['web_hook_notifications_url']);
    $('#webHookHttpMethodSelect').val(dict['web_hook_notifications_http_method']);
    $('#commandNotificationsSwitch')[0].checked = dict['command_notifications_enabled']; markHideIfNull('command_notifications_enabled', 'commandNotificationsSwitch');
    $('#commandNotificationsEntry').val(dict['command_notifications_exec']);

    /* working schedule */
    $('#workingScheduleSwitch')[0].checked = dict['working_schedule']; markHideIfNull('working_schedule', 'workingScheduleSwitch');
    $('#mondayEnabledSwitch')[0].checked = Boolean(dict['monday_from'] && dict['monday_to']); markHideIfNull('monday_from', 'mondayEnabledSwitch');
    $('#mondayFromEntry').val(dict['monday_from']); markHideIfNull('monday_from', 'mondayFromEntry');
    $('#mondayToEntry').val(dict['monday_to']); markHideIfNull('monday_to', 'mondayToEntry');
    
    $('#tuesdayEnabledSwitch')[0].checked = Boolean(dict['tuesday_from'] && dict['tuesday_to']); markHideIfNull('tuesday_from', 'tuesdayEnabledSwitch');
    $('#tuesdayFromEntry').val(dict['tuesday_from']); markHideIfNull('tuesday_from', 'tuesdayFromEntry');
    $('#tuesdayToEntry').val(dict['tuesday_to']); markHideIfNull('tuesday_to', 'tuesdayToEntry');
    
    $('#wednesdayEnabledSwitch')[0].checked = Boolean(dict['wednesday_from'] && dict['wednesday_to']); markHideIfNull('wednesday_from', 'wednesdayEnabledSwitch');
    $('#wednesdayFromEntry').val(dict['wednesday_from']); markHideIfNull('wednesday_from', 'wednesdayFromEntry');
    $('#wednesdayToEntry').val(dict['wednesday_to']); markHideIfNull('wednesday_to', 'wednesdayToEntry');
    
    $('#thursdayEnabledSwitch')[0].checked = Boolean(dict['thursday_from'] && dict['thursday_to']); markHideIfNull('thursday_from', 'thursdayEnabledSwitch');
    $('#thursdayFromEntry').val(dict['thursday_from']); markHideIfNull('thursday_from', 'thursdayFromEntry');
    $('#thursdayToEntry').val(dict['thursday_to']); markHideIfNull('thursday_to', 'thursdayToEntry');
    
    $('#fridayEnabledSwitch')[0].checked = Boolean(dict['friday_from'] && dict['friday_to']); markHideIfNull('friday_from', 'fridayEnabledSwitch');
    $('#fridayFromEntry').val(dict['friday_from']); markHideIfNull('friday_from', 'fridayFromEntry');
    $('#fridayToEntry').val(dict['friday_to']); markHideIfNull('friday_to', 'fridayToEntry');
    
    $('#saturdayEnabledSwitch')[0].checked = Boolean(dict['saturday_from'] && dict['saturday_to']); markHideIfNull('saturday_from', 'saturdayEnabledSwitch');
    $('#saturdayFromEntry').val(dict['saturday_from']); markHideIfNull('saturday_from', 'saturdayFromEntry');
    $('#saturdayToEntry').val(dict['saturday_to']); markHideIfNull('saturday_to', 'saturdayToEntry');
    
    $('#sundayEnabledSwitch')[0].checked = Boolean(dict['sunday_from'] && dict['sunday_to']); markHideIfNull('sunday_from', 'sundayEnabledSwitch');
    $('#sundayFromEntry').val(dict['sunday_from']); markHideIfNull('sunday_from', 'sundayFromEntry');
    $('#sundayToEntry').val(dict['sunday_to']); markHideIfNull('sunday_to', 'sundayToEntry');
    $('#workingScheduleTypeSelect').val(dict['working_schedule_type']); markHideIfNull('working_schedule_type', 'workingScheduleTypeSelect');
    
    /* additional sections */
    $('input[type=checkbox].additional-section.main-config').each(function () {
        var name = this.id.substring(0, this.id.length - 6);
        this.checked = dict[name];
        markHideIfNull(name, this.id);
    });

    /* additional configs */
    $('tr.additional-config').each(function () {
        var $this = $(this);
        var control = $this.find('input, select, textarea, div.html');
        
        if (!control.hasClass('camera-config')) {
            return;
        }

        var id = control.attr('id');
        var name;
        if (id.endsWith('Entry')) {
            name = id.substring(0, id.length - 5);
            control.val(dict['_' + name]);
        }
        else if (id.endsWith('Select')) {
            name = id.substring(0, id.length - 6);
            control.val(dict['_' + name]);
        }
        else if (id.endsWith('Slider')) {
            name = id.substring(0, id.length - 6);
            control.val(dict['_' + name]);
        }
        else if (id.endsWith('Switch')) {
            name = id.substring(0, id.length - 6);
            control[0].checked = dict['_' + name];
        }
        else if (id.endsWith('Html')) {
            name = id.substring(0, id.length - 4);
            control.html(dict['_' + name]);
        }
        
        markHideIfNull('_' + name, id);
    });

    updateConfigUi();
}

    
    /* progress */

function beginProgress(cameraIds) {
    if (inProgress) {
        return; /* already in progress */
    }

    inProgress = true;
    
    /* replace the main page message with a progress indicator */
    $('div.add-camera-message').replaceWith('<img class="main-loading-progress" src="' + staticPath + 'img/main-loading-progress.gif">');
    
    /* show the apply button progress indicator */
    $('#applyButton').html('<img class="apply-progress" src="' + staticPath + 'img/apply-progress.gif">');
    
    /* show the camera progress indicators */
    if (cameraIds) {
        cameraIds.forEach(function (cameraId) {
            $('div.camera-frame#camera' + cameraId + ' div.camera-progress').addClass('visible');
        });
    }
    else {
        $('div.camera-progress').addClass('visible');
    }
    
    /* remove the settings progress lock */
    $('div.settings-progress').css('width', '100%').css('opacity', '0.9');
}

function endProgress() {
    if (!inProgress) {
        return; /* not in progress */
    }
    
    inProgress = false;
    
    /* deal with the apply button */
    if (Object.keys(pushConfigs).length === 0) {
        hideApply();
    }
    else {
        showApply();
    }
    
    /* hide the settings progress lock */
    $('div.settings-progress').css('opacity', '0');
    
    /* hide the camera progress indicator */
    $('div.camera-progress').removeClass('visible');

    setTimeout(function () {
        $('div.settings-progress').css('width', '0px');
    }, 500);
}

function downloadFile(path) {
    path = basePath + path;

    var url = window.location.href;
    var parts = url.split('/');
    url = parts.slice(0, 3).join('/') + path;
    url = addAuthParams('GET', url);
    
    /* download the file by creating a temporary iframe */
    var frame = $('<iframe style="display: none;"></iframe>');
    frame.attr('src', url);
    $('body').append(frame);
}

function uploadFile(path, input, callback) {
    if (!window.FormData) {
        showErrorMessage("Your browser doesn't implement this function!");s
        callback();
    }

    var formData = new FormData();
    var files = input[0].files;
    formData.append('files', files[0], files[0].name);

    ajax('POST', path, formData, callback);
}


    /* apply button */

function showApply() {
    var applyButton = $('#applyButton');
    
    applyButton.html('Apply');
    applyButton.css('display', 'inline-block');
    applyButton.removeClass('progress');
    setTimeout(function () {
        applyButton.css('opacity', '1');
    }, 10);
}

function hideApply() {
    var applyButton = $('#applyButton');
    
    applyButton.css('opacity', '0');
    applyButton.removeClass('progress');
    
    setTimeout(function () {
        applyButton.css('display', 'none');
    }, 500);
}

function isApplyVisible() {
    var applyButton = $('#applyButton');
    
    return applyButton.is(':visible');
}

function doApply() {
    if (!configUiValid()) {
        runAlertDialog('Make sure all the configuration options are valid!');
        return;
    }
    
    function actualApply() {
        /* gather the affected motion instances */
        var affectedInstances = {};
        Object.keys(pushConfigs).forEach(function (key) {
            var config = pushConfigs[key];
            if (key === 'main') {
                return;
            }
            
            var instance;
            if (config.proto == 'netcam' || config.proto == 'v4l2') {
                instance = '';
            }
            else if (config.proto == 'motioneye') { /* motioneye */
                instance = config.host || '';
                if (config.port) {
                    instance += ':' + config.port;
                }
            }
            
            affectedInstances[instance] = true;
        });
        affectedInstances = Object.keys(affectedInstances);
        
        /* compute the affected camera ids */ 
        var cameraIdsByInstance = getCameraIdsByInstance();
        var affectedCameraIds = [];
        
        affectedInstances.forEach(function (instance) {
            affectedCameraIds = affectedCameraIds.concat(cameraIdsByInstance[instance] || []);
        });
        
        beginProgress(affectedCameraIds);
        affectedCameraIds.forEach(function (cameraId) {
            refreshDisabled[cameraId] |= 0;
            refreshDisabled[cameraId]++;
        });
        
        ajax('POST', basePath + 'config/0/set/', pushConfigs, function (data) {
            affectedCameraIds.forEach(function (cameraId) {
                refreshDisabled[cameraId]--;
            });
            
            if (data == null || data.error) {
                endProgress();
                showErrorMessage(data && data.error);
                return;
            }
            
            if (data.reboot) {
                var count = 0;
                function checkServerReboot() {
                    ajax('GET', basePath + 'config/0/get/', null, 
                        function () {
                            window.location.reload(true);
                        },
                        function () {
                            if (count < 25) {
                                count += 1;
                                setTimeout(checkServerReboot, 2000);
                            }
                            else {
                                window.location.reload(true);
                            }
                        }
                    );
                }
                
                setTimeout(checkServerReboot, 15000);
                
                return;
            }
            
            if (data.reload) {
                window.location.reload(true);
                return;
            }
            
            /* update the camera name in the device select
             * and frame title bar */
            Object.keys(pushConfigs).forEach(function (key) {
                var config = pushConfigs[key];
                if (config.key !== 'main') {
                    $('#cameraSelect').find('option[value=' + key + ']').html(config.name);
                }
                
                $('#camera' + key).find('span.camera-name').html(config.name);
            });
    
            pushConfigs = {};
            pushConfigReboot = false;
            endProgress();
            recreateCameraFrames(); /* a camera could have been disabled */
        });
    }
    
    if (pushConfigReboot) {
        runConfirmDialog('This will reboot the system. Continue?', function () {
            actualApply();
        });
    }
    else {
        actualApply();
    }
}

function doShutDown() {
    runConfirmDialog('Really shut down?', function () {
        ajax('POST', basePath + 'power/shutdown/');
        setTimeout(function () {
            refreshInterval = 1000000;
            showModalDialog('<div class="modal-progress"></div>');
            
            function checkServer() {
                ajax('GET', basePath, null, 
                    function () {
                        setTimeout(checkServer, 1000);
                    },
                    function () {
                        showModalDialog('Powered Off');
                        setTimeout(function () {
                            $('div.modal-glass').animate({'opacity': '1', 'background-color': '#212121'}, 200);
                        },100);
                    },
                    10000 /* timeout = 10s */
                );
            }
            
            checkServer();
        }, 10);
    });
}

function doReboot() {
    runConfirmDialog('Really reboot?', function () {
        ajax('POST', basePath + 'power/reboot/');
        setTimeout(function () {
            refreshInterval = 1000000;
            showModalDialog('<div class="modal-progress"></div>');
            var shutDown = false;
            
            function checkServer() {
                ajax('GET', basePath, null, 
                    function () {
                        if (!shutDown) {
                            setTimeout(checkServer, 1000);
                        }
                        else {
                            runAlertDialog('The system has been rebooted!', function () {
                                window.location.reload(true);
                            });
                        }
                    },
                    function () {
                        shutDown = true; /* the first error indicates the system was shut down */
                        setTimeout(checkServer, 1000);
                    },
                    5 * 1000 /* timeout = 5s */
                );
            }
            
            checkServer();
        }, 10);
    });
}

function doRemCamera() {
    if (Object.keys(pushConfigs).length) {
        return runAlertDialog('Please apply the modified settings first!');
    }
    
    var cameraId = $('#cameraSelect').val();
    if (cameraId == null || cameraId === 'add') {
        runAlertDialog('No camera to remove!');
        return;
    }

    var deviceName = $('#cameraSelect').find('option[value=' + cameraId + ']').text();
    
    runConfirmDialog('Remove camera ' + deviceName + '?', function () {
        /* disable further refreshing of this camera */
        var img = $('div.camera-frame#camera' + cameraId).find('img.camera');
        if (img.length) {
            img[0].loading = 1;
        }

        beginProgress();
        ajax('POST', basePath + 'config/' + cameraId + '/rem/', null, function (data) {
            if (data == null || data.error) {
                endProgress();
                showErrorMessage(data && data.error);
                return;
            }
            
            fetchCurrentConfig(endProgress);
        });
    });
}

function doUpdate() {
    if (Object.keys(pushConfigs).length) {
        return runAlertDialog('Please apply the modified settings first!');
    }
    
    showModalDialog('<div class="modal-progress"></div>');
    ajax('GET', basePath + 'update/', null, function (data) {
        if (data.update_version == null) {
            runAlertDialog('motionEye is up to date (current version: ' + data.current_version + ')');
        }
        else {
            runConfirmDialog('New version available: ' + data.update_version + '. Update?', function () {
                refreshInterval = 1000000;
                showModalDialog('<div style="text-align: center;"><span>Updating. This may take a few minutes.</span><div class="modal-progress"></div></div>');
                ajax('POST', basePath + 'update/?version=' + data.update_version, null, function () {
                    var count = 0;
                    function checkServer() {
                        ajax('GET', basePath + 'config/0/get/', null,
                            function () {
                                runAlertDialog('motionEye was successfully updated!', function () {
                                    window.location.reload(true);
                                });
                            },
                            function () {
                                if (count < 60) {
                                    count += 1;
                                    setTimeout(checkServer, 5000);
                                }
                                else {
                                    runAlertDialog('Update failed!', function () {
                                        window.location.reload(true);
                                    });
                                }
                            }
                        );
                    }
                    
                    setTimeout(checkServer, 10000);

                }, function (e) { /* error */
                    runAlertDialog('The update process has failed!', function () {
                        window.location.reload(true);
                    });
                });

                return false; /* prevents hiding the modal container */
            });
        }
    });
}

function doBackup() {
    downloadFile('config/backup/');
}

function doRestore() {
    var content = 
            $('<table class="restore-dialog">' +
                '<tr>' +
                    '<td class="dialog-item-label"><span class="dialog-item-label">Backup File</span></td>' +
                    '<td class="dialog-item-value"><form><input type="file" class="styled" id="fileInput"></form></td>' +
                    '<td><span class="help-mark" title="the backup file you have previously downloaded">?</span></td>' +
                '</tr>' +
            '</table>');
    
    /* collect ui widgets */
    var fileInput = content.find('#fileInput');
    
    /* make validators */
    makeFileValidator(fileInput, true);
    
    function uiValid() {
        /* re-validate all the validators */
        content.find('.validator').each(function () {
            this.validate();
        });
        
        var valid = true;
        var query = content.find('input, select');
        query.each(function () {
            if (this.invalid) {
                valid = false;
                return false;
            }
        });

        return valid;
    }

    runModalDialog({
        title: 'Restore Configuration',
        closeButton: true,
        buttons: 'okcancel',
        content: content,
        onOk: function () {
            if (!uiValid(true)) {
                return false;
            }
            
            refreshInterval = 1000000;

            setTimeout(function () {
                showModalDialog('<div style="text-align: center;"><span>Restoring configuration...</span><div class="modal-progress"></div></div>');
                uploadFile(basePath + 'config/restore/', fileInput, function (data) {
                    if (data && data.ok) {
                        var count = 0;
                        function checkServer() {
                            ajax('GET', basePath + 'config/0/get/', null,
                                function () {
                                    runAlertDialog('The configuration has been restored!', function () {
                                        window.location.reload(true);
                                    });
                                },
                                function () {
                                    if (count < 25) {
                                        count += 1;
                                        setTimeout(checkServer, 2000);
                                    }
                                    else {
                                        runAlertDialog('Failed to restore the configuration!', function () {
                                            window.location.reload(true);
                                        });
                                    }
                                }
                            );
                        }
                        
                        if (data.reboot) {
                            setTimeout(checkServer, 10000);
                        }
                        else {
                            setTimeout(function () {
                                window.location.reload();
                            }, 5000);
                        }
                    }
                    else {
                        hideModalDialog();
                        showErrorMessage('Failed to restore the configuration!');
                    }
                });
            }, 10);
        }
    });
}

function doDownloadZipped(cameraId, groupKey) {
    showModalDialog('<div class="modal-progress"></div>', null, null, true);
    ajax('GET', basePath + 'picture/' + cameraId + '/zipped/' + groupKey + '/', null, function (data) {
        if (data.error) {
            hideModalDialog(); /* progress */
            showErrorMessage(data.error);
        }
        else {
            hideModalDialog(); /* progress */
            downloadFile('picture/' + cameraId + '/zipped/' + groupKey + '/?key=' + data.key);
        }
    });
}

function doDeleteFile(path, callback) {
    var url = window.location.href;
    var parts = url.split('/');
    url = parts.slice(0, 3).join('/') + path;
    
    runConfirmDialog('Really delete this file?', function () {
        showModalDialog('<div class="modal-progress"></div>', null, null, true);
        ajax('POST', url, null, function (data) {
            hideModalDialog(); /* progress */
            hideModalDialog(); /* confirm */
            
            if (data == null || data.error) {
                showErrorMessage(data && data.error);
                return;
            }

            if (callback) {
                callback();
            }
        });
        
        return false;
    }, {stack: true});
}

function doDeleteAllFiles(mediaType, cameraId, groupKey, callback) {
    runConfirmDialog('Really delete all ' + mediaType + 's in ' + groupKey + '?', function () {
        showModalDialog('<div class="modal-progress"></div>', null, null, true);
        ajax('POST', basePath + mediaType + '/' + cameraId + '/delete_all/' + groupKey + '/', null, function (data) {
            hideModalDialog(); /* progress */
            hideModalDialog(); /* confirm */
            
            if (data == null || data.error) {
                showErrorMessage(data && data.error);
                return;
            }

            if (callback) {
                callback();
            }
        });
        
        return false;
    }, {stack: true});
}


    /* fetch & push */

function fetchCurrentConfig(onFetch) {
    function fetchCameraList() {
        /* fetch the camera list */
        ajax('GET', basePath + 'config/list/', null, function (data) {
            if (data == null || data.error) {
                showErrorMessage(data && data.error);
                data = {cameras: []};
                if (onFetch) {
                    onFetch(null);
                }
            }
            
            initialConfigFetched = true;
            
            var i, cameras = data.cameras;
            
            if (isAdmin()) {
                var cameraSelect = $('#cameraSelect');
                cameraSelect.html('');
                for (i = 0; i < cameras.length; i++) {
                    var camera = cameras[i];
                    cameraSelect.append('<option value="' + camera['id'] + '">' + camera['name'] + '</option>');
                }
                cameraSelect.append('<option value="add">add camera...</option>');
                
                var enabledCameras = cameras.filter(function (camera) {return camera['enabled'];});
                if (enabledCameras.length > 0) { /* prefer the first enabled camera */
                    cameraSelect[0].selectedIndex = cameras.indexOf(enabledCameras[0]);
                    fetchCurrentCameraConfig(onFetch);
                }
                else if (cameras.length) { /* only disabled cameras */
                    cameraSelect[0].selectedIndex = 0;
                    fetchCurrentCameraConfig(onFetch);
                }
                else { /* no camera at all */
                    cameraSelect[0].selectedIndex = -1;

                    if (onFetch) {
                        onFetch(data);
                    }
                }

                updateConfigUi();
            }
            else { /* normal user */
                if (!cameras.length) {
                    /* normal user with no cameras doesn't make too much sense - force login */
                    doLogout();
                }

                if (onFetch) {
                    onFetch(data);
                }
            }

            var mainLoadingProgressImg = $('img.main-loading-progress');
            if (mainLoadingProgressImg.length) {
                mainLoadingProgressImg.animate({'opacity': 0}, 200, function () {
                    recreateCameraFrames(cameras);
                    mainLoadingProgressImg.remove();
                });
            }
            else {
                recreateCameraFrames(cameras);
            }
        });
    }
 
    /* add a progress indicator */
    $('div.page-container').append('<img class="main-loading-progress" src="' + staticPath + 'img/main-loading-progress.gif">');

    if (isAdmin()) {
        /* fetch the main configuration */
        ajax('GET', basePath + 'config/main/get/', null, function (data) {
            if (data == null || data.error) {
                showErrorMessage(data && data.error);
                return;
            }
            
            dict2MainUi(data);
            fetchCameraList();
        });
    }
    else {
        fetchCameraList();
    }
}

function fetchCurrentCameraConfig(onFetch) {
    var cameraId = $('#cameraSelect').val();
    if (cameraId != null) {
        ajax('GET', basePath + 'config/' + cameraId + '/get/?force=true', null, function (data) {
            if (data == null || data.error) {
                showErrorMessage(data && data.error);
                dict2CameraUi(null);
                if (onFetch) {
                    onFetch(null);
                }
                
                return;
            }
            
            dict2CameraUi(data);
            if (onFetch) {
                onFetch(data);
            }
        });
    }
    else {
        dict2CameraUi({});
        if (onFetch) {
            onFetch({});
        }
    }
}

function pushMainConfig(reboot) {
    if (!initialConfigFetched) {
        return;
    }
    
    var mainConfig = mainUi2Dict();
    
    pushConfigReboot = pushConfigReboot || reboot;
    pushConfigs['main'] = mainConfig;
    if (!isApplyVisible()) {
        showApply();
    }
}

function pushCameraConfig(reboot) {
    if (!initialConfigFetched) {
        return;
    }
    
    var cameraId = $('#cameraSelect').val();
    if (!cameraId) {
        return; /* event triggered without a selected camera */
    }

    var cameraConfig = cameraUi2Dict();

    pushConfigReboot = pushConfigReboot || reboot;
    pushConfigs[cameraId] = cameraConfig;
    if (!isApplyVisible()) {
        showApply();
    }
    
    /* also update the config stored in the camera frame div */
    var cameraFrame = $('div.camera-frame#camera' + cameraId);
    if (cameraFrame.length) {
        Object.update(cameraFrame[0].config, cameraConfig);
    }
}

function pushPreview(control) {
    var cameraId = $('#cameraSelect').val();
    
    var brightness = $('#brightnessSlider').val();
    var contrast= $('#contrastSlider').val();
    var saturation = $('#saturationSlider').val();
    var hue = $('#hueSlider').val();
    
    var data = {};
    
    if (brightness !== '' && (!control || control == 'brightness')) {
        data.brightness = brightness;
    }
    
    if (contrast !== '' && (!control || control == 'contrast')) {
        data.contrast = contrast;
    }
    
    if (saturation !== '' && (!control || control == 'saturation')) {
        data.saturation = saturation;
    }
    
    if (hue !== '' && (!control || control == 'hue')) {
        data.hue = hue;
    }
    
    refreshDisabled[cameraId] |= 0;
    refreshDisabled[cameraId]++;
    
    ajax('POST', basePath + 'config/' + cameraId + '/set_preview/', data, function (data) {
        refreshDisabled[cameraId]--;
        
        if (data == null || data.error) {
            showErrorMessage(data && data.error);
            return;
        }
    });
}

function getCameraIdsByInstance() {
    /* a motion instance is identified by the (host, port) pair;
     * the local instance has both the host and the port set to empty string */
    
    var cameraIdsByInstance = {};
    $('div.camera-frame').each(function () {
        var instance;
        if (this.config.proto == 'netcam' || this.config.proto == 'v4l2') {
            instance = '';
        }
        else if (this.config.proto == 'motioneye') {
            instance = this.config.host || '';
            if (this.config.port) {
                instance += ':' + this.config.port;
            }
        }
        else { /* assuming simple mjpeg camera */
            return;
        }
        
        (cameraIdsByInstance[instance] = cameraIdsByInstance[instance] || []).push(this.config.id);
    });
    
    return cameraIdsByInstance;
}


    /* dialogs */

function runAlertDialog(message, onOk, options) {
    var params = {
        title: message,
        buttons: 'ok',
        onOk: onOk
    };
    
    if (options) {
        Object.update(params, options);
    }
    
    runModalDialog(params);
}

function runConfirmDialog(message, onYes, options) {
    var params = {
        title: message,
        buttons: 'yesno',
        onYes: onYes
    };
    
    if (options) {
        Object.update(params, options);
    }
    
    runModalDialog(params);
}

function runLoginDialog(retry) {
    /* a workaround so that browsers will remember the credentials */
    var tempFrame = $('<iframe name="temp" id="temp" style="display: none;"></iframe>');
    $('body').append(tempFrame);
    
    var form = 
            $('<form action="' + basePath + 'login/" target="temp" method="POST"><table class="login-dialog">' +
                '<tr>' +
                    '<td class="login-dialog-error" colspan="100"></td>' +
                '</tr>' +
                '<tr>' +
                    '<td class="dialog-item-label"><span class="dialog-item-label">Username</span></td>' +
                    '<td class="dialog-item-value"><input type="text" name="username" class="styled" id="usernameEntry"></td>' +
                '</tr>' +
                '<tr>' +
                    '<td class="dialog-item-label"><span class="dialog-item-label">Password</span></td>' +
                    '<td class="dialog-item-value"><input type="password" name="password" class="styled" id="passwordEntry"></td>' +
                    '<input type="submit" style="display: none;" name="login" value="login">' +
                '</tr>' +
            '</table></form>');

    var usernameEntry = form.find('#usernameEntry');
    var passwordEntry = form.find('#passwordEntry');
    var errorTd = form.find('td.login-dialog-error');
    
    if (window._loginRetry) {
        errorTd.css('display', 'table-cell');
        errorTd.html('Invalid credentials.');
    }

    var params = {
        title: 'Login',
        content: form,
        buttons: [
            {caption: 'Cancel', isCancel: true, click: function () {
                tempFrame.remove();
            }},
            {caption: 'Login', isDefault: true, click: function () {
                window.username = usernameEntry.val();
                window.password = passwordEntry.val();
                window._loginDialogSubmitted = true;
                
                setCookie('username', window.username);
                
                form.submit();
                setTimeout(function () {
                    tempFrame.remove();
                }, 5000);
                
                if (retry) {
                    retry();
                }
            }}
        ],
    };
    
    runModalDialog(params);
}

function runPictureDialog(entries, pos, mediaType) {
    var content = $('<div class="picture-dialog-content"></div>');
    
    var img = $('<img class="picture-dialog-content">');
    content.append(img);
    
    var prevArrow = $('<div class="picture-dialog-prev-arrow button mouse-effect" title="previous picture"></div>');
    content.append(prevArrow);
    
    var nextArrow = $('<div class="picture-dialog-next-arrow button mouse-effect" title="next picture"></div>');
    content.append(nextArrow);
    
    var progressImg = $('<img class="picture-dialog-progress" src="' + staticPath + 'img/modal-progress.gif">');
    
    function updatePicture() {
        var entry = entries[pos];

        var windowWidth = $(window).width();
        var windowHeight = $(window).height();
        var widthCoef = windowWidth < 1000 ? 0.8 : 0.5;
        var heightCoef = 0.75;
        
        var width = parseInt(windowWidth * widthCoef);
        var height = parseInt(windowHeight * heightCoef);        
        
        prevArrow.css('display', 'none');
        nextArrow.css('display', 'none');
        img.parent().append(progressImg);
        updateModalDialogPosition();
        progressImg.css('left', (img.parent().width() - progressImg.width()) / 2);
        progressImg.css('top', (img.parent().height() - progressImg.height()) / 2);
        
        img.attr('src', addAuthParams('GET', basePath + mediaType + '/' + entry.cameraId + '/preview' + entry.path));
        img.load(function () {
            var aspectRatio = this.naturalWidth / this.naturalHeight;
            var sizeWidth = width * width / aspectRatio;
            var sizeHeight = height * aspectRatio * height;
            
            if (sizeWidth < sizeHeight) {
                img.width(width);
            }
            else {
                img.height(height);
            }
            updateModalDialogPosition();
            prevArrow.css('display', pos > 0 ? '' : 'none');
            nextArrow.css('display', pos < entries.length - 1 ? '' : 'none');
            progressImg.remove();
        });
        
        $('div.modal-container').find('span.modal-title:last').html(entry.name);
        updateModalDialogPosition();
    }
    
    prevArrow.click(function () {
        if (pos > 0) {
            pos--;
        }
        
        updatePicture();
    });
    
    nextArrow.click(function () {
        if (pos < entries.length - 1) {
            pos++;
        }
        
        updatePicture();
    });
    
    function bodyKeyDown(e) {
        switch (e.which) {
            case 37:
                if (prevArrow.is(':visible')) {
                    prevArrow.click();
                }
                break;
                
            case 39:
                if (nextArrow.is(':visible')) {
                    nextArrow.click();
                }
                break;
        }
    }
    
    $('body').on('keydown', bodyKeyDown);
    
    img.load(updateModalDialogPosition);
    
    runModalDialog({
        title: ' ',
        closeButton: true,
        buttons: [
            {caption: 'Close'},
            {caption: 'Download', isDefault: true, click: function () {
                var entry = entries[pos];
                downloadFile(mediaType + '/' + entry.cameraId + '/download' + entry.path);
                
                return false;
            }}
        ],
        content: content,
        stack: true,
        onShow: updatePicture,
        onClose: function () {
            $('body').off('keydown', bodyKeyDown);
        }
    });
}

function runAddCameraDialog() {
    if (!$('#motionEyeSwitch')[0].checked) {
        return runAlertDialog('Please enable motionEye first!');
    }
    
    if (Object.keys(pushConfigs).length) {
        return runAlertDialog('Please apply the modified settings first!');
    }
    
    var content = 
            $('<table class="add-camera-dialog">' +
                '<tr>' +
                    '<td class="dialog-item-label"><span class="dialog-item-label">Camera Type</span></td>' +
                    '<td class="dialog-item-value"><select class="styled" id="typeSelect">' +
                        (hasLocalCamSupport ? '<option value="v4l2">Local Camera</option>' : '') +
                        (hasNetCamSupport ? '<option value="netcam">Network Camera</option>' : '') +
                        '<option value="motioneye">Remote motionEye Camera</option>' +
                        '<option value="mjpeg">Simple MJPEG Camera</option>' +
                    '</select></td>' +
                    '<td><span class="help-mark" title="the type of camera you wish to add">?</span></td>' +
                '</tr>' +
                '<tr class="motioneye netcam mjpeg">' +
                    '<td class="dialog-item-label"><span class="dialog-item-label">URL</span></td>' +
                    '<td class="dialog-item-value"><input type="text" class="styled" id="urlEntry" placeholder="http://example.com:8080/cams/..."></td>' +
                    '<td><span class="help-mark" title="the camera URL (e.g. http://example.com:8080/cam/)">?</span></td>' +
                '</tr>' +
                '<tr class="motioneye netcam mjpeg">' +
                    '<td class="dialog-item-label"><span class="dialog-item-label">Username</span></td>' +
                    '<td class="dialog-item-value"><input type="text" class="styled" id="usernameEntry" placeholder="username..."></td>' +
                    '<td><span class="help-mark" title="the username for the URL, if required (e.g. admin)">?</span></td>' +
                '</tr>' +
                '<tr class="motioneye netcam mjpeg">' +
                    '<td class="dialog-item-label"><span class="dialog-item-label">Password</span></td>' +
                    '<td class="dialog-item-value"><input type="password" class="styled" id="passwordEntry" placeholder="password..."></td>' +
                    '<td><span class="help-mark" title="the password for the URL, if required">?</span></td>' +
                '</tr>' +
                '<tr class="v4l2 motioneye netcam mjpeg">' +
                    '<td class="dialog-item-label"><span class="dialog-item-label">Camera</span></td>' +
                    '<td class="dialog-item-value"><select class="styled" id="addCameraSelect"></select><span id="cameraMsgLabel"></span></td>' +
                    '<td><span class="help-mark" title="the camera you wish to add">?</span></td>' +
                '</tr>' +
                '<tr class="v4l2 motioneye netcam mjpeg">' +
                    '<td colspan="100"><div class="dialog-item-separator"></div></td>' +
                '</tr>' +
                '<tr class="v4l2 motioneye netcam mjpeg">' +
                    '<td class="dialog-item-value" colspan="100"><div id="addCameraInfo"></div></td>' +
                '</tr>' +
            '</table>');
    
    /* collect ui widgets */
    var typeSelect = content.find('#typeSelect');
    var urlEntry = content.find('#urlEntry');
    var usernameEntry = content.find('#usernameEntry');
    var passwordEntry = content.find('#passwordEntry');
    var addCameraSelect = content.find('#addCameraSelect');
    var addCameraInfo = content.find('#addCameraInfo');
    var cameraMsgLabel = content.find('#cameraMsgLabel');
    
    /* make validators */
    makeUrlValidator(urlEntry, true);
    makeTextValidator(usernameEntry, false);
    makeTextValidator(typeSelect, false);
    makeComboValidator(addCameraSelect, true);
    
    /* ui interaction */
    function updateUi() {
        content.find('tr.v4l2, tr.motioneye, tr.netcam, tr.mjpeg').css('display', 'none');

        if (typeSelect.val() == 'motioneye') {
            content.find('tr.motioneye').css('display', 'table-row');
            usernameEntry.val('admin');
            usernameEntry.attr('readonly', 'readonly');
            addCameraInfo.html(
                    'Remote motionEye cameras are cameras installed behind another motionEye server. ' +
                    'Adding them here will allow you to view and manage them remotely.');
        }
        else if (typeSelect.val() == 'netcam') {
            usernameEntry.removeAttr('readonly');
            
            /* make sure there is one trailing slash
             * so that a path can be detected */
            var url = urlEntry.val().trim();
            var m = url.match(new RegExp('/', 'g'));
            if (m && m.length < 3 && !url.endsWith('/')) {
                urlEntry.val(url + '/');
            }

            content.find('tr.netcam').css('display', 'table-row');
            addCameraInfo.html(
                    'Network cameras (or IP cameras) are devices that natively stream RTSP or MJPEG videos or plain JPEG images. ' +
                    "Consult your device's manual to find out the correct RTSP, MJPEG or JPEG URL.");
        }
        else if (typeSelect.val() == 'mjpeg') {
            usernameEntry.removeAttr('readonly');
            
            /* make sure there is one trailing slash
             * so that a path can be detected */
            var url = urlEntry.val().trim();
            var m = url.match(new RegExp('/', 'g'));
            if (m && m.length < 3 && !url.endsWith('/')) {
                urlEntry.val(url + '/');
            }

            content.find('tr.mjpeg').css('display', 'table-row');
            addCameraInfo.html(
                    'Adding your device as a simple MJPEG camera instead of as a network camera will improve the framerate, ' +
                    'but no motion detection, picture capturing or movie recording will be available for it. ' +
                    'The camera must be accessible to both your server and your browser. ' +
                    'This type of camera is not compatible with Internet Explorer.');
        }
        else { /* assuming v4l2 */
            content.find('tr.v4l2').css('display', 'table-row');
            addCameraInfo.html(
                    'Local cameras are camera devices that are connected directly to your motionEye system. ' +
                    'These are usually USB webcams or board-specific cameras.');
        }
        
        updateModalDialogPosition();
        
        /* re-validate all the validators */
        content.find('.validator').each(function () {
            this.validate();
        });
        
        if (uiValid()) {
            listCameras();
        }
    }
    
    function uiValid(includeCameraSelect) {
        var query = content.find('input, select');
        if (!includeCameraSelect) {
            query = query.not('#addCameraSelect');
        }
        else {
            if (cameraMsgLabel.html() || !addCameraSelect.val()) {
                return false;
            }
        }

        /* re-validate all the validators */
        content.find('.validator').each(function () {
            this.validate();
        });
        
        var valid = true;
        query.each(function () {
            if (this.invalid) {
                valid = false;
                return false;
            }
        });
        
        return valid;
    }
    
    function splitCameraUrl(url) {
        var parts = url.split('://');
        var scheme = parts[0];
        var index = parts[1].indexOf('/');
        var host = null;
        var path = '';
        if (index >= 0) {
            host = parts[1].substring(0, index);
            path = parts[1].substring(index);
        }
        else {
            host = parts[1];
        }
        
        var port = '';
        parts = host.split(':');
        if (parts.length >= 2) {
            host = parts[0];
            port = parts[1];
        }
        
        if (path == '') {
            path = '/';
        }
        
        return {
            scheme: scheme,
            host: host,
            port: port,
            path: path
        };
    }
    
    function listCameras() {
        var progress = $('<div style="text-align: center; margin: 2px;"><img src="' + staticPath + 'img/small-progress.gif"></div>');
        
        addCameraSelect.html('');
        addCameraSelect.hide();
        addCameraSelect.parent().find('div').remove(); /* remove any previous progress div */
        addCameraSelect.before(progress);
        
        var data = {};
        if (urlEntry.is(':visible') && urlEntry.val()) {
            data = splitCameraUrl(urlEntry.val());
        }
        data.username = usernameEntry.val();
        data.password = passwordEntry.val();
        data.proto = typeSelect.val();
        
        cameraMsgLabel.html('');
        
        ajax('GET', basePath + 'config/list/', data, function (data) {
            progress.remove();
            
            if (data == null || data.error) {
                cameraMsgLabel.html(data && data.error);
                
                return;
            }
            
            if (data.error || !data.cameras) {
                return;
            }

            data.cameras.forEach(function (info) {
                var option = $('<option value="' + info.id + '">' + info.name + '</option>');
                option[0]._extra_attrs = {};
                Object.keys(info).forEach(function (key) {
                    if (key == 'id' || key == 'name') {
                        return;
                    }
                    
                    var value = info[key];
                    option[0]._extra_attrs[key] = value;
                });

                addCameraSelect.append(option);
            });
            
            if (!data.cameras || !data.cameras.length) {
                addCameraSelect.append('<option value="">(no cameras)</option>');
            }
            
            addCameraSelect.show();
            addCameraSelect[0].validate();
        });
    }
    
    typeSelect.change(function () {
        addCameraSelect.html('');
    });
    
    typeSelect.change(updateUi);
    urlEntry.change(updateUi);
    usernameEntry.change(updateUi);
    passwordEntry.change(updateUi);

    runModalDialog({
        title: 'Add Camera...',
        closeButton: true,
        buttons: 'okcancel',
        content: content,
        onOk: function () {
            if (!uiValid(true)) {
                return false;
            }

            var data = {};
            
            if (typeSelect.val() == 'motioneye') {
                data = splitCameraUrl(urlEntry.val());
                data.proto = 'motioneye';
                data.username = usernameEntry.val();
                data.password = passwordEntry.val();
                data.remote_camera_id = addCameraSelect.val();
            }
            else if (typeSelect.val() == 'netcam') {
                data = splitCameraUrl(urlEntry.val());
                data.username = usernameEntry.val();
                data.password = passwordEntry.val();
                data.proto = 'netcam';
                data.camera_index = addCameraSelect.val();
            }
            else if (typeSelect.val() == 'mjpeg') {
                data = splitCameraUrl(urlEntry.val());
                data.username = usernameEntry.val();
                data.password = passwordEntry.val();
                data.proto = 'mjpeg';
            }
            else { /* assuming v4l2 */
                data.proto = 'v4l2';
                data.path = addCameraSelect.val();
            }
            
            /* add all extra attributes */
            var option = addCameraSelect.find('option:eq(' + addCameraSelect[0].selectedIndex + ')')[0];
            Object.keys(option._extra_attrs).forEach(function (key) {
                var value = option._extra_attrs[key];
                data[key] = value;
            });

            beginProgress();
            ajax('POST', basePath + 'config/add/', data, function (data) {
                endProgress();

                if (data == null || data.error) {
                    showErrorMessage(data && data.error);
                    return;
                }
                
                var cameraOption = $('#cameraSelect').find('option[value=add]');
                cameraOption.before('<option value="' + data.id + '">' + data.name + '</option>');
                $('#cameraSelect').val(data.id).change();
                recreateCameraFrames();
            });
        }
    });

    updateUi();
}

function runTimelapseDialog(cameraId, groupKey, group) {
    var content = 
            $('<table class="timelapse-dialog">' +
                '<tr><td colspan="2" class="timelapse-warning"></td></tr>' +
                '<tr>' +
                    '<td class="dialog-item-label"><span class="dialog-item-label">Group</span></td>' +
                    '<td class="dialog-item-value">' + groupKey + '</td>' +
                '</tr>' +
                '<tr>' +
                    '<td class="dialog-item-label"><span class="dialog-item-label">Include a picture taken every</span></td>' +
                    '<td class="dialog-item-value">' +
                        '<select class="styled timelapse" id="intervalSelect">' + 
                            '<option value="1">second</option>' +
                            '<option value="5">5 seconds</option>' +
                            '<option value="10">10 seconds</option>' +
                            '<option value="30">30 seconds</option>' +
                            '<option value="60">minute</option>' +
                            '<option value="300">5 minutes</option>' +
                            '<option value="600">10 minutes</option>' +
                            '<option value="1800">30 minutes</option>' +
                            '<option value="3600">hour</option>' +
                        '</select>' +
                    '</td>' +
                    '<td><span class="help-mark" title="choose the interval of time between two selected pictures">?</span></td>' +
                '</tr>' +
                '<tr>' +
                    '<td class="dialog-item-label"><span class="dialog-item-label">Movie framerate</span></td>' +
                    '<td class="dialog-item-value"><input type="text" class="styled range" id="framerateSlider"></td>' +
                    '<td><span class="help-mark" title="choose how fast you want the timelapse playback to be">?</span></td>' +
                '</tr>' +
            '</table>');

    var intervalSelect = content.find('#intervalSelect');
    var framerateSlider = content.find('#framerateSlider');
    var timelapseWarning = content.find('td.timelapse-warning');
    
    if (group.length > 1440) { /* one day worth of pictures, taken 1 minute apart */
        timelapseWarning.html('Given the large number of pictures, creating your timelapse might take a while!');
        timelapseWarning.css('display', 'table-cell');
    }
    
    makeSlider(framerateSlider, 1, 100, 0, [
        {value: 1, label: '1'},
        {value: 20, label: '20'},
        {value: 40, label: '40'},
        {value: 60, label: '60'},
        {value: 80, label: '80'},
        {value: 100, label: '100'}
    ], null, 0);
    
    intervalSelect.val(60);
    framerateSlider.val(20).each(function () {this.update()});

    runModalDialog({
        title: 'Create Timelapse Movie',
        closeButton: true,
        buttons: 'okcancel',
        content: content,
        onOk: function () {
            var progressBar = $('<div style=""></div>');
            makeProgressBar(progressBar);
            
            runModalDialog({
                title: 'Creating Timelapse Movie...',
                content: progressBar,
                stack: true,
                noKeys: true
            });
            
            var url = basePath + 'picture/' + cameraId + '/timelapse/' + groupKey + '/';
            var data = {interval: intervalSelect.val(), framerate: framerateSlider.val()};
            var first = true;
            
            function checkTimelapse() {
                var actualUrl = url;
                if (!first) {
                    actualUrl += '?check=true';
                }

                ajax('GET', actualUrl, data, function (data) {
                    if (data == null || data.error) {
                        hideModalDialog(); /* progress */
                        hideModalDialog(); /* timelapse dialog */
                        showErrorMessage(data && data.error);
                        return;
                    }
                    
                    if (data.progress != -1 && first) {
                        showPopupMessage('A timelapse movie is already being created.');
                    }
                    
                    if (data.progress == -1 && !first && !data.key) {
                        hideModalDialog(); /* progress */
                        hideModalDialog(); /* timelapse dialog */
                        showErrorMessage('The timelapse movie could not be created.');
                        return;
                    }
                    
                    if (data.progress == -1) {
                        data.progress = 0;
                    }

                    if (data.key) {
                        progressBar[0].setProgress(100);
                        progressBar[0].setText('100%');
                        
                        setTimeout(function () {
                            hideModalDialog(); /* progress */
                            hideModalDialog(); /* timelapse dialog */
                            downloadFile('picture/' + cameraId + '/timelapse/' + groupKey + '/?key=' + data.key);
                        }, 500);
                    }
                    else {
                        progressBar[0].setProgress(data.progress * 100);
                        progressBar[0].setText(parseInt(data.progress * 100) + '%');
                        setTimeout(checkTimelapse, 1000);
                    }

                    first = false;
                });
            }
            
            checkTimelapse();

            return false;
        },
        stack: true
    });
}

function runMediaDialog(cameraId, mediaType) {
    var dialogDiv = $('<div class="media-dialog"></div>');
    var mediaListDiv = $('<div class="media-dialog-list"></div>');
    var groupsDiv = $('<div class="media-dialog-groups"></div>');
    var buttonsDiv = $('<div class="media-dialog-buttons"></div>');
    
    var groups = {};
    var groupKey = null;
    
    dialogDiv.append(groupsDiv);
    dialogDiv.append(mediaListDiv);
    dialogDiv.append(buttonsDiv);
    
    /* add a temporary div to compute 3em in px */
    var tempDiv = $('<div style="width: 3em; height: 3em;"></div>');
    $('div.modal-container').append(tempDiv);
    var height = tempDiv.height();
    tempDiv.remove();

    function showGroup(key) {
        groupKey = key;
        
        if (mediaListDiv.find('img.media-list-progress').length) {
            return; /* already in progress of loading */
        }
        
        /* (re)set the current state of the group buttons */
        groupsDiv.find('div.media-dialog-group-button').each(function () {
            var $this = $(this);
            if (this.key == key) {
                $this.addClass('current');
            }
            else {
                $this.removeClass('current');
            }
        });
        
        var mediaListByName = {};
        var entries = groups[key];
        
        /* cleanup the media list */
        mediaListDiv.children('div.media-list-entry').detach();
        mediaListDiv.html('');
        
        function addEntries() {
            /* add the entries to the media list */
            entries.forEach(function (entry, i) {
                var entryDiv = entry.div;
                var detailsDiv = null;
                
                if (!entryDiv) {
                    entryDiv = $('<div class="media-list-entry"></div>');
                    
                    var previewImg = $('<img class="media-list-preview" src="' + staticPath + 'img/modal-progress.gif"/>');
                    entryDiv.append(previewImg);
                    previewImg[0]._src = addAuthParams('GET', basePath + mediaType + '/' + cameraId + '/preview' + entry.path + '?height=' + height);
                    
                    var downloadButton = $('<div class="media-list-download-button button">Download</div>');
                    entryDiv.append(downloadButton);
                    
                    var deleteButton = $('<div class="media-list-delete-button button">Delete</div>');
                    if (isAdmin()) {
                        entryDiv.append(deleteButton);
                    }

                    var nameDiv = $('<div class="media-list-entry-name">' + entry.name + '</div>');
                    entryDiv.append(nameDiv);
                    
                    detailsDiv = $('<div class="media-list-entry-details"></div>');
                    entryDiv.append(detailsDiv);
                    
                    downloadButton.click(function () {
                        downloadFile(mediaType + '/' + cameraId + '/download' + entry.path);
                        return false;
                    });
                    
                    deleteButton.click(function () {
                        doDeleteFile(basePath + mediaType + '/' + cameraId + '/delete' + entry.path, function () {
                            entryDiv.remove();
                            entries.splice(i, 1); /* remove entry from group */

                            /* update text on group button */
                            groupsDiv.find('div.media-dialog-group-button').each(function () {
                                var $this = $(this);
                                if (this.key == groupKey) {
                                    var text = this.innerHTML;
                                    text = text.substring(0, text.lastIndexOf(' '));
                                    text += ' (' + entries.length + ')';
                                    this.innerHTML = text;
                                }
                            });
                        });
                        
                        return false;
                    });

                    entryDiv.click(function () {
                        var pos = entries.indexOf(entry);
                        runPictureDialog(entries, pos, mediaType);
                    });
                    
                    entry.div = entryDiv;
                }
                else {
                    detailsDiv = entry.div.find('div.media-list-entry-details');
                }                    
                
                var momentSpan = $('<span class="details-moment">' + entry.momentStr + ', </span>');
                var momentShortSpan = $('<span class="details-moment-short">' + entry.momentStrShort + '</span>');
                var sizeSpan = $('<span class="details-size">' + entry.sizeStr + '</span>');
                detailsDiv.empty();
                detailsDiv.append(momentSpan);
                detailsDiv.append(momentShortSpan);
                detailsDiv.append(sizeSpan);
                mediaListDiv.append(entryDiv);
            });

            /* trigger a scroll event */
            mediaListDiv.scroll();
        }
        
        /* if details are already fetched, simply add the entries and return */
        if (entries[0].timestamp) {
            return addEntries();
        }
        
        var previewImg = $('<img class="media-list-progress" src="' + staticPath + 'img/modal-progress.gif"/>');
        mediaListDiv.append(previewImg);
        
        var url = basePath + mediaType + '/' + cameraId + '/list/?prefix=' + (key || 'ungrouped');
        ajax('GET', url, null, function (data) {
            previewImg.remove();
            
            if (data == null || data.error) {
                hideModalDialog();
                showErrorMessage(data && data.error);
                return;
            }
            
            /* index the media list by name */
            data.mediaList.forEach(function (media) {
                var path = media.path;
                var parts = path.split('/');
                var name = parts[parts.length - 1];
                
                mediaListByName[name] = media;
            });
            
            /* assign details to entries */
                entries.forEach(function (entry) {
                    var media = mediaListByName[entry.name];
                    if (media) {
                        entry.momentStr = media.momentStr;
                        entry.momentStrShort = media.momentStrShort;
                        entry.sizeStr = media.sizeStr;
                        entry.timestamp = media.timestamp;
                    }
                });
 
                /* sort the entries by timestamp */
            entries.sortKey(function (e) {return e.timestamp || e.name;}, true);
            
            addEntries();
        });
    }
    
    if (mediaType == 'picture') {
        var zippedButton = $('<div class="media-dialog-button">Zipped</div>');
        buttonsDiv.append(zippedButton);
        
        zippedButton.click(function () {
            if (groupKey != null) {
                doDownloadZipped(cameraId, groupKey);
            }
        });
        
        var timelapseButton = $('<div class="media-dialog-button">Timelapse</div>');
        buttonsDiv.append(timelapseButton);
        
        timelapseButton.click(function () {
            if (groupKey != null) {
                runTimelapseDialog(cameraId, groupKey, groups[groupKey]);
            }
        });
    }

    if (isAdmin()) {
        var deleteAllButton = $('<div class="media-dialog-button media-dialog-delete-all-button">Delete All</div>');
        buttonsDiv.append(deleteAllButton);
        
        deleteAllButton.click(function () {
            if (groupKey != null) {
                doDeleteAllFiles(mediaType, cameraId, groupKey, function () {
                    /* delete th group button */
                    groupsDiv.find('div.media-dialog-group-button').each(function () {
                        var $this = $(this);
                        if (this.key == groupKey) {
                            $this.remove();
                        }
                    });
                    
                    /* delete the group itself */
                    delete groups[groupKey];
                    
                    /* show the first existing group, if any */
                    var keys = Object.keys(groups);
                    if (keys.length) {
                        showGroup(keys[0]);
                    }
                    else {
                        hideModalDialog();
                    }
                });
            }
        });
    }
    
    function updateDialogSize() {
        var windowWidth = $(window).width();
        var windowHeight = $(window).height();
        
        if (Object.keys(groups).length == 0) {
            groupsDiv.width('auto');
            groupsDiv.height('auto');
            groupsDiv.addClass('small-screen');
            mediaListDiv.width('auto');
            mediaListDiv.height('auto');
            buttonsDiv.hide();

            return;
        }
        
        buttonsDiv.show();
        
        if (windowWidth < 1000) {
            mediaListDiv.width(parseInt(windowWidth * 0.8));
            mediaListDiv.height(parseInt(windowHeight * 0.7));
            groupsDiv.width(parseInt(windowWidth * 0.8));
            groupsDiv.height('');
            groupsDiv.addClass('small-screen');
        }
        else {
            mediaListDiv.width(parseInt(windowWidth * 0.7));
            mediaListDiv.height(parseInt(windowHeight * 0.7));
            groupsDiv.height(parseInt(windowHeight * 0.7));
            groupsDiv.width('');
            groupsDiv.removeClass('small-screen');
        }
    }
    
    function onResize() {
        updateDialogSize();
        updateModalDialogPosition();
    }
    
    $(window).resize(onResize);
    
    updateDialogSize();
    
    showModalDialog('<div class="modal-progress"></div>');
    
    /* fetch the media list */
    ajax('GET', basePath + mediaType + '/' + cameraId + '/list/', null, function (data) {
        if (data == null || data.error) {
            hideModalDialog();
            showErrorMessage(data && data.error);
            return;
        }
        
        /* group the media */
        data.mediaList.forEach(function (media) {
            var path = media.path;
            var parts = path.split('/');
            var keyParts = parts.splice(0, parts.length - 1);
            var key = keyParts.join('/');
            
            if (key.indexOf('/') === 0) {
                key = key.substring(1);
            }
            
            var list = (groups[key] = groups[key] || []);
            
            list.push({
                'path': path,
                'group': key,
                'name': parts[parts.length - 1],
                'cameraId': cameraId
            });
        });
        
        updateDialogSize();
        
        var keys = Object.keys(groups);
        keys.sort();
        keys.reverse();
        
        if (keys.length) {
            keys.forEach(function (key) {
                var groupButton = $('<div class="media-dialog-group-button"></div>');
                groupButton.text((key || '(ungrouped)') + ' (' + groups[key].length + ')');
                groupButton[0].key = key;
                
                groupButton.click(function () {
                    showGroup(key);
                });
                
                groupsDiv.append(groupButton);
            });
            
            /* add tooltips to larger group buttons */
            setTimeout(function () {
                groupsDiv.find('div.media-dialog-group-button').each(function () {
                    if (this.scrollWidth > this.offsetWidth) {
                        this.title = this.innerHTML;
                    }
                });
            }, 10);
        }
        else {
            groupsDiv.html('(no media files)');
            mediaListDiv.remove();
        }
        
        var title;
        if ($(window).width() < 1000) {
            title = data.cameraName;
        }
        else if (mediaType === 'picture') {
            title = 'Pictures taken by ' + data.cameraName;
        }
        else {
            title = 'Movies recorded by ' + data.cameraName;
        }
        
        runModalDialog({
            title: title,
            closeButton: true,
            buttons: '',
            content: dialogDiv,
            onShow: function () {
                //dialogDiv.scrollTop(dialogDiv.prop('scrollHeight'));
                if (keys.length) {
                    showGroup(keys[0]);
                }
            },
            onClose: function () {
                $(window).unbind('resize', onResize);
            }
        });
    });
    
    /* install the media list scroll event handler */
    mediaListDiv.scroll(function () {
        var height = mediaListDiv.height();
        
        mediaListDiv.find('img.media-list-preview').each(function () {
            if (!this._src) {
                return;
            }
            
            var $this = $(this);
            var entryDiv = $this.parent();
            
            var top1 = entryDiv.position().top;
            var top2 = top1 + entryDiv.height();
            
            if ((top1 >= 0 && top1 <= height) ||
                (top2 >= 0 && top2 <= height)) {
                
                this.src = this._src;
                delete this._src;
            }
        });
    });
}


    /* camera frames */

function addCameraFrameUi(cameraConfig) {
    var pageContainer = $('div.page-container');
    
    if (cameraConfig == null) {
        var cameraFrameDivPlaceHolder = $('<div class="camera-frame-place-holder"></div>');
        pageContainer.append(cameraFrameDivPlaceHolder);
        
        return;
    }
    
    var cameraId = cameraConfig.id;
    
    var cameraFrameDiv = $(
            '<div class="camera-frame">' +
                '<div class="camera-top-bar">' +
                    '<span class="camera-name"></span>' +
                    '<div class="camera-buttons">' +
                        '<div class="button camera-button mouse-effect full-screen" title="full-screen window"></div>' +
                        '<div class="button camera-button mouse-effect media-pictures" title="pictures"></div>' +
                        '<div class="button camera-button mouse-effect media-movies" title="movies"></div>' +
                        '<div class="button camera-button mouse-effect configure" title="configure"></div>' +
                    '</div>' +
                '</div>' +
                '<div class="camera-container">' +
                    '<div class="camera-placeholder"><img class="no-camera" src="' + staticPath + 'img/no-camera.svg"></div>' +
                    '<img class="camera">' +
                    '<div class="camera-progress"><img class="camera-progress"></div>' +
                '</div>' +
            '</div>');
    
    var nameSpan = cameraFrameDiv.find('span.camera-name');
    var configureButton = cameraFrameDiv.find('div.camera-button.configure');
    var picturesButton = cameraFrameDiv.find('div.camera-button.media-pictures');
    var moviesButton = cameraFrameDiv.find('div.camera-button.media-movies');
    var fullScreenButton = cameraFrameDiv.find('div.camera-button.full-screen');
    var cameraPlaceholder = cameraFrameDiv.find('div.camera-placeholder');
    var cameraProgress = cameraFrameDiv.find('div.camera-progress');
    var cameraImg = cameraFrameDiv.find('img.camera');
    var progressImg = cameraFrameDiv.find('img.camera-progress');
    
    /* no camera buttons if not admin */
    if (!isAdmin()) {
        configureButton.hide();
    }
    
    /* no media buttons for simple mjpeg cameras */
    if (cameraConfig['proto'] == 'mjpeg') {
        picturesButton.hide();
        moviesButton.hide();
    }
    
    cameraFrameDiv.attr('id', 'camera' + cameraId);
    cameraFrameDiv[0].refreshDivider = 0;
    cameraFrameDiv[0].config = cameraConfig;
    nameSpan.html(cameraConfig.name);
    progressImg.attr('src', staticPath + 'img/camera-progress.gif');
    
    cameraProgress.click(function () {
        doFullScreenCamera(cameraId);
    });
    
    cameraProgress.addClass('visible');
    cameraPlaceholder.css('opacity', '0');
    
    /* insert the new camera frame at the right position,
     * with respect to the camera id */
    var cameraFrames = pageContainer.find('div.camera-frame');
    var cameraIds = cameraFrames.map(function () {return parseInt(this.id.substring(6));});
    cameraIds.sort();
    
    var index = 0; /* find the first position that is greater than the current camera id */
    while (index < cameraIds.length && cameraIds[index] < cameraId) {
        index++;
    }
    
    if (index < cameraIds.length) {
        var beforeCameraFrame = pageContainer.find('div.camera-frame#camera' + cameraIds[index]);
        cameraFrameDiv.insertAfter(beforeCameraFrame);
    }
    else  {
        pageContainer.append(cameraFrameDiv);
    }

    /* fade in */
    cameraFrameDiv.animate({'opacity': 1}, 100);
    
    /* add the button handlers */
    configureButton.click(function () {
        doConfigureCamera(cameraId);
    });

    picturesButton.click(function (cameraId) {
        return function () {
            runMediaDialog(cameraId, 'picture');
        };
    }(cameraId));
    
    moviesButton.click(function (cameraId) {
        return function () {
            runMediaDialog(cameraId, 'movie');
        };
    }(cameraId));
    
    fullScreenButton.click(function (cameraId) {
        return function () {
            var path = basePath + 'picture/' + cameraId + '/frame/';
            window.open(path, '_blank');
        };
    }(cameraId));
    
    /* error and load handlers */
    cameraImg.error(function () {
        this.error = true;
        this.loading = 0;
        
        cameraImg.addClass('error').removeClass('loading');
        cameraImg.height(Math.round(cameraImg.width() * 0.75));
        cameraPlaceholder.css('opacity', 1);
        cameraProgress.removeClass('visible');
        cameraFrameDiv.removeClass('motion-detected');
    });
    cameraImg.load(function () {
        if (refreshDisabled[cameraId]) {
            return; /* refresh temporarily disabled for updating */
        }
        
        this.error = false;
        this.loading = 0;
        
        cameraImg.removeClass('error').removeClass('loading');
        cameraImg.css('height', '');
        cameraPlaceholder.css('opacity', 0);
        cameraProgress.removeClass('visible');
        
        /* there's no point in looking for a cookie update more often than once every second */
        var now = new Date().getTime();
        if ((!this.lastCookieTime || now - this.lastCookieTime > 1000) && (cameraFrameDiv[0].config['proto'] != 'mjpeg')) {
            if (getCookie('motion_detected_' + cameraId) == 'true') {
                cameraFrameDiv.addClass('motion-detected');
            }
            else {
                cameraFrameDiv.removeClass('motion-detected');
            }
            
            this.lastCookieTime = now;
        }

        if (fullScreenCameraId) {
            /* update the modal dialog position when image is loaded */
            updateModalDialogPosition();
        }
    });
    
    cameraImg.addClass('loading');
    cameraImg.height(Math.round(cameraImg.width() * 0.75));
}

function remCameraFrameUi(cameraId) {
    var pageContainer = $('div.page-container');
    var cameraFrameDiv = pageContainer.find('div.camera-frame#camera' + cameraId);
    cameraFrameDiv.animate({'opacity': 0}, 100, function () {
        cameraFrameDiv.remove();
    });
}

function recreateCameraFrames(cameras) {
    var pageContainer = $('div.page-container');
    
    function updateCameras(cameras) {
        cameras = cameras.filter(function (camera) {return camera.enabled;});
        var i, camera;

        /* remove everything on the page */
        pageContainer.children().remove();
        
        /* add camera frames */
        for (i = 0; i < cameras.length; i++) {
            camera = cameras[i];
            addCameraFrameUi(camera);
        }
        
        if ($('#cameraSelect').find('option').length < 2 && isAdmin() && $('#motionEyeSwitch')[0].checked) {
            /* invite the user to add a camera */
            var addCameraLink = $('<div class="add-camera-message">' + 
                    '<a href="javascript:runAddCameraDialog()">You have not configured any camera yet. Click here to add one...</a></div>');
            pageContainer.append(addCameraLink);
        }
    }
    
    if (cameras != null) {
        updateCameras(cameras);
    }
    else {
        ajax('GET', basePath + 'config/list/', null, function (data) {
            if (data == null || data.error) {
                showErrorMessage(data && data.error);
                return;
            }
            
            updateCameras(data.cameras);
        });
    }
    
    /* update settings panel */
    var cameraId = $('#cameraSelect').val();
    if (cameraId && cameraId != 'add') {
        openSettings(cameraId);
    }
}


function doConfigureCamera(cameraId) {
    if (inProgress) {
        return;
    }
    
    hideApply();
    pushConfigs = {};
    pushConfigReboot = false;
    
    openSettings(cameraId);
}

function doFullScreenCamera(cameraId) {
    if (inProgress || refreshDisabled[cameraId]) {
        return;
    }
    
    if (fullScreenCameraId != null) {
        return; /* a camera is already in full screen */
    }
    
    fullScreenCameraId = -1; /* avoids successive fast toggles of fullscreen */
    
    var cameraFrameDiv = $('#camera' + cameraId);
    var cameraName = cameraFrameDiv.find('span.camera-name').text();
    var frameImg = cameraFrameDiv.find('img.camera');
    var aspectRatio = frameImg.width() / frameImg.height();
    var windowWidth = $(window).width();
    var windowHeight = $(window).height();
    var windowAspectRatio = windowWidth / windowHeight;
    var frameIndex = cameraFrameDiv.index();
    var pageContainer = $('div.page-container');
    
    if (frameImg.hasClass('error')) {
        return; /* no full screen for erroneous cameras */
    }

    var width;
    if (windowAspectRatio > aspectRatio) {
        width = aspectRatio * Math.round(0.8 * windowHeight);
    }
    else {
        width = Math.round(0.9 * windowWidth);
    }

    cameraFrameDiv.find('div.camera-progress').addClass('visible');
    
    var cameraImg = cameraFrameDiv.find('img.camera');
    cameraImg.load(function showFullScreenCamera() {
        cameraFrameDiv.css('width', width);
        fullScreenCameraId = cameraId;
        
        runModalDialog({
            title: cameraName,
            closeButton: true,
            content: cameraFrameDiv,
            onShow: function () {
                cameraImg.unbind('load', showFullScreenCamera);
            },
            onClose: function () {
                fullScreenCameraId = null;
                cameraFrameDiv.css('width', '');
                var nextFrame = pageContainer.children('div:eq(' + frameIndex + ')');
                if (nextFrame.length) {
                    nextFrame.before(cameraFrameDiv);
                }
                else {
                    pageContainer.append(cameraFrameDiv);
                }
            }
        });
    });
    
    if (cameraFrameDiv[0].config['proto'] == 'mjpeg') {
        /* manually trigger the load event on simple mjpeg cameras */
        cameraImg.load();
    }
}

function refreshCameraFrames() {
    function refreshCameraFrame(cameraId, img, serverSideResize) {
        if (refreshDisabled[cameraId]) {
            /* camera refreshing disabled, retry later */
            
            return;
        }
        
        if (img.loading) {
            img.loading++; /* increases each time the camera would refresh but is still loading */
            
            if (img.loading > 2 * 1000 / refreshInterval) { /* limits the retries to one every two seconds */
                img.loading = 0;
            }
            else {
                return; /* wait for the previous frame to finish loading */
            }
        }
        
        var timestamp = new Date().getTime();
        var path = basePath + 'picture/' + cameraId + '/current/?_=' + timestamp;
        if (serverSideResize) {
            path += '&width=' + img.width;
        }
        
        path = addAuthParams('GET', path);
        
        img.src = path;
        img.loading = 1;
    }

    var cameraFrames;
    if (fullScreenCameraId != null && fullScreenCameraId >= 0) {
        cameraFrames = $('#camera' + fullScreenCameraId);
    }
    else {
        cameraFrames = $('div.page-container').find('div.camera-frame');
    }
    
    cameraFrames.each(function () {
        if (!this.img) {
            this.img = $(this).find('img.camera')[0];
            if (this.config['proto'] == 'mjpeg') {
                var url = this.config['url'].replace('127.0.0.1', window.location.host.split(':')[0]);
                url += (url.indexOf('?') > 0 ? '&' : '?') + '_=' + new Date().getTime();
                this.img.src = url;
            }
        }
        
        if (this.config['proto'] == 'mjpeg') {
            return; /* no manual refresh for simple mjpeg cameras */
        }
        
        /* at a refresh interval of 50ms, the refresh rate is limited to 20 fps */
        var count = 1000 / (refreshInterval * this.config['streaming_framerate']);
        var serverSideResize = this.config['streaming_server_resize'];
        
        if (count <= 2) {
            /* skipping frames (showing the same frame twice) at this rate won't be visible,
             * while the effective framerate will be as close as possible to the motion's one */
            count -= 1;
        }
        
        if (this.img.error) {
            /* in case of error, decrease the refresh rate to 1 fps */
            count = 1000 / refreshInterval;
        }
        
        if (this.refreshDivider < count) {
            this.refreshDivider++;
        }
        else {
            var cameraId = this.id.substring(6);
            refreshCameraFrame(cameraId, this.img, serverSideResize);
            
            this.refreshDivider = 0;
        }
    });
    
    setTimeout(refreshCameraFrames, refreshInterval);
}

function checkCameraErrors() {
    /* properly triggers the onerror event on the cameras whose imgs were not successfully loaded,
     * but the onerror event hasn't been triggered, for some reason (seems to happen in Chrome) */
    var cameraFrames = $('div.page-container').find('img.camera');
    
    cameraFrames.each(function () {
        if (this.complete === true && this.naturalWidth === 0 && !this.error && this.src) {
            $(this).error();
        }
    });
    
    setTimeout(checkCameraErrors, 500);
}


    /* startup function */

$(document).ready(function () {
    /* detect base path */
    if (frame) {
        window.basePath = qualifyPath('../../../');

    }
    else {
        window.basePath = splitUrl(qualifyPath('')).baseUrl;

        /* restore the username from cookie */
        window.username = getCookie('username');
    }
    
    /* open/close settings */
    $('div.settings-button').click(function () {
        if (isSettingsOpen()) {
            closeSettings();
        }
        else {
            openSettings();
        }
    });
    
    /* software update button */
    $('div#updateButton').click(doUpdate);
    
    /* backup/restore */
    $('div#backupButton').click(doBackup);
    $('div#restoreButton').click(doRestore);
    
    /* prevent scroll events on settings div from propagating TODO this does not actually work */
    $('div.settings').mousewheel(function (e, d) {
        var t = $(this);
        if (d > 0 && t.scrollTop() === 0) {
            e.preventDefault();
        }
        else if (d < 0 && (t.scrollTop() === t.get(0).scrollHeight - t.innerHeight())) {
            e.preventDefault();
        }
    });
    
    initUI();
    beginProgress();
    
    ajax('GET', basePath + 'login/', null, function () {
        if (!frame) {
            fetchCurrentConfig(endProgress);
        }
    });
    
    refreshCameraFrames();
    checkCameraErrors();
});
