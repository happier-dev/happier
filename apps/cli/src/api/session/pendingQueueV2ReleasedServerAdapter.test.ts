import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runPendingQueueV2ReleasedServerAdapter } from './pendingQueueV2ReleasedServerAdapter';
import { encodeBase64, encrypt } from '../encryption';
import { configuration } from '@/configuration';

const axiosGetMock = vi.hoisted(() => vi.fn());

vi.mock('axios', async (importOriginal) => {
    const actual = await importOriginal<typeof import('axios')>();
    return {
        ...actual,
        default: {
            ...actual.default,
            get: axiosGetMock,
            isAxiosError: actual.default.isAxiosError,
        },
    };
});

function createSocket(ack: unknown) {
    const socket = {
        connected: true,
        timeout: vi.fn(() => socket),
        emitWithAck: vi.fn(async () => ack),
    };
    return socket;
}

function createHarness(overrides: Record<string, unknown> = {}) {
    const socket = createSocket({
        ok: true,
        didMaterialize: true,
        didWrite: true,
        message: { id: 'message-1', seq: 12, localId: 'local-1' },
    });
    const contractResult = {
        mode: 'released_server_v0_2_1' as const,
        runtimeActivity: 'legacy' as const,
        pendingInput: 'released_server_v0_2_1' as const,
        publisherAuthority: 'indeterminate' as const,
        sessionConnectionEpoch: 4,
        socket,
    };
    let currentContractResult: typeof contractResult | null = contractResult;
    let runtimeAuthorityCurrent = true;
    const deliverMaterializedUserMessageToAgentQueue = vi.fn((_message: Parameters<Parameters<typeof runPendingQueueV2ReleasedServerAdapter>[0]['deliverMaterializedUserMessageToAgentQueue']>[0]) => true);
    const params = {
        token: 'token-1',
        serverUrl: 'https://server.example',
        sessionId: 'session-1',
        contractResult,
        getContractResult: () => currentContractResult,
        getSessionConnectionEpoch: () => 4,
        getSocket: () => socket,
        isRuntimeAuthorityCurrent: () => runtimeAuthorityCurrent,
        mode: 'plain' as const,
        ctx: null,
        deliverMaterializedUserMessageToAgentQueue,
        ...overrides,
    };
    return {
        socket,
        contractResult,
        params,
        deliverMaterializedUserMessageToAgentQueue,
        replaceContractResult: () => { currentContractResult = { ...contractResult }; },
        revokeRuntimeAuthority: () => { runtimeAuthorityCurrent = false; },
    };
}

function transcriptMessage(overrides: Record<string, unknown> = {}) {
    return {
        id: 'message-1',
        seq: 12,
        localId: 'local-1',
        sidechainId: null,
        createdAt: 100,
        updatedAt: 101,
        content: {
            t: 'plain',
            v: { role: 'user', content: { type: 'text', text: 'released prompt' } },
        },
        ...overrides,
    };
}

