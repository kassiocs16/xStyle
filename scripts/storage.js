function getDatabase() {
	return new Promise((resolve, reject) => {
		let dbOpenRequest = window.indexedDB.open("xstyle", 4);
		dbOpenRequest.onsuccess = function(e) {
			resolve(e.target.result);
		};
		dbOpenRequest.onerror = function(event) {
			console.log(event);
			reject(event);
		};
		dbOpenRequest.onupgradeneeded = function(event) {
			if (event.oldVersion == 0) {
				// Installed
				event.target.result.createObjectStore("styles", {
					keyPath: 'id',
					autoIncrement: true
				});
			} else {
				upgradeToNewest();
			}
		};
	});
}

var cachedStyles = null;
function getStyles(options) {
	return new Promise((resolve) => {
		if (cachedStyles != null) {
			resolve(filterStyles(cachedStyles, options));
		} else {
			getDatabase().then((db) => {
				var tx = db.transaction(["styles"], "readonly");
				var os = tx.objectStore("styles");
				var all = [];
				os.openCursor().onsuccess = function(event) {
					var cursor = event.target.result;
					if (cursor) {
						var s = cursor.value;
						s.id = cursor.key;
						all.push(cursor.value);
						cursor.continue();
					} else {
						cachedStyles = all;
						resolve(filterStyles(all, options));
					}
				};
			});
		}
	});
}

function getInstalledStyleForDomain(domain){
	return new Promise(function(resolve, reject){
		browser.runtime.sendMessage({method: "getStyles", matchUrl: domain}).then(resolve);
	});
}

function invalidateCache(andNotify) {
	cachedStyles = null;
	if (andNotify) {
		browser.runtime.sendMessage({method: "invalidateCache"});
	}
}

function filterStyles(styles, options) {
	var enabled = fixBoolean(options.enabled);
	var url = "url" in options ? options.url : null;
	var id = "id" in options ? Number(options.id) : null;
	var matchUrl = "matchUrl" in options ? options.matchUrl : null;

	if (enabled != null) {
		styles = styles.filter(function(style) {
			return style.enabled == enabled;
		});
	}
	if (url != null) {
		styles = styles.filter(function(style) {
			return style.url == url;
		});
	}
	if (id != null) {
		styles = styles.filter(function(style) {
			return style.id == id;
		});
	}
	if (matchUrl != null) {
		// Return as a hash from style to applicable sections? Can only be used with matchUrl.
		var asHash = "asHash" in options ? options.asHash : false;
		if (asHash) {
			var h = {disableAll: prefs.get("disableAll", false)};
			styles.forEach(function(style) {
				var applicableSections = getApplicableSections(style, matchUrl);
				if (applicableSections.length > 0) {
					h[style.id] = applicableSections;
				}
			});
			return h;
		}
		styles = styles.filter(function(style) {
			var applicableSections = getApplicableSections(style, matchUrl);
			return applicableSections.length > 0;
		});
	}
	return styles;
}

function saveStyle(o) {
	delete o["method"];
	return new Promise((resolve) => {
		getDatabase().then((db) => {
			var tx = db.transaction(["styles"], "readwrite");
			var os = tx.objectStore("styles");
			// Update
			if (o.id) {
				var request = os.get(Number(o.id));
				request.onsuccess = function(event) {
					var style = request.result || {};
					for (var prop in o) {
						if (prop == "id") {
							continue;
						}
						style[prop] = o[prop];
					}
					if (typeof(style.advanced) === 'undefined') {
						style.advanced = {"item": {}, "saved": {}, "css": []};
					}
					request = os.put(style);
					request.onsuccess = function(event) {
						notifyAllTabs({method: "styleUpdated", style: style});
						invalidateCache(true);
						resolve(style);
					};
				};
				return;
			}
			// Create
			// Set optional things to null if they're undefined
			["updateUrl", "md5Url", "url", "originalMd5"].filter(function(att) {
				return !(att in o);
			}).forEach(function(att) {
				o[att] = null;
			});
			if (typeof(o.advanced) === 'undefined') {
				o.advanced = {"item": {}, "saved": {}, "css": []};
			}
			// Set other optional things to empty array if they're undefined
			o.sections.forEach(function(section) {
				["urls", "urlPrefixes", "domains", "regexps", "exclude"].forEach(function(property) {
					if (!section[property]) {
						section[property] = [];
					}
				});
			});
			// Set to enabled if not set
			if (!("enabled" in o)) {
				o.enabled = true;
			}
			// Make sure it's not null - that makes indexeddb sad
			delete o["id"];
			var request = os.add(o);
			request.onsuccess = function(event) {
				invalidateCache(true);
				// Give it the ID that was generated
				o.id = event.target.result;
				notifyAllTabs({method: "styleAdded", style: o});
				resolve(o);
			};
		});
	});
}

