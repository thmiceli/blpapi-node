/// <reference path="./typings/tsd.d.ts" />
'use strict';
var __extends = this.__extends || function (d, b) {
    for (var p in b) if (b.hasOwnProperty(p)) d[p] = b[p];
    function __() { this.constructor = d; }
    __.prototype = b.prototype;
    d.prototype = new __();
};
var assert = require('assert');
var events = require('events');
var util = require('util');
var Promise = require('bluebird');
var debug = require('debug');
var _ = require('lodash');
var createError = require('custom-error-generator');
// Import the binding layer module.
var blpapijs = require('./build/Release/blpapijs');
// Extend the Session type with the methods from EventEmitter so
// its instances can listen for events.
_.assign(blpapijs.Session.prototype, events.EventEmitter.prototype);
// LOGGING
var trace = debug('blpapi:trace');
var log = debug('blpapi:debug');
var Subscription = (function (_super) {
    __extends(Subscription, _super);
    function Subscription(security, fields, options) {
        _super.call(this);
        this.options = null;
        this.security = security;
        this.fields = fields;
        if (options) {
            this.options = options;
        }
    }
    Subscription.prototype.toJSON = function () {
        var result = {
            security: this.security,
            fields: this.fields
        };
        if (this.options) {
            result.options = this.options;
        }
        return result;
    };
    return Subscription;
})(events.EventEmitter);
exports.Subscription = Subscription;
var BlpApiError = (function () {
    function BlpApiError(data) {
        this.data = data;
        this.name = BlpApiError.NAME;
        // Subscription errors have a description, other errors have a message.
        this.message = data.reason.message || data.reason.description;
    }
    // STATIC DATA
    BlpApiError.NAME = 'BlpApiError';
    return BlpApiError;
})();
exports.BlpApiError = BlpApiError;
// CONSTANTS
var EVENT_TYPE = {
    RESPONSE: 'RESPONSE',
    PARTIAL_RESPONSE: 'PARTIAL_RESPONSE'
};
// Mapping of request types to response names to listen for.
// The strings are taken from section A of the BLPAPI Developer's Guide, and are organized by
// service.
var REQUEST_TO_RESPONSE_MAP = {
    // //blp/refdata
    'HistoricalDataRequest': 'HistoricalDataResponse',
    'IntradayTickRequest': 'IntradayTickResponse',
    'IntradayBarRequest': 'IntradayBarResponse',
    'ReferenceDataRequest': 'ReferenceDataResponse',
    'PortfolioDataRequest': 'PortfolioDataResponse',
    'BeqsRequest': 'BeqsResponse',
    // //blp/apiflds
    'FieldInfoRequest': 'fieldResponse',
    'FieldSearchRequest': 'fieldResponse',
    'CategorizedFieldSearchRequest': 'categorizedFieldResponse',
    // //blp/instruments
    'instrumentListRequest': 'InstrumentListResponse',
    'curveListRequest': 'CurveListResponse',
    'govtListRequest': 'GovtListResponse',
    // //blp/tasvc
    'studyRequest': 'studyResponse',
    // //blp/apiauth
    'TokenGenerationRequest': 'TokenGenerationSuccess',
    'AuthorizationRequest': 'AuthorizationSuccess'
};
// Mapping of service URIs to the event names to listen to when subscribed to these services.
var SERVICE_TO_SUBSCRIPTION_EVENTS_MAP = {
    '//blp/mktdata': ['MarketDataEvents'],
    '//blp/mktvwap': ['MarketDataEvents'],
    '//blp/mktbar': ['MarketBarStart', 'MarketBarUpdate', 'MarketBarEnd'],
    '//blp/pagedata': ['PageUpdate']
};
// Convert generic BLPAPI errors caused by thrown C++ exceptions to error objects with
// a type that has the same name than the exception type.
var getError = (function () {
    var errorTypeNames = [
        'DuplicateCorrelationIdException',
        'InvalidStateException',
        'InvalidAggrgumentException',
        'InvalidConversionException',
        'IndexOutOfRangeException',
        'FieldNotFoundException',
        'NotFoundException',
        'UnknownErrorException',
        'UnsupportedOperationException'
    ];
    errorTypeNames.forEach(function (typeName) {
        exports[typeName] = createError(typeName, Error);
    });
    return function (error) {
        var typeName = error.typeName;
        if (typeName in exports) {
            return new exports[typeName](error.message);
        }
        else {
            return error;
        }
    };
})();
function isObjectEmpty(obj) {
    return (0 === Object.getOwnPropertyNames(obj).length);
}
function securityToService(security) {
    var serviceRegex = /^\/\/blp\/[a-z]+/;
    var match = serviceRegex.exec(security);
    // XXX: note that we shoud probably capture what the default service is to use when
    //      reading in the session options.  However, when not specified, it is
    //      '//blp/mktdata'.
    return match ? match[0] : '//blp/mktdata';
}
function subscriptionsToServices(subscriptions) {
    return _.chain(subscriptions).map(function (s) {
        return securityToService(s.security);
    }).uniq().value();
}
var Session = (function (_super) {
    __extends(Session, _super);
    // CREATORS
    function Session(opts) {
        _super.call(this);
        this.eventListeners = {};
        this.requests = {};
        this.subscriptions = {};
        this.services = {};
        this.correlatorId = 0;
        this.stopped = null;
        this.session = new blpapijs.Session(opts);
        this.session.once('SessionTerminated', this.sessionTerminatedHandler.bind(this));
        log('Session created');
        trace(opts);
        this.setMaxListeners(0); // Remove max listener limit
    }
    // PRIVATE MANIPULATORS
    Session.prototype.invoke = function (func) {
        var args = [];
        for (var _i = 1; _i < arguments.length; _i++) {
            args[_i - 1] = arguments[_i];
        }
        try {
            return func.apply(this.session, args);
        }
        catch (err) {
            throw getError(err);
        }
    };
    Session.prototype.nextCorrelatorId = function () {
        return this.correlatorId++;
    };
    Session.prototype.listen = function (eventName, expectedId, handler) {
        var _this = this;
        if (!(eventName in this.eventListeners)) {
            trace('Listener added: ' + eventName);
            this.session.on(eventName, (function (eventName, m) {
                var correlatorId = m.correlations[0].value;
                assert(correlatorId in _this.eventListeners[eventName], 'correlation id does not exist: ' + correlatorId);
                _this.eventListeners[eventName][correlatorId](m);
            }).bind(this, eventName));
            this.eventListeners[eventName] = {};
        }
        this.eventListeners[eventName][expectedId] = handler;
    };
    Session.prototype.unlisten = function (eventName, correlatorId) {
        delete this.eventListeners[eventName][correlatorId];
        if (isObjectEmpty(this.eventListeners[eventName])) {
            trace('Listener removed: ' + eventName);
            this.session.removeAllListeners(eventName);
            delete this.eventListeners[eventName];
        }
    };
    Session.prototype.openService = function (uri) {
        var _this = this;
        var thenable = this.services[uri] = this.services[uri] || new Promise(function (resolve, reject) {
            trace('Opening service: ' + uri);
            var openServiceId = _this.nextCorrelatorId();
            _this.invoke(_this.session.openService, uri, openServiceId);
            _this.listen('ServiceOpened', openServiceId, function (ev) {
                log('Service opened: ' + uri);
                trace(ev);
                _this.unlisten('ServiceOpened', openServiceId);
                _this.unlisten('ServiceOpenFailure', openServiceId);
                resolve();
            });
            _this.listen('ServiceOpenFailure', openServiceId, function (ev) {
                log('Service open failure' + uri);
                trace(ev);
                _this.unlisten('ServiceOpened', openServiceId);
                _this.unlisten('ServiceOpenFailure', openServiceId);
                delete _this.services[uri];
                reject(new BlpApiError(ev.data));
            });
        }).bind(this); // end 'new Promise'
        return thenable;
    };
    Session.prototype.requestHandler = function (cb, m) {
        var eventType = m.eventType;
        var isFinal = (EVENT_TYPE.PARTIAL_RESPONSE !== eventType);
        log(util.format('Response: %s|%d|%s', m.messageType, m.correlations[0].value, eventType));
        trace(m);
        cb(null, m.data, isFinal);
        if (isFinal) {
            var correlatorId = m.correlations[0].value;
            var messageType = m.messageType;
            delete this.requests[correlatorId];
            this.unlisten(messageType, correlatorId);
        }
    };
    Session.prototype.sessionTerminatedHandler = function (ev) {
        var _this = this;
        log('Session terminating');
        trace(ev);
        _([{ prop: 'eventListeners', cleanupFn: function (eventName) {
            _this.session.removeAllListeners(eventName);
        } }, { prop: 'requests', cleanupFn: function (k) {
            _this.requests[k](new Error('session terminated'));
        } }, { prop: 'subscriptions', cleanupFn: function (k) {
            _this.subscriptions[k].emit('error', new Error('session terminated'));
        } }]).forEach(function (table) {
            Object.getOwnPropertyNames(_this[table.prop]).forEach(function (key) {
                table.cleanupFn(key);
            });
            _this[table.prop] = null;
        });
        if (!this.stopped) {
            this.stopped = Promise.resolve();
        }
        // tear down the session
        this.invoke(this.session.destroy);
        this.session = null;
        // emit event to any listeners
        this.emit('SessionTerminated', ev.data);
        log('Session terminated');
    };
    Session.prototype.doRequest = function (uri, requestName, request, execute, callback) {
        var _this = this;
        try {
            this.validateSession();
        }
        catch (ex) {
            callback(ex);
            return;
        }
        var correlatorId = this.nextCorrelatorId();
        this.requests[correlatorId] = callback;
        this.openService(uri).then(function () {
            log(util.format('Request: %s|%d', requestName, correlatorId));
            trace(request);
            execute(correlatorId);
            assert(requestName in REQUEST_TO_RESPONSE_MAP, util.format('Request, %s, not handled', requestName));
            _this.listen(REQUEST_TO_RESPONSE_MAP[requestName], correlatorId, _this.requestHandler.bind(_this, callback));
        }).catch(function (ex) {
            delete _this.requests[correlatorId];
            callback(ex);
        });
    };
    // PRIVATE ACCESSORS
    Session.prototype.validateSession = function () {
        if (this.stopped) {
            throw new Error('session terminated');
        }
    };
    // MANIPULATORS
    Session.prototype.start = function (cb) {
        var _this = this;
        this.validateSession();
        return new Promise(function (resolve, reject) {
            trace('Starting session');
            _this.invoke(_this.session.start);
            var listener = function (listenerName, handler, ev) {
                _this.session.removeAllListeners(listenerName);
                handler(ev.data);
            };
            _this.session.once('SessionStarted', listener.bind(_this, 'SessionStartupFailure', function (data) {
                log('Session started');
                trace(data);
                resolve();
            }));
            _this.session.once('SessionStartupFailure', listener.bind(_this, 'SessionStarted', function (data) {
                log('Session start failure');
                trace(data);
                reject(new BlpApiError(data));
            }));
        }).nodeify(cb);
    };
    Session.prototype.stop = function (cb) {
        var _this = this;
        return this.stopped = this.stopped || new Promise(function (resolve, reject) {
            log('Stopping session');
            _this.invoke(_this.session.stop);
            _this.session.once('SessionTerminated', function (ev) {
                resolve();
            });
        }).nodeify(cb);
    };
    // 'request' function definition
    Session.prototype.request = function (uri, requestName, request, arg3, arg4, arg5) {
        var _this = this;
        var args = Array.prototype.slice.call(arguments);
        // Get callback and remove it from array.
        var callback = args.splice(-1)[0];
        // Get optional identity and label arguments (idx 3 and 4 if present).
        var optionalArgs = args.slice(3);
        var executeRequest = function (correlatorId) {
            var args = [_this.session.request, uri, requestName, request, correlatorId].concat(optionalArgs);
            _this.invoke.apply(_this, args);
        };
        this.doRequest(uri, requestName, request, executeRequest, callback);
    };
    Session.prototype.authenticate = function (cb) {
        var _this = this;
        var correlatorId = this.nextCorrelatorId();
        return new Promise(function (resolve, reject) {
            function callback(err, data) {
                if (err) {
                    reject(err);
                }
                else {
                    if (data.hasOwnProperty('token')) {
                        resolve(data.token);
                    }
                    else {
                        reject(new BlpApiError(data));
                    }
                }
            }
            var executeRequest = function (correlatorId) {
                _this.invoke(_this.session.generateToken, correlatorId);
                _this.listen('TokenGenerationFailure', correlatorId, function (m) {
                    _this.unlisten('TokenGenerationFailure', correlatorId);
                    reject(new BlpApiError(m.data));
                });
            };
            _this.doRequest('//blp/apiauth', 'TokenGenerationRequest', null, executeRequest, callback);
        }).nodeify(cb);
    };
    Session.prototype.authorize = function (token, cb) {
        var _this = this;
        var correlatorId = this.nextCorrelatorId();
        return new Promise(function (resolve, reject) {
            var identity = _this.session.createIdentity();
            function callback(err) {
                if (err) {
                    reject(err);
                }
                else {
                    resolve(identity);
                }
            }
            var executeRequest = function (correlatorId) {
                _this.invoke(_this.session.sendAuthorizationRequest, token, identity, correlatorId);
                _this.listen('AuthorizationFailure', correlatorId, function (m) {
                    _this.unlisten('AuthorizationFailure', correlatorId);
                    reject(new BlpApiError(m.data));
                });
            };
            _this.doRequest('//blp/apiauth', 'AuthorizationRequest', null, executeRequest, callback);
        }).nodeify(cb);
    };
    // 'subscribe' function implementation.
    Session.prototype.subscribe = function (subscriptions, arg1, arg2, arg3) {
        var _this = this;
        this.validateSession();
        var args = Array.prototype.slice.call(arguments);
        var callback = null;
        // If callback is present it is the last argument.
        if (typeof args[args.length - 1] === 'function') {
            // Get callback argument and remove it from the array of arguments.
            callback = args.splice(-1)[0];
        }
        // Get identity and label optional arguments, if specified they will be at index
        // 1 and 2.
        var optionalArgs = args.slice(1);
        _.forEach(subscriptions, function (s, i) {
            // XXX: O(N) - not critical but note to use ES6 Map in the future
            var cid = _.findKey(_this.subscriptions, function (other) {
                return s === other;
            });
            if (undefined !== cid) {
                throw new Error('Subscription already exists for index ' + i);
            }
        });
        var subs = _.map(subscriptions, function (s) {
            var cid = _this.nextCorrelatorId();
            // XXX: yes, this is a side-effect of map, but it is needed for performance
            //      reasons until ES6 Map is available
            _this.subscriptions[cid] = s;
            var result = {
                security: s.security,
                correlation: cid,
                fields: s.fields
            };
            if ('options' in s) {
                result.options = s.options;
            }
            return result;
        });
        return Promise.all(_.map(subscriptionsToServices(subscriptions), function (uri) {
            return _this.openService(uri);
        })).then(function () {
            log('Subscribing to: ' + JSON.stringify(subscriptions));
            var fwdArgs = [_this.session.subscribe, subs].concat(optionalArgs);
            _this.invoke.apply(_this, fwdArgs);
            _.forEach(subs, function (s) {
                var uri = securityToService(s.security);
                var cid = s.correlation;
                var userSubscription = _this.subscriptions[cid];
                assert(uri in SERVICE_TO_SUBSCRIPTION_EVENTS_MAP, util.format('Service, %s, not handled', uri));
                var events = SERVICE_TO_SUBSCRIPTION_EVENTS_MAP[uri];
                events.forEach(function (event) {
                    log('listening on event: ' + event + ' for cid: ' + cid);
                    _this.listen(event, cid, function (m) {
                        userSubscription.emit('data', m.data, s);
                    });
                });
            });
        }).catch(function (ex) {
            _.forEach(subs, function (s) {
                var cid = s.correlation;
                delete _this.subscriptions[cid];
            });
            throw ex;
        }).nodeify(callback);
    };
    Session.prototype.unsubscribe = function (subscriptions, label) {
        var _this = this;
        this.validateSession();
        log('Unsubscribing: ' + JSON.stringify(subscriptions));
        _.forEach(subscriptions, function (s, i) {
            // XXX: O(N) - not critical but note to use ES6 Map in the future
            var cid = _.findKey(_this.subscriptions, function (other) {
                return s === other;
            });
            if (undefined === cid) {
                throw new Error('Subscription not found at index ' + i);
            }
        });
        var cids = _.map(subscriptions, function (s) {
            // XXX: O(N) - not critical but note to use ES6 Map in the future
            var cid = _.findKey(_this.subscriptions, function (other) {
                return s === other;
            });
            return _.parseInt(cid);
        });
        var subs = _.map(cids, function (cid) {
            return {
                security: ' ',
                correlation: cid,
                fields: []
            };
        });
        // Build argument list appending optional arguments passed by caller.
        var args = [this.session.unsubscribe, subs].concat(Array.prototype.slice.call(arguments, 1));
        this.invoke.apply(this, args);
        _.forEach(cids, function (cid) {
            process.nextTick(function () {
                _this.subscriptions[cid].emit('end');
                delete _this.subscriptions[cid];
            });
            // unlisten for events
            var service = securityToService(_this.subscriptions[cid].security);
            assert(service in SERVICE_TO_SUBSCRIPTION_EVENTS_MAP, util.format('Service, %s, not handled', service));
            var events = SERVICE_TO_SUBSCRIPTION_EVENTS_MAP[service];
            _.forEach(events, function (e) {
                _this.unlisten(e, cid);
            });
        });
    };
    return Session;
})(events.EventEmitter);
exports.Session = Session;
// Local variables:
// c-basic-offset: 4
// tab-width: 4
// indent-tabs-mode: nil
// End:
//
// vi: set shiftwidth=4 tabstop=4 expandtab:
// :indentSize=4:tabSize=4:noTabs=true:
// ----------------------------------------------------------------------------
// Copyright (C) 2015 Bloomberg L.P.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to
// deal in the Software without restriction, including without limitation the
// rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
// sell copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
// FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
// IN THE SOFTWARE.
// ----------------------------- END-OF-FILE ----------------------------------
//# sourceMappingURL=blpapi.js.map