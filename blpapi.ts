/// <reference path="./typings/tsd.d.ts" />

'use strict';

import assert = require('assert');
import events = require('events');
import util = require('util');

import Promise = require('bluebird');
import debug = require('debug');
import _ = require('lodash');

import blpapijs = require('blpapijs');
import customError = require('custom-error-generator');
var createCustomError = customError.createError;

// LOGGING
var trace = debug('blpapi-wrapper:trace');
var log = debug('blpapi-wrapper:debug');

// Note: When support for authorizing multiple identities was added, this
// added an optional identity parameter to functions that could be called on
// different identities. In all cases, this was added before the optional
// label. To avoid breaking existing callers, when these functions are called
// with the old number of arguments, they check the last argument and will
// accept either a label or identity.

var getError = function () {
    var errorTypeNames = [
        'DuplicateCorrelationIdException',
        'InvalidStateException',
        'InvalidArgumentException',
        'InvalidConversionException',
        'IndexOutOfRangeException',
        'FieldNotFoundException',
        'NotFoundException',
        'UnknownErrorException',
        'UnsupportedOperationException'
    ];

    errorTypeNames.forEach((typeName: string): void => {
        exports[typeName] = createCustomError(typeName, Error);
    });
    return (error: any): Error => {
        var typeName = error.typeName;
        if (typeName in exports) {
            return new exports[typeName](error.message);
        } else {
            return error;
        }
    }
}();

var invoke = function (func: any) {
    try {
        return func.apply(this,
                          Array.prototype.slice.call(arguments, 1));
    } catch(err) {
        throw getError(err);
    }
};

interface BlpApiSessionOpts {
    serverHost?: string;
    serverPort?: number;
}

interface BlpApiSubscription {
    security: string;
    fields: string[];
    options?: any;
    correlation: number;
}

interface BlpApiIdentity {
}

class BlpApiSession extends events.EventEmitter {
    session: blpapijs.Session;

    constructor(...args: any[])
    {
        super();
        
        this.session = new blpapijs.Session(args);
        var that = this;
        this.session.emit = function() {
            that.emit.apply(that, arguments);
        }
    }
    
    start()
    {
        return invoke.call(this.session, this.session.start);
    }

    
    authorize(uri: string, cid: number)
    {
        return invoke.call(this.session, this.session.authorize, uri, cid);
    }
    
    authorizeUser(request: any, cid: number)
    {
        return invoke.call(this.session,
                           this.session.authorizeUser,
                           request,
                           cid);
    }
    
    stop()
    {
        return invoke.call(this.session, this.session.stop);
    }

    destroy()
    {
        return invoke.call(this.session, this.session.destroy);
    }

    openService(uri: string, cid: number)
    {
        return invoke.call(this.session, this.session.openService, uri, cid);
    }
    
    subscribe(sub: any[], arg2?: Object, arg3?: string)
    {
        var identity = arg2;
        var label = arg3;
        if (2 === arguments.length && typeof arg2 === 'string') {
            identity = undefined;
            label = arg2;
        }
        return invoke.call(this.session,
                           this.session.subscribe,
                           sub,
                           identity,
                           label);
    }
    
    resubscribe(sub: any[], label?: string)
    {
        return invoke.call(this.session, this.session.resubscribe, sub, label);
    }

    unsubscribe(sub: any[], label?: string)
    {
        return invoke.call(this.session, this.session.unsubscribe, sub, label);
    }
    
    request(uri: string, name: string, request: any, cid: number, arg5?: Object, arg6?: string)
    {
        var identity = arg5;
        var label = arg6;
        if (5 === arguments.length && typeof arg5 === 'string') {
            identity = undefined;
            label = arg5;
        }
        return invoke.call(this.session, this.session.request,
                           uri, name, request, cid, identity, label);
    }
}


////////////////////////////////////
////////////////////////////////////


// PUBLIC TYPES
export interface IRequestCallback {
    (err: Error, data?: any, isFinal?: boolean): void;
}

