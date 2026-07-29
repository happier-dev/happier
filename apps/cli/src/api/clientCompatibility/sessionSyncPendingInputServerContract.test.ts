import { describe, expect, it, vi } from 'vitest';
import {
    classifySessionSyncPendingInputHttpContractShape,
    createSessionSyncPendingInputServerContractController,
} from './sessionSyncPendingInputServerContract';

const sessionSyncCurrent = {
    v: 1,
    enforcement: 'observe',
    minimumSessionSyncProtocolVersion: 1,
    currentSessionSyncProtocolVersion: 2,
    declarationTransport: 'headers-v1',
    minimumVersionsByClientKind: {
        daemon: '0.2.10',
        'session-runner': '0.2.10-preview.1',
    },
    upgradeUrlsByClientKind: {
        daemon: 'https://app.happier.dev/update?client=daemon',
        'session-runner': 'https://app.happier.dev/update?client=session-runner',
    },
} as const;
const sessionSyncOld = { ...sessionSyncCurrent, currentSessionSyncProtocolVersion: 1 } as const;
const pendingInputCurrent = { currentPendingInputProtocolVersion: 1 } as const;
const currentFeatures = {
    features: {},
    capabilities: {
        compatibility: { v: 1, sessionSync: sessionSyncCurrent, pendingInput: pendingInputCurrent },
    },
};
const releasedServerFeatures = {
    features: {
        sharing: {
            session: { enabled: true },
            public: { enabled: true },
            contentKeys: { enabled: true },
            pendingQueueV2: { enabled: true },
        },
    },
    capabilities: {},
};
const currentAck = {
    v: 1,
    compatibility: { v: 1, sessionSync: sessionSyncCurrent, pendingInput: pendingInputCurrent },
};

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function createSocket(ack: unknown = currentAck) {
    return {
        connected: true,
        timeout: vi.fn().mockReturnThis(),
        emitWithAck: vi.fn().mockResolvedValue(ack),
    };
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((next) => { resolve = next; });
    return { promise, resolve };
}

