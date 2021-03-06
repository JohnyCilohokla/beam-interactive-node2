import { EventEmitter } from 'events';
import * as Url from 'url';

import { CancelledError, InteractiveError, MessageParseError, TimeoutError } from '../errors';
import { IRawValues } from '../interfaces';
import { Method, Packet, PacketState, Reply } from './packets';
import {
    ExponentialReconnectionPolicy,
    IReconnectionPolicy,
} from './reconnection';

/**
 * Close codes that are deemed to be recoverable by the reconnection policy
 */
export const recoverableCloseCodes = [1000, 1011];

//We don't support lz4 due to time constraints right now
export type CompressionScheme = 'none' | 'gzip';

/**
 * SocketOptions are passed to the Interactive Socket and control behavior.
 */
export interface ISocketOptions {
    // Settings to use for reconnecting automatically to Constellation.
    // Defaults to automatically reconnecting with the ExponentialPolicy.
    reconnectionPolicy?: IReconnectionPolicy;
    autoReconnect?: boolean;

    // Websocket URL to connect to, defaults to <TODO>
    url?: string;

    //compression scheme, defaults to none, Will remain none until pako typings are updated
    compressionScheme?: CompressionScheme;

    // Query params to add
    queryParams?: IRawValues;

    // Optional OAuth token to use for authentication.
    authToken?: string;

    // Timeout on Constellation method calls before we throw an error.
    replyTimeout?: number;

    // Duration upon which to send a ping to the server. Defaults to 10 seconds.
    pingInterval?: number;
    // Any extra headers to include in the socket connection.
    extraHeaders?: IRawValues;
    // Optional intercept function that can be run before socket reconnections.
    reconnectChecker?: () => Promise<void>;
}

export interface IWebSocketOptions {
    headers: IRawValues;
}

export interface ICloseEvent {
    code: number;
    reason: string;
    wasClean: boolean;
}

/**
 * SocketState is used to record the status of the websocket connection.
 */
export enum SocketState {
    /**
     * A connection attempt has not been made yet.
     */
    Idle = 1,
    /**
     * A connection attempt is currently being made.
     */
    Connecting,
    /**
     * The socket is connection and data may be sent.
     */
    Connected,
    /**
     * The socket is gracefully closing; after this it will become Idle.
     */
    Closing,
    /**
     * The socket is reconnecting after closing unexpectedly.
     */
    Reconnecting,
    /**
     * Connect was called whilst the old socket was still open.
     */
    Refreshing,
}

function getDefaults(): ISocketOptions {
    return {
        url: '',
        replyTimeout: 10000,
        compressionScheme: 'none',
        autoReconnect: true,
        reconnectionPolicy: new ExponentialReconnectionPolicy(),
        pingInterval: 10 * 1000,
        extraHeaders: {},
        queryParams: {},
        reconnectChecker: () => Promise.resolve(),
    };
}

export class InteractiveSocket extends EventEmitter {
    // WebSocket constructor, may be overridden if the environment
    // does not natively support it.

    //tslint:disable-next-line:variable-name
    public static WebSocket: any = typeof WebSocket === 'undefined'
        ? null
        : WebSocket;

    private reconnectTimeout: NodeJS.Timer;
    private options: ISocketOptions;
    private state: SocketState = SocketState.Idle;
    private socket: any;
    private queue: Set<Packet> = new Set<Packet>();
    private lastSequenceNumber = 0;

