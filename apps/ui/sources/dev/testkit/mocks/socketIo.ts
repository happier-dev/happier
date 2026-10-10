import { vi } from 'vitest';

type SocketListener = (...args: unknown[]) => void;

export interface SocketIoManagerBoundary {
    timeout(): number | false;
    timeout(value: number | false): SocketIoManagerBoundary;
}

class SocketIoManagerBoundaryStub implements SocketIoManagerBoundary {
    // socket.io-client's Manager defaults to 20 seconds before caller configuration.
    private timeoutMs: number | false = 20_000;

    timeout(): number | false;
    timeout(value: number | false): this;
    timeout(value?: number | false): number | false | this {
        if (value === undefined) return this.timeoutMs;
        this.timeoutMs = value;
        return this;
    }
}

/** Mirror Manager's connection-attempt timeout, distinct from Socket's ACK timeout. */
export function createSocketIoManagerBoundaryStub(): SocketIoManagerBoundary {
    return new SocketIoManagerBoundaryStub();
}

/** Socket.IO is the external network boundary; the transport adapter remains real. */
export function createSocketIoBoundaryStub(options: Readonly<{ autoConnect?: boolean }> = {}) {
    const listeners = new Map<string, Set<SocketListener>>();
    const anyListeners = new Set<SocketListener>();
    const emitWithAck = vi.fn(async (_event: string, _payload?: unknown): Promise<unknown> => ({ v: 1, ok: true, admittedSessionIds: [] }));
    const socket = {
        io: createSocketIoManagerBoundaryStub(),
        id: 'socket-test', connected: false, active: false,
        on: vi.fn((event: string, listener: SocketListener) => {
            const handlers = listeners.get(event) ?? new Set<SocketListener>();
            handlers.add(listener); listeners.set(event, handlers);
        }),
        off: vi.fn((event: string, listener?: SocketListener) => {
            if (listener) listeners.get(event)?.delete(listener); else listeners.delete(event);
        }),
        onAny: vi.fn((listener: SocketListener) => { anyListeners.add(listener); }),
        offAny: vi.fn(() => { anyListeners.clear(); }),
        removeAllListeners: vi.fn(() => { listeners.clear(); }),
        connect: vi.fn(() => {
            socket.active = true;
            if (options.autoConnect !== false) trigger('connect');
        }),
        disconnect: vi.fn(() => {
            const wasConnected = socket.connected;
            socket.active = false; socket.connected = false;
            if (wasConnected) trigger('disconnect', 'io client disconnect');
        }),
        emit: vi.fn((_event: string, ..._args: unknown[]) => {}),
        emitWithAck,
        timeout: vi.fn((_ms: number) => ({ emitWithAck })),
    };
    function trigger(event: string, ...args: unknown[]) {
        if (event === 'connect') { socket.connected = true; socket.active = true; }
        if (event === 'disconnect') { socket.connected = false; socket.active = false; }
        for (const listener of listeners.get(event) ?? []) listener(...args);
        for (const listener of anyListeners) listener(event, ...args);
    }
    return { socket, trigger, listeners };
}