describe('session-sync Pending-input server contract controller', () => {
    it('keeps the v0.2.1 HTTP fingerprint typed as a legacy contract-shape candidate, not released authority', () => {
        expect(classifySessionSyncPendingInputHttpContractShape(releasedServerFeatures))
            .toBe('v0_2_1_legacy_contract_shape');
    });

    it('classifies the Remote-valid strict current envelope with per-client version and upgrade maps', async () => {
        const socket = createSocket();
        const fetchImpl = vi.fn().mockImplementation(async () => jsonResponse(currentFeatures));
        const controller = createSessionSyncPendingInputServerContractController({
            serverUrl: 'https://server.example/', token: 'token', fetchImpl,
        });

        const result = await controller.resolve({ sessionConnectionEpoch: 7, socket, machineId: 'machine' });

        expect(result).toEqual({
            mode: 'session_sync_v2_pending_input_v1',
            sessionConnectionEpoch: 7,
            socket,
        });
        expect(Object.keys(result)).toEqual(['mode', 'sessionConnectionEpoch', 'socket']);
        expect(fetchImpl).toHaveBeenCalledWith('https://server.example/v1/features', expect.objectContaining({ redirect: 'manual' }));
    });

    it('classifies the exact released-server HTTP payload plus the exact empty socket ACK', async () => {
        const socket = createSocket({});
        const controller = createSessionSyncPendingInputServerContractController({
            serverUrl: 'https://server.example',
            token: 'token',
            fetchImpl: vi.fn().mockResolvedValue(jsonResponse(releasedServerFeatures)),
        });

        await expect(controller.resolve({ sessionConnectionEpoch: 1, socket, machineId: 'machine' })).resolves.toEqual({
            mode: 'released_server_v0_2_1',
            sessionConnectionEpoch: 1,
            socket,
        });
    });

    it.each([
        'server-v0.2.1-dev.33.1',
        'server-v0.2.3-dev.35.1',
        'server-v0.2.4-dev.38.1',
    ])('documents that immutable %s has the same observed HTTP-plus-empty-ping contract shape', async (_tag) => {
        const socket = createSocket({});
        const controller = createSessionSyncPendingInputServerContractController({
            serverUrl: 'https://server.example',
            token: 'token',
            fetchImpl: vi.fn().mockResolvedValue(jsonResponse(releasedServerFeatures)),
        });

        await expect(controller.resolve({ sessionConnectionEpoch: 1, socket, machineId: 'machine' })).resolves.toMatchObject({
            mode: 'released_server_v0_2_1',
        });
    });

    it.each([
        ['session-sync only', {
            features: {}, capabilities: { compatibility: { v: 1, sessionSync: sessionSyncCurrent } },
        }, currentAck],
        ['Pending-input only', {
            features: {}, capabilities: { compatibility: { v: 1, sessionSync: sessionSyncOld, pendingInput: pendingInputCurrent } },
        }, currentAck],
        ['current HTTP and old socket', currentFeatures, {}],
        ['old HTTP and current socket', releasedServerFeatures, currentAck],
        ['current HTTP and malformed socket', currentFeatures, { ...currentAck, extra: true }],
        ['old HTTP and nonempty socket', releasedServerFeatures, { extra: true }],
    ])('keeps %s indeterminate', async (_name, httpPayload, socketAck) => {
        const socket = createSocket(socketAck);
        const controller = createSessionSyncPendingInputServerContractController({
            serverUrl: 'https://server.example', token: 'token',
            fetchImpl: vi.fn().mockResolvedValue(jsonResponse(httpPayload)),
        });

        await expect(controller.resolve({ sessionConnectionEpoch: 1, socket, machineId: 'machine' })).resolves.toMatchObject({ mode: 'indeterminate' });
    });

    it.each([401, 403])('classifies HTTP %s as auth_failed without probing the socket', async (status) => {
        const socket = createSocket();
        const controller = createSessionSyncPendingInputServerContractController({
            serverUrl: 'https://server.example', token: 'token',
            fetchImpl: vi.fn().mockResolvedValue(jsonResponse(currentFeatures, status)),
        });

        await expect(controller.resolve({ sessionConnectionEpoch: 1, socket, machineId: 'machine' })).resolves.toEqual({
            mode: 'auth_failed', sessionConnectionEpoch: 1, socket,
        });
        expect(socket.emitWithAck).not.toHaveBeenCalled();
    });

    it.each([302, 400, 404, 405, 409, 422, 429, 500, 501])('keeps HTTP %s indeterminate even with a current-looking body', async (status) => {
        const socket = createSocket();
        const controller = createSessionSyncPendingInputServerContractController({
            serverUrl: 'https://server.example', token: 'token',
            fetchImpl: vi.fn().mockResolvedValue(jsonResponse(currentFeatures, status)),
        });

        await expect(controller.resolve({ sessionConnectionEpoch: 1, socket, machineId: 'machine' })).resolves.toMatchObject({ mode: 'indeterminate' });
        expect(socket.emitWithAck).not.toHaveBeenCalled();
    });

    it('keeps missing identity, disconnect, transport failures, and malformed HTTP indeterminate', async () => {
        const socket = createSocket();
        const fetchImpl = vi.fn().mockRejectedValue(new Error('network'));
        const controller = createSessionSyncPendingInputServerContractController({ serverUrl: 'https://server.example', token: 'token', fetchImpl });

        await expect(controller.resolve({ sessionConnectionEpoch: 1, socket, machineId: null })).resolves.toMatchObject({ mode: 'indeterminate' });
        socket.connected = false;
        await expect(controller.resolve({ sessionConnectionEpoch: 2, socket, machineId: 'machine' })).resolves.toMatchObject({ mode: 'indeterminate' });
        socket.connected = true;
        await expect(controller.resolve({ sessionConnectionEpoch: 3, socket, machineId: 'machine' })).resolves.toMatchObject({ mode: 'indeterminate' });
        expect(fetchImpl).toHaveBeenCalledTimes(1);

        const malformed = createSessionSyncPendingInputServerContractController({
            serverUrl: 'https://server.example', token: 'token',
            fetchImpl: vi.fn().mockResolvedValue(new Response('not json', { status: 200 })),
        });
        await expect(malformed.resolve({ sessionConnectionEpoch: 4, socket, machineId: 'machine' })).resolves.toMatchObject({ mode: 'indeterminate' });
    });

    it('does not cache an invalid disconnected resolution across same-authority recovery', async () => {
        const socket = createSocket();
        const fetchImpl = vi.fn().mockImplementation(async () => jsonResponse(currentFeatures));
        const controller = createSessionSyncPendingInputServerContractController({
            serverUrl: 'https://server.example', token: 'token', fetchImpl,
        });
        await expect(controller.resolve({ sessionConnectionEpoch: 1, socket, machineId: 'machine' }))
            .resolves.toMatchObject({ mode: 'session_sync_v2_pending_input_v1' });

        socket.connected = false;
        await expect(controller.resolve({ sessionConnectionEpoch: 1, socket, machineId: 'machine' }))
            .resolves.toMatchObject({ mode: 'indeterminate' });
        socket.connected = true;
        await expect(controller.resolve({ sessionConnectionEpoch: 1, socket, machineId: 'machine' }))
            .resolves.toMatchObject({ mode: 'session_sync_v2_pending_input_v1' });

        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it('re-probes the same connected authority after a settled indeterminate result', async () => {
        const socket = createSocket();
        const fetchImpl = vi.fn()
            .mockResolvedValueOnce(jsonResponse(currentFeatures, 503))
            .mockResolvedValueOnce(jsonResponse(currentFeatures));
        const controller = createSessionSyncPendingInputServerContractController({
            serverUrl: 'https://server.example', token: 'token', fetchImpl,
        });
        const probe = { sessionConnectionEpoch: 1, socket, machineId: 'machine' };

        await expect(controller.resolve(probe)).resolves.toMatchObject({ mode: 'indeterminate' });
        await expect(controller.resolve(probe)).resolves.toMatchObject({
            mode: 'session_sync_v2_pending_input_v1',
            sessionConnectionEpoch: 1,
            socket,
        });

        expect(fetchImpl).toHaveBeenCalledTimes(2);
        expect(socket.emitWithAck).toHaveBeenCalledTimes(1);
    });

    it('keeps the HTTP body read inside the compatibility probe timeout', async () => {
        vi.useFakeTimers();
        try {
            let result: Awaited<ReturnType<ReturnType<typeof createSessionSyncPendingInputServerContractController>['resolve']>> | undefined;
            const fetchImpl = vi.fn(async (
                _input: Parameters<typeof fetch>[0],
                init?: Parameters<typeof fetch>[1],
            ) => {
                const signal = init?.signal;
                const response = new Response(null, { status: 200 });
                Object.defineProperty(response, 'json', {
                    value: () => new Promise<never>((_resolve, reject) => {
                        signal?.addEventListener('abort', () => reject(new Error('body read aborted')), { once: true });
                    }),
                });
                return response;
            });
            const socket = createSocket();
            const controller = createSessionSyncPendingInputServerContractController({
                serverUrl: 'https://server.example', token: 'token', timeoutMs: 10, fetchImpl,
            });

            void controller.resolve({ sessionConnectionEpoch: 1, socket, machineId: 'machine' })
                .then((resolved) => { result = resolved; });
            await vi.advanceTimersByTimeAsync(10);

            expect(result).toMatchObject({ mode: 'indeterminate', sessionConnectionEpoch: 1, socket });
            expect(socket.emitWithAck).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    it('single-flights the exact epoch/socket and rejects same-epoch replacement sockets and same-socket replacement epochs', async () => {
        const firstFetch = deferred<Response>();
        const fetchImpl = vi.fn().mockImplementationOnce(() => firstFetch.promise).mockResolvedValue(jsonResponse(currentFeatures));
        const socketA = createSocket({});
        const socketB = createSocket({});
        const controller = createSessionSyncPendingInputServerContractController({ serverUrl: 'https://server.example', token: 'token', fetchImpl });

        const first = controller.resolve({ sessionConnectionEpoch: 1, socket: socketA, machineId: 'machine' });
        const same = controller.resolve({ sessionConnectionEpoch: 1, socket: socketA, machineId: 'machine' });
        expect(same).toBe(first);
        const replacementSocket = controller.resolve({ sessionConnectionEpoch: 1, socket: socketB, machineId: 'machine' });
        await expect(replacementSocket).resolves.toMatchObject({ mode: 'indeterminate', socket: socketB });
        firstFetch.resolve(jsonResponse(releasedServerFeatures));
        await expect(first).resolves.toMatchObject({ mode: 'indeterminate', socket: socketA });

        const replacementEpoch = controller.resolve({ sessionConnectionEpoch: 2, socket: socketB, machineId: 'machine' });
        await expect(replacementEpoch).resolves.toMatchObject({ mode: 'indeterminate', sessionConnectionEpoch: 2, socket: socketB });
        expect(fetchImpl).toHaveBeenCalledTimes(3);
    });

    it('does not let a stale completion poison a re-resolved identical epoch/socket', async () => {
        const releases = [deferred<Response>(), deferred<Response>()];
        const fetchImpl = vi.fn()
            .mockImplementationOnce(() => releases[0]!.promise)
            .mockImplementationOnce(() => releases[1]!.promise);
        const socket = createSocket();
        const controller = createSessionSyncPendingInputServerContractController({ serverUrl: 'https://server.example', token: 'token', fetchImpl });
        const probe = { sessionConnectionEpoch: 1, socket, machineId: 'machine' };

        const stale = controller.resolve(probe);
        controller.invalidate({ sessionConnectionEpoch: 1, socket });
        const current = controller.resolve(probe);
        releases[0]!.resolve(jsonResponse(currentFeatures));
        await expect(stale).resolves.toMatchObject({ mode: 'indeterminate' });
        releases[1]!.resolve(jsonResponse(currentFeatures));
        await expect(current).resolves.toMatchObject({ mode: 'session_sync_v2_pending_input_v1' });
        expect(socket.emitWithAck).toHaveBeenCalledTimes(1);
    });

    it('rejects a disconnect after the socket ACK starts', async () => {
        const ack = deferred<unknown>();
        const socket = createSocket();
        socket.emitWithAck.mockImplementationOnce(() => ack.promise);
        const controller = createSessionSyncPendingInputServerContractController({
            serverUrl: 'https://server.example', token: 'token',
            fetchImpl: vi.fn().mockResolvedValue(jsonResponse(currentFeatures)),
        });

        const resolving = controller.resolve({ sessionConnectionEpoch: 1, socket, machineId: 'machine' });
        await vi.waitFor(() => expect(socket.emitWithAck).toHaveBeenCalledTimes(1));
        socket.connected = false;
        ack.resolve(currentAck);
        await expect(resolving).resolves.toMatchObject({ mode: 'indeterminate' });
    });

    it('invalidates to a no-I/O indeterminate result for the exact active authority', async () => {
        const socket = createSocket();
        const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(currentFeatures));
        const controller = createSessionSyncPendingInputServerContractController({
            serverUrl: 'https://server.example', token: 'token', fetchImpl,
        });
        await controller.resolve({ sessionConnectionEpoch: 3, socket, machineId: 'machine' });
        fetchImpl.mockClear();
        socket.emitWithAck.mockClear();

        expect(controller.invalidate({ sessionConnectionEpoch: 3, socket })).toEqual({
            mode: 'indeterminate', sessionConnectionEpoch: 3, socket,
        });
        expect(fetchImpl).not.toHaveBeenCalled();
        expect(socket.emitWithAck).not.toHaveBeenCalled();
    });

    it('invalidates an explicit epoch/socket authority even when no probe is active', () => {
        const socket = createSocket();
        const fetchImpl = vi.fn();
        const controller = createSessionSyncPendingInputServerContractController({
            serverUrl: 'https://server.example', token: 'token', fetchImpl,
        });

        expect(controller.invalidate({ sessionConnectionEpoch: 3, socket })).toEqual({
            mode: 'indeterminate', sessionConnectionEpoch: 3, socket,
        });
        expect(fetchImpl).not.toHaveBeenCalled();
        expect(socket.emitWithAck).not.toHaveBeenCalled();
    });
});