    constructor(options: ISocketOptions = {}) {
        super();
        this.setMaxListeners(Infinity);
        this.setOptions(options);

        if (InteractiveSocket.WebSocket === undefined) {
            throw new Error(
                'Cannot find a websocket implementation; please provide one by ' +
                    'running InteractiveSocket.WebSocket = myWebSocketModule;',
            );
        }

        this.on('message', (msg: any) => {
            this.extractMessage(msg);
        });

        this.on('open', () => {
            this.options.reconnectionPolicy.reset();
            this.state = SocketState.Connected;
            this.queue.forEach(data => this.send(data));
        });

        this.on('close', (evt: ICloseEvent) => {
            // If this close event's code is not within our recoverable code array
            // We raise it as an error and refuse to connect.
            if (recoverableCloseCodes.indexOf(evt.code) === -1) {
                const err = InteractiveError.fromSocketMessage({
                    code: evt.code,
                    message: evt.reason,
                });
                this.state = SocketState.Closing;
                this.emit('error', err);
                // Refuse to continue, these errors usually mean something is very wrong with our connection.
                return;
            }

            if (this.state === SocketState.Refreshing) {
                this.state = SocketState.Idle;
                this.options.reconnectChecker().then(() => this.connect());
                return;
            }

            if (
                this.state === SocketState.Closing ||
                !this.options.autoReconnect
            ) {
                this.state = SocketState.Idle;
                return;
            }

            this.state = SocketState.Reconnecting;

            this.reconnectTimeout = setTimeout(() => {
                this.options.reconnectChecker().then(() => this.connect());
            }, this.options.reconnectionPolicy.next());
        });
    }

    /**
     * Set the given options.
     * Defaults and previous option values will be used if not supplied.
     */
    public setOptions(options: ISocketOptions) {
        this.options = Object.assign(
            {},
            this.options || getDefaults(),
            options,
        );
    }

    /**
     * Open a new socket connection. By default, the socket will auto
     * connect when creating a new instance.
     */
    public connect(): this {
        if (this.state === SocketState.Closing) {
            this.state = SocketState.Refreshing;
            return this;
        }
        const defaultHeaders = {
            'X-Protocol-Version': '2.0',
        };

        const headers = Object.assign(
            {},
            defaultHeaders,
            this.options.extraHeaders,
        );

        const extras: IWebSocketOptions = {
            headers,
        };

        const url = Url.parse(this.options.url, true);
        // Clear out search so it populates query using the query
        // https://nodejs.org/api/url.html#url_url_format_urlobject
        url.search = null;

        if (this.options.authToken) {
            extras.headers['Authorization'] = `Bearer ${this.options
                .authToken}`;
        }
        url.query = Object.assign({}, url.query, this.options.queryParams);

        this.socket = new InteractiveSocket.WebSocket(
            Url.format(url),
            [],
            extras,
        );

        this.state = SocketState.Connecting;

        this.socket.addEventListener('close', (evt: ICloseEvent) =>
            this.emit('close', evt),
        );
        this.socket.addEventListener('open', () => this.emit('open'));
        this.socket.addEventListener('message', (evt: any) =>
            this.emit('message', evt.data),
        );

        this.socket.addEventListener('error', (err: any) => {
            if (this.state === SocketState.Closing) {
                // Ignore errors on a closing socket.
                return;
            }

            this.emit('error', err);
        });

        return this;
    }

    /**
     * Returns the current state of the socket.
     * @return {State}
     */
    public getState(): SocketState {
        return this.state;
    }

    /**
     * Close gracefully shuts down the websocket.
     */
    public close() {
        if (this.state === SocketState.Reconnecting) {
            clearTimeout(this.reconnectTimeout);
            this.state = SocketState.Idle;
            return;
        }

        if (this.state !== SocketState.Idle) {
            this.state = SocketState.Closing;
            this.socket.close(1000, 'Closed normally.');
            this.queue.forEach(packet => packet.cancel());
            this.queue.clear();
        }
    }

    /**
     * Executes an RPC method on the server. Returns a promise which resolves
     * after it completes, or after a timeout occurs.
     */
    public execute(
        method: string,
        params: IRawValues = {},
        discard: boolean = false,
    ): Promise<any> {
        const methodObj = new Method(method, params, discard);
        return this.send(new Packet(methodObj));
    }