export class Subscription extends events.EventEmitter {
    security: string;
    fields: string[];
    options: any = null;

    constructor(security: string, fields: string[], options?: any) {
        super();

        this.security = security;
        this.fields = fields;
        if (3 === arguments.length) {
            this.options = options;
        }
    }

    private toJSON(): Object {
        var result: { security: string; fields: string[]; options?: any; } = {
            security: this.security,
            fields: this.fields
        };

        if (null !== this.options) {
            result.options = this.options;
        }

        return result;
    }
}

export class BlpApiError implements Error {
    // STATIC DATA
    static NAME: string = 'BlpApiError';

    // DATA
    data: any;
    name: string;
    message: string;
    constructor(data: any) {
        this.data = data;
        this.name = BlpApiError.NAME;
        // Subscription errors have a description, other errors have a message.
        this.message = data.reason.message || data.reason.description;
    }
}

// CONSTANTS
var EVENT_TYPE = {
    RESPONSE:         'RESPONSE'
  , PARTIAL_RESPONSE: 'PARTIAL_RESPONSE'
};

// Mapping of request types to response names to listen for.
// The strings are taken from section A of the BLPAPI Developer's Guide, and are organized by
// service.
var REQUEST_TO_RESPONSE_MAP: { [index: string]: string; } = {
    // //blp/refdata
    'HistoricalDataRequest': 'HistoricalDataResponse',
    'IntraDayTickRequest':   'IntraDayTickResponse',
    'IntraDayBarRequest':    'IntraDayBarResponse',
    'ReferenceDataRequest':  'ReferenceDataResponse',
    'PortfolioDataRequest':  'PortfolioDataResponse',
    'BeqsRequest':           'BeqsResponse',

    // //blp/apiflds
    'FieldInfoRequest':              'fieldResponse',
    'FieldSearchRequest':            'fieldResponse',
    'CategorizedFieldSearchRequest': 'categorizedFieldResponse',

    // //blp/instruments
    'instrumentListRequest': 'InstrumentListResponse',
    'curveListRequest':      'CurveListResponse',
    'govtListRequest':       'GovtListResponse',

    // //blp/tasvc
    'studyRequest':          'studyResponse',

    // //blp/apiauth
    'AuthorizationRequest':      'AuthorizationResponse',
    'AuthorizationTokenRequest': 'AuthorizationTokenResponse'
};

// Mapping of service URIs to the event names to listen to when subscribed to these services.
var SERVICE_TO_SUBSCRIPTION_EVENTS_MAP: { [uri: string]: string[]; } = {
    '//blp/mktdata':  ['MarketDataEvents'],
    '//blp/mktvwap':  ['MarketDataEvents'],
    '//blp/mktbar':   ['MarketBarStart', 'MarketBarUpdate', 'MarketBarEnd'],
    '//blp/pagedata': ['PageUpdate']
};

// ANONYMOUS FUNCTIONS
function isObjectEmpty(obj: Object): boolean {
    return (0 === Object.getOwnPropertyNames(obj).length);
}

function securityToService(security: string): string {
    var serviceRegex = /^\/\/blp\/[a-z]+/;
    var match = serviceRegex.exec(security);
    // XXX: note that we shoud probably capture what the default service is to use when
    //      reading in the session options.  However, when not specified, it is
    //      '//blp/mktdata'.
    return match ? match[0] : '//blp/mktdata';
}

function subscriptionsToServices(subscriptions: Subscription[]): string[] {
    return _.chain(subscriptions).map((s: Subscription): string => {
        return securityToService(s.security);
    }).uniq().value();
}


export class Session extends events.EventEmitter {
    //ATTRIBUTES
    // TypeScript compiler needs this to allow "this['property-string']" type of access
    [index: string]: any;

