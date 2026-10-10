import { vi } from "vitest";
import type { Server } from 'socket.io';

/** Socket.IO room discovery is a network boundary, including its timed form. */
export function createSocketRoomDiscoveryHarness(resolveSockets: (room: string) => Promise<readonly unknown[]>): Server {
    return { in: (room: string) => {
        const discovery = { fetchSockets: () => resolveSockets(room), timeout: (_timeoutMs: number) => discovery };
        return discovery;
    } } as unknown as Server;
}

type SocketHandler = (...args: any[]) => unknown | Promise<unknown>;

type SocketTimeoutEmitter = {
    emitWithAck: (...args: any[]) => Promise<unknown>;
};

export type FakeSocket = {
    connected: boolean;
    data?: Record<string, unknown>;
    id: string;
    handlers: Map<string, SocketHandler>;
    emit: ReturnType<typeof vi.fn>;
    on: (event: string, handler: SocketHandler) => void;
    timeout: () => SocketTimeoutEmitter;
};

type FakeSocketOverrides = Partial<Omit<FakeSocket, "handlers" | "on">>;

export function createFakeSocket(overrides: FakeSocketOverrides = {}): FakeSocket {
    const handlers = new Map<string, SocketHandler>();
    const socket: FakeSocket = {
        connected: true,
        id: "fake-socket",
        handlers,
        emit: vi.fn(),
        on(event: string, handler: SocketHandler) {
            handlers.set(event, handler);
        },
        timeout() {
            return {
                emitWithAck: async () => {
                    throw new Error("not implemented");
                },
            };
        },
        ...overrides,
    };
    return socket;
}

/** An authenticated present-user socket at the verified transport boundary. */
export function createAuthenticatedFakeSocket(overrides: FakeSocketOverrides = {}): FakeSocket {
    return createFakeSocket({
        ...overrides,
        data: {
            authAuthority: "present_user",
            ...(overrides.data ?? {}),
        },
    });
}

/**
 * Admits the connect-time credential re-verification the authority-bearing
 * socket handlers run before they mutate Machine state or disclose stored
 * Artifact content.
 *
 * `socketCredentialCurrentness` is the adapter over the token verifier and the
 * Account row — a system boundary these module-mocked specs deliberately do not
 * stand up, and a fake socket carries no handshake token. The refusal itself is
 * proven against a real database in the `*.currentness.sqlite.integration.spec`
 * files, so admitting it here keeps each spec's subject its own behaviour.
 */
export function createCurrentSocketCredentialModuleMock() {
    return { hasCurrentSocketCredential: async () => true };
}

export function getSocketHandler(
    socket: Pick<FakeSocket, "handlers">,
    event: string,
): SocketHandler {
    const handler = socket.handlers.get(event);
    if (!handler) {
        throw new Error(`Missing socket handler for ${event}`);
    }
    return handler;
}

export async function triggerSocketHandler(
    socket: Pick<FakeSocket, "handlers">,
    event: string,
    ...args: any[]
): Promise<void> {
    await getSocketHandler(socket, event)(...args);
}
