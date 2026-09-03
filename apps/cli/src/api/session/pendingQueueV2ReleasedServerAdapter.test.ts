import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { continuePendingQueueV2OnReleasedServer } from './pendingQueueV2ReleasedServerAdapter';

type ReleasedAck =
    | { ok: true; didMaterialize: false }
    | {
        ok: true;
        didMaterialize: true;
        didWrite: boolean;
        message: { id: string; seq: number; localId: string };
    }
    | { ok: false; error: 'invalid-params' | 'session-not-found' | 'forbidden' | 'internal' };

function positiveAck(): ReleasedAck {
    return {
        ok: true,
        didMaterialize: true,
        didWrite: true,
        message: { id: 'message-1', seq: 4, localId: 'local-1' },
    };
}

function positiveMessage() {
    return {
        id: 'message-1',
        seq: 4,
        localId: 'local-1',
        sidechainId: null,
        createdAt: 100,
        updatedAt: 101,
        content: { t: 'plain' as const, v: { role: 'user', content: { type: 'text', text: 'hello' } } },
    };
}

function harness(
    ack: ReleasedAck = positiveAck(),
    reportDiagnosticPhase?: (phase: string) => void,
) {
    const socket = {
        connected: true,
        emitWithAck: vi.fn().mockResolvedValue(ack),
        timeout: vi.fn().mockReturnThis(),
    };
    let epoch = 7;
    let activeSocket: object = socket;
    let runtimeCurrent = true;
    const contract = {
        mode: 'released_server_v0_2_1' as const,
        runtimeActivity: 'legacy' as const,
        pendingInput: 'released_server_v0_2_1' as const,
        sessionConnectionEpoch: 7,
        socket,
    };
    let activeContract: typeof contract | object = contract;
    return {
        socket,
        contract,
        setEpoch: (next: number) => { epoch = next; },
        setSocket: (next: object) => { activeSocket = next; },
        setRuntimeCurrent: (next: boolean) => { runtimeCurrent = next; },
        replaceContract: () => { activeContract = { ...contract }; },
        run: () => continuePendingQueueV2OnReleasedServer({
            contract,
            getServerContract: () => activeContract as typeof contract,
            token: 'token',
            serverUrl: 'https://server.example',
            sessionId: 'session-1',
            getSessionConnectionEpoch: () => epoch,
            getSocket: () => activeSocket,
            hasCurrentLocalRuntimeAuthority: () => runtimeCurrent,
            decodeStoredContent: (content) => content.t === 'plain' ? content.v : null,
            reportDiagnosticPhase,
        }),
    };
}

function mockLookupMessage(message: unknown = positiveMessage()) {
    return vi.spyOn(axios, 'get').mockResolvedValue({
        status: 200,
        data: { message },
    });
}

function axiosFailure(status: number, data: unknown): Error {
    return Object.assign(new Error(`HTTP ${status}`), {
        isAxiosError: true,
        response: { status, data },
    });
}