    // DATA
    private session: BlpApiSession;
    private eventListeners: {[index: string]: {[index: number]: Function}} = {};
    private requests: {[index: string]: IRequestCallback} = {};
    private subscriptions: {[index: string]: Subscription} = {};
    private services: {[index: string]: Promise<void>} = {};
    private correlatorId: number = 0;
    private stopped: Promise<void> = null;

    // PRIVATE MANIPULATORS
    private nextCorrelatorId(): number {
        return this.correlatorId++;
    }

    private listen(eventName: string, expectedId: number, handler: Function): void {
        if (!(eventName in this.eventListeners)) {
            trace('Listener added: ' + eventName);
            this.session.on(eventName, ((eventName: string, m: any): void => {
                var correlatorId = m.correlations[0].value;
                assert(correlatorId in this.eventListeners[eventName],
                       'correlation id does not exist: ' + correlatorId);
                this.eventListeners[eventName][correlatorId](m);
            }).bind(this, eventName));

            this.eventListeners[eventName] = {};
        }
        this.eventListeners[eventName][expectedId] = handler;
    }

    private unlisten(eventName: string, correlatorId: number): void {
        delete this.eventListeners[eventName][correlatorId];
        if (isObjectEmpty(this.eventListeners[eventName])) {
            trace('Listener removed: ' + eventName);
            this.session.removeAllListeners(eventName);
            delete this.eventListeners[eventName];
        }
    }

    private openService(uri: string): Promise<void> {
        var thenable = this.services[uri] = this.services[uri] ||
                                            new Promise<void>((resolve: Function,
                                                               reject: Function): void => {
            trace('Opening service: ' + uri);
            var openServiceId = this.nextCorrelatorId();

            this.session.openService(uri, openServiceId);

            this.listen('ServiceOpened', openServiceId, (ev: any): void => {
                log('Service opened: ' + uri);
                trace(ev);
                this.unlisten('ServiceOpened', openServiceId);
                this.unlisten('ServiceOpenFailure', openServiceId);
                resolve();
            });

            this.listen('ServiceOpenFailure', openServiceId, (ev: any): void => {
                log('Service open failure' + uri);
                trace(ev);
                this.unlisten('ServiceOpened', openServiceId);
                this.unlisten('ServiceOpenFailure', openServiceId);
                delete this.services[uri];
                reject(new BlpApiError(ev.data));
            });
        }).bind(this); // end 'new Promise'

        return thenable;
    }

    private requestHandler(cb: IRequestCallback, m: any): void {
        var eventType = m.eventType;
        var isFinal = (EVENT_TYPE.RESPONSE === eventType);

        log(util.format('Response: %s|%d|%s',
                        m.messageType,
                        m.correlations[0].value,
                        eventType));
        trace(m);

        cb(null, m.data, isFinal);

        if (isFinal) {
            var correlatorId = m.correlations[0].value;
            var messageType = m.messageType;
            delete this.requests[correlatorId];
            this.unlisten(messageType, correlatorId);
        }
    }

    private sessionTerminatedHandler(ev: any): void {
        log('Session terminating');
        trace(ev);

        _([{prop: 'eventListeners', cleanupFn: (eventName: string): void => {
            this.session.removeAllListeners(eventName);
         }},
         {prop: 'requests', cleanupFn: (k: string): void => {
            this.requests[k](new Error('session terminated'));
         }},
         {prop: 'subscriptions', cleanupFn: (k: string): void => {
            this.subscriptions[k].emit('error', new Error('session terminated'));
         }}
       ]).forEach((table: {prop: string; cleanupFn: (s: string) => void}): void => {
            Object.getOwnPropertyNames(this[table.prop]).forEach((key: string): void => {
                table.cleanupFn(key);
            });
            this[table.prop] = null;
        });

        if (!this.stopped) {
            this.stopped = Promise.resolve();
        }

        // tear down the session
        this.session.destroy();
        this.session = null;

        // emit event to any listeners
        this.emit('SessionTerminated', ev.data);
        log('Session terminated');
    }