describe('released-server Pending-input adapter', () => {
    it('preserves a thrown claim failure rather than reporting an empty queue', async () => {
        const harness = createHarness();
        const failure = new Error('socket disconnected');
        harness.socket.emitWithAck.mockRejectedValueOnce(failure);
        await expect(runPendingQueueV2ReleasedServerAdapter(harness.params)).rejects.toBe(failure);
    });

    it('reports an explicit failed claim as unavailable rather than an empty queue', async () => {
        const harness = createHarness();
        harness.socket.emitWithAck.mockResolvedValueOnce({ ok: false, error: 'internal' });
        await expect(runPendingQueueV2ReleasedServerAdapter(harness.params)).rejects.toMatchObject({ message: 'internal' });
        expect(harness.deliverMaterializedUserMessageToAgentQueue).not.toHaveBeenCalled();
    });

    it('keeps a missing exact transcript read distinct from an empty queue', async () => {
        const harness = createHarness();
        const failure = Object.assign(new Error('missing'), { isAxiosError: true,
            response: { status: 404, data: { error: 'Message not found' } } });
        axiosGetMock.mockRejectedValue(failure);
        const operation = runPendingQueueV2ReleasedServerAdapter(harness.params);
        await expect(operation).resolves.toEqual({ type: 'retryable_transport' });
        expect(harness.socket.emitWithAck).toHaveBeenCalledTimes(1);
        expect(harness.deliverMaterializedUserMessageToAgentQueue).not.toHaveBeenCalled();
    });
    it('leaves requester unknown when an old Home supplies only body-authored attribution', async () => {
        const harness = createHarness();
        const actionRequestAttributionV1 = {
            requestRef: 'local-1', requester: { serverId: 'home', accountId: 'mallory' },
            persona: { serverId: 'home', sessionId: 'session-1' }, origin: null,
        };
        axiosGetMock.mockResolvedValueOnce({ status: 200, data: { message: transcriptMessage({
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'old Home' }, actionRequestAttributionV1 } },
        }) } });
        await expect(runPendingQueueV2ReleasedServerAdapter(harness.params)).resolves.toMatchObject({ type: 'materialized' });
        expect(harness.deliverMaterializedUserMessageToAgentQueue.mock.calls[0]?.[0])
            .toHaveProperty('actionRequestAttributionV1', undefined);
    });

    beforeEach(() => {
        vi.useRealTimers();
        axiosGetMock.mockReset();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it.each(['plain', 'corrupt', 'encrypted'] as const)('opens %s content under E2EE before provider delivery', async (envelope) => {
        const payload = { role: 'user', content: { type: 'text', text: 'released prompt' } };
        const content = envelope === 'plain'
            ? { t: 'plain', v: payload }
            : { t: 'encrypted', c: envelope === 'corrupt' ? 'invalid' : encodeBase64(encrypt(new Uint8Array(32), 'legacy', payload)) };
        const harness = createHarness();
        axiosGetMock.mockResolvedValueOnce({ status: 200, data: { message: transcriptMessage({ content }) } });

        const operation = runPendingQueueV2ReleasedServerAdapter({
            ...harness.params,
            mode: 'e2ee',
            ctx: { encryptionKey: new Uint8Array(32), encryptionVariant: 'legacy' },
        });
        if (envelope === 'encrypted') {
            const result = await operation;
            expect(result).toMatchObject({ type: 'materialized', localId: 'local-1' });
            expect(harness.deliverMaterializedUserMessageToAgentQueue).toHaveBeenCalledWith({
                ...payload, localId: 'local-1', createdAt: 100,
            }, 'send');
        } else {
            await expect(operation).rejects.toThrow();
            expect(harness.deliverMaterializedUserMessageToAgentQueue).not.toHaveBeenCalled();
        }
    });

    it('does not open encrypted content under a plain Session', async () => {
        const harness = createHarness();
        axiosGetMock.mockResolvedValueOnce({ status: 200, data: { message: transcriptMessage({
            content: { t: 'encrypted', c: encodeBase64(encrypt(new Uint8Array(32), 'legacy', { role: 'user', content: { type: 'text', text: 'released prompt' } })) },
        }) } });
        await expect(runPendingQueueV2ReleasedServerAdapter(harness.params)).rejects.toThrow();
        expect(harness.deliverMaterializedUserMessageToAgentQueue).not.toHaveBeenCalled();
    });

    it('looks up the exact ACK identity and invokes the ordinary provider callback exactly once', async () => {
        const harness = createHarness();
        axiosGetMock.mockResolvedValueOnce({ status: 200, data: { message: transcriptMessage() } });

        await expect(runPendingQueueV2ReleasedServerAdapter(harness.params)).resolves.toEqual({
            type: 'materialized',
            localId: 'local-1',
            seq: 12,
            content: transcriptMessage().content,
            createdAt: 100,
            updatedAt: 101,
        });
        expect(harness.socket.emitWithAck).toHaveBeenCalledWith('pending-materialize-next', { sid: 'session-1' });
        expect(axiosGetMock).toHaveBeenCalledWith(
            'https://server.example/v2/sessions/session-1/messages/by-local-id/local-1',
            expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer token-1' }) }),
        );
        expect(harness.deliverMaterializedUserMessageToAgentQueue).toHaveBeenCalledTimes(1);
        expect(harness.deliverMaterializedUserMessageToAgentQueue).toHaveBeenCalledWith({
            role: 'user',
            content: { type: 'text', text: 'released prompt' },
            localId: 'local-1',
            createdAt: 100,
        }, 'send');
    });

    it('returns zero input for the exact no-pending ACK without a transcript lookup', async () => {
        const harness = createHarness();
        harness.socket.emitWithAck.mockResolvedValueOnce({ ok: true, didMaterialize: false });

        await expect(runPendingQueueV2ReleasedServerAdapter(harness.params)).resolves.toEqual({ type: 'no_pending' });
        expect(axiosGetMock).not.toHaveBeenCalled();
        expect(harness.deliverMaterializedUserMessageToAgentQueue).not.toHaveBeenCalled();
    });

    it('treats an exact didWrite false materialization ACK as zero input without lookup or delivery', async () => {
        const harness = createHarness();
        harness.socket.emitWithAck.mockResolvedValueOnce({
            ok: true,
            didMaterialize: true,
            didWrite: false,
            message: { id: 'message-1', seq: 12, localId: 'local-1' },
        });

        await expect(runPendingQueueV2ReleasedServerAdapter(harness.params)).resolves.toEqual({ type: 'no_pending' });
        expect(axiosGetMock).not.toHaveBeenCalled();
        expect(harness.deliverMaterializedUserMessageToAgentQueue).not.toHaveBeenCalled();
    });

    it.each([
        ['id', { id: 'other' }],
        ['seq', { seq: 13 }],
        ['localId', { localId: 'other' }],
        ['sidechain', { sidechainId: 'branch' }],
        ['timestamp', { createdAt: -1 }],
        ['canonical user text', { content: { t: 'plain', v: { type: 'user', text: 'coercible' } } }],
    ])('rejects a mismatched or malformed %s transcript row before provider input', async (_name, rowOverride) => {
        const harness = createHarness();
        axiosGetMock.mockResolvedValueOnce({ status: 200, data: { message: transcriptMessage(rowOverride) } });

        await expect(runPendingQueueV2ReleasedServerAdapter(harness.params)).rejects.toThrow();
        expect(harness.deliverMaterializedUserMessageToAgentQueue).not.toHaveBeenCalled();
    });

    it('rejects replaced result-object authority after lookup starts', async () => {
        let release!: (value: unknown) => void;
        axiosGetMock.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
        const harness = createHarness();

        const pending = runPendingQueueV2ReleasedServerAdapter(harness.params);
        await vi.waitFor(() => expect(axiosGetMock).toHaveBeenCalledTimes(1));
        harness.replaceContractResult();
        release({ status: 200, data: { message: transcriptMessage() } });

        await expect(pending).resolves.toEqual({ type: 'retryable_transport' });
        expect(harness.deliverMaterializedUserMessageToAgentQueue).not.toHaveBeenCalled();
    });

    it('rejects lost runtime authority immediately before provider delivery', async () => {
        const harness = createHarness();
        axiosGetMock.mockImplementationOnce(async () => {
            harness.revokeRuntimeAuthority();
            return { status: 200, data: { message: transcriptMessage() } };
        });

        await expect(runPendingQueueV2ReleasedServerAdapter(harness.params)).resolves.toEqual({ type: 'retryable_transport' });
        expect(harness.deliverMaterializedUserMessageToAgentQueue).not.toHaveBeenCalled();
    });

    it('maps lookup authentication failure to auth_failure without provider input', async () => {
        const harness = createHarness();
        const error = new axios.AxiosError('unauthorized', 'ERR_BAD_RESPONSE', undefined, undefined, {
            status: 401,
            statusText: 'Unauthorized',
            headers: new axios.AxiosHeaders(),
            config: { headers: new axios.AxiosHeaders() },
            data: {},
        });
        axiosGetMock.mockRejectedValueOnce(error);

        await expect(runPendingQueueV2ReleasedServerAdapter(harness.params)).resolves.toEqual({ type: 'auth_failure' });
        expect(harness.deliverMaterializedUserMessageToAgentQueue).not.toHaveBeenCalled();
    });

    it('retains the popped original through repeated unhealthy exact reads without rematerializing', async () => {
        vi.useFakeTimers();
        const harness = createHarness();
        axiosGetMock
            .mockRejectedValueOnce(Object.assign(new Error('offline'), {
                isAxiosError: true,
                code: 'ECONNRESET',
            }))
            .mockRejectedValueOnce(Object.assign(new Error('offline'), { isAxiosError: true, code: 'ECONNRESET' }))
            .mockRejectedValueOnce(Object.assign(new Error('offline'), { isAxiosError: true, code: 'ECONNRESET' }))
            .mockResolvedValueOnce({ status: 200, data: { message: transcriptMessage() } });

        const operation = runPendingQueueV2ReleasedServerAdapter(harness.params);
        await vi.waitFor(() => expect(axiosGetMock).toHaveBeenCalledTimes(1));
        await vi.advanceTimersByTimeAsync(configuration.transcriptLookupErrorBackoffBaseMs * 3);

        await expect(operation).resolves.toMatchObject({
            type: 'materialized',
            localId: 'local-1',
        });
        expect(harness.socket.emitWithAck).toHaveBeenCalledTimes(1);
        expect(axiosGetMock).toHaveBeenCalledTimes(4);
        expect(axiosGetMock.mock.calls[1]).toEqual([
            axiosGetMock.mock.calls[0]?.[0],
            { ...axiosGetMock.mock.calls[0]?.[1], beforeRedirect: expect.any(Function) },
        ]);
        expect(harness.deliverMaterializedUserMessageToAgentQueue).toHaveBeenCalledTimes(1);
    });

    it('does not retry the exact lookup after runtime authority is lost during canonical backoff', async () => {
        vi.useFakeTimers();
        const harness = createHarness();
        axiosGetMock.mockRejectedValueOnce(Object.assign(new Error('offline'), {
            isAxiosError: true,
            code: 'ECONNRESET',
        }));

        const operation = runPendingQueueV2ReleasedServerAdapter(harness.params);
        await vi.waitFor(() => expect(axiosGetMock).toHaveBeenCalledTimes(1));
        harness.revokeRuntimeAuthority();
        await vi.advanceTimersByTimeAsync(configuration.transcriptLookupErrorBackoffBaseMs);

        await expect(operation).resolves.toEqual({ type: 'retryable_transport' });
        expect(harness.socket.emitWithAck).toHaveBeenCalledTimes(1);
        expect(axiosGetMock).toHaveBeenCalledTimes(1);
        expect(harness.deliverMaterializedUserMessageToAgentQueue).not.toHaveBeenCalled();
    });

    it('cancels the exact lookup backoff with the containing caller lifetime', async () => {
        vi.useFakeTimers();
        const controller = new AbortController();
        const harness = createHarness({ signal: controller.signal });
        axiosGetMock.mockRejectedValue(Object.assign(new Error('offline'), { isAxiosError: true, code: 'ECONNRESET' }));
        const operation = runPendingQueueV2ReleasedServerAdapter(harness.params);
        await vi.waitFor(() => expect(axiosGetMock).toHaveBeenCalledTimes(1));
        controller.abort();
        await expect(operation).resolves.toEqual({ type: 'retryable_transport' });
        expect(harness.socket.emitWithAck).toHaveBeenCalledTimes(1);
        expect(axiosGetMock).toHaveBeenCalledTimes(1);
        expect(harness.deliverMaterializedUserMessageToAgentQueue).not.toHaveBeenCalled();
    });

    it('does not report materialized or retry when the ordinary provider callback declines the row', async () => {
        const deliver = vi.fn(() => false);
        const harness = createHarness({ deliverMaterializedUserMessageToAgentQueue: deliver });
        axiosGetMock.mockResolvedValueOnce({ status: 200, data: { message: transcriptMessage() } });

        await expect(runPendingQueueV2ReleasedServerAdapter(harness.params)).resolves.toEqual({ type: 'retryable_transport' });
        expect(deliver).toHaveBeenCalledTimes(1);
        expect(harness.socket.emitWithAck).toHaveBeenCalledTimes(1);
        expect(axiosGetMock).toHaveBeenCalledTimes(1);
    });
});
