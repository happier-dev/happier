import { beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { serializeOutboundError } from './outboundErrorSerialization';

import {
    blockPendingQueueV2Delivery,
    enqueuePendingQueueV2MessageViaHttp,
    readBlockedPendingQueueV2DeliveryByLocalIdFromServer,
    listPendingQueueV2LocalIdsFromServer,
    listPendingQueueV2DeliveryStatusesFromServer,
    listPendingQueueV2ProviderDeliveryLocalIdsFromServer,
    markPendingQueueV2DeliveryHandled,
    materializeNextPendingQueueV2Message,
    materializeNextPendingQueueV2MessageOnReleasedServer,
    materializeNextPendingQueueV2MessageViaHttp,
    PendingQueueMaterializationTransportAmbiguousError,
    readAcceptedPendingQueueV2DeliveryRetryDirective,
    resolveAcceptedPendingQueueV2Delivery,
} from './pendingQueueV2Transport';

const { mockGet, mockPost } = vi.hoisted(() => ({
    mockGet: vi.fn(),
    mockPost: vi.fn(),
}));

vi.mock('axios', () => ({
    default: {
        get: mockGet,
        post: mockPost,
        isAxiosError: () => false,
    },
}));

describe('pendingQueueV2Transport', () => {
    beforeEach(() => {
        mockGet.mockReset();
        mockPost.mockReset();
    });

    it('accepts a terminal enqueue rejoin only with the exact committed-message localId', async () => {
        const localId = ' exact-cli-local ';
        const requestedAction = { v: 1, kind: 'enqueue' } as const;
        mockPost.mockResolvedValueOnce({
            data: {
                didWrite: false,
                terminal: true,
                message: { id: 'message-1', seq: 5, localId, requestedAction },
            },
        });

        await expect(enqueuePendingQueueV2MessageViaHttp({
            token: 'token',
            sessionId: 'session-1',
            body: {
                localId,
                ciphertext: 'cipher',
                requestedAction,
            },
        })).resolves.toEqual({ didWrite: false, terminal: true, suppressed: false });

        mockPost.mockResolvedValueOnce({
            data: {
                didWrite: false,
                terminal: true,
                message: { id: 'message-1', seq: 5, localId: 'different-local', requestedAction },
            },
        });
        await expect(enqueuePendingQueueV2MessageViaHttp({
            token: 'token',
            sessionId: 'session-1',
            body: {
                localId,
                ciphertext: 'cipher',
                requestedAction,
            },
        })).rejects.toThrow('Invalid Pending enqueue terminal proof');

        mockPost.mockResolvedValueOnce({
            data: {
                didWrite: false,
                terminal: true,
                message: {
                    id: 'message-1',
                    seq: 5,
                    localId,
                    requestedAction: { v: 1, kind: 'send_now' },
                },
            },
        });
        await expect(enqueuePendingQueueV2MessageViaHttp({
            token: 'token',
            sessionId: 'session-1',
            body: {
                localId,
                ciphertext: 'cipher',
                requestedAction,
            },
        })).rejects.toThrow('Invalid Pending enqueue terminal proof');
    });

    it('preserves conditional continuation admission and parses suppression', async () => {
        mockPost.mockResolvedValueOnce({
            data: { didWrite: false, suppressed: true },
        });

        await expect(enqueuePendingQueueV2MessageViaHttp({
            token: 'token',
            sessionId: 'session-1',
            body: {
                localId: 'connected-service-continuation:test',
                ciphertext: 'cipher',
                requestedAction: { v: 1, kind: 'send_now' },
                deliveryMode: 'continuation_if_no_queued_user_input',
            },
        })).resolves.toEqual({ didWrite: false, terminal: false, suppressed: true });
        expect(mockPost).toHaveBeenCalledWith(
            expect.stringContaining('/v2/sessions/session-1/pending'),
            expect.objectContaining({
                localId: 'connected-service-continuation:test',
                deliveryMode: 'continuation_if_no_queued_user_input',
            }),
            expect.any(Object),
        );
    });

    it('rejects whitespace-only enqueue identity before transport', async () => {
        await expect(enqueuePendingQueueV2MessageViaHttp({
            token: 'token',
            sessionId: 'session-1',
            body: {
                localId: ' \t\r\n ',
                ciphertext: 'cipher',
                requestedAction: { v: 1, kind: 'enqueue' },
            },
        })).rejects.toThrow('Pending localId must not be blank');
        expect(mockPost).not.toHaveBeenCalled();
    });

    it('rejects whitespace-only action and settlement identities before transport', async () => {
        const socket = {
            connected: true,
            emitWithAck: vi.fn(),
            timeout: vi.fn().mockReturnThis(),
        };

        await expect(resolveAcceptedPendingQueueV2Delivery({
            socket: socket as any,
            sessionId: 'session-1',
            localId: ' \t ',
        })).rejects.toThrow('Pending localId must not be blank');
        await expect(blockPendingQueueV2Delivery({
            token: 'token',
            sessionId: 'session-1',
            localId: ' \t ',
            reason: 'payload_too_large',
        })).rejects.toThrow('Pending localId must not be blank');
        await expect(markPendingQueueV2DeliveryHandled({
            token: 'token',
            sessionId: 'session-1',
            localId: ' \t ',
        })).rejects.toThrow('Pending localId must not be blank');
        await expect(readBlockedPendingQueueV2DeliveryByLocalIdFromServer({
            token: 'token',
            sessionId: 'session-1',
            localId: ' \t ',
        })).rejects.toThrow('Pending localId must not be blank');

        expect(socket.emitWithAck).not.toHaveBeenCalled();
        expect(mockGet).not.toHaveBeenCalled();
        expect(mockPost).not.toHaveBeenCalled();
    });

    it('emits only the immutable released materialize payload and accepts its exact positive ACK', async () => {
        const socket = {
            connected: true,
            emitWithAck: vi.fn().mockResolvedValue({
                ok: true,
                didMaterialize: true,
                didWrite: true,
                message: { id: 'message-1', seq: 4, localId: 'local-1' },
            }),
            timeout: vi.fn().mockReturnThis(),
        };

        await expect(materializeNextPendingQueueV2MessageOnReleasedServer({
            sessionId: 'session-1',
            socket: socket as any,
        })).resolves.toEqual({
            ok: true,
            didMaterialize: true,
            didWrite: true,
            message: { id: 'message-1', seq: 4, localId: 'local-1' },
        });
        expect(socket.emitWithAck).toHaveBeenCalledWith('pending-materialize-next', { sid: 'session-1' });
    });

    it.each([
        { ok: true, didMaterialize: false, extra: true },
        { ok: true, didMaterialize: true, message: { id: 'message-1', seq: 4, localId: 'local-1' } },
        { ok: true, didMaterialize: true, didWrite: true, message: { id: '', seq: 4, localId: 'local-1' } },
        { ok: true, didMaterialize: true, didWrite: true, message: { id: 'message-1', seq: -1, localId: 'local-1' } },
        { ok: false, error: 'unknown' },
        { ok: false, error: 'forbidden', extra: true },
        { ok: true, didMaterialize: false, pendingCount: 0 },
    ])('rejects a non-exact released ACK %#', async (ack) => {
        const socket = {
            connected: true,
            emitWithAck: vi.fn().mockResolvedValue(ack),
            timeout: vi.fn().mockReturnThis(),
        };

        await expect(materializeNextPendingQueueV2MessageOnReleasedServer({
            sessionId: 'session-1',
            socket: socket as any,
        })).rejects.toThrow('Invalid released server pending materialize acknowledgement');
    });

    it('reads only the accepted-settlement overload directive with typed delay before Retry-After', () => {
        expect(readAcceptedPendingQueueV2DeliveryRetryDirective({
            response: {
                status: 503,
                headers: { 'Retry-After': '9' },
                data: {
                    error: 'transaction-unavailable',
                    retryAfterMs: 1_250,
                    correlationId: 'req-accepted-busy',
                },
            },
        })).toEqual({
            retryAfterMs: 1_250,
            correlationId: 'req-accepted-busy',
        });
        expect(readAcceptedPendingQueueV2DeliveryRetryDirective({
            response: {
                status: 503,
                headers: { 'Retry-After': '2.5' },
                data: { error: 'transaction-unavailable' },
            },
        })).toEqual({ retryAfterMs: 2_500 });
        expect(readAcceptedPendingQueueV2DeliveryRetryDirective({
            response: {
                status: 500,
                headers: { 'Retry-After': '1' },
                data: { error: 'internal', correlationId: 'req-generic-500' },
            },
        })).toBeNull();
    });

    it('fails closed instead of using HTTP provider materialization when the selected socket disconnects', async () => {
        const materialization = materializeNextPendingQueueV2Message({
            token: 'token',
            sessionId: 'session-1',
            socket: { connected: false } as any,
        });

        await expect(materialization).rejects.toMatchObject({
            code: 'pending_queue_materialization_transport_ambiguous',
            diagnosticCode: 'pending_queue_materialization_socket_disconnected',
            classification: 'socket_disconnected',
        });
        await expect(materialization).rejects.toBeInstanceOf(PendingQueueMaterializationTransportAmbiguousError);

        expect(mockPost).not.toHaveBeenCalled();
    });

    it('sends runtime-idle delivery timing in HTTP materialization requests', async () => {
        mockPost.mockResolvedValueOnce({
            data: {
                ok: true,
                didMaterialize: false,
                pendingCount: 1,
                pendingVersion: 2,
                deferredReason: 'waiting_for_runtime_activity',
            },
        });

        await expect(materializeNextPendingQueueV2MessageViaHttp({
            token: 'token',
            sessionId: 'session-1',
            deliveryTiming: 'after_runtime_idle',
            expectedRuntimeActivityRevision: 41,
        })).resolves.toMatchObject({
            didMaterialize: false,
            deferredReason: 'waiting_for_runtime_activity',
        });

        expect(mockPost).toHaveBeenCalledTimes(1);
        expect(mockPost.mock.calls[0]?.[1]).toEqual({
            deliveryTiming: 'after_runtime_idle',
            expectedRuntimeActivityRevision: 41,
        });
    });

    it('preserves the server-owned unknown-activity deadline over HTTP materialization', async () => {
        mockPost.mockResolvedValueOnce({
            data: {
                ok: true,
                didMaterialize: false,
                pendingCount: 1,
                pendingVersion: 2,
                deferredReason: 'runtime_activity_unknown',
                retryAfterMs: 29_750,
            },
        });

        await expect(materializeNextPendingQueueV2MessageViaHttp({
            token: 'token',
            sessionId: 'session-1',
            deliveryTiming: 'after_runtime_idle',
        })).resolves.toMatchObject({
            didMaterialize: false,
            deferredReason: 'runtime_activity_unknown',
            retryAfterMs: 29_750,
        });
    });

    it('preserves unresolved-head backpressure from HTTP materialization', async () => {
        mockPost.mockResolvedValueOnce({
            data: {
                ok: true,
                didMaterialize: false,
                pendingCount: 2,
                pendingBlockedCount: 0,
                pendingVersion: 7,
                deferredReason: 'waiting_for_predecessor',
            },
        });

        await expect(materializeNextPendingQueueV2MessageViaHttp({
            token: 'token',
            sessionId: 'session-1',
            deliveryStateOptIn: true,
        })).resolves.toMatchObject({
            didMaterialize: false,
            deferredReason: 'waiting_for_predecessor',
            pendingQueueState: {
                known: true,
                pendingCount: 2,
                pendingBlockedCount: 0,
                pendingVersion: 7,
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
        })).rejects.toBe(error);

        expect(mockPost).toHaveBeenCalledTimes(1);
        expect(mockPost.mock.calls[0]?.[1]).toEqual({ deliveryState: 'provider' });
    });

    it('fails closed through explicit HTTP materialization when no session socket is selected', async () => {
        const error = { response: { status: 422 } };
        mockPost.mockRejectedValueOnce(error);

        await expect(materializeNextPendingQueueV2Message({
            token: 'token',
            sessionId: 'session-1',
            deliveryStateOptIn: true,
        })).rejects.toBe(error);

        expect(mockPost).toHaveBeenCalledTimes(1);
        expect(mockPost.mock.calls[0]?.[1]).toEqual({ deliveryState: 'provider' });
    });

    it('returns a fail-closed contract result for HTTP materialization without a provider action', async () => {
        mockPost.mockResolvedValueOnce({
            data: {
                ok: true,
                didMaterialize: true,
                localId: 'legacy-local',
                didWriteMessage: true,
                pendingCount: 0,
                pendingVersion: 3,
                message: {
                    id: 'm-legacy',
                    seq: 42,
                    localId: 'legacy-local',
                    messageRole: 'user',
                    content: {
                        t: 'plain',
                        v: {
                            role: 'user',
                            content: { type: 'text', text: 'legacy prompt' },
                            localId: 'legacy-local',
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
            localId: 'legacy-local',
            message: null,
            providerDeliveryContractInvalid: true,
        });

        expect(mockPost).toHaveBeenCalledTimes(1);
        expect(mockPost.mock.calls[0]?.[1]).toEqual({ deliveryState: 'provider' });
    });

    it('fails closed on a missing provider action even when the legacy opt-in flag is false', async () => {
        mockPost.mockResolvedValueOnce({
            data: {
                ok: true,
                didMaterialize: true,
                localId: 'hard-cutover-local',
                didWriteMessage: false,
                pendingCount: 0,
                pendingVersion: 3,
                message: {
                    id: null,
                    seq: null,
                    localId: 'hard-cutover-local',
                    messageRole: 'user',
                    content: {
                        t: 'plain',
                        v: {
                            role: 'user',
                            content: { type: 'text', text: 'hard cutover prompt' },
                            localId: 'hard-cutover-local',
                        },
                    },
                    requestedAction: { v: 1, kind: 'enqueue' },
                    createdAt: 1_000,
                    updatedAt: 1_000,
                },
            },
        });

        await expect(materializeNextPendingQueueV2MessageViaHttp({
            token: 'token',
            sessionId: 'session-1',
            deliveryStateOptIn: false,
        })).resolves.toMatchObject({
            didMaterialize: true,
            localId: 'hard-cutover-local',
            message: null,
            providerDeliveryContractInvalid: true,
        });
    });

    it('returns a fail-closed contract result for socket materialization without a provider action', async () => {
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
        })).resolves.toMatchObject({
            didMaterialize: true,
            localId: 'legacy-socket-local',
            message: null,
            providerDeliveryContractInvalid: true,
        });

        expect(socket.emitWithAck).toHaveBeenCalledWith('pending-materialize-next', {
            sid: 'session-1',
            deliveryState: 'provider',
        });
        expect(mockPost).not.toHaveBeenCalled();
    });

    it('sends runtime-idle delivery timing in socket materialization requests', async () => {
        const socket = {
            connected: true,
            timeout: vi.fn(() => socket),
            emitWithAck: vi.fn(async () => ({
                ok: true,
                didMaterialize: false,
                pendingCount: 1,
                pendingVersion: 2,
                deferredReason: 'waiting_for_runtime_activity',
            })),
        };

        await expect(materializeNextPendingQueueV2Message({
            token: 'token',
            sessionId: 'session-1',
            socket: socket as any,
            deliveryTiming: 'after_runtime_idle',
        })).resolves.toMatchObject({
            didMaterialize: false,
            deferredReason: 'waiting_for_runtime_activity',
        });

        expect(socket.emitWithAck).toHaveBeenCalledWith('pending-materialize-next', {
            sid: 'session-1',
            deliveryTiming: 'after_runtime_idle',
        });
        expect(mockPost).not.toHaveBeenCalled();
    });

    it('preserves the server-owned unknown-activity deadline over socket materialization', async () => {
        const socket = {
            connected: true,
            timeout: vi.fn(() => socket),
            emitWithAck: vi.fn(async () => ({
                ok: true,
                didMaterialize: false,
                pendingCount: 1,
                pendingVersion: 2,
                deferredReason: 'runtime_activity_unknown',
                retryAfterMs: 29_750,
            })),
        };

        await expect(materializeNextPendingQueueV2Message({
            token: 'token',
            sessionId: 'session-1',
            socket: socket as any,
            deliveryTiming: 'after_runtime_idle',
        })).resolves.toMatchObject({
            didMaterialize: false,
            deferredReason: 'runtime_activity_unknown',
            retryAfterMs: 29_750,
        });
        expect(mockPost).not.toHaveBeenCalled();
    });


    it('preserves unresolved-head backpressure from socket materialization', async () => {
        const socket = {
            connected: true,
            timeout: vi.fn(() => socket),
            emitWithAck: vi.fn(async () => ({
                ok: true,
                didMaterialize: false,
                pendingCount: 2,
                pendingBlockedCount: 0,
                pendingVersion: 9,
                deferredReason: 'waiting_for_predecessor',
            })),
        };

        await expect(materializeNextPendingQueueV2Message({
            token: 'token',
            sessionId: 'session-1',
            socket: socket as any,
            deliveryStateOptIn: true,
        })).resolves.toMatchObject({
            didMaterialize: false,
            deferredReason: 'waiting_for_predecessor',
            pendingQueueState: { pendingCount: 2, pendingBlockedCount: 0, pendingVersion: 9 },
        });

        expect(mockPost).not.toHaveBeenCalled();
    });

    it('does not redrive through HTTP after a connected socket response is lost', async () => {
        const socket = {
            connected: true,
            timeout: vi.fn(() => socket),
            emitWithAck: vi.fn(async () => {
                throw new Error('socket response lost');
            }),
        };
        await expect(materializeNextPendingQueueV2Message({
            token: 'token',
            sessionId: 'session-1',
            socket: socket as any,
            expectedPendingVersion: 7,
        })).rejects.toMatchObject({
            code: 'pending_queue_materialization_transport_ambiguous',
            diagnosticCode: 'pending_queue_materialization_transport_failure',
            classification: 'transport_failure',
        });

        expect(socket.emitWithAck).toHaveBeenCalledWith('pending-materialize-next', {
            sid: 'session-1',
            expectedPendingVersion: 7,
        });
        expect(mockPost).not.toHaveBeenCalled();
    });

    it('does not redrive through HTTP after an invalid connected socket ACK', async () => {
        const socket = {
            connected: true,
            timeout: vi.fn(() => socket),
            emitWithAck: vi.fn(async () => ({ ok: 'not-a-boolean' })),
        };

        await expect(materializeNextPendingQueueV2Message({
            token: 'token',
            sessionId: 'session-1',
            socket: socket as any,
        })).rejects.toMatchObject({
            code: 'pending_queue_materialization_transport_ambiguous',
            diagnosticCode: 'pending_queue_materialization_ack_malformed',
            classification: 'malformed_ack',
        });

        expect(mockPost).not.toHaveBeenCalled();
    });

    it('preserves a typed negative materialization ACK as a safe server rejection diagnostic', async () => {
        const socket = {
            connected: true,
            timeout: vi.fn(() => socket),
            emitWithAck: vi.fn(async () => ({ ok: false, error: 'forbidden' })),
        };

        const materialization = materializeNextPendingQueueV2Message({
            token: 'token',
            sessionId: 'session-1',
            socket: socket as any,
        });

        await expect(materialization).rejects.toMatchObject({
            code: 'pending_queue_materialization_transport_ambiguous',
            diagnosticCode: 'pending_queue_materialization_server_rejected',
            classification: 'server_rejected',
            serverError: 'forbidden',
        });
        const error = await materialization.catch((cause) => cause);
        expect(serializeOutboundError(error)).toMatchObject({
            code: 'pending_queue_materialization_transport_ambiguous',
            message: 'Connected pending queue materialization did not return a valid acknowledgement',
        });
        expect(mockPost).not.toHaveBeenCalled();
    });

    it('preserves a typed transaction-unavailable materialization ACK and its server retry delay', async () => {
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
        })).rejects.toMatchObject({
            code: 'pending_queue_materialization_transport_ambiguous',
            diagnosticCode: 'pending_queue_materialization_server_retryable',
            classification: 'server_retryable',
            serverError: 'transaction-unavailable',
            retryAfterMs: 1_000,
        });
        expect(mockPost).not.toHaveBeenCalled();
    });

    it('classifies a missing materialization ACK at the local deadline and preserves its safe cause', async () => {
        vi.useFakeTimers();
        try {
            const socket = {
                connected: true,
                timeout: vi.fn(() => socket),
                emitWithAck: vi.fn(() => new Promise<never>(() => {})),
            };
            const materialization = materializeNextPendingQueueV2Message({
                token: 'token',
                sessionId: 'session-1',
                socket: socket as any,
            });
            const observed = materialization.catch((error) => error);

            await vi.advanceTimersByTimeAsync(10_000);

            const error = await observed;
            expect(error).toMatchObject({
                code: 'pending_queue_materialization_transport_ambiguous',
                diagnosticCode: 'pending_queue_materialization_ack_timeout',
                classification: 'ack_timeout',
            });
            expect(serializeOutboundError(error)).toMatchObject({
                code: 'pending_queue_materialization_transport_ambiguous',
                cause: {
                    code: 'socket_ack_timeout',
                    message: 'pending-materialize-next ack timed out after 10000ms',
                },
            });
            expect(mockPost).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    it('parses row-first provider delivery materialization with a durable transcript row', async () => {
        const deliveryState = { mode: 'provider' as const, unresolved: true };
        mockPost.mockResolvedValueOnce({
            data: {
                ok: true,
                didMaterialize: true,
                localId: 'row-first-local',
                didWriteMessage: true,
                pendingCount: 1,
                pendingVersion: 2,
                deliveryState,
                message: {
                    id: 'm-row-first',
                    seq: 42,
                    localId: 'row-first-local',
                    requestedAction: { v: 1, kind: 'enqueue' },
                    providerAction: 'send',
                    messageRole: 'user',
                    content: {
                        t: 'plain',
                        v: {
                            role: 'user',
                            content: { type: 'text', text: 'row-first prompt' },
                            localId: 'row-first-local',
                            meta: { source: 'ui', sentFrom: 'web' },
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
            localId: 'row-first-local',
            didWrite: true,
            message: {
                id: 'm-row-first',
                seq: 42,
                localId: 'row-first-local',
                deliveryState,
                content: {
                    t: 'plain',
                    v: {
                        role: 'user',
                        content: { type: 'text', text: 'row-first prompt' },
                        localId: 'row-first-local',
                        meta: { source: 'ui', sentFrom: 'web' },
                    },
                },
            },
        });
    });

    it('parses row-first provider delivery materialization from socket ACKs', async () => {
        const deliveryState = { mode: 'provider' as const, unresolved: true };
        const socket = {
            connected: true,
            timeout: vi.fn(() => socket),
            emitWithAck: vi.fn(async () => ({
                ok: true,
                didMaterialize: true,
                localId: 'row-first-socket-local',
                didWrite: true,
                pendingCount: 1,
                pendingVersion: 2,
                deliveryState,
                message: {
                    id: 'm-row-first-socket',
                    seq: 43,
                    localId: 'row-first-socket-local',
                    requestedAction: { v: 1, kind: 'enqueue' },
                    providerAction: 'send',
                    messageRole: 'user',
                    content: {
                        t: 'plain',
                        v: {
                            role: 'user',
                            content: { type: 'text', text: 'row-first socket prompt' },
                            localId: 'row-first-socket-local',
                            meta: { source: 'ui', sentFrom: 'web' },
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
        })).resolves.toMatchObject({
            didMaterialize: true,
            localId: 'row-first-socket-local',
            didWrite: true,
            message: {
                id: 'm-row-first-socket',
                seq: 43,
                localId: 'row-first-socket-local',
                deliveryState,
            },
        });
        expect(mockPost).not.toHaveBeenCalled();
    });

    it('parses provider delivery claims that are not committed transcript rows yet', async () => {
        const deliveryState = { mode: 'provider' as const, unresolved: true };
        mockPost.mockResolvedValueOnce({
            data: {
                ok: true,
                didMaterialize: true,
                localId: 'claimed-local',
                didWriteMessage: false,
                pendingCount: 1,
                pendingVersion: 2,
                deliveryState,
                message: {
                    id: null,
                    seq: null,
                    localId: 'claimed-local',
                    requestedAction: { v: 1, kind: 'enqueue' },
                    providerAction: 'send',
                    messageRole: 'user',
                    content: {
                        t: 'plain',
                        v: {
                            role: 'user',
                            content: { type: 'text', text: 'claimed prompt' },
                            localId: 'claimed-local',
                            meta: { source: 'ui', sentFrom: 'web' },
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
            localId: 'claimed-local',
            didWrite: false,
            message: {
                id: null,
                seq: null,
                localId: 'claimed-local',
                deliveryState,
                content: {
                    t: 'plain',
                    v: {
                        role: 'user',
                        content: { type: 'text', text: 'claimed prompt' },
                        localId: 'claimed-local',
                        meta: { source: 'ui', sentFrom: 'web' },
                    },
                },
            },
        });
    });

    it('allows legacy provider delivery claims without explicit delivery state under provider opt-in', async () => {
        mockPost.mockResolvedValueOnce({
            data: {
                ok: true,
                didMaterialize: true,
                localId: 'legacy-claimed-local',
                didWriteMessage: false,
                pendingCount: 1,
                pendingVersion: 2,
                message: {
                    id: null,
                    seq: null,
                    localId: 'legacy-claimed-local',
                    requestedAction: { v: 1, kind: 'enqueue' },
                    providerAction: 'send',
                    messageRole: 'user',
                    content: {
                        t: 'plain',
                        v: {
                            role: 'user',
                            content: { type: 'text', text: 'legacy claimed prompt' },
                            localId: 'legacy-claimed-local',
                            meta: { source: 'ui', sentFrom: 'web' },
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
            localId: 'legacy-claimed-local',
            didWrite: false,
            message: {
                id: null,
                seq: null,
                localId: 'legacy-claimed-local',
                deliveryState: null,
                content: {
                    t: 'plain',
                    v: {
                        role: 'user',
                        content: { type: 'text', text: 'legacy claimed prompt' },
                        localId: 'legacy-claimed-local',
                        meta: { source: 'ui', sentFrom: 'web' },
                    },
                },
            },
        });
    });

    it('allows uncommitted provider delivery claims with an opaque materialization id under provider opt-in', async () => {
        mockPost.mockResolvedValueOnce({
            data: {
                ok: true,
                didMaterialize: true,
                localId: 'opaque-id-claimed-local',
                didWriteMessage: false,
                pendingCount: 1,
                pendingVersion: 2,
                message: {
                    id: 'opaque-pending-materialization-id',
                    seq: null,
                    localId: 'opaque-id-claimed-local',
                    requestedAction: { v: 1, kind: 'enqueue' },
                    providerAction: 'send',
                    messageRole: 'user',
                    content: {
                        t: 'plain',
                        v: {
                            role: 'user',
                            content: { type: 'text', text: 'opaque id claimed prompt' },
                            localId: 'opaque-id-claimed-local',
                            meta: { source: 'ui', sentFrom: 'web' },
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
            localId: 'opaque-id-claimed-local',
            didWrite: false,
            message: {
                id: 'opaque-pending-materialization-id',
                seq: null,
                localId: 'opaque-id-claimed-local',
                deliveryState: null,
                content: {
                    t: 'plain',
                    v: {
                        role: 'user',
                        content: { type: 'text', text: 'opaque id claimed prompt' },
                        localId: 'opaque-id-claimed-local',
                        meta: { source: 'ui', sentFrom: 'web' },
                    },
                },
            },
        });
    });

    it('allows uncommitted provider delivery claims with stale resolved provider state under provider opt-in', async () => {
        mockPost.mockResolvedValueOnce({
            data: {
                ok: true,
                didMaterialize: true,
                localId: 'resolved-state-claimed-local',
                didWriteMessage: false,
                pendingCount: 1,
                pendingVersion: 2,
                deliveryState: { mode: 'provider', unresolved: false },
                message: {
                    id: 'opaque-resolved-state-materialization-id',
                    seq: null,
                    localId: 'resolved-state-claimed-local',
                    requestedAction: { v: 1, kind: 'enqueue' },
                    providerAction: 'send',
                    messageRole: 'user',
                    content: {
                        t: 'plain',
                        v: {
                            role: 'user',
                            content: { type: 'text', text: 'resolved provider state claimed prompt' },
                            localId: 'resolved-state-claimed-local',
                            meta: { source: 'ui', sentFrom: 'web' },
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
            localId: 'resolved-state-claimed-local',
            didWrite: false,
            message: {
                id: 'opaque-resolved-state-materialization-id',
                seq: null,
                localId: 'resolved-state-claimed-local',
                deliveryState: { mode: 'provider', unresolved: false },
            },
        });
    });

    it('allows provider delivery claims whose local id is only present on the materialize ack', async () => {
        mockPost.mockResolvedValueOnce({
            data: {
                ok: true,
                didMaterialize: true,
                localId: 'top-level-claimed-local',
                didWriteMessage: false,
                pendingCount: 1,
                pendingVersion: 2,
                message: {
                    id: null,
                    seq: null,
                    localId: null,
                    requestedAction: { v: 1, kind: 'enqueue' },
                    providerAction: 'send',
                    messageRole: 'user',
                    content: {
                        t: 'plain',
                        v: {
                            role: 'user',
                            content: { type: 'text', text: 'top-level local id claimed prompt' },
                            meta: { source: 'ui', sentFrom: 'web' },
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
            localId: 'top-level-claimed-local',
            didWrite: false,
            message: {
                id: null,
                seq: null,
                localId: null,
                content: {
                    t: 'plain',
                    v: {
                        role: 'user',
                        content: { type: 'text', text: 'top-level local id claimed prompt' },
                        meta: { source: 'ui', sentFrom: 'web' },
                    },
                },
            },
        });
    });

    it('returns a fail-closed contract result when transcript identity is only null after parser normalization', async () => {
        mockPost.mockResolvedValueOnce({
            data: {
                ok: true,
                didMaterialize: true,
                localId: 'malformed-seq-claimed-local',
                didWriteMessage: false,
                pendingCount: 1,
                pendingVersion: 2,
                message: {
                    id: null,
                    seq: 'not-a-seq',
                    localId: 'malformed-seq-claimed-local',
                    messageRole: 'user',
                    content: {
                        t: 'plain',
                        v: {
                            role: 'user',
                            content: { type: 'text', text: 'malformed seq claimed prompt' },
                            localId: 'malformed-seq-claimed-local',
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
            localId: 'malformed-seq-claimed-local',
            message: null,
            providerDeliveryContractInvalid: true,
        });
    });

    it('returns a fail-closed contract result without an explicit false write marker', async () => {
        mockPost.mockResolvedValueOnce({
            data: {
                ok: true,
                didMaterialize: true,
                localId: 'missing-write-marker-local',
                pendingCount: 1,
                pendingVersion: 2,
                message: {
                    id: null,
                    seq: null,
                    localId: 'missing-write-marker-local',
                    messageRole: 'user',
                    content: {
                        t: 'plain',
                        v: {
                            role: 'user',
                            content: { type: 'text', text: 'missing write marker prompt' },
                            localId: 'missing-write-marker-local',
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
            localId: 'missing-write-marker-local',
            message: null,
            providerDeliveryContractInvalid: true,
        });
    });

    it('does not fall back on authentication failures', async () => {
        mockPost.mockRejectedValueOnce({ response: { status: 401 } });

        await expect(materializeNextPendingQueueV2MessageViaHttp({
            token: 'token',
            sessionId: 'session-1',
            deliveryStateOptIn: true,
        })).rejects.toMatchObject({
            response: { status: 401 },
        });

        expect(mockPost).toHaveBeenCalledTimes(1);
        expect(axios.post).toHaveBeenCalledWith(
            expect.stringContaining('/v2/sessions/session-1/pending/materialize-next'),
            { deliveryState: 'provider' },
            expect.objectContaining({
                headers: expect.objectContaining({ Authorization: 'Bearer token' }),
            }),
        );
    });

    it('settles provider-accepted delivery only through the current session publisher socket', async () => {
        const socket = {
            connected: true,
            emitWithAck: vi.fn().mockResolvedValue({
                ok: true,
                didResolve: true,
                pendingCount: 1,
                pendingBlockedCount: 0,
                pendingVersion: 9,
                message: {
                    id: 'm-accepted',
                    seq: 43,
                    localId: 'local/with spaces',
                    messageRole: 'user',
                    content: {
                        t: 'plain',
                        v: {
                            role: 'user',
                            content: { type: 'text', text: 'accepted prompt' },
                            localId: 'local/with spaces',
                        },
                    },
                    createdAt: 1_000,
                    updatedAt: 1_000,
                },
            }),
            timeout: vi.fn().mockReturnThis(),
        };

        await expect(resolveAcceptedPendingQueueV2Delivery({
            socket: socket as any,
            sessionId: 'session-1',
            localId: 'local/with spaces',
        })).resolves.toEqual({
            didResolve: true,
            pendingQueueState: {
                known: true,
                pendingCount: 1,
                pendingVersion: 9,
                pendingBlockedCount: 0,
            },
            message: {
                id: 'm-accepted',
                seq: 43,
                localId: 'local/with spaces',
                messageRole: 'user',
                content: {
                    t: 'plain',
                    v: {
                        role: 'user',
                        content: { type: 'text', text: 'accepted prompt' },
                        localId: 'local/with spaces',
                    },
                },
                createdAt: 1_000,
                updatedAt: 1_000,
                deliveryState: null,
            },
        });

        expect(socket.emitWithAck).toHaveBeenCalledWith('pending-delivery-accepted-v1', {
            v: 1,
            sessionId: 'session-1',
            localId: 'local/with spaces',
        });
        expect(mockPost).not.toHaveBeenCalled();
    });

    it('preserves didResolve false for a successful no-op accepted delivery', async () => {
        const socket = {
            connected: true,
            emitWithAck: vi.fn().mockResolvedValue({
                ok: true,
                didResolve: false,
                pendingCount: 1,
                pendingBlockedCount: 1,
                pendingVersion: 10,
            }),
            timeout: vi.fn().mockReturnThis(),
        };

        await expect(resolveAcceptedPendingQueueV2Delivery({
            socket: socket as any,
            sessionId: 'session-1',
            localId: 'blocked-local',
        })).resolves.toEqual({
            didResolve: false,
            pendingQueueState: {
                known: true,
                pendingCount: 1,
                pendingBlockedCount: 1,
                pendingVersion: 10,
            },
            message: null,
        });
    });

    it('preserves the exact committed message proof for a replayed accepted delivery', async () => {
        const socket = {
            connected: true,
            emitWithAck: vi.fn().mockResolvedValue({
                ok: true,
                didResolve: false,
                pendingCount: 0,
                pendingBlockedCount: 0,
                pendingVersion: 11,
                message: {
                    id: 'm-replayed-accepted',
                    seq: 44,
                    localId: ' replayed-accepted ',
                    messageRole: 'user',
                    content: {
                        t: 'plain',
                        v: {
                            role: 'user',
                            content: { type: 'text', text: 'accepted prompt' },
                            localId: ' replayed-accepted ',
                        },
                    },
                    createdAt: 1_000,
                    updatedAt: 1_001,
                },
            }),
            timeout: vi.fn().mockReturnThis(),
        };

        await expect(resolveAcceptedPendingQueueV2Delivery({
            socket: socket as any,
            sessionId: 'session-1',
            localId: ' replayed-accepted ',
        })).resolves.toEqual({
            didResolve: false,
            pendingQueueState: {
                known: true,
                pendingCount: 0,
                pendingBlockedCount: 0,
                pendingVersion: 11,
            },
            message: {
                id: 'm-replayed-accepted',
                seq: 44,
                localId: ' replayed-accepted ',
                messageRole: 'user',
                content: {
                    t: 'plain',
                    v: {
                        role: 'user',
                        content: { type: 'text', text: 'accepted prompt' },
                        localId: ' replayed-accepted ',
                    },
                },
                createdAt: 1_000,
                updatedAt: 1_001,
                deliveryState: null,
            },
        });
    });

    it.each([
        { ok: true, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 10 },
        { ok: true, didResolve: true, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 10 },
        { ok: true, didResolve: false, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 10, extra: true },
        { ok: false, error: 'transaction-unavailable' },
        {
            ok: true,
            didResolve: true,
            pendingCount: 0,
            pendingBlockedCount: 0,
            pendingVersion: 10,
            message: {},
        },
        {
            ok: true,
            didResolve: true,
            pendingCount: 0,
            pendingBlockedCount: 0,
            pendingVersion: 10,
            message: {
                id: 'm-wrong-local-id',
                seq: 43,
                localId: 'different-local-id',
                content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'wrong row' } } },
                createdAt: 1_000,
                updatedAt: 1_000,
            },
        },
    ])('fails closed on a malformed accepted settlement acknowledgement %#', async (ack) => {
        const socket = {
            connected: true,
            emitWithAck: vi.fn().mockResolvedValue(ack),
            timeout: vi.fn().mockReturnThis(),
        };

        await expect(resolveAcceptedPendingQueueV2Delivery({
            socket: socket as any,
            sessionId: 'session-1',
            localId: 'accepted-local',
        })).rejects.toThrow('Invalid pending delivery accepted settlement acknowledgement');
        expect(mockPost).not.toHaveBeenCalled();
    });

    it('fails closed without HTTP fallback when the publisher socket is disconnected', async () => {
        await expect(resolveAcceptedPendingQueueV2Delivery({
            socket: { connected: false } as any,
            sessionId: 'session-1',
            localId: 'accepted-local',
        })).rejects.toMatchObject({
            code: 'socket_not_connected',
            event: 'pending-delivery-accepted-v1',
        });
        expect(mockPost).not.toHaveBeenCalled();
    });


    it('posts provider delivery block state to the dedicated pending route', async () => {
        mockPost.mockResolvedValueOnce({
            data: {
                ok: true,
                pendingCount: 1,
                pendingVersion: 10,
            },
        });

        await expect(blockPendingQueueV2Delivery({
            token: 'token',
            sessionId: 'session-1',
            localId: 'local/with spaces',
            reason: 'payload_too_large',
        })).resolves.toEqual({
            pendingQueueState: {
                known: true,
                pendingCount: 1,
                pendingVersion: 10,
                pendingBlockedCount: 0,
            },
        });

        expect(mockPost).toHaveBeenCalledWith(
            expect.stringContaining('/v2/sessions/session-1/pending/local%2Fwith%20spaces/delivery/block'),
            { reason: 'payload_too_large' },
            expect.objectContaining({
                headers: expect.objectContaining({ Authorization: 'Bearer token' }),
            }),
        );
    });

    it('lists only queued provider-delivery local ids for close recovery', async () => {
        mockGet.mockResolvedValueOnce({
            data: {
                pending: [
                    { localId: 'typed-provider', status: 'queued', deliveryState: 'delivering', deliveryStatus: { status: 'delivering' } },
                    { localId: 'provider-1', status: 'queued', deliveryState: 'delivering' },
                    { localId: 'regular-queued', status: 'queued', deliveryState: null },
                    { localId: 'provider-blocked', status: 'queued', deliveryState: 'blocked' },
                    { localId: 'discarded-provider', status: 'discarded' },
                    { localId: 'provider-2', status: 'queued', deliveryState: 'delivering' },
                ],
            },
        });

        await expect(listPendingQueueV2ProviderDeliveryLocalIdsFromServer({
            token: 'token',
            sessionId: 'session/with spaces',
        })).resolves.toEqual(['typed-provider', 'provider-1', 'provider-2']);

        expect(mockGet).toHaveBeenCalledWith(
            expect.stringContaining('/v2/sessions/session%2Fwith%20spaces/pending'),
            expect.objectContaining({
                headers: expect.objectContaining({ Authorization: 'Bearer token' }),
                timeout: 10_000,
            }),
        );
    });

    it('projects canonical per-row delivery statuses (terminal rows are absent)', async () => {
        mockGet.mockResolvedValueOnce({
            data: {
                pending: [
                    { localId: 'typed-only', deliveryStatus: { status: 'queued' } },
                    { localId: 'delivering-1', status: 'queued', deliveryState: 'delivering', deliveryStatus: { status: 'delivering' } },
                    { localId: 'blocked-1', status: 'queued', deliveryState: 'blocked', deliveryBlockedReason: 'provider_acceptance_timeout' },
                    { localId: 'discarded-1', status: 'discarded', discardedReason: 'manual' },
                ],
            },
        });

        await expect(listPendingQueueV2DeliveryStatusesFromServer({
            token: 'token',
            sessionId: 'session/with spaces',
        })).resolves.toEqual([
            { localId: 'typed-only', status: 'queued' },
            { localId: 'delivering-1', status: 'delivering' },
            { localId: 'blocked-1', status: 'blocked' },
            { localId: 'discarded-1', status: 'discarded' },
        ]);

        expect(mockGet).toHaveBeenCalledWith(
            expect.stringContaining('/v2/sessions/session%2Fwith%20spaces/pending'),
            expect.objectContaining({
                headers: expect.objectContaining({ Authorization: 'Bearer token' }),
                timeout: 10_000,
            }),
        );
    });

    it.each([
        ['missing pending projection', {}],
        ['non-array pending projection', { pending: null }],
        ['malformed pending row', { pending: [{ status: 'queued' }] }],
        ['missing delivery status fields', { pending: [{ localId: 'missing-status' }] }],
        ['unknown legacy delivery status', { pending: [{ localId: 'unknown-status', status: 'future' }] }],
        ['invalid typed delivery status', {
            pending: [{ localId: 'invalid-typed', deliveryStatus: { status: 'future' } }],
        }],
        ['contradictory typed and persisted delivery status', {
            pending: [{
                localId: 'contradictory',
                status: 'queued',
                deliveryState: 'delivering',
                deliveryStatus: { status: 'discarded', reason: null },
            }],
        }],
        ['duplicate local id with identical status', {
            pending: [
                { localId: 'duplicate-identical', status: 'queued', deliveryState: 'delivering' },
                { localId: 'duplicate-identical', status: 'queued', deliveryState: 'delivering' },
            ],
        }],
        ['conflicting duplicate row', {
            pending: [
                { localId: 'duplicate', status: 'queued', deliveryState: 'delivering' },
                { localId: 'duplicate', status: 'discarded' },
            ],
        }],
    ])('rejects a non-authoritative delivery-status snapshot: %s', async (_case, data) => {
        mockGet.mockResolvedValueOnce({ data });

        await expect(listPendingQueueV2DeliveryStatusesFromServer({
            token: 'token',
            sessionId: 'session-1',
        })).rejects.toThrow('Invalid pending queue delivery status projection');
    });

    it.each([
        ['local-id reader', () => listPendingQueueV2LocalIdsFromServer({ token: 'token', sessionId: 'session-1' })],
        ['delivery-status reader', () => listPendingQueueV2DeliveryStatusesFromServer({ token: 'token', sessionId: 'session-1' })],
        ['provider-delivery reader', () => listPendingQueueV2ProviderDeliveryLocalIdsFromServer({ token: 'token', sessionId: 'session-1' })],
        ['blocked-delivery reader', () => readBlockedPendingQueueV2DeliveryByLocalIdFromServer({ token: 'token', sessionId: 'session-1', localId: 'target' })],
    ])('uses the same strict canonical projection parser for the %s', async (_case, readProjection) => {
        const invalidProjections = [
            {},
            { pending: [{ localId: 'malformed-without-status' }] },
            {
                pending: [{
                    localId: 'contradictory',
                    status: 'queued',
                    deliveryState: 'delivering',
                    deliveryStatus: { status: 'discarded', reason: null },
                }],
            },
            {
                pending: [
                    { localId: 'duplicate', status: 'queued', deliveryState: 'delivering' },
                    { localId: 'duplicate', status: 'queued', deliveryState: 'delivering' },
                ],
            },
        ];

        for (const data of invalidProjections) {
            mockGet.mockResolvedValueOnce({ data });
            await expect(readProjection()).rejects.toThrow('Invalid pending queue delivery status projection');
        }
    });

    it('reads blocked provider delivery state for a specific local id', async () => {
        mockGet.mockResolvedValueOnce({
            data: {
                pending: [
                    { localId: 'other-local', status: 'queued', deliveryState: 'blocked', deliveryBlockedReason: 'payload_too_large' },
                    {
                        localId: 'blocked-local',
                        status: 'queued',
                        deliveryState: 'blocked',
                        deliveryBlockedReason: 'runtime_disposed_before_delivery',
                        deliveryStatus: { status: 'blocked', reason: 'runtime_disposed_before_delivery' },
                    },
                    { localId: 'delivering-local', status: 'queued', deliveryState: 'delivering' },
                    { localId: 'future-local', status: 'queued', deliveryState: 'blocked', deliveryBlockedReason: 'future_reason' },
                ],
            },
        });

        await expect(readBlockedPendingQueueV2DeliveryByLocalIdFromServer({
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

    it('posts explicit handled resolution to the dedicated pending route', async () => {
        mockPost.mockResolvedValueOnce({
            data: {
                ok: true,
                pendingCount: 0,
                pendingVersion: 12,
            },
        });

        await expect(markPendingQueueV2DeliveryHandled({
            token: 'token',
            sessionId: 'session-1',
            localId: 'local-1',
        })).resolves.toEqual({
            pendingQueueState: {
                known: true,
                pendingCount: 0,
                pendingVersion: 12,
                pendingBlockedCount: 0,
            },
        });

        expect(mockPost).toHaveBeenCalledWith(
            expect.stringContaining('/v2/sessions/session-1/pending/local-1/delivery/handled'),
            {},
            expect.objectContaining({
                headers: expect.objectContaining({ Authorization: 'Bearer token' }),
            }),
        );
    });
});