describe('released server pending continuation', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('continues its own exact didWrite acknowledgement through the real parser and one exact lookup', async () => {
        const reportDiagnosticPhase = vi.fn();
        const target = harness(positiveAck(), reportDiagnosticPhase);
        const get = mockLookupMessage();

        await expect(target.run()).resolves.toEqual({
            type: 'materialized',
            message: {
                id: 'message-1',
                seq: 4,
                localId: 'local-1',
                messageRole: 'user',
                content: positiveMessage().content,
                createdAt: 100,
                updatedAt: 101,
            },
        });
        expect(target.socket.emitWithAck).toHaveBeenCalledTimes(1);
        expect(target.socket.emitWithAck).toHaveBeenCalledWith('pending-materialize-next', { sid: 'session-1' });
        expect(get).toHaveBeenCalledWith(
            'https://server.example/v2/sessions/session-1/messages/by-local-id/local-1',
            expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer token' }) }),
        );
        expect(reportDiagnosticPhase.mock.calls).toEqual([
            ['materialize.server_claim'],
            ['materialize.compatibility_transcript_lookup'],
        ]);
    });

    it.each([
        { ok: true as const, didMaterialize: false as const },
        { ...positiveAck(), didWrite: false },
        { ok: false as const, error: 'forbidden' as const },
    ])('does no exact lookup or provider-eligible continuation for released ACK %#', async (ack) => {
        const target = harness(ack);
        const get = vi.spyOn(axios, 'get');

        await expect(target.run()).resolves.toEqual({
            type: ack.ok && ack.didMaterialize === false ? 'no_pending' : 'zero_effect',
        });
        expect(get).not.toHaveBeenCalled();
    });

    it.each([
        ['identity mismatch', { ...positiveMessage(), seq: 5 }],
        ['sidechain content', { ...positiveMessage(), sidechainId: 'sidechain-1' }],
        ['non-user content', { ...positiveMessage(), content: { t: 'plain' as const, v: { role: 'agent', content: { type: 'output', data: 'no' } } } }],
        ['non-text user content', { ...positiveMessage(), content: { t: 'plain' as const, v: { role: 'user', content: { type: 'image', url: 'no' } } } }],
        ['invalid timestamp', { ...positiveMessage(), updatedAt: Number.MAX_SAFE_INTEGER + 1 }],
        ['fractional timestamp', { ...positiveMessage(), updatedAt: 101.5 }],
    ])('fails closed for %s exact-read content', async (_name, message) => {
        const target = harness();
        mockLookupMessage(message);

        await expect(target.run()).resolves.toEqual({ type: 'zero_effect' });
    });

    it.each([
        ['not found', axiosFailure(404, { error: 'Message not found' })],
        ['authentication', axiosFailure(403, { error: 'forbidden' })],
        ['protocol error', axiosFailure(409, { error: 'conflict' })],
        ['network exhaustion', Object.assign(new Error('offline'), { isAxiosError: true, code: 'ECONNREFUSED' })],
    ])('fails closed for %s exact-read failure', async (name, error) => {
        const target = harness();
        vi.spyOn(axios, 'get').mockRejectedValue(error);

        await expect(target.run()).resolves.toEqual(
            name === 'authentication'
                ? { type: 'auth_failed', statusCode: 403 }
                : { type: 'zero_effect' },
        );
    });

    it.each(['contract', 'epoch', 'socket', 'disconnect', 'authority'] as const)(
        'fails closed when %s changes during the exact lookup',
        async (change) => {
            const target = harness();
            vi.spyOn(axios, 'get').mockImplementation(async () => {
                if (change === 'contract') target.replaceContract();
                if (change === 'epoch') target.setEpoch(8);
                if (change === 'socket') target.setSocket({ connected: true });
                if (change === 'disconnect') target.socket.connected = false;
                if (change === 'authority') target.setRuntimeCurrent(false);
                return { status: 200, data: { message: positiveMessage() } };
            });

            await expect(target.run()).resolves.toEqual({ type: 'zero_effect' });
        },
    );

    it('does not report authentication from an exact lookup after its contract result was replaced', async () => {
        const target = harness();
        vi.spyOn(axios, 'get').mockImplementation(async () => {
            target.replaceContract();
            throw axiosFailure(403, { error: 'forbidden' });
        });

        await expect(target.run()).resolves.toEqual({ type: 'zero_effect' });
    });

    it('retries only the identical exact lookup after a transient failure without materializing again', async () => {
        vi.useFakeTimers();
        const target = harness();
        const get = vi.spyOn(axios, 'get')
            .mockRejectedValueOnce(Object.assign(new Error('offline'), {
                isAxiosError: true,
                code: 'ECONNRESET',
            }))
            .mockResolvedValueOnce({ status: 200, data: { message: positiveMessage() } });

        const continuation = target.run();
        await vi.advanceTimersByTimeAsync(100);

        await expect(continuation).resolves.toMatchObject({
            type: 'materialized',
            message: { localId: 'local-1' },
        });
        expect(target.socket.emitWithAck).toHaveBeenCalledTimes(1);
        expect(get).toHaveBeenCalledTimes(2);
        expect(get.mock.calls[1]).toEqual(get.mock.calls[0]);
    });

    it('does not retry the exact lookup after runtime authority is lost during backoff', async () => {
        vi.useFakeTimers();
        const target = harness();
        const get = vi.spyOn(axios, 'get')
            .mockRejectedValueOnce(Object.assign(new Error('offline'), {
                isAxiosError: true,
                code: 'ECONNRESET',
            }));

        const continuation = target.run();
        await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(1));
        target.setRuntimeCurrent(false);
        await vi.advanceTimersByTimeAsync(100);

        await expect(continuation).resolves.toEqual({ type: 'zero_effect' });
        expect(target.socket.emitWithAck).toHaveBeenCalledTimes(1);
        expect(get).toHaveBeenCalledTimes(1);
    });
});