// Install a style, check its url
function installStyle(json) {
	json = updateStyleFormat(json);
	if (json.url) {
		return new Promise((resolve) => {
			getStyles({url: json.url}).then((response) => {
				if (response.length != 0) {
					json.id = response[0].id;
					delete json.name;
				}
				if (typeof(json.autoUpdate) === 'undefined') {
					json.autoUpdate = json.updateUrl !== null;
				}
				saveStyle(json).then(resolve);
			});
		});
	}
	// Have not URL key, install as a new style
	return saveStyle(json);
}

function enableStyle(id, enabled) {
	return new Promise(function(resolve){
		saveStyle({id: id, enabled: enabled}).then((style) => {
			handleUpdate(style);
			notifyAllTabs({method: "styleUpdated", style: style});
			resolve();
		});
	});
}

function deleteStyle(id) {
	return new Promise(function(resolve){
		getDatabase().then((db) => {
			var tx = db.transaction(["styles"], "readwrite");
			var os = tx.objectStore("styles");
			var request = os.delete(Number(id));
			request.onsuccess = function(event) {
				handleDelete(id);
				invalidateCache(true);
				notifyAllTabs({method: "styleDeleted", id: id});
				resolve();
			};
		});
	});
}

function fixBoolean(b) {
	if (typeof b != "undefined") {
		return b != "false";
	}
	return null;
}

