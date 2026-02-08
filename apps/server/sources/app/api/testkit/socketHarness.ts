import { vi } from "vitest";

type SocketHandler = (...args: any[]) => unknown | Promise<unknown>;

type SocketTimeoutEmitter = {
    emitWithAck: (...args: any[]) => Promise<unknown>;
};

export type FakeSocket = {
    connected: boolean;
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