    private doRequest(uri: string,
                      requestName: string,
                      request: any,
                      callback: IRequestCallback,
                      isAuthRequest: boolean,
                      identity?: BlpApiIdentity): void
    {
        this.validateSession();

        var correlatorId = this.nextCorrelatorId();
        this.requests[correlatorId] = callback;

        this.openService(uri).then((): void => {
            log(util.format('Request: %s|%d', requestName, correlatorId));
            trace(request);
            if (isAuthRequest) {
                this.session.authorizeUser(request, correlatorId);
            } else {
                // TODO: blpapi-node doesn't accept null; remove this when that's fixed.
                identity = identity || undefined;
                this.session.request(uri, requestName, request, correlatorId, identity);
            }
            assert(requestName in REQUEST_TO_RESPONSE_MAP,
                   util.format('Request, %s, not handled', requestName));
            this.listen(REQUEST_TO_RESPONSE_MAP[requestName],
                        correlatorId,
                        this.requestHandler.bind(this, callback));
        }).catch((ex: Error): void => {
            delete this.requests[correlatorId];
            callback(ex);
        });
    }

    // PRIVATE ACCESSORS
    private validateSession(): void {
        if (this.stopped) {
            throw new Error('session terminated');
        }
    }

    // CREATORS
    constructor(opts: BlpApiSessionOpts) {
        super();

        this.session = new BlpApiSession(opts);
        this.session.once('SessionTerminated', this.sessionTerminatedHandler.bind(this));
        log('Session created');
        trace(opts);
    }

    // MANIPULATORS
    start(cb?: (err: any, value: any) => void): Promise<void> {
        this.validateSession();

        return new Promise<void>((resolve: Function, reject: Function): void => {
            trace('Starting session');
            this.session.start();

            var listener = (listenerName: string, handler: Function, ev: any): void => {
                this.session.removeAllListeners(listenerName);
                handler(ev.data);
            };

            this.session.once('SessionStarted',
                              listener.bind(this, 'SessionStartupFailure', (data: any): void => {
                                  log('Session started');
                                  trace(data);
                                  resolve();
                              }));

            this.session.once('SessionStartupFailure',
                              listener.bind(this, 'SessionStarted', (data: any): void => {
                                  log('Session start failure');
                                  trace(data);
                                  reject(new BlpApiError(data));
                              }));
        }).nodeify(cb);
    }

    stop(cb?: (err: any, value: any) => void): Promise<void> {
        return this.stopped = this.stopped ||
                              new Promise<void>((resolve: Function, reject: Function): void => {
            log('Stopping session');
            this.session.stop();
            this.session.once('SessionTerminated', (ev: any): void => {
                resolve();
            });
        }).nodeify(cb);
    }

    request(uri: string,
            requestName: string,
            request: any,
            identity: BlpApiIdentity,
            callback: IRequestCallback): void
    {
        var isAuthRequest = false;
        this.doRequest(uri, requestName, request, callback, isAuthRequest, identity);
    }

    authorizeUser(request: any, cb?: (err: any, value: any) => void): Promise<BlpApiIdentity> {
        return new Promise<BlpApiIdentity>((resolve: (identity: BlpApiIdentity) => void,
                                             reject: (err: Error) => void): void => {
            var identity: BlpApiIdentity = null;
            function callback(err: Error, data?: any, isFinal?: boolean): void {
                if (err) {
                    reject(err);
                } else {
                    if (data.hasOwnProperty('identity')) {
                        identity = data.identity;
                    }
                    if (isFinal) {
                        if (identity) {
                            resolve(identity);
                        } else {
                            reject(new BlpApiError(data));
                        }
                    }
                }
            }
            var uri = '//blp/apiauth';
            var requestName = 'AuthorizationRequest';
            var isAuthRequest = true;
            this.doRequest(uri, requestName, request, callback, isAuthRequest);
        }).nodeify(cb);
    }

