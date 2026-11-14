import type { Socket } from 'socket.io-client';

import type { ClientToServerEvents, ServerToClientEvents } from '../types';
import type { AccountUpdatesSocket } from './client/transport/sessionClientTransport';

type Listener = (...args: never[]) => void;
type ServerSocket = Socket<ServerToClientEvents, ClientToServerEvents>;
type SharedConnection = { socket: ServerSocket; views: Set<View>; attached: Set<View> };
type View = AccountUpdatesSocket & { emitLocal(event: string, args: readonly unknown[]): void };

/** Process-wide: a session host holds many Sessions of one Account; each gets a view, not a socket. */
const connections = new Map<string, SharedConnection>();
let sharedInThisProcess = false;

/**
 * Called once by the session host, the one process that holds many Sessions. A runner process holds
 * a single Session, so its one Session client keeps its own socket: there is nothing to share.
 */
export function shareAccountUpdatesInThisProcess(): void {
    sharedInThisProcess = true;
}

/**
 * The Account (user-scoped) update connection for one Session client. In a session host it is one
 * connection per credential, fanned out in-process: each Session client owns a view with the socket
 * surface it already uses. `connect()` attaches its demand, `disconnect()` releases it, and events
 * reach only attached views (delivery follows demand). The server connection opens on the first
 * attached view and closes when none remain.
 */
export function openAccountUpdatesSocket(key: string, create: () => ServerSocket): AccountUpdatesSocket {
    if (!sharedInThisProcess) return create();
    let connection = connections.get(key);
    if (!connection) {
        const socket = create();
        const shared: SharedConnection = { socket, views: new Set(), attached: new Set() };
        const fanOut = (event: string, args: readonly unknown[]) => {
            for (const view of [...shared.attached]) view.emitLocal(event, args);
        };
        socket.on('connect', () => fanOut('connect', []));
        socket.on('disconnect', (...args: unknown[]) => fanOut('disconnect', args));
        socket.onAny((event: string, ...args: unknown[]) => fanOut(event, args));
        connection = shared;
        connections.set(key, shared);
    }
    const shared = connection;
    const listeners = new Map<string, Set<Listener>>();
    const release = (view: View) => {
        if (!shared.attached.delete(view)) return false;
        if (shared.attached.size === 0) shared.socket.disconnect();
        return true;
    };
    const view: View = {
        get connected() { return shared.attached.has(view) && shared.socket.connected; },
        on(event, listener) {
            const set = listeners.get(event) ?? new Set<Listener>();
            set.add(listener);
            listeners.set(event, set);
            return view;
        },
        off(event, listener) { listeners.get(event)?.delete(listener); return view; },
        emitLocal(event, args) {
            for (const listener of [...listeners.get(event) ?? []]) Reflect.apply(listener, undefined, args);
        },
        connect() {
            if (!shared.views.has(view) || shared.attached.has(view)) {
                if (shared.views.has(view) && !shared.socket.connected && !shared.socket.active) shared.socket.connect();
                return view;
            }
            shared.attached.add(view);
            // Joining an open connection is this view's connect; the server sees no new socket.
            if (shared.socket.connected) queueMicrotask(() => { if (view.connected) view.emitLocal('connect', []); });
            else if (!shared.socket.active) shared.socket.connect();
            return view;
        },
        disconnect() {
            const wasConnected = view.connected;
            if (release(view) && wasConnected) view.emitLocal('disconnect', ['io client disconnect']);
            return view;
        },
        close() {
            view.disconnect();
            shared.views.delete(view);
            listeners.clear();
            if (shared.views.size === 0 && connections.get(key) === shared) {
                connections.delete(key);
                shared.socket.close();
            }
            return view;
        },
    };
    shared.views.add(view);
    return view;
}