function getDomains(url) {
	if (url.indexOf("file:") == 0) {
		return [];
	}
	var d = /.*?:\/*([^\/:]+)/.exec(url)[1];
	var domains = [d];
	while (d.indexOf(".") != -1) {
		d = d.substring(d.indexOf(".") + 1);
		domains.push(d);
	}
	return domains;
}

function getType(o) {
	if (typeof o == "undefined" || typeof o == "string") {
		return typeof o;
	}
	if (o instanceof Array) {
		return "array";
	}
	throw "Not supported - " + o;
}

const namespacePattern = /^\s*(@namespace[^;]+;\s*)+$/;
function getApplicableSections(style, url) {
	var sections = style.sections.filter(function(section) {
		return sectionAppliesToUrl(section, url);
	});
	// ignore if it's just namespaces
	if (sections.length == 1 && namespacePattern.test(sections[0].code)) {
		return [];
	}
	return sections;
}

function sectionAppliesToUrl(section, url) {
	if (!canStyle(url)) {
		return false;
	}
	if (section.exclude && section.exclude.length > 0) {
		if (section.exclude.some(function(exclude) {
			if (exclude[0] != "^") {
				exclude = "^" + exclude;
			}
			if (exclude[exclude.length - 1] != "$") {
				exclude += "$";
			}
			var re = runTryCatch(function() { return new RegExp(exclude) });
			if (re) {
				return (re).test(url);
			} else {
				console.log(section.id + "'s exclude '" + exclude + "' is not valid");
			}
		})) {
			return false;
		}
	}
	if (section.urls.length == 0 && section.domains.length == 0 && section.urlPrefixes.length == 0 && section.regexps.length == 0) {
		//console.log(section.id + " is global");
		return true;
	}
	if (section.urls.indexOf(url) != -1) {
		//console.log(section.id + " applies to " + url + " due to URL rules");
		return true;
	}
	if (section.urlPrefixes.some(function(prefix) {
		return url.indexOf(prefix) == 0;
	})) {
		//console.log(section.id + " applies to " + url + " due to URL prefix rules");
		return true;
	}
	if (section.domains.length > 0 && getDomains(url).some(function(domain) {
		return section.domains.indexOf(domain) != -1;
	})) {
		//console.log(section.id + " applies due to " + url + " due to domain rules");
		return true;
	}
	if (section.regexps.some(function(regexp) {
		// we want to match the full url, so add ^ and $ if not already present
		if (regexp[0] != "^") {
			regexp = "^" + regexp;
		}
		if (regexp[regexp.length - 1] != "$") {
			regexp += "$";
		}
		var re = runTryCatch(function() { return new RegExp(regexp) });
		if (re) {
			return (re).test(url);
		} else {
			console.log(section.id + "'s regexp '" + regexp + "' is not valid");
		}
	})) {
		//console.log(section.id + " applies to " + url + " due to regexp rules");
		return true;
	}
	//console.log(section.id + " does not apply due to " + url);
	return false;
}

function isCheckbox(el) {
	return el.nodeName.toLowerCase() == "input" && "checkbox" == el.type.toLowerCase();
}

// js engine can't optimize the entire function if it contains try-catch
// so we should keep it isolated from normal code in a minimal wrapper
function runTryCatch(func) {
	try { return func() }
	catch(e) {}
}

// Accepts an array of pref names (values are fetched via prefs.get)
// and establishes a two-way connection between the document elements and the actual prefs
function setupLivePrefs(IDs) {
	var localIDs = {};
	IDs.forEach(function(id) {
		localIDs[id] = true;
		updateElement(id).addEventListener("change", function() {
			notifyBackground({"method": "prefChanged", "prefName": this.id, "value": isCheckbox(this) ? this.checked : this.value});
			prefs.set(this.id, isCheckbox(this) ? this.checked : this.value);
		});
	});
	browser.runtime.onMessage.addListener(function(request) {
		if (request.prefName in localIDs) {
			updateElement(request.prefName);
		}
	});
	function updateElement(id) {
		var el = document.getElementById(id);
		el[isCheckbox(el) ? "checked" : "value"] = prefs.get(id);
		el.dispatchEvent(new Event("change", {bubbles: true, cancelable: true}));
		return el;
	}
}

globalKeys = {};
var prefs = browser.extension.getBackgroundPage().prefs || new function Prefs() {
	const _this = this;
	let boundWrappers = {};
	let boundMethods = {};

	let defaults = {
		"show-badge": true, // display text on popup menu icon
		"modify-csp": true, // modify csp
		"auto-update": false, // Auto update styles
		"disableAll": false, // boss key
		"compact-popup": false,
		"only-applies-html": false,

		"manage.sort": "id", //sort styles in management page

		"editor.initAdvanced": 20,
		"editor.options": {}, // CodeMirror.defaults.*
		"editor.lineWrapping": true, // word wrap
		"editor.smartIndent": true, // "smart" indent
		"editor.indentWithTabs": false, // smart indent with tabs
		"editor.tabSize": 4, // tab width, in spaces
		"editor.keyMap":
			navigator.appVersion.indexOf("Windows") > 0 ? "sublime" : "default",
		"editor.theme": "default", // CSS theme
		"editor.beautify": { // CSS beautifier{
			"indent_size": 1,
			"indent_char": "\t",
			"space_around_selector_separator": true,
			"selector_separator_newline": true,
			"end_with_newline": false,
			"newline_between_rules": true,
			"space_around_selector_separator": true
		},
		"editor.lintDelay": 500, // lint gutter marker update delay, ms
		"editor.lintReportDelay": 2000, // lint report update delay, ms
		"editor.fontSize": 16, // font size
		"editor.fontName": "sans-serif" // font size
	};
	// when browser is strarting up, the setting is default
	this.isDefault = true;

	let values = deepCopy(defaults);
	let syncTimeout; // see broadcast() function below

	Object.defineProperty(this, "readOnlyValues", {value: {}});

	Prefs.prototype.get = function(key, defaultValue) {
		if (key in boundMethods) {
			if (key in boundWrappers) {
				return boundWrappers[key];
			} else {
				if (key in values) {
					boundWrappers[key] = boundMethods[key](values[key]);
					return boundWrappers[key];
				}
			}
		}
		if (key in values) {
			return values[key];
		}
		if (defaultValue !== undefined) {
			return defaultValue;
		}
		if (key in defaults) {
			return defaults[key];
		}
		console.warn("No default preference for '%s'", key);
	};

	Prefs.prototype.getAll = function(key) {
		return deepCopy(values);
	};

	Prefs.prototype.set = function(key, value, options) {
		let oldValue = deepCopy(values[key]);
		values[key] = value;
		defineReadonlyProperty(this.readOnlyValues, key, value);
		if ((!options || !options.noBroadcast) && !equal(value, oldValue)) {
			_this.broadcast(key, value, options);
		}
	};

	Prefs.prototype.bindAPI = function(apiName, apiMethod) {
		boundMethods[apiName] = apiMethod;
	};

	Prefs.prototype.remove = function(key) {
		_this.set(key, undefined)
	};

	Prefs.prototype.broadcast = function(key, value, options) {
		const message = {method: "prefChanged", prefName: key, value: value};
		notifyAllTabs(message);
		browser.runtime.sendMessage(message);
		if (key == "disableAll") {
			notifyAllTabs({method: "styleDisableAll", disableAll: value});
		}
		if (!options || !options.noSync) {
			clearTimeout(syncTimeout);
			syncTimeout = setTimeout(function() {
				getSync().set({"settings": values});
			}, 0);
		}
	};

	Object.keys(defaults).forEach(function(key) {
		_this.set(key, defaults[key], {noBroadcast: true});
	});

	getSync().get("settings").then(function(result) {
		_this.isDefault = false;
		const synced = result.settings;
		for (var key in defaults) {
			if (synced && (key in synced)) {
				_this.set(key, synced[key], {noSync: true});
			} else {
				var value = tryMigrating(key);
				if (value !== undefined) {
					_this.set(key, value);
				}
			}
		}
	});

	browser.storage.onChanged.addListener(function(changes, area) {
		if (area == "sync" && "settings" in changes) {
			const synced = changes.settings.newValue;
			if (synced) {
				for (key in defaults) {
					if (key in synced) {
						_this.set(key, synced[key], {noSync: true});
					}
				}
			} else {
				// user manually deleted our settings, we'll recreate them
				getSync().set({"settings": values});
			}
		}
	});

	function tryMigrating(key) {
		if (!(key in localStorage)) {
			return undefined;
		}
		var value = localStorage[key];
		delete localStorage[key];
		localStorage["DEPRECATED: " + key] = value;
		switch (typeof defaults[key]) {
			case "boolean":
				return value.toLowerCase() === "true";
			case "number":
				return Number(value);
			case "object":
				try {
					return JSON.parse(value);
				} catch(e) {
					console.log("Cannot migrate from localStorage %s = '%s': %o", key, value, e);
					return undefined;
				}
		}
		return value;
	}
};

function sessionStorageHash(name) {
	var hash = {
		value: {},
		set: function(k, v) { this.value[k] = v; this.updateStorage(); },
		unset: function(k) { delete this.value[k]; this.updateStorage(); },
		updateStorage: function() {
			sessionStorage[this.name] = JSON.stringify(this.value);
		}
	};
	try { hash.value = JSON.parse(sessionStorage[name]); } catch(e) {}
	Object.defineProperty(hash, "name", {value: name});
	return hash;
}

function deepCopy(obj) {
	if (!obj || typeof obj != "object") {
		return obj;
	} else {
		var emptyCopy = Object.create(Object.getPrototypeOf(obj));
		return deepMerge(emptyCopy, obj);
	}
}

function deepMerge(target, obj1 /* plus any number of object arguments */) {
	for (var i = 1; i < arguments.length; i++) {
		var obj = arguments[i];
		for (var k in obj) {
			// hasOwnProperty checking is not needed for our non-OOP stuff
			var value = obj[k];
			if (!value || typeof value != "object") {
				target[k] = value;
			} else if (k in target) {
				deepMerge(target[k], value);
			} else {
				target[k] = deepCopy(value);
			}
		}
	}
	return target;
}

