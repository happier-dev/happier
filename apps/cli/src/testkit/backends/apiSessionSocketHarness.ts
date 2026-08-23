import { vi } from 'vitest';
import {
    MACHINE_PLAIN_DATA_KEY_MARKER,
    type SessionTurnMutationV1,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';

type SocketEventHandler = (...args: unknown[]) => void;

export function createAvailableSessionSpawnMachineSnapshot(
    machineId: string,
    options?: Readonly<{ dataEncryptionKey?: string }>,
) {
    return {
        id: machineId,
        revokedAt: null,
        replacedByMachineId: null,
        dataEncryptionKey: options?.dataEncryptionKey ?? MACHINE_PLAIN_DATA_KEY_MARKER,
        operationProtocolCapabilities: {
            sessionSpawn: { protocolVersions: [1] },
        },
        operationProtocolCapabilitiesRevision: 1,
    };
}

export function respondToExactMachineSessionSpawnRpc(params: Readonly<{
    event: string;
    args: unknown[];
    machineId: string;
    sessionId: string;
    rpcCodec?: Readonly<{
        decode: (value: unknown) => unknown;
        encode: (value: unknown) => unknown;
    }>;
    onSpawnRequest?: (request: Readonly<Record<string, unknown>>) => void;
}>): boolean {
    if (params.event !== SOCKET_RPC_EVENTS.CALL) return false;
    const [rawCall, rawCallback] = params.args;
    const call = rawCall && typeof rawCall === 'object' && !Array.isArray(rawCall)
        ? rawCall as { method?: unknown; params?: unknown }
        : null;
    const callback = typeof rawCallback === 'function'
        ? rawCallback as (value: unknown) => void
        : null;
    if (!call || !callback) return false;

    const exactMethod = (method: string) => `${params.machineId}:${method}`;
    if (call.method === exactMethod(RPC_METHODS.DAEMON_SESSION_CREATION_PREPARE)) {
        const decodedParams = params.rpcCodec?.decode(call.params) ?? call.params;
        const request = decodedParams && typeof decodedParams === 'object' && !Array.isArray(decodedParams)
            ? decodedParams as Readonly<Record<string, unknown>>
            : {};
        callback({
            ok: true,
            result: params.rpcCodec?.encode({
                ok: true,
                directory: typeof request.directory === 'string' ? request.directory : process.cwd(),
                directoryCreationRequired: false,
                checkout: null,
            }) ?? {
                ok: true,
                directory: typeof request.directory === 'string' ? request.directory : process.cwd(),
                directoryCreationRequired: false,
                checkout: null,
            },
        });
        return true;
    }

    if (
        call.method === exactMethod(RPC_METHODS.SPAWN_HAPPY_SESSION)
        || call.method === exactMethod(RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE)
    ) {
        const decodedParams = params.rpcCodec?.decode(call.params) ?? call.params;
        const request = decodedParams && typeof decodedParams === 'object' && !Array.isArray(decodedParams)
            ? decodedParams as Readonly<Record<string, unknown>>
            : {};
        params.onSpawnRequest?.(request);
        const result = {
            success: true,
            sessionId: params.sessionId,
            sessionCreationOutcome: {
                disposition: 'created',
                organizationPlacement: { folderId: null, tagIds: [] },
            },
        };
        callback({
            ok: true,
            result: params.rpcCodec?.encode(result) ?? result,
        });
        return true;
    }

    return false;
}

export function createSessionTurnMutationAppliedReceipt(mutation: SessionTurnMutationV1) {
    return {
        v: mutation.v,
        sessionId: mutation.sessionId,
        mutationId: mutation.mutationId,
        ...('turnId' in mutation && mutation.turnId ? { turnId: mutation.turnId } : {}),
        action: mutation.action,
        decision: 'applied' as const,
        observedAt: mutation.observedAt,
        appliedAt: mutation.observedAt + 1,
    };
}

export function createSessionTurnMutationAppliedSocketAck(mutation: SessionTurnMutationV1) {
    return {
        result: 'success' as const,
        applied: true,
        receipt: createSessionTurnMutationAppliedReceipt(mutation),
    };
}

export function createSessionTurnMutationAppliedHttpResponse(mutation: SessionTurnMutationV1) {
    return {
        status: 200,
        data: {
            success: true as const,
            applied: true,
            receipt: createSessionTurnMutationAppliedReceipt(mutation),
        },
    };
}

export type ApiSessionSocketStub = {
    id: string;
    connected: boolean;
    on: ReturnType<typeof vi.fn>;
    off: ReturnType<typeof vi.fn>;
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    removeAllListeners: ReturnType<typeof vi.fn>;
    emit: ReturnType<typeof vi.fn>;
    timeout: ReturnType<typeof vi.fn>;
    emitWithAck: ReturnType<typeof vi.fn>;
    volatile: {
        emit: ReturnType<typeof vi.fn>;
    };
    trigger: (event: string, ...args: unknown[]) => void;
    getHandler: (event: string) => SocketEventHandler | undefined;
    getHandlers: (event: string) => SocketEventHandler[];
};

export function createApiSessionSocketStub(options: {
    id?: string;
    connected?: boolean;
    onConnect?: (socket: ApiSessionSocketStub) => void;
    disconnectReason?: string;
    emit?: (
        event: string,
        args: unknown[],
        socket: ApiSessionSocketStub,
    ) => unknown;
    emitWithAckResult?: unknown;
    emitWithAck?: (
        event: string,
        payload: unknown,
        socket: ApiSessionSocketStub,
    ) => Promise<unknown> | unknown;
} = {}): ApiSessionSocketStub {
    const handlers = new Map<string, Set<SocketEventHandler>>();

    const socket = {
        id: options.id ?? 'sock-1',
        connected: options.connected ?? false,
        on: vi.fn((event: string, handler: SocketEventHandler) => {
            const listeners = handlers.get(event) ?? new Set<SocketEventHandler>();
            listeners.add(handler);
            handlers.set(event, listeners);
            return socket;
        }),
        off: vi.fn((event: string, handler?: SocketEventHandler) => {
            if (!handler) {
                handlers.delete(event);
                return socket;
            }
            const listeners = handlers.get(event);
            listeners?.delete(handler);
            if (listeners && listeners.size === 0) {
                handlers.delete(event);
            }
            return socket;
        }),
        connect: vi.fn(() => {
            socket.connected = true;
            options.onConnect?.(socket);
            socket.trigger('connect');
            return socket;
        }),
        disconnect: vi.fn(() => {
            socket.connected = false;
            if (options.disconnectReason) {
                socket.trigger('disconnect', options.disconnectReason);
            }
            return socket;
        }),
        close: vi.fn(() => {
            socket.connected = false;
            if (options.disconnectReason) {
                socket.trigger('disconnect', options.disconnectReason);
            }
            return socket;
        }),
        removeAllListeners: vi.fn(() => {
            handlers.clear();
            return socket;
        }),
        emit: vi.fn((event: string, ...args: unknown[]) => options.emit?.(event, args, socket)),
        timeout: vi.fn(() => socket),
        emitWithAck: vi.fn(async (event: string, payload: unknown) => {
            if (options.emitWithAck) {
                return options.emitWithAck(event, payload, socket);
            }
            return options.emitWithAckResult ?? { ok: true, id: 'm1', seq: 1, localId: 'l1' };
        }),
        volatile: {
            emit: vi.fn(),
        },
        trigger(event: string, ...args: unknown[]) {
            for (const handler of handlers.get(event) ?? []) {
                handler(...args);
            }
        },
        getHandler(event: string) {
            return [...(handlers.get(event) ?? [])][0];
        },
        getHandlers(event: string) {
            return [...(handlers.get(event) ?? [])];
        },
    };

    return socket;
}

export function bindApiSessionSocketMock(
    mockIo: ReturnType<typeof vi.fn>,
    socket: ApiSessionSocketStub,
): void {
    mockIo.mockReset();
    mockIo.mockImplementation(() => socket);
}

export function bindApiSessionSocketPairMock(
    mockIo: ReturnType<typeof vi.fn>,
    params: Readonly<{
        sessionSocket: ApiSessionSocketStub;
        userSocket: ApiSessionSocketStub;
        fallbackSocket?: ApiSessionSocketStub;
    }>,
): void {
    mockIo.mockReset();
    mockIo
        .mockImplementationOnce(() => params.userSocket)
        .mockImplementationOnce(() => params.sessionSocket);

    if (params.fallbackSocket) {
        mockIo.mockImplementation(() => params.fallbackSocket);
    }
}

export function bindApiSessionSocketSequenceMock(
    mockIo: ReturnType<typeof vi.fn>,
    sockets: readonly [ApiSessionSocketStub, ...ApiSessionSocketStub[]],
): void {
    const [firstSocket, ...remainingSockets] = sockets;
    const fallbackSocket = remainingSockets[remainingSockets.length - 1] ?? firstSocket;

    mockIo.mockReset();
    mockIo.mockImplementationOnce(() => firstSocket);

    for (const socket of remainingSockets) {
        mockIo.mockImplementationOnce(() => socket);
    }

    mockIo.mockImplementation(() => fallbackSocket);
}

export async function flushApiSessionClientMessageCommitQueue(client: {
    messageCommitQueueTail: Promise<unknown>;
    providerTranscriptDispatchTail?: Promise<unknown>;
}): Promise<void> {
    await client.providerTranscriptDispatchTail;
    await client.messageCommitQueueTail;
}