    subscribe(subscriptions: Subscription[],
              identity: BlpApiIdentity,
              cb?: (err: any) => void): Promise<void>
    {
        this.validateSession();

        _.forEach(subscriptions, (s: Subscription, i: number): void => {
            // XXX: O(N) - not critical but note to use ES6 Map in the future
            var cid = _.findKey(this.subscriptions, (other: Subscription): boolean => {
                return s === other;
            });

            if (undefined !== cid) {
                throw new Error('Subscription already exists for index ' + i);
            }
        });

        var subs = _.map(subscriptions, (s: Subscription): BlpApiSubscription => {
            var cid = this.nextCorrelatorId();

            // XXX: yes, this is a side-effect of map, but it is needed for performance
            //      reasons until ES6 Map is available
            this.subscriptions[cid] = s;

            var result: BlpApiSubscription = {
                security: s.security,
                correlation: cid,
                fields: s.fields
            };

            if ('options' in s) {
                result.options = s.options;
            }

            return result;
        });

        return Promise.all(_.map(subscriptionsToServices(subscriptions),
                                 (uri: string): Promise<void> =>
        {
            return this.openService(uri);
        })).then((): void => {
            log('Subscribing to: ' + JSON.stringify(subscriptions));

            // TODO: blpapi-node doesn't accept null; remove this when that's fixed.
            identity = identity || undefined;
            this.session.subscribe(subs, identity);

            _.forEach(subs, (s: BlpApiSubscription): void => {
                var uri = securityToService(s.security);
                var cid = s.correlation;
                var userSubscription = this.subscriptions[cid];

                assert(uri in SERVICE_TO_SUBSCRIPTION_EVENTS_MAP,
                       util.format('Service, %s, not handled', uri));
                var events = SERVICE_TO_SUBSCRIPTION_EVENTS_MAP[uri];
                events.forEach((event: string): void => {
                    log('listening on event: ' + event + ' for cid: ' + cid);
                    this.listen(event, cid, (m: any): void => {
                        userSubscription.emit('data', m.data, s);
                    });
                });
            });
        }).catch((ex: Error): void => {
            _.forEach(subs, (s: BlpApiSubscription): void => {
                var cid = s.correlation;
                delete this.subscriptions[cid];
            });
            throw ex;
        }).nodeify(cb);
    }

    unsubscribe(subscriptions: Subscription[]): void {
        this.validateSession();

        log('Unsubscribing: ' + JSON.stringify(subscriptions));

        _.forEach(subscriptions, (s: Subscription, i: number): void => {
            // XXX: O(N) - not critical but note to use ES6 Map in the future
            var cid = _.findKey(this.subscriptions, (other: Subscription): boolean => {
                return s === other;
            });

            if (undefined === cid) {
                throw new Error('Subscription not found at index ' + i);
            }
        });

        var cids = _.map(subscriptions, (s: Subscription): number => {
            // XXX: O(N) - not critical but note to use ES6 Map in the future
            var cid = _.findKey(this.subscriptions, (other: Subscription): boolean => {
                return s === other;
            });
            return _.parseInt(cid);
        });

        var subs = _.map(cids, (cid: number): BlpApiSubscription => {
            return <BlpApiSubscription>{
                security: ' ',
                correlation: cid,
                fields: []
            };
        });

        this.session.unsubscribe(subs);

        _.forEach(cids, (cid: number): void => {
            process.nextTick((): void => {
                this.subscriptions[cid].emit('end');
                delete this.subscriptions[cid];
            });
            this.unlisten('MarketDataEvents', cid);
        });
    }
}

// Local variables:
// c-basic-offset: 4
// tab-width: 4
// indent-tabs-mode: nil
// End:
//
// vi: set shiftwidth=4 tabstop=4 expandtab:
// :indentSize=4:tabSize=4:noTabs=true:

// ----------------------------------------------------------------------------
// Copyright (C) 2014 Bloomberg L.P.
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