function shallowMerge(target, obj1 /* plus any number of object arguments */) {
	for (var i = 1; i < arguments.length; i++) {
		var obj = arguments[i];
		for (var k in obj) {
			target[k] = obj[k];
			// hasOwnProperty checking is not needed for our non-OOP stuff
		}
	}
	return target;
}

function equal(a, b) {
	if (!a || !b || typeof a != "object" || typeof b != "object") {
		return a === b;
	}
	if (Object.keys(a).length != Object.keys(b).length) {
		return false;
	}
	for (var k in a) {
		if (a[k] !== b[k]) {
			return false;
		}
	}
	return true;
}

function defineReadonlyProperty(obj, key, value) {
	var copy = deepCopy(value);
	// In ES6, freezing a literal is OK (it returns the same value), but in previous versions it's an exception.
	if (typeof copy == "object") {
		Object.freeze(copy);
	}
	Object.defineProperty(obj, key, {value: copy, configurable: true})
}

function getSync() {
	if ("sync" in browser.storage) {
		return browser.storage.sync;
	}
	// In old Firefox version, sync is not supported, use local to instead of it
	if ("local" in browser.storage) {
		return browser.storage.local;
	}
}


// Upgrade functions
function upgradeToNewest() {
	getDatabase().then((db) => {
		let tx = db.transaction(["styles"], "readwrite");
		let os = tx.objectStore("styles");
		os.openCursor().onsuccess = function(e) {
			let cursor = e.target.result;
			if (cursor) {
				let s = cursor.value;
				s.id = cursor.key;
				s = updateStyleFormat(s);
				os.put(s);
				cursor.continue();
			}
		};
	});
}