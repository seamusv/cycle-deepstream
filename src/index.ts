import { Driver } from '@cycle/run'
import xs, { Stream } from 'xstream'
import fromEvent from 'xstream/extra/fromEvent'
import concat from 'xstream/extra/concat'
import * as deepstream from 'deepstream.io-client-js'
import { EventEmitter } from 'events'
import {
  Intent, LoginIntent, SubscribeIntent,
  RecordSetIntent, ListSetIntent, ListenIntent,
  ListEntryIntent, EventEmitIntent, EventListenIntent,
  RPCIntent, CycleDeepstream, Event, Source
} from './types'

export const actions = require('./actions')

const stringify = require('json-stringify-safe')

export function makeDeepstreamDriver({url, options = {}, debug = false}:
  { url: string, options?: Object, debug?: boolean }): CycleDeepstream {

  let client: deepstreamIO.Client
  let cachedRecords: any = {}
  let cachedLists: any = {}
  let eventCallbacks: any = {}
  let presenceCallbacks: any = {}
  const log = console.debug === undefined ? console.log : console.debug

  return function deepstreamDriver(action$) {
    // Internal event emitter to delegate between action and response
    const driverEvents = new EventEmitter()

    // The stream of events we will return from this driver:
    const response$: Source = fromEvent(driverEvents, 'deepstream-event')
    // Log the events that the output stream sees
    // This also ensures that the stream is created now, and ensures
    // emitted events have a valid listener.
    response$.addListener({
      next: i => logEvent(i)
    })

    const emit = (data: Event, scope: string) => {
      if (typeof scope === 'undefined') {
        driverEvents.emit('deepstream-event', data)
      } else {
        driverEvents.emit('deepstream-event', { ...data, scope })
      }
    }

    function logAction(...msgs: Array<string>) {
      if (debug)
        log.apply(null, ['deepstream action:', ...msgs])
    }

    function logEvent(event: any) {
      if (event['error'] !== undefined) {
        /* istanbul ignore next */
        console.error('deepstream error:', stringify(event))
      } else if (debug) {
        log('deepstream event:', stringify(event))
      }
    }

    function getCacheName(name: string, scope?: string): string {
      if (typeof scope !== 'undefined') {
        name = name + scope
      }
      return name;
    }

    function getRecord(name: string, scope?: string): Promise<deepstreamIO.Record> {
      let cacheName = getCacheName(name, scope);
      return new Promise((resolve, reject) => {
        const record = cachedRecords[cacheName] === undefined ?
            client.record.getRecord(name) : cachedRecords[cacheName]
        record.on('error', /* istanbul ignore next */(err: string) => reject(err))
        record.whenReady((record: deepstreamIO.Record) => {
          cachedRecords[cacheName] = record
          resolve(record)
        })
      })
    }

    function getList(name: string, scope?: string): Promise<deepstreamIO.List> {
      let cacheName = getCacheName(name, scope);
      return new Promise((resolve, reject) => {
        const list = cachedLists[cacheName] === undefined ?
          client.record.getList(name) : cachedLists[cacheName]
        list.on('error', /* istanbul ignore next */(err: string) => reject(err))
        list.whenReady((list: deepstreamIO.List) => {
          cachedLists[cacheName] = list
          resolve(list)
        })
      })
    }

    function getEventCallback(name: string, scope?: string): (data: any) => string {
      if (typeof scope !== 'undefined') {
        name = name + scope
      }
      if (eventCallbacks[name] === undefined) {
        eventCallbacks[name] = (data: any) => emit(data, scope)
      }
      return eventCallbacks[name]
    }

    function getPresenceCallback(scope: string): (username: string, isLoggedIn: boolean) => void {
      if (eventCallbacks[scope] === undefined) {
        eventCallbacks[scope] = (username: string, isLoggedIn: boolean) => {
          emit({ event: 'presence.event', username, isLoggedIn }, scope)
        }
      }
      return eventCallbacks[scope]
    }

    /* istanbul ignore next */
    const noop = () => { }

    const login$ = action$.filter(intent => intent.action === 'login')
    const loginListener = login$.addListener({
      next: (intent: LoginIntent) => {
        logAction(intent.action, '(auth details hidden)')
        if (client !== undefined) {
          client.close()
        }
        // Delete caches:
        cachedRecords = {}
        cachedLists = {}
        eventCallbacks = {}
        presenceCallbacks = {}
        client = deepstream(url, options).login(
          intent.auth, (success: boolean, data: Object) => {
            if (success) {
              emit({ event: 'login.success', data }, intent.scope)
            } else {
              emit({ event: 'login.failure', data }, intent.scope)
            }
          })
        client.on('error', (error: string) => {
          emit({ event: 'client.error', error }, intent.scope)
        })
        client.on('connectionStateChanged', (state: string) => {
          emit({ event: 'connection.state', state }, intent.scope)
        })
      },
      error: noop,
      complete: noop
    })

    const logout$ = action$.filter(intent => intent.action === 'logout')
    const logoutListener = logout$.addListener({
      next: intent => {
        logAction(intent.action)
        // Delete caches:
        cachedRecords = {}
        cachedLists = {}
        if (client !== undefined) {
          client.close()
        }
        emit({ event: 'logout' }, intent.scope)
      },
      error: noop,
      complete: noop
    })

    const recordSubscription$ = action$.filter(intent => intent.action === 'record.subscribe'
      && intent.name !== undefined)
    const recordSubscriptionListener = recordSubscription$.addListener({
      next: (intent: SubscribeIntent) => {
        const events = Object.assign({
          //record.existing will fire record.change for existing values on subscribe
          'record.existing': true,
          'record.change': true,
          'record.discard': true,
          'record.delete': true,
          'record.error': true
        }, intent.events)
        logAction(intent.action, intent.name, intent.events ? stringify(intent.events) : '')
        getRecord(intent.name, intent.scope).then(record => {
          if (events['record.change']) {
            record.subscribe((data: Object) => {
              emit({ event: 'record.change', name: record.name, data: data }, intent.scope)
            }, events['record.existing'])
          }
          if (events['record.discard']) {
            record.on('discard', () => {
              emit({ event: 'record.discard', name: record.name }, intent.scope)
            })
          }
          if (events['record.delete']) {
            record.on('delete', () => {
              emit({ event: 'record.delete', name: record.name }, intent.scope)
            })
          }
          if (events['record.error']) {
            record.on('error', (err: string) => {
              emit({ event: 'record.error', name: record.name, error: err }, intent.scope)
            })
          }
        })
      },
      error: noop,
      complete: noop
    })

    const recordGet$ = action$.filter(intent => intent.action === 'record.get'
      && intent.name !== undefined)
    const recordGetListener = recordGet$.addListener({
      next: intent => {
        logAction(intent.action, intent.name)
        getRecord(intent.name, intent.scope).then(record => {
          emit({ event: 'record.get', name: record.name, data: record.get() }, intent.scope)
        })
      },
      error: noop,
      complete: noop
    })

    const recordSnapshot$ = action$.filter(intent => intent.action === 'record.snapshot'
      && intent.name !== undefined)
    const recordSnapshotListener = recordSnapshot$.addListener({
      next: intent => {
        logAction(intent.action, intent.name)
        client.record.snapshot(intent.name, (error, data) => {
          emit({ event: 'record.snapshot', name: intent.name, data }, intent.scope)
        })
      },
      error: noop,
      complete: noop
    })


    const recordSet$ = action$.filter(intent => intent.action === 'record.set'
      && intent.name !== undefined
      && (<RecordSetIntent>intent).data !== undefined)
    const recordSetListener = recordSet$.addListener({
      next: (intent: RecordSetIntent) => {
        logAction(intent.action, intent.name)
        const writeCallback = (error: string) => {
          if (error) {
            console.error(error)
          } else {
            emit({ event: 'record.set', name: intent.name }, intent.scope)
          }
        }
        getRecord(intent.name, intent.scope).then(record => {
          if (typeof intent.path === 'undefined') {
            if (intent.acknowledge) {
              record.set(intent.data, writeCallback)
            } else {
              record.set(intent.data)
            }
          } else {
            if (intent.acknowledge) {
              record.set(intent.path, intent.data, writeCallback)
            } else {
              record.set(intent.path, intent.data)
            }
          }
        })
      },
      error: noop,
      complete: noop
    })

    const recordDelete$ = action$.filter(intent => intent.action === 'record.delete'
      && intent.name !== undefined)
    const recordDeleteListener = recordDelete$.addListener({
      next: intent => {
        logAction(intent.action, intent.name)
        getRecord(intent.name, intent.scope).then(record => {
          record.unsubscribe()
          record.delete()
          delete cachedRecords[getCacheName(record.name, intent.scope)]
        })
      },
      error: noop,
      complete: noop
    })

    const recordDiscard$ = action$.filter(intent => intent.action === 'record.discard'
      && intent.name !== undefined)
    const recordDiscardListener = recordDiscard$.addListener({
      next: intent => {
        logAction(intent.action, intent.name)
        getRecord(intent.name, intent.scope).then(record => {
          record.unsubscribe()
          record.discard()
          console.log("discarding", getCacheName(record.name, intent.scope));
          delete cachedRecords[getCacheName(record.name, intent.scope)]
        })
      },
      error: noop,
      complete: noop
    })

    const recordListen$ = action$.filter(intent => intent.action === 'record.listen'
      && (<ListenIntent>intent).pattern !== undefined)
    const recordListenListener = recordListen$.addListener({
      next: (intent: ListenIntent) => {
        logAction(intent.action, intent.pattern)
        client.record.listen(intent.pattern, (match, isSubscribed, response) => {
          if (isSubscribed) {
            response.accept()
          }
          emit({ event: 'record.listen', match, isSubscribed }, intent.scope)
        })
      },
      error: noop,
      complete: noop
    })

    const listSubscription$ = action$.filter(intent => intent.action === 'list.subscribe'
      && intent.name !== undefined)
    const listSubscriptionListener = listSubscription$.addListener({
      next: (intent: SubscribeIntent) => {
        const events = Object.assign({
          'list.change': true,
          'list.entry-existing': true,
          'list.discard': true,
          'list.delete': true,
          'list.error': true,
          'list.entry-added': true,
          'list.entry-moved': true,
          'list.entry-removed': true
        }, intent.events)
        logAction(intent.action, intent.name, intent.events ? stringify(intent.events) : '')
        getList(intent.name, intent.scope).then(list => {
          // Is this the first time the subscription callback is called?
          let callbackFirstCall = true
          list.subscribe((data: Array<string>) => {
            if (events['list.change']) {
              emit({ event: 'list.change', name: list.name, data: data }, intent.scope)
            }
            // Only do this the *first* time the callback is called, on subscription:
            if (events['list.entry-existing'] && callbackFirstCall) {
              for (let i = 0; i < data.length; i++) {
                emit({ event: 'list.entry-existing', name: list.name, entry: data[i], position: i }, intent.scope)
              }
            }
            callbackFirstCall = false
          }, true)
          if (events['list.discard']) {
            list.on('discard', () => {
              emit({ event: 'list.discard', name: list.name }, intent.scope)
            })
          }
          if (events['list.delete']) {
            list.on('delete', () => {
              emit({ event: 'list.delete', name: list.name }, intent.scope)
            })
          }
          if (events['list.error']) {
            list.on('error', (err: string) => {
              emit({ event: 'list.error', name: list.name, error: err }, intent.scope)
            })
          }
          if (events['list.entry-added']) {
            list.on('entry-added', (entry: string, position: number) => {
              emit({ event: 'list.entry-added', name: list.name, entry, position }, intent.scope)
            })
          }
          if (events['list.entry-moved']) {
            list.on('entry-moved', (entry: string, position: number) => {
              emit({ event: 'list.entry-moved', name: list.name, entry, position }, intent.scope)
            })
          }
          if (events['list.entry-removed']) {
            list.on('entry-removed', (entry: string, position: number) => {
              emit({ event: 'list.entry-removed', name: list.name, entry, position }, intent.scope)
            })
          }
        })
      },
      error: noop,
      complete: noop
    })

    const listGetEntries$ = action$.filter(intent => intent.action === 'list.getEntries'
      && intent.name !== undefined)
    const listGetEntriesListener = listGetEntries$.addListener({
      next: intent => {
        logAction(intent.action, intent.name)
        getList(intent.name, intent.scope).then(list => {
          emit({ event: 'list.getEntries', name: list.name, data: list.getEntries() }, intent.scope)
        })
      },
      error: noop,
      complete: noop
    })

    const listSetEntries$ = action$.filter(intent => intent.action === 'list.setEntries'
      && (<ListSetIntent>intent).entries !== undefined
      && intent.name !== undefined)
    const listSetEntriesListener = listSetEntries$.addListener({
      next: (intent: ListSetIntent) => {
        logAction(intent.action, intent.name)
        getList(intent.name, intent.scope).then(list => {
          list.setEntries(intent.entries)
        })
      },
      error: noop,
      complete: noop
    })

    const listAddEntry$ = action$.filter(intent => intent.action === 'list.addEntry'
      && intent.name !== undefined
      && (<ListEntryIntent>intent).entry !== undefined)
    const listAddEntryListener = listAddEntry$.addListener({
      next: (intent: ListEntryIntent) => {
        logAction(intent.action, intent.name, intent.entry)
        getList(intent.name, intent.scope).then(list => {
          list.addEntry(intent.entry, intent.index)
        })
      },
      error: noop,
      complete: noop
    })

    const listRemoveEntry$ = action$.filter(intent => intent.action === 'list.removeEntry'
      && intent.name !== undefined
      && (<ListEntryIntent>intent).entry !== undefined)
    const listRemoveEntryListener = listRemoveEntry$.addListener({
      next: (intent: ListEntryIntent) => {
        logAction(intent.action, intent.name, intent.entry)
        getList(intent.name, intent.scope).then(list => {
          list.removeEntry(intent.entry, intent.index)
        })
      },
      error: noop,
      complete: noop
    })

    const listDelete$ = action$.filter(intent => intent.action === 'list.delete'
      && intent.name !== undefined)
    const listDeleteListener = listDelete$.addListener({
      next: intent => {
        logAction(intent.action, intent.name)
        getList(intent.name, intent.scope).then(list => {
          list.delete()
          delete cachedLists[getCacheName(list.name, intent.scope)]
        })
      },
      error: noop,
      complete: noop
    })

    const listDiscard$ = action$.filter(intent => intent.action === 'list.discard'
      && intent.name !== undefined)
    const listDiscardListener = listDiscard$.addListener({
      next: intent => {
        logAction(intent.action, intent.name)
        getList(intent.name, intent.scope).then(list => {
          list.discard()
          delete cachedLists[getCacheName(list.name, intent.scope)]
        })
      },
      error: noop,
      complete: noop
    })

    const eventSubscribe$ = action$.filter(intent => intent.action === 'event.subscribe'
      && intent.name !== undefined)
    const eventSubscribeListener = eventSubscribe$.addListener({
      next: intent => {
        logAction(intent.action, intent.name)
        const callback = getEventCallback(intent.name, intent.scope)
        client.event.subscribe(intent.name, callback)
      }
    })

    const eventUnsubscribe$ = action$.filter(intent => intent.action === 'event.unsubscribe'
      && intent.name !== undefined)
    const eventUnsubscribeListener = eventUnsubscribe$.addListener({
      next: intent => {
        logAction(intent.action, intent.name)
        const callback = getEventCallback(intent.name, intent.scope)
        client.event.unsubscribe(intent.name, callback)
      }
    })

    const eventEmit$ = action$.filter(intent => intent.action === 'event.emit'
      && intent.name !== undefined)
    const eventEmitListener = eventEmit$.addListener({
      next: (intent: EventEmitIntent) => {
        logAction(intent.action, intent.name)
        client.event.emit(intent.name, intent.data)
      }
    })

    const eventListen$ = action$.filter(intent => intent.action === 'event.listen'
      && (<EventListenIntent>intent).pattern !== undefined)
    const eventListenListener = eventListen$.addListener({
      next: (intent: EventListenIntent) => {
        logAction(intent.action, intent.pattern)
        client.event.listen(intent.pattern, (match, isSubscribed, response) => {
          if (isSubscribed) {
            response.accept()
          }
          emit({ event: 'event.listen', match, isSubscribed }, intent.scope)
        })
      },
      error: noop,
      complete: noop
    })

    const eventUnlisten$ = action$.filter(intent => intent.action === 'event.unlisten'
      && (<EventListenIntent>intent).pattern !== undefined)
    const eventUnlistenListener = eventUnlisten$.addListener({
      next: (intent: EventListenIntent) => {
        logAction(intent.action, intent.pattern)
        client.event.unlisten(intent.pattern)
      },
      error: noop,
      complete: noop
    })

    const rpcMake$ = action$.filter((intent: RPCIntent) => intent.action === 'rpc.make'
      && intent.method !== undefined)
    const rpcMakeListener = rpcMake$.addListener({
      next: (intent: RPCIntent) => {
        logAction(intent.action, intent.method, stringify(intent.data))
        client.rpc.make(intent.method, intent.data, (error, result) => {
          if (error) {
            throw new Error(error)
          }
          emit({ event: 'rpc.response', data: result }, intent.scope)
        })
      },
      error: noop,
      complete: noop
    })

    const presenceSubscribe$ = action$.filter(intent => intent.action === 'presence.subscribe')
    const presenceSubscribeListener = presenceSubscribe$.addListener({
      next: intent => {
        logAction(intent.action)
        const callback = getPresenceCallback(intent.scope)
        client.presence.subscribe(callback)
      }
    })


    const presenceUnsubscribe$ = action$.filter(intent => intent.action === 'presence.unsubscribe')
    const presenceUnsubscribeListener = presenceUnsubscribe$.addListener({
      next: intent => {
        logAction(intent.action)
        const callback = getPresenceCallback(intent.scope)
        client.presence.unsubscribe(callback)
      }
    })

    const presenceGetAll$ = action$.filter(intent => intent.action === 'presence.getAll')
    const presenceGetAllListener = presenceGetAll$.addListener({
      next: intent => {
        logAction(intent.action)
        client.presence.getAll(clients => {
          emit({ event: 'presence.getAll', clients }, intent.scope)
        })
      }
    })


    return response$
  }
}
