import { beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { SocketAckError } from '@/session/transport/shared/socketAck';

import {
    blockPendingQueueV2Delivery,
    blockPendingExecutionRunDelivery,
    enqueuePendingQueueV2MessageViaHttp,
    PendingQueueAcceptedSettlementError,
    isAcceptedPendingQueueV2DeliveryAckResponseLoss,
    listPendingQueueV2DeliveryStatusesFromServer,
    listPendingQueueV2ProviderDeliveryLocalIdsFromServer,
    materializeNextPendingQueueV2Message,
    materializeNextPendingExecutionRunMessage,
    materializeNextPendingQueueV2MessageViaHttp,
    materializeNextPendingQueueV2MessageViaReleasedServerSocket,
    readAcceptedPendingQueueV2DeliveryRetryDirective,
    readPendingQueueV2DeliveryFailureByLocalIdFromServer,
    readPendingQueueV2MessageContentByLocalIdFromServer,
    readPendingQueueV2ActivationEligibilityFromServer,
    resolveAcceptedPendingQueueV2Delivery,
    resolveAcceptedPendingExecutionRunDelivery,
    settlePendingQueueV2Admission,
    withdrawPendingQueueV2Message,
    listPendingQueueV2ResetStartDemands,
    updatePendingQueueV2RequestedAction,
    readPendingResetStartsForSource,
} from './pendingQueueV2Transport';

const { mockGet, mockPost, mockDelete, mockPatch } = vi.hoisted(() => ({
    mockGet: vi.fn(),
    mockPost: vi.fn(),
    mockDelete: vi.fn(),
    mockPatch: vi.fn(),
}));

vi.mock('axios', () => ({
    default: {
        get: mockGet,
        post: mockPost,
        delete: mockDelete,
        patch: mockPatch,
        isAxiosError: (error: unknown) => Boolean(
            error && typeof error === 'object' && (error as { isAxiosError?: unknown }).isAxiosError === true,
        ),
    },
}));

describe('pendingQueueV2Transport', () => {
    beforeEach(() => {
        mockGet.mockReset();
        mockPost.mockReset();
        mockDelete.mockReset();
        mockPatch.mockReset();
    });

    it('reads only reset-held queued inputs, preserving exact accepted witness identity', async () => {
        const reset = { source: { bindingKind: 'account', ref: { service: { pluginId: 'happier.agent.codex', localId: 'openai' }, accountId: 'account' } },
            recordId: 'paug_v1_abcdefgh', meterId: 'weekly', witness: { id: 'history-entry', observedAtMs: 1000 } };
        const requestedAction = { v: 1, kind: 'reset_start', reset };
        mockGet.mockResolvedValueOnce({ data: { pending: [
            { localId: 'held', status: 'queued', requestedAction },
            { localId: 'consumed', status: 'queued', deliveryState: 'delivering', requestedAction },
            { localId: 'discarded', status: 'discarded', requestedAction },
            { localId: 'ordinary', status: 'queued', requestedAction: { v: 1, kind: 'enqueue' } },
        ] } });
        expect(await listPendingQueueV2ResetStartDemands({ token: 'token', sessionId: 'session' })).toEqual([{ localId: 'held', reset }]);
    });

    it('reads source waiting metadata with exact signed request and rejects missing authority facts', async () => {
        const source = { bindingKind: 'account', ref: { service: { pluginId: 'happier.agent.codex', localId: 'openai' }, accountId: 'account' } } as const;
        mockPost.mockResolvedValueOnce({ data: { entries: [{ sessionId: 'session', localId: 'held', reset: {
            source, recordId: 'paug_v1_abcdefgh', meterId: 'weekly', witness: { id: 'accepted', observedAtMs: 1000 },
        } }] } });
        await expect(readPendingResetStartsForSource({ token: 'must-not-cross', source,
            authorizeRequest: () => ({ 'x-execution-proof': 'signed-read' }) })).rejects.toThrow();
        expect(mockPost.mock.calls[0]?.[2]?.headers).not.toHaveProperty('Authorization');
        mockPost.mockResolvedValueOnce({ data: { entries: [] } });
        expect(await readPendingResetStartsForSource({ token: 'token', source })).toEqual({ entries: [] });
    });

    it('refuses unsupported reset mutation at the PATCH boundary without immediate-send fallback', async () => {
        const requestedAction = { v: 1, kind: 'reset_start', reset: {
            source: { bindingKind: 'account', ref: { service: { pluginId: 'happier.agent.codex', localId: 'openai' }, accountId: 'account' } },
            recordId: 'paug_v1_abcdefgh', meterId: 'weekly', witness: { id: 'history-entry', observedAtMs: 1000 },
        } } as const;
        const denial = new Error('reset-start-unsupported');
        mockPatch.mockRejectedValueOnce(denial);
        await expect(updatePendingQueueV2RequestedAction({ token: 'must-not-use', sessionId: 'session', localId: 'held', requestedAction,
            resolveAuthorizationHeaders: () => ({ 'x-execution-proof': 'signed' }) })).rejects.toBe(denial);
        expect(mockPost).not.toHaveBeenCalled();
    });

    it.each([undefined, 'run/one'])('withdraws through the exact semantic POST owner with full body-bound authority (run %s)', async (targetExecutionRunId) => {
        mockPost.mockResolvedValueOnce({ data: { ok: true, outcome: 'removed' } });
        mockDelete.mockResolvedValueOnce({ data: { ok: true, outcome: 'removed' } });
        const resolveAuthorizationHeaders = vi.fn(() => ({ 'x-execution-proof': 'signed-withdraw' }));
        const path = targetExecutionRunId
            ? '/v2/sessions/session%2Fone/execution-runs/run%2Fone/pending/input%2Fone/withdraw'
            : '/v2/sessions/session%2Fone/pending/input%2Fone/withdraw';
        expect(await withdrawPendingQueueV2Message({ token: 'daemon-token-must-not-cross', sessionId: 'session/one',
            localId: 'input/one', ...(targetExecutionRunId ? { targetExecutionRunId } : {}), resolveAuthorizationHeaders,
        })).toEqual({ outcome: 'removed' });
        expect(resolveAuthorizationHeaders).toHaveBeenCalledWith({ method: 'POST', path, body: {} });
        expect(mockPost).toHaveBeenCalledWith(expect.stringContaining(path), {}, expect.objectContaining({
            headers: expect.objectContaining({ 'x-execution-proof': 'signed-withdraw' }),
        }));
        expect(mockPost.mock.calls[0]?.[2]?.headers).not.toHaveProperty('Authorization');
        expect(mockDelete).not.toHaveBeenCalled();
    });

    it('does not turn a malformed semantic withdrawal response into removal', async () => {
        mockPost.mockResolvedValueOnce({ data: { ok: true } });
        mockDelete.mockResolvedValueOnce({ data: { ok: true } });
        expect(await withdrawPendingQueueV2Message({ token: 'token', sessionId: 'session', localId: 'input',
            resolveAuthorizationHeaders: () => ({ 'x-execution-proof': 'signed-withdraw' }),
        })).toEqual({ outcome: 'delivery_unknown' });
    });

    it.each([
        [403, 'session_access_authentication_required', false],
        [503, 'session_access_authentication_unavailable', true],
    ] as const)('preserves Pending enqueue Team-auth continuation %s/%s', async (status, code, retryable) => {
        mockPost.mockRejectedValueOnce({ response: { status, data: { error: code } } });

        await expect(enqueuePendingQueueV2MessageViaHttp({
            token: 'token',
            sessionId: 'session-1',
            body: {
                localId: 'input-1',
                ciphertext: 'ciphertext',
                requestedAction: { v: 1, kind: 'enqueue' },
            },
        })).rejects.toMatchObject({ code, status, retryable });
    });

    it('uses the caller-bound authorization for the exact pending enqueue request without a bearer fallback', async () => {
        const body = {
            localId: 'input-1',
            content: { t: 'plain' as const, v: { role: 'user', content: { type: 'text', text: 'hello' } } },
            requestedAction: { v: 1 as const, kind: 'steer_if_active' as const },
        };
        const resolveAuthorizationHeaders = vi.fn(() => ({ 'x-execution-proof': 'signed' }));
        mockPost.mockResolvedValueOnce({ data: { didWrite: true } });

        await expect(enqueuePendingQueueV2MessageViaHttp({
            token: 'daemon-token-must-not-cross',
            sessionId: 'session/with spaces',
            body,
            resolveAuthorizationHeaders,
        })).resolves.toMatchObject({ didWrite: true });

        expect(resolveAuthorizationHeaders).toHaveBeenCalledWith({
            method: 'POST',
            path: '/v2/sessions/session%2Fwith%20spaces/pending',
            body,
        });
        const requestConfig = mockPost.mock.calls[0]?.[2] as { headers?: Record<string, string> } | undefined;
        expect(requestConfig?.headers).toMatchObject({ 'x-execution-proof': 'signed' });
        expect(requestConfig?.headers).not.toHaveProperty('Authorization');
    });

    it('claims only the exact execution-run socket resource and preserves its authenticated author', async () => {
        const recipient = { kind: 'execution_run' as const, runId: 'run-a' };
        const socket = {
            connected: true,
            timeout: vi.fn(() => socket),
            emitWithAck: vi.fn(async () => ({
                v: 2, ok: true, didMaterialize: false,
                recipient, sidechainId: 'sidechain-a', authorAccountId: null,
                deliveryState: { mode: 'provider', unresolved: false },
                pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 1,
            })),
        };
        await expect(materializeNextPendingExecutionRunMessage({
            socket: socket as never, sessionId: 'session-a', recipient,
            sidechainId: 'sidechain-a', foregroundState: 'ready',
            deliveryTiming: 'after_foreground_ready',
        })).resolves.toMatchObject({ didMaterialize: false, recipient, sidechainId: 'sidechain-a', authorAccountId: null });
        expect(socket.emitWithAck).toHaveBeenCalledWith('session-pending-execution-run-materialize-next-v2', {
            v: 2, sessionId: 'session-a', recipient, sidechainId: 'sidechain-a',
            foregroundState: 'ready', deliveryTiming: 'after_foreground_ready',
        });
        expect(mockPost).not.toHaveBeenCalled();
    });

    it.each([
        { recipient: { kind: 'execution_run', runId: 'run-b' }, sidechainId: 'sidechain-a' },
        { recipient: { kind: 'execution_run', runId: 'run-a' }, sidechainId: 'sidechain-b' },
        { recipient: { kind: 'execution_run', runId: 'run-a', label: 'forged' }, sidechainId: 'sidechain-a' },
        {},
    ])('rejects mismatched target acknowledgement without main or HTTP fallback: %j', async (echo) => {
        const socket = {
            connected: true,
            timeout: vi.fn(() => socket),
            emitWithAck: vi.fn(async () => ({
                v: 2, ok: true, didMaterialize: false, authorAccountId: null,
                deliveryState: { mode: 'provider', unresolved: false },
                pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 1, ...echo,
            })),
        };
        await expect(materializeNextPendingExecutionRunMessage({
            socket: socket as never, sessionId: 'session-a',
            recipient: { kind: 'execution_run', runId: 'run-a' },
            sidechainId: 'sidechain-a', foregroundState: 'ready', deliveryTiming: 'after_foreground_ready',
        })).rejects.toMatchObject({ classification: 'malformed_ack' });
        expect(socket.emitWithAck).toHaveBeenCalledTimes(1);
        expect(mockPost).not.toHaveBeenCalled();
    });

    it('settles the exact target user anchor and rejects a different localId', async () => {
        const recipient = { kind: 'execution_run' as const, runId: 'run-a' };
        const ack = {
            v: 2, recipient, sidechainId: 'sidechain-a',
            result: {
                ok: true, didResolve: true,
                pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 2,
                message: {
                    id: 'message-a', localId: 'input-a', seq: 8,
                    content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'hello' } } },
                    createdAt: 1, updatedAt: 1,
                },
            },
        };
        const socket = {
            connected: true, timeout: vi.fn(() => socket), emitWithAck: vi.fn(async () => ack),
        };
        const request = { socket: socket as never, sessionId: 'session-a', recipient, sidechainId: 'sidechain-a', localId: 'input-a' };
        await expect(resolveAcceptedPendingExecutionRunDelivery(request)).resolves.toMatchObject({
            didResolve: true, message: { localId: 'input-a', seq: 8 },
        });
        expect(socket.emitWithAck).toHaveBeenCalledWith('session-pending-execution-run-delivery-accepted-v2', {
            v: 2, sessionId: 'session-a', recipient, sidechainId: 'sidechain-a', localId: 'input-a',
        });
        ack.result.message.localId = 'other-input';
        await expect(resolveAcceptedPendingExecutionRunDelivery(request)).rejects.toThrow();
        expect(mockPost).not.toHaveBeenCalled();
    });

    it('blocks unavailable target input through the authenticated publisher without an Account fallback', async () => {
        const recipient = { kind: 'execution_run' as const, runId: 'run-a' };
        const socket = {
            connected: true, timeout: vi.fn(() => socket),
            emitWithAck: vi.fn(async () => ({
                v: 2, recipient, localId: 'input-a',
                result: { ok: true, didUpdate: true, pendingCount: 1, pendingBlockedCount: 1, pendingVersion: 2 },
            })),
        };
        await expect(blockPendingExecutionRunDelivery({
            socket: socket as never, sessionId: 'session-a', recipient, localId: 'input-a',
            reason: 'session_input_target_unavailable',
        })).resolves.toMatchObject({ didUpdate: true });
        expect(socket.emitWithAck).toHaveBeenCalledWith('session-pending-execution-run-delivery-block-v2', {
            v: 2, sessionId: 'session-a', recipient, localId: 'input-a', reason: 'session_input_target_unavailable',
        });
        expect(mockPost).not.toHaveBeenCalled();
    });

    it('reads one exact pending message content for durable admission rejoin', async () => {
        const content = {
            t: 'plain' as const,
            v: { role: 'user', content: { type: 'text', text: 'prepared' }, meta: {} },
        };
        mockGet.mockResolvedValueOnce({
            data: {
                pending: [
                    { localId: 'other', content },
                    { localId: 'message-1', content },
                ],
            },
        });

        await expect(readPendingQueueV2MessageContentByLocalIdFromServer({
            token: 'token',
            sessionId: 'session-1',
            localId: 'message-1',
        })).resolves.toEqual(content);
    });

    it('degrades a conditional-steer settlement to a strict block on an older server', async () => {
        mockPost
            .mockRejectedValueOnce({ isAxiosError: true, response: { status: 400 } })
            .mockResolvedValueOnce({
                data: { ok: true, pendingCount: 1, pendingBlockedCount: 1, pendingVersion: 3 },
            });

        await expect(blockPendingQueueV2Delivery({
            token: 'token',
            sessionId: 'session-1',
            localId: 'conditional-steer-1',
            reason: 'conditional_steer_unavailable',
        })).resolves.toMatchObject({ usedLegacySteeringUnavailableFallback: true });
        expect(mockPost.mock.calls.map((call) => call[1])).toEqual([
            { reason: 'conditional_steer_unavailable' },
            { reason: 'steering_unavailable' },
        ]);
    });

    it('uses the exact released-server socket request and accepts only its strict positive ACK', async () => {
        const socket = {
            connected: true,
            timeout: vi.fn(() => socket),
            emitWithAck: vi.fn(async () => ({
                ok: true,
                didMaterialize: true,
                didWrite: true,
                message: { id: 'message-1', seq: 12, localId: 'local-1' },
            })),
        };

        await expect(materializeNextPendingQueueV2MessageViaReleasedServerSocket({
            socket: socket as never,
            sessionId: 'session-1',
        })).resolves.toEqual({
            type: 'materialized',
            didWrite: true,
            message: { id: 'message-1', seq: 12, localId: 'local-1' },
        });
        expect(socket.emitWithAck).toHaveBeenCalledWith('pending-materialize-next', { sid: 'session-1' });
    });

    it.each([
        [{ ok: true, didMaterialize: false }, { type: 'no_pending' }],
        [{ ok: false, error: 'internal' }, { type: 'error', error: 'internal' }],
        [{ ok: false, error: 'future-error' }, { type: 'error', error: 'malformed_ack' }],
        [{ ok: true, didMaterialize: false, pendingCount: 0 }, { type: 'error', error: 'malformed_ack' }],
        [{ ok: true, didMaterialize: true, didWrite: true, message: { id: '', seq: 1, localId: 'local' } }, { type: 'error', error: 'malformed_ack' }],
        [{ ok: true, didMaterialize: true, didWrite: true, message: { id: '   ', seq: 1, localId: 'local' } }, { type: 'error', error: 'malformed_ack' }],
        [{ ok: true, didMaterialize: true, didWrite: true, message: { id: 'id', seq: 1, localId: '\t' } }, { type: 'error', error: 'malformed_ack' }],
        [{ ok: true, didMaterialize: true, didWrite: false, message: { id: 'id', seq: 1, localId: 'local' } }, {
            type: 'materialized',
            didWrite: false,
            message: { id: 'id', seq: 1, localId: 'local' },
        }],
        [{ ok: true, didMaterialize: true, didWrite: true, message: { id: 'id', seq: -1, localId: 'local' } }, { type: 'error', error: 'malformed_ack' }],
        [{ ok: true, didMaterialize: true, didWrite: true, message: { id: 'id', seq: 1, localId: 'local', extra: true } }, { type: 'error', error: 'malformed_ack' }],
    ])('strictly classifies released-server ACK %#', async (ack, expected) => {
        const socket = {
            connected: true,
            timeout: vi.fn(() => socket),
            emitWithAck: vi.fn(async () => ack),
        };
        await expect(materializeNextPendingQueueV2MessageViaReleasedServerSocket({
            socket: socket as never,
            sessionId: 'session-1',
        })).resolves.toEqual(expected);
    });

    it('uses legacy HTTP materialization unless provider delivery state is explicitly requested', async () => {
        mockPost.mockResolvedValueOnce({
            data: {
                ok: true,
                didMaterialize: false,
                pendingCount: 0,
                pendingVersion: 1,
            },
        });

        await expect(materializeNextPendingQueueV2MessageViaHttp({
            token: 'token',
            sessionId: 'session-1',
        })).resolves.toMatchObject({
            didMaterialize: false,
            pendingQueueState: {
                known: true,
                pendingCount: 0,
                pendingVersion: 1,
            },
        });

        expect(mockPost).toHaveBeenCalledTimes(1);
        expect(mockPost.mock.calls[0]?.[1]).toEqual({});
    });

    it('passes runtime-idle delivery timing through HTTP materialization and returns deferred delivery state', async () => {
        mockPost.mockResolvedValueOnce({
            data: {
                ok: true,
                didMaterialize: false,
                pendingCount: 1,
                pendingBlockedCount: 0,
                pendingVersion: 7,
                deferredReason: 'waiting_for_runtime_activity',
                localId: 'runtime-idle-head',
            },
        });

        await expect(materializeNextPendingQueueV2MessageViaHttp({
            token: 'token',
            sessionId: 'session-1',
            deliveryTiming: 'after_runtime_idle',
        } as Parameters<typeof materializeNextPendingQueueV2MessageViaHttp>[0] & { deliveryTiming: 'after_runtime_idle' })).resolves.toMatchObject({
            didMaterialize: false,
            pendingQueueState: {
                known: true,
                pendingCount: 1,
                pendingBlockedCount: 0,
                pendingVersion: 7,
            },
            deliveryState: null,
            deferredReason: 'waiting_for_runtime_activity',
            localId: 'runtime-idle-head',
        });

        expect(mockPost).toHaveBeenCalledTimes(1);
        expect(mockPost.mock.calls[0]?.[1]).toEqual({ deliveryTiming: 'after_runtime_idle' });
    });

    it('passes runtime-idle delivery timing through socket materialization and returns deferred delivery state', async () => {
        const socket = {
            connected: true,
            timeout: vi.fn(() => socket),
            emitWithAck: vi.fn(async () => ({
                ok: true,
                didMaterialize: false,
                pendingCount: 1,
                pendingBlockedCount: 0,
                pendingVersion: 8,
                deferredReason: 'waiting_for_runtime_activity',
                localId: 'runtime-idle-head',
            })),
        };

        await expect(materializeNextPendingQueueV2Message({
            token: 'token',
            sessionId: 'session-1',
            socket: socket as any,
            deliveryTiming: 'after_runtime_idle',
        } as Parameters<typeof materializeNextPendingQueueV2Message>[0] & { deliveryTiming: 'after_runtime_idle' })).resolves.toMatchObject({
            didMaterialize: false,
            pendingQueueState: {
                known: true,
                pendingCount: 1,
                pendingBlockedCount: 0,
                pendingVersion: 8,
            },
            deliveryState: null,
            deferredReason: 'waiting_for_runtime_activity',
            localId: 'runtime-idle-head',
        });

        expect(socket.emitWithAck).toHaveBeenCalledWith('pending-materialize-next', {
            sid: 'session-1',
            deliveryTiming: 'after_runtime_idle',
        });
        expect(mockPost).not.toHaveBeenCalled();
    });

    it('never redrives a durable row over HTTP after a connected socket attempt becomes ambiguous', async () => {
        const socketError = new Error('socket acknowledgement lost');
        const socket = {
            connected: true,
            timeout: vi.fn(() => socket),
            emitWithAck: vi.fn(async () => { throw socketError; }),
        };

        const materialization = materializeNextPendingQueueV2Message({
            token: 'token',
            sessionId: 'session-1',
            socket: socket as any,
            knownPendingVersion: 4,
        });
        await expect(materialization).rejects.toBe(socketError);
        await expect(materialization).rejects.toMatchObject({
            diagnosticCode: 'pending_queue_materialization_transport_failure',
            classification: 'transport_failure',
        });
        expect(mockPost).not.toHaveBeenCalled();
    });

    it('distinguishes typed negative and malformed current materialization ACKs', async () => {
        const typedNegativeSocket = {
            connected: true,
            timeout: vi.fn(() => typedNegativeSocket),
            emitWithAck: vi.fn(async () => ({ ok: false, error: 'forbidden' })),
        };
        await expect(materializeNextPendingQueueV2Message({
            token: 'token',
            sessionId: 'session-1',
            socket: typedNegativeSocket as any,
            deliveryStateOptIn: true,
        })).rejects.toMatchObject({
            diagnosticCode: 'pending_queue_materialization_server_rejected',
            classification: 'server_rejected',
            serverError: 'forbidden',
        });

        const malformedSocket = {
            connected: true,
            timeout: vi.fn(() => malformedSocket),
            emitWithAck: vi.fn(async () => ({ ok: 'not-a-boolean' })),
        };
        await expect(materializeNextPendingQueueV2Message({
            token: 'token',
            sessionId: 'session-1',
            socket: malformedSocket as any,
            deliveryStateOptIn: true,
        })).rejects.toMatchObject({
            diagnosticCode: 'pending_queue_materialization_ack_malformed',
            classification: 'malformed_ack',
        });

        expect(mockPost).not.toHaveBeenCalled();
    });

    it('preserves typed transaction-unavailable materialization retry guidance', async () => {
        const socket = {
            connected: true,
            timeout: vi.fn(() => socket),
            emitWithAck: vi.fn(async () => ({
                ok: false,
                error: 'transaction-unavailable',
                retryAfterMs: 1_000,
            })),
        };

        await expect(materializeNextPendingQueueV2Message({
            token: 'token',
            sessionId: 'session-1',
            socket: socket as any,
            deliveryStateOptIn: true,
        })).rejects.toMatchObject({
            diagnosticCode: 'pending_queue_materialization_server_retryable',
            classification: 'server_retryable',
            serverError: 'transaction-unavailable',
            retryAfterMs: 1_000,
        });
        expect(mockPost).not.toHaveBeenCalled();
    });

    it('preserves the socket timeout error while adding a stable materialization diagnostic', async () => {
        const timeoutError = new SocketAckError({
            code: 'socket_ack_timeout',
            event: 'pending-materialize-next',
            timeoutMs: 10_000,
        });
        const socket = {
            connected: true,
            timeout: vi.fn(() => socket),
            emitWithAck: vi.fn(async () => { throw timeoutError; }),
        };
        const materialization = materializeNextPendingQueueV2Message({
            token: 'token',
            sessionId: 'session-1',
            socket: socket as any,
            deliveryStateOptIn: true,
        });

        await expect(materialization).rejects.toBe(timeoutError);
        await expect(materialization).rejects.toMatchObject({
            code: 'socket_ack_timeout',
            diagnosticCode: 'pending_queue_materialization_ack_timeout',
            classification: 'ack_timeout',
        });
        expect(mockPost).not.toHaveBeenCalled();
    });

    it('accepts row-first unresolved provider delivery materialization responses under provider delivery opt-in', async () => {
        mockPost.mockResolvedValueOnce({
            data: {
                ok: true,
                didMaterialize: true,
                localId: 'provider-local',
                didWriteMessage: true,
                pendingCount: 1,
                pendingVersion: 2,
                message: {
                    id: 'm-provider',
                    seq: 42,
                    localId: 'provider-local',
                    providerAction: 'send',
                    messageRole: 'user',
                    content: {
                        t: 'plain',
                        v: {
                            role: 'user',
                            content: { type: 'text', text: 'provider prompt' },
                            localId: 'provider-local',
                        },
                    },
                    deliveryState: { mode: 'provider', unresolved: true },
                    createdAt: 1_000,
                    updatedAt: 1_000,
                },
            },
        });

        await expect(materializeNextPendingQueueV2MessageViaHttp({
            token: 'token',
            sessionId: 'session-1',
            deliveryStateOptIn: true,
        } as Parameters<typeof materializeNextPendingQueueV2MessageViaHttp>[0] & { deliveryStateOptIn: true })).resolves.toMatchObject({
            didMaterialize: true,
            localId: 'provider-local',
            didWrite: true,
            message: {
                id: 'm-provider',
                seq: 42,
                localId: 'provider-local',
                deliveryState: { mode: 'provider', unresolved: true },
            },
        });

        expect(mockPost).toHaveBeenCalledTimes(1);
        expect(mockPost.mock.calls[0]?.[1]).toEqual({ deliveryState: 'provider' });
    });

    it('accepts an idempotent provider claim only with its exact committed transcript anchor', async () => {
        mockPost.mockResolvedValueOnce({
            data: {
                ok: true,
                didMaterialize: true,
                localId: 'provider-current-local',
                didWriteMessage: false,
                pendingCount: 1,
                pendingVersion: 2,
                deliveryState: { mode: 'provider', unresolved: true },
                message: {
                    id: 'm-provider-current',
                    seq: 44,
                    localId: 'provider-current-local',
                    providerAction: 'send',
                    messageRole: 'user',
                    content: {
                        t: 'plain',
                        v: {
                            role: 'user',
                            content: { type: 'text', text: 'current provider prompt' },
                            localId: 'provider-current-local',
                        },
                    },
                    createdAt: 1_000,
                    updatedAt: 1_000,
                },
            },
        });

        await expect(materializeNextPendingQueueV2MessageViaHttp({
            token: 'token',
            sessionId: 'session-1',
            deliveryStateOptIn: true,
        })).resolves.toMatchObject({
            didMaterialize: true,
            localId: 'provider-current-local',
            didWrite: false,
            message: {
                id: 'm-provider-current',
                seq: 44,
                localId: 'provider-current-local',
                deliveryState: { mode: 'provider', unresolved: true },
            },
        });
    });

    it('rejects an idempotent committed anchor without unresolved provider state', async () => {
        mockPost.mockResolvedValueOnce({
            data: {
                ok: true,
                didMaterialize: true,
                localId: 'provider-current-local',
                didWriteMessage: false,
                pendingCount: 1,
                pendingVersion: 2,
                message: {
                    id: 'm-provider-current',
                    seq: 44,
                    localId: 'provider-current-local',
                    providerAction: 'send',
                    messageRole: 'user',
                    content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'prompt' } } },
                    createdAt: 1_000,
                    updatedAt: 1_000,
                },
            },
        });

        await expect(materializeNextPendingQueueV2MessageViaHttp({
            token: 'token',
            sessionId: 'session-1',
            deliveryStateOptIn: true,
        })).rejects.toMatchObject({
            name: 'PendingProviderDeliveryMaterializationContractError',
            localId: 'provider-current-local',
        });
    });

    it('rejects committed provider delivery materialization responses without unresolved provider state', async () => {
        mockPost.mockResolvedValueOnce({
            data: {
                ok: true,
                didMaterialize: true,
                localId: 'provider-local',
                didWriteMessage: true,
                pendingCount: 1,
                pendingVersion: 2,
                message: {
                    id: 'm-provider',
                    seq: 42,
                    localId: 'provider-local',
                    messageRole: 'user',
                    content: {
                        t: 'plain',
                        v: {
                            role: 'user',
                            content: { type: 'text', text: 'provider prompt' },
                            localId: 'provider-local',
                        },
                    },
                    createdAt: 1_000,
                    updatedAt: 1_000,
                },
            },
        });

        await expect(materializeNextPendingQueueV2MessageViaHttp({
            token: 'token',
            sessionId: 'session-1',
            deliveryStateOptIn: true,
        } as Parameters<typeof materializeNextPendingQueueV2MessageViaHttp>[0] & { deliveryStateOptIn: true })).rejects.toThrow(/provider delivery/i);
    });

    it('rejects incompatible provider delivery socket ACKs without falling back to HTTP', async () => {
        const socket = {
            connected: true,
            timeout: vi.fn(() => socket),
            emitWithAck: vi.fn(async () => ({
                ok: true,
                didMaterialize: true,
                localId: 'legacy-socket-local',
                didWrite: true,
                pendingCount: 0,
                pendingVersion: 4,
                message: {
                    id: 'm-legacy-socket',
                    seq: 43,
                    localId: 'legacy-socket-local',
                    messageRole: 'user',
                    content: {
                        t: 'plain',
                        v: {
                            role: 'user',
                            content: { type: 'text', text: 'legacy socket prompt' },
                            localId: 'legacy-socket-local',
                        },
                    },
                    createdAt: 1_000,
                    updatedAt: 1_000,
                },
            })),
        };

        await expect(materializeNextPendingQueueV2Message({
            token: 'token',
            sessionId: 'session-1',
            socket: socket as any,
            deliveryStateOptIn: true,
        })).rejects.toThrow(/provider delivery/i);

        expect(socket.emitWithAck).toHaveBeenCalledWith('pending-materialize-next', {
            sid: 'session-1',
            deliveryState: 'provider',
        });
        expect(mockPost).not.toHaveBeenCalled();
    });

    it.each([undefined, 'future_action'])(
        'rejects provider delivery HTTP materialization with %s providerAction',
        async (providerAction) => {
            mockPost.mockResolvedValueOnce({
                data: {
                    ok: true,
                    didMaterialize: true,
                    localId: 'invalid-action-http',
                    didWriteMessage: false,
                    pendingCount: 1,
                    pendingVersion: 2,
                    message: {
                        id: null,
                        seq: null,
                        localId: 'invalid-action-http',
                        messageRole: 'user',
                        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'prompt' } } },
                        deliveryState: { mode: 'provider', unresolved: true },
                        ...(providerAction === undefined ? {} : { providerAction }),
                        createdAt: 1_000,
                        updatedAt: 1_000,
                    },
                },
            });

            await expect(materializeNextPendingQueueV2MessageViaHttp({
                token: 'token',
                sessionId: 'session-1',
                deliveryStateOptIn: true,
            })).rejects.toMatchObject({
                name: 'PendingProviderDeliveryMaterializationContractError',
                localId: 'invalid-action-http',
            });
        },
    );

    it('rejects a malformed providerAction socket ACK without falling back to HTTP', async () => {
        const socket = {
            connected: true,
            timeout: vi.fn(() => socket),
            emitWithAck: vi.fn(async () => ({
                ok: true,
                didMaterialize: true,
                localId: 'invalid-action-socket',
                didWrite: false,
                pendingCount: 1,
                pendingVersion: 2,
                message: {
                    id: null,
                    seq: null,
                    localId: 'invalid-action-socket',
                    messageRole: 'user',
                    content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'prompt' } } },
                    deliveryState: { mode: 'provider', unresolved: true },
                    providerAction: 'future_action',
                    createdAt: 1_000,
                    updatedAt: 1_000,
                },
            })),
        };

        await expect(materializeNextPendingQueueV2Message({
            token: 'token',
            sessionId: 'session-1',
            socket: socket as any,
            deliveryStateOptIn: true,
        })).rejects.toMatchObject({
            name: 'PendingProviderDeliveryMaterializationContractError',
            localId: 'invalid-action-socket',
        });
        expect(mockPost).not.toHaveBeenCalled();
    });

  it('accepts provider claim materialization responses with null transcript id and seq', async () => {
    mockPost.mockResolvedValueOnce({
      data: {
        ok: true,
        didMaterialize: true,
                localId: 'provider-claim-local',
                didWriteMessage: false,
                pendingCount: 1,
                pendingVersion: 2,
                deliveryState: { mode: 'provider', unresolved: true },
                message: {
                    id: null,
                    seq: null,
                    localId: 'provider-claim-local',
                    providerAction: 'send',
                    inputAdmissionReceipt: { v: 1, issuer: 'authenticatedMachine' },
                    messageRole: null,
                    content: {
                        t: 'encrypted',
                        c: 'cipher-provider-claim',
                    },
                    createdAt: 1_000,
                    updatedAt: 1_000,
                },
            },
        });

        await expect(materializeNextPendingQueueV2MessageViaHttp({
            token: 'token',
            sessionId: 'session-1',
            deliveryStateOptIn: true,
        } as Parameters<typeof materializeNextPendingQueueV2MessageViaHttp>[0] & { deliveryStateOptIn: true })).resolves.toMatchObject({
            didMaterialize: true,
            localId: 'provider-claim-local',
            didWrite: false,
            message: {
                id: null,
                seq: null,
                localId: 'provider-claim-local',
                messageRole: null,
                inputAdmissionReceipt: { v: 1, issuer: 'authenticatedMachine' },
                content: { t: 'encrypted', c: 'cipher-provider-claim' },
                deliveryState: { mode: 'provider', unresolved: true },
      },
    });
  });

  it('retains authenticated machine admission receipts from socket claims', async () => {
    const socket = {
      connected: true,
      timeout: vi.fn(() => socket),
      emitWithAck: vi.fn(async () => ({
        ok: true,
        didMaterialize: true,
        localId: 'protected-local',
        didWrite: false,
        pendingCount: 1,
        pendingVersion: 2,
        message: {
          id: null,
          seq: null,
          localId: 'protected-local',
          providerAction: 'send',
          messageRole: 'user',
          inputAdmissionReceipt: { v: 1, issuer: 'authenticatedMachine' },
          content: {
            t: 'plain',
            v: { role: 'user', content: { type: 'text', text: 'protected prompt' } },
          },
          createdAt: 1_000,
          updatedAt: 1_000,
          deliveryState: { mode: 'provider', unresolved: true },
        },
      })),
    };

    await expect(materializeNextPendingQueueV2Message({
      token: 'token',
      sessionId: 'session-1',
      socket: socket as any,
      deliveryStateOptIn: true,
    })).resolves.toMatchObject({
      didMaterialize: true,
      message: {
        inputAdmissionReceipt: { v: 1, issuer: 'authenticatedMachine' },
      },
    });
  });

  it('accepts provider claim materialization responses with opaque ids and omitted delivery state', async () => {
    mockPost.mockResolvedValueOnce({
      data: {
        ok: true,
        didMaterialize: true,
        localId: 'provider-claim-opaque-local',
        didWriteMessage: false,
        pendingCount: 1,
        pendingVersion: 2,
        message: {
          id: 'opaque-pending-materialization-id',
          seq: null,
          localId: 'provider-claim-opaque-local',
          providerAction: 'send',
          messageRole: 'user',
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: 'opaque id provider claim prompt' },
              localId: 'provider-claim-opaque-local',
            },
          },
          createdAt: 1_000,
          updatedAt: 1_000,
        },
      },
    });

    await expect(materializeNextPendingQueueV2MessageViaHttp({
      token: 'token',
      sessionId: 'session-1',
      deliveryStateOptIn: true,
    } as Parameters<typeof materializeNextPendingQueueV2MessageViaHttp>[0] & { deliveryStateOptIn: true })).resolves.toMatchObject({
      didMaterialize: true,
      localId: 'provider-claim-opaque-local',
      didWrite: false,
      message: {
        id: 'opaque-pending-materialization-id',
        seq: null,
        localId: 'provider-claim-opaque-local',
        content: {
          t: 'plain',
          v: {
            role: 'user',
            content: { type: 'text', text: 'opaque id provider claim prompt' },
            localId: 'provider-claim-opaque-local',
          },
        },
      },
    });
  });

  it('accepts provider claim materialization responses with stale resolved provider state', async () => {
    mockPost.mockResolvedValueOnce({
      data: {
        ok: true,
        didMaterialize: true,
        localId: 'provider-claim-resolved-local',
        didWriteMessage: false,
        pendingCount: 1,
        pendingVersion: 2,
        deliveryState: { mode: 'provider', unresolved: false },
        message: {
          id: 'opaque-resolved-state-materialization-id',
          seq: null,
          localId: 'provider-claim-resolved-local',
          providerAction: 'send',
          messageRole: 'user',
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: 'resolved provider state claim prompt' },
              localId: 'provider-claim-resolved-local',
            },
          },
          createdAt: 1_000,
          updatedAt: 1_000,
        },
      },
    });

    await expect(materializeNextPendingQueueV2MessageViaHttp({
      token: 'token',
      sessionId: 'session-1',
      deliveryStateOptIn: true,
    } as Parameters<typeof materializeNextPendingQueueV2MessageViaHttp>[0] & { deliveryStateOptIn: true })).resolves.toMatchObject({
      didMaterialize: true,
      localId: 'provider-claim-resolved-local',
      didWrite: false,
      message: {
        id: 'opaque-resolved-state-materialization-id',
        seq: null,
        localId: 'provider-claim-resolved-local',
        deliveryState: { mode: 'provider', unresolved: false },
      },
    });
  });

  it('fails closed when provider delivery opt-in is rejected instead of falling back to legacy materialization', async () => {
    const error = { response: { status: 400 } };
    mockPost.mockRejectedValueOnce(error);

        await expect(materializeNextPendingQueueV2MessageViaHttp({
            token: 'token',
            sessionId: 'session-1',
            deliveryStateOptIn: true,
        } as Parameters<typeof materializeNextPendingQueueV2MessageViaHttp>[0] & { deliveryStateOptIn: true })).rejects.toBe(error);

        expect(mockPost).toHaveBeenCalledTimes(1);
        expect(mockPost.mock.calls[0]?.[1]).toEqual({ deliveryState: 'provider' });
    });

    it('fails closed before HTTP when provider delivery has no bound session socket', async () => {
        const materialization = materializeNextPendingQueueV2Message({
            token: 'token',
            sessionId: 'session-1',
            socket: { connected: false } as any,
            deliveryStateOptIn: true,
        });
        await expect(materialization).rejects.toThrow('Provider pending materialization requires the bound session socket');
        await expect(materialization).rejects.toMatchObject({
            diagnosticCode: 'pending_queue_materialization_socket_disconnected',
            classification: 'socket_disconnected',
        });

        expect(mockPost).not.toHaveBeenCalled();
    });

    it('does not fall back on materialization authentication failures', async () => {
        mockPost.mockRejectedValueOnce({ response: { status: 401 } });

        await expect(materializeNextPendingQueueV2MessageViaHttp({
            token: 'token',
            sessionId: 'session-1',
            deliveryStateOptIn: true,
        } as Parameters<typeof materializeNextPendingQueueV2MessageViaHttp>[0] & { deliveryStateOptIn: true })).rejects.toMatchObject({
            response: { status: 401 },
        });

        expect(axios.post).toHaveBeenCalledWith(
            expect.stringContaining('/v2/sessions/session-1/pending/materialize-next'),
            { deliveryState: 'provider' },
            expect.objectContaining({
                headers: expect.objectContaining({ Authorization: 'Bearer token' }),
            }),
        );
        expect(mockPost).toHaveBeenCalledTimes(1);
    });

    it('posts manual provider delivery state actions to dedicated pending routes', async () => {
        const transport = await import('./pendingQueueV2Transport');
        mockPost.mockResolvedValueOnce({ data: { ok: true, pendingCount: 1, pendingVersion: 6 } });

        await expect((transport as any).blockPendingQueueV2Delivery({
            token: 'token',
            sessionId: 'session-1',
            localId: 'blocked-local',
            reason: 'delivery_outcome_uncertain',
        })).resolves.toEqual({
            pendingQueueState: { known: true, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 6 },
        });

        expect(mockPost.mock.calls[0]?.[0]).toContain('/v2/sessions/session-1/pending/blocked-local/delivery/block');
        expect(mockPost.mock.calls[0]?.[1]).toEqual({ reason: 'delivery_outcome_uncertain' });
    });

    it('settles accepted provider delivery only through the exact session publisher socket', async () => {
        const transport = await import('./pendingQueueV2Transport');
        const socket = {
            connected: true,
            timeout: vi.fn(() => socket),
            emitWithAck: vi.fn(async () => ({
                ok: true,
                didResolve: false,
                pendingCount: 1,
                pendingBlockedCount: 1,
                pendingVersion: 10,
            })),
        };

        await expect((transport as any).resolveAcceptedPendingQueueV2Delivery({
            socket,
            sessionId: 'session-1',
            localId: 'blocked-local',
        })).resolves.toEqual({
            didResolve: false,
            pendingQueueState: { known: true, pendingCount: 1, pendingBlockedCount: 1, pendingVersion: 10 },
            message: null,
        });
        expect(socket.emitWithAck).toHaveBeenCalledWith('pending-delivery-accepted-v1', {
            v: 1,
            sessionId: 'session-1',
            localId: 'blocked-local',
        });
        expect(mockPost).not.toHaveBeenCalled();
    });

    it('settles protected Session input only through the exact session publisher socket', async () => {
        const socket = {
            connected: true,
            timeout: vi.fn(() => socket),
            emitWithAck: vi.fn(async () => ({
                v: 1,
                result: { status: 'accepted', localId: 'admission-local' },
            })),
        };
        const decision = {
            kind: 'admit' as const,
            finalContent: {
                t: 'plain' as const,
                v: { role: 'user', content: { type: 'text', text: 'settled' } },
            },
        };

        await expect(settlePendingQueueV2Admission({
            socket: socket as never,
            sessionId: 'session-1',
            localId: 'admission-local',
            decision,
        })).resolves.toEqual({ status: 'accepted', localId: 'admission-local' });
        expect(socket.emitWithAck).toHaveBeenCalledWith('session-pending-admission-settlement-v1', {
            v: 1,
            sessionId: 'session-1',
            localId: 'admission-local',
            decision,
        });
        expect(mockPost).not.toHaveBeenCalled();
    });

    it('retains sealed host-observed acceptance in the publisher settlement request', async () => {
        const socket = {
            connected: true,
            timeout: vi.fn(() => socket),
            emitWithAck: vi.fn(async () => ({
                ok: true, didResolve: false, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 10,
            })),
        };
        const acceptedDelivery = { t: 'encrypted', c: 'sealed-exact-acceptance' } as const;
        const request = { socket: socket as never, sessionId: 'session-1', localId: 'accepted-local', acceptedDelivery };
        await resolveAcceptedPendingQueueV2Delivery(request);
        expect(socket.emitWithAck).toHaveBeenCalledWith('pending-delivery-accepted-v1', {
            v: 1, sessionId: 'session-1', localId: 'accepted-local', acceptedDelivery,
        });
    });

    it('preserves didResolve false from an accepted-delivery no-op response', async () => {
        const transport = await import('./pendingQueueV2Transport');
        const socket = {
            connected: true,
            timeout: vi.fn(() => socket),
            emitWithAck: vi.fn(async () => ({
                ok: true,
                didResolve: false,
                pendingCount: 1,
                pendingBlockedCount: 1,
                pendingVersion: 10,
            })),
        };

        await expect((transport as any).resolveAcceptedPendingQueueV2Delivery({
            socket,
            sessionId: 'session-1',
            localId: 'blocked-local',
        })).resolves.toEqual({
            didResolve: false,
            pendingQueueState: { known: true, pendingCount: 1, pendingBlockedCount: 1, pendingVersion: 10 },
            message: null,
        });
    });

    it('preserves the exact committed replay message on didResolve false', async () => {
        const transport = await import('./pendingQueueV2Transport');
        const socket = {
            connected: true,
            timeout: vi.fn(() => socket),
            emitWithAck: vi.fn(async () => ({
                ok: true,
                didResolve: false,
                pendingCount: 0,
                pendingBlockedCount: 0,
                pendingVersion: 11,
                message: {
                    id: 'm-replayed',
                    seq: 44,
                    localId: ' replayed-local ',
                    messageRole: 'user',
                    content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'replayed' } } },
                    createdAt: 1_000,
                    updatedAt: 1_001,
                },
            })),
        };

        await expect((transport as any).resolveAcceptedPendingQueueV2Delivery({
            socket,
            sessionId: 'session-1',
            localId: ' replayed-local ',
        })).resolves.toMatchObject({
            didResolve: false,
            message: { id: 'm-replayed', seq: 44, localId: ' replayed-local ' },
        });
    });

    it('parses typed transaction unavailability into a bounded accepted-settlement retry directive', async () => {
        const socket = {
            connected: true,
            timeout: vi.fn(() => socket),
            emitWithAck: vi.fn(async () => ({
                ok: false,
                error: 'transaction-unavailable',
                retryAfterMs: 1_250,
                correlationId: 'accepted-settlement-1',
            })),
        };

        const error = await resolveAcceptedPendingQueueV2Delivery({
            socket: socket as never,
            sessionId: 'session-1',
            localId: 'accepted-local',
        }).catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(PendingQueueAcceptedSettlementError);
        expect(readAcceptedPendingQueueV2DeliveryRetryDirective(error)).toEqual({
            retryAfterMs: 1_250,
            correlationId: 'accepted-settlement-1',
        });
    });

    it('distinguishes socket ACK response loss from typed server transaction unavailability', () => {
        const responseLoss = new SocketAckError({
            code: 'socket_ack_timeout',
            event: 'pending-delivery-accepted-v1',
            timeoutMs: 10_000,
        });
        const disconnected = new SocketAckError({
            code: 'socket_not_connected',
            event: 'pending-delivery-accepted-v1',
        });

        expect(isAcceptedPendingQueueV2DeliveryAckResponseLoss(responseLoss)).toBe(true);
        expect(isAcceptedPendingQueueV2DeliveryAckResponseLoss(disconnected)).toBe(false);
        expect(readAcceptedPendingQueueV2DeliveryRetryDirective(responseLoss)).toBeNull();
    });


    it('lists only queued provider-delivery local ids for close recovery', async () => {
        mockGet.mockResolvedValueOnce({
            data: {
                pending: [
                    { localId: 'provider-1', status: 'queued', deliveryState: 'delivering' },
                    { localId: 'regular-queued', status: 'queued', deliveryState: null },
                    { localId: 'provider-blocked', status: 'queued', deliveryState: 'blocked' },
                    { localId: 'discarded-provider', status: 'discarded', deliveryState: 'delivering' },
                    { localId: 'provider-1', status: 'queued', deliveryState: 'delivering' },
                    { localId: 'provider-2', status: 'queued', deliveryState: 'delivering' },
                ],
            },
        });

        await expect(listPendingQueueV2ProviderDeliveryLocalIdsFromServer({
            token: 'token',
            sessionId: 'session/with spaces',
        })).resolves.toEqual(['provider-1', 'provider-2']);

        expect(mockGet).toHaveBeenCalledWith(
            expect.stringContaining('/v2/sessions/session%2Fwith%20spaces/pending'),
            expect.objectContaining({
                headers: expect.objectContaining({ Authorization: 'Bearer token' }),
                timeout: 10_000,
            }),
        );
    });

    it('projects one canonical delivery status per pending local id', async () => {
        mockGet.mockResolvedValueOnce({
            data: {
                pending: [
                    { localId: 'delivering', status: 'queued', deliveryState: 'delivering' },
                    { localId: 'blocked', status: 'queued', deliveryStatus: { status: 'blocked', reason: 'runtime_config_blocked' } },
                    { localId: 'discarded', status: 'discarded', deliveryState: 'delivering' },
                    { localId: 'delivering', status: 'queued', deliveryState: 'blocked' },
                    { localId: '', status: 'queued', deliveryState: 'delivering' },
                ],
            },
        });

        await expect(listPendingQueueV2DeliveryStatusesFromServer({
            token: 'token',
            sessionId: 'session/with spaces',
        })).resolves.toEqual([
            { localId: 'delivering', status: 'delivering', deliveryStatus: { status: 'delivering', detail: 'awaiting_acceptance' } },
            { localId: 'blocked', status: 'blocked', deliveryStatus: { status: 'blocked', reason: 'runtime_config_blocked' } },
            { localId: 'discarded', status: 'discarded', deliveryStatus: { status: 'discarded', reason: null } },
        ]);
    });

    it('lists target delivery statuses from the exact run route and validates the recipient echo', async () => {
        const recipient = { kind: 'execution_run' as const, runId: 'run-a' };
        mockGet.mockResolvedValueOnce({
            data: {
                recipient,
                pending: [{ localId: 'target-input', status: 'queued', deliveryState: 'blocked', deliveryBlockedReason: 'provider_rejected_before_acceptance' }],
            },
        });

        await expect(listPendingQueueV2DeliveryStatusesFromServer({
            token: 'token', sessionId: 'session-a', recipient,
        })).resolves.toEqual([
            { localId: 'target-input', status: 'blocked', deliveryStatus: { status: 'blocked', reason: 'provider_rejected_before_acceptance' } },
        ]);
        expect(mockGet).toHaveBeenCalledWith(
            expect.stringContaining('/v2/sessions/session-a/execution-runs/run-a/pending'),
            expect.objectContaining({
                headers: expect.objectContaining({ Authorization: 'Bearer token' }),
                timeout: 10_000,
            }),
        );

        mockGet.mockResolvedValueOnce({
            data: { recipient: { kind: 'execution_run', runId: 'run-b' }, pending: [] },
        });
        await expect(listPendingQueueV2DeliveryStatusesFromServer({
            token: 'token', sessionId: 'session-a', recipient,
        })).rejects.toThrow('Target pending status recipient mismatch');
    });

    it('keeps whitespace-distinct opaque local ids separate in delivery status projection', async () => {
        mockGet.mockResolvedValueOnce({
            data: {
                pending: [
                    { localId: ' request-1', status: 'queued', deliveryState: 'delivering' },
                    { localId: 'request-1 ', status: 'queued', deliveryState: 'delivering' },
                ],
            },
        });

        await expect(listPendingQueueV2DeliveryStatusesFromServer({
            token: 'token',
            sessionId: 'session/with spaces',
        })).resolves.toEqual([
            { localId: ' request-1', status: 'delivering', deliveryStatus: { status: 'delivering', detail: 'awaiting_acceptance' } },
            { localId: 'request-1 ', status: 'delivering', deliveryStatus: { status: 'delivering', detail: 'awaiting_acceptance' } },
        ]);
    });

    it('prefers typed delivery status when listing provider-delivery local ids', async () => {
        mockGet.mockResolvedValueOnce({
            data: {
                pending: [
                    { localId: 'typed-provider', status: 'queued', deliveryState: null, deliveryStatus: { status: 'delivering' } },
                    { localId: 'raw-provider', status: 'queued', deliveryState: 'delivering' },
                    { localId: 'typed-blocked', status: 'queued', deliveryState: 'delivering', deliveryStatus: { status: 'blocked', reason: 'runtime_config_blocked' } },
                ],
            },
        });

        await expect(listPendingQueueV2ProviderDeliveryLocalIdsFromServer({
            token: 'token',
            sessionId: 'session/with spaces',
        })).resolves.toEqual(['typed-provider', 'raw-provider']);
    });

    it('reads blocked provider delivery state for a specific local id', async () => {
        mockGet.mockResolvedValueOnce({
            data: {
                pending: [
                    { localId: 'other-local', status: 'queued', deliveryState: 'blocked', deliveryBlockedReason: 'provider_rejected_before_acceptance' },
                    { localId: 'blocked-local', status: 'queued', deliveryState: 'blocked', deliveryBlockedReason: 'runtime_disposed_before_delivery' },
                    { localId: 'delivering-local', status: 'queued', deliveryState: 'delivering', deliveryBlockedReason: 'runtime_disposed_before_delivery' },
                ],
            },
        });

        await expect(readPendingQueueV2DeliveryFailureByLocalIdFromServer({
            token: 'token',
            sessionId: 'session/with spaces',
            localId: 'blocked-local',
        })).resolves.toEqual({
            localId: 'blocked-local',
            reason: 'runtime_disposed_before_delivery',
        });

        expect(mockGet).toHaveBeenCalledWith(
            expect.stringContaining('/v2/sessions/session%2Fwith%20spaces/pending'),
            expect.objectContaining({
                headers: expect.objectContaining({ Authorization: 'Bearer token' }),
                timeout: 10_000,
            }),
        );
    });

    it('prefers typed blocked delivery status for a specific local id', async () => {
        mockGet.mockResolvedValueOnce({
            data: {
                pending: [
                    {
                        localId: 'blocked-local',
                        status: 'queued',
                        deliveryState: 'delivering',
                        deliveryBlockedReason: null,
                        deliveryStatus: { status: 'blocked', reason: 'payload_too_large' },
                    },
                ],
            },
        });

        await expect(readPendingQueueV2DeliveryFailureByLocalIdFromServer({
            token: 'token',
            sessionId: 'session/with spaces',
            localId: 'blocked-local',
        })).resolves.toEqual({
            localId: 'blocked-local',
            reason: 'payload_too_large',
        });
    });

    it('admits the exact queued user row for authorized activation without coupling delivery priority', async () => {
        mockGet.mockResolvedValueOnce({
            data: {
                pending: [
                    {
                        localId: 'eligible',
                        messageRole: 'user',
                        requestedAction: { v: 1, kind: 'send_now' },
                        deliveryStatus: { status: 'queued' },
                    },
                ],
            },
        });
        await expect(readPendingQueueV2ActivationEligibilityFromServer({
            token: 'token', sessionId: 'session-1', requestId: 'eligible',
        })).resolves.toBe('eligible');

        mockGet.mockResolvedValueOnce({
            data: {
                pending: [{
                    localId: 'authorized-enqueue',
                    messageRole: 'user',
                    requestedAction: { v: 1, kind: 'enqueue' },
                    deliveryStatus: { status: 'queued' },
                }],
            },
        });
        await expect(readPendingQueueV2ActivationEligibilityFromServer({
            token: 'token', sessionId: 'session-1', requestId: 'authorized-enqueue',
        })).resolves.toBe('eligible');

        mockGet.mockResolvedValueOnce({ data: { pending: [] } });
        await expect(readPendingQueueV2ActivationEligibilityFromServer({
            token: 'token', sessionId: 'session-1', requestId: 'resolved',
        })).resolves.toBe('missing');
    });
});
