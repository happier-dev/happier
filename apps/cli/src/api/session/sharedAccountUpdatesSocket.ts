import type { Socket } from 'socket.io-client';
import {
    createManagedConnectionSupervisor,
    DEFAULT_MANAGED_CONNECTION_POLICY,
    type ManagedConnectionTransport,
} from '@happier-dev/connection-supervisor';

import { classifyTransportErrorToProbeResult } from '@/api/connection/classifyTransportErrorToProbeResult';
import type { ClientToServerEvents, ServerToClientEvents } from '../types';
import type { AccountUpdatesSocket } from './client/transport/sessionClientTransport';

type Listener = (...args: never[]) => void;
type ServerSocket = Socket<ServerToClientEvents, ClientToServerEvents>;
type View = AccountUpdatesSocket & { emitLocal(event: string, args: readonly unknown[]): void };
type CreateSocket = () => Readonly<{ socket: ServerSocket; transport: ManagedConnectionTransport }>;

function createAccountUpdatesConnection(create: CreateSocket) {
    const views = new Set<View>();
    const attached = new Set<View>();
    let currentSocket: ServerSocket | null = null;
    const fanOut = (event: string, args: readonly unknown[]) => {
        for (const view of [...attached]) view.emitLocal(event, args);
    };
    const supervisor = createManagedConnectionSupervisor({
        ...DEFAULT_MANAGED_CONNECTION_POLICY,
        probeReadiness: async () => ({ status: 'ready' }),
        classifyTransportErrorToProbeResult,
        createTransport: () => {
            const { socket, transport } = create();
            currentSocket = socket;
            socket.on('disconnect', (...args) => {
                if (currentSocket === socket) fanOut('disconnect', args);
            });
            socket.onAny((event, ...args: unknown[]) => {
                if (currentSocket === socket) fanOut(event, args);
            });
            return transport;
        },
        onConnected: ({ state }) => {
            fanOut('connect', []);
            if (state.lastDisconnectedAt !== null && state.reason !== 'initial_connect') fanOut('reconnect', []);
        },
    });
    return { views, attached, supervisor, isConnected: () => currentSocket?.connected === true };
}

/** Process-wide: a session host holds many Sessions of one Account; each gets a view, not a socket. */
const connections = new Map<string, ReturnType<typeof createAccountUpdatesConnection>>();
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
export function openAccountUpdatesSocket(key: string, create: CreateSocket): AccountUpdatesSocket {
    const shared = (sharedInThisProcess ? connections.get(key) : undefined) ?? createAccountUpdatesConnection(create);
    if (sharedInThisProcess) connections.set(key, shared);
    const listeners = new Map<string, Set<Listener>>();
    const view: View = {
        get connected() { return shared.attached.has(view) && shared.isConnected(); },
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
            if (!shared.views.has(view) || shared.attached.has(view)) return view;
            shared.attached.add(view);
            // Joining an open connection is this view's connect; the server sees no new socket.
            if (shared.isConnected()) queueMicrotask(() => { if (view.connected) view.emitLocal('connect', []); });
            else if (shared.attached.size === 1) void shared.supervisor.start();
            return view;
        },
        disconnect() {
            const wasConnected = view.connected;
            if (!shared.attached.delete(view)) return view;
            if (shared.attached.size === 0) void shared.supervisor.stop();
            if (wasConnected) view.emitLocal('disconnect', ['io client disconnect']);
            return view;
        },
        close() {
            view.disconnect();
            shared.views.delete(view);
            listeners.clear();
            if (shared.views.size === 0 && connections.get(key) === shared) connections.delete(key);
            return view;
        },
    };
    shared.views.add(view);
    return view;
}