    /**
     * Send emits a Method over the websocket, wrapped in a Packet to provide queueing and
     * cancellation. It returns a promise which resolves with the reply payload from the Server.
     */
    public send(packet: Packet): Promise<any> {
        if (packet.getState() === PacketState.Cancelled) {
            return Promise.reject(new CancelledError());
        }

        this.queue.add(packet);

        // If the socket has not said hello, queue the request and return
        // the promise eventually emitted when it is sent.
        if (this.state !== SocketState.Connected) {
            return new Promise((resolve, reject) => {
                let timer: NodeJS.Timer;
                let onSend: Function;
                let onCancel: Function;
                let onClose: Function;
                onSend = (data: any) => {
                    clearTimeout(timer);
                    packet.removeListener('cancel', onCancel);
                    this.removeListener('close', onClose);
                    resolve(data);
                };
                onCancel = () => {
                    clearTimeout(timer);
                    packet.removeListener('send', onSend);
                    this.removeListener('close', onClose);
                    reject(new CancelledError());
                };
                onClose = () => {
                    clearTimeout(timer);
                    packet.removeListener('send', onSend);
                    packet.removeListener('cancel', onCancel);

                    // reject(new CancelledError()); // TODO handle close
                };
                packet.once('send', onSend);
                packet.once('cancel', onCancel);
                this.once('close', onClose);

                timer = setTimeout(
                    () => {
                        packet.removeListener('send', onSend);
                        packet.removeListener('cancel', onCancel);
                        this.removeListener('close', onClose);
                        reject(new TimeoutError(`Expected to get event send ${JSON.stringify(packet)}`));
                    },
                    120 * 1000);
            });
        }


        const timeout = packet.getTimeout(this.options.replyTimeout);
        const promise = new Promise((resolve, reject) => {
            let timer: NodeJS.Timer;
            let onReply: Function;
            let onCancel: Function;
            let onClose: Function;
            onReply = (data: Reply) => {
                this.queue.delete(packet);

                clearTimeout(timer);
                packet.removeListener('cancel', onCancel);
                this.removeListener('close', onClose);

                if (data.error) {
                    reject(data.error);
                } else {
                    resolve(data.result);
                }
            };
            onCancel = () => {
                this.queue.delete(packet);

                clearTimeout(timer);
                this.removeListener(`reply:${packet.id()}`, onReply);
                this.removeListener('close', onClose);
                reject(new CancelledError());
            };
            onClose = () => {
                clearTimeout(timer);
                this.removeListener(`reply:${packet.id()}`, onReply);
                packet.removeListener('cancel', onCancel);

                reject(new CancelledError()); // if the connection is closed I want to cancel the event
                /*if (this.queue.has(packet)) { // resend if packet is still in the queue
                    packet.setState(PacketState.Pending);
                    this.send(packet).then(
                        (data) => { resolve(data); },
                        (error) => { reject(error); }
                    );
                }*/
            };
            this.once(`reply:${packet.id()}`, onReply);
            packet.once('cancel', onCancel);
            this.once('close', onClose);

            timer = setTimeout(
                () => {
                    this.removeListener(`reply:${packet.id()}`, onReply);
                    packet.removeListener('cancel', onCancel);
                    this.removeListener('close', onClose);
                    reject(new TimeoutError(`Expected to get event reply:${packet.id()}`));
                },
                timeout);
        });

        packet.emit('send', promise);
        packet.setState(PacketState.Sending);
        this.sendPacketInner(packet);

        return promise;
    }

    public reply(reply: Reply) {
        this.sendRaw(reply);
    }

    private sendPacketInner(packet: Packet) {
        this.sendRaw(packet.setSequenceNumber(this.lastSequenceNumber));
    }

    private sendRaw(packet: any) {
        const data = JSON.stringify(packet);
        const payload = data;

        this.emit('send', payload);
        this.socket.send(payload);
    }

    private extractMessage(packet: string | Buffer) {
        let messageString: string;
        messageString = <string>packet;
        let message: any;
        try {
            message = JSON.parse(messageString);
        } catch (err) {
            throw new MessageParseError('Message returned was not valid JSON');
        }

        if (message.hasOwnProperty('seq')) {
            this.lastSequenceNumber = message.seq;
        }

        switch (message.type) {
            case 'method':
                this.emit('method', Method.fromSocket(message));
                break;
            case 'reply':
                this.emit(`reply:${message.id}`, Reply.fromSocket(message));
                break;
            default:
                throw new MessageParseError(
                    `Unknown message type "${message.type}"`,
                );
        }
    }

    public getQueueSize(): number {
        return this.queue.size;
    }
}
