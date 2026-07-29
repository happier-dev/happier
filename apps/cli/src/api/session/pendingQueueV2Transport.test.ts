import { beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { SocketAckError } from '@/session/transport/shared/socketAck';

import {
    PendingQueueAcceptedSettlementError,
    isAcceptedPendingQueueV2DeliveryAckResponseLoss,
    listPendingQueueV2DeliveryStatusesFromServer,
    listPendingQueueV2ProviderDeliveryLocalIdsFromServer,
    materializeNextPendingQueueV2Message,
    materializeNextPendingQueueV2MessageViaHttp,
    materializeNextPendingQueueV2MessageViaReleasedServerSocket,
    readAcceptedPendingQueueV2DeliveryRetryDirective,
    readBlockedPendingQueueV2DeliveryByLocalIdFromServer,
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
    },
}));

describe('pendingQueueV2Transport', () => {
    beforeEach(() => {
        mockGet.mockReset();
        mockPost.mockReset();
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

        await expect(materializeNextPendingQueueV2Message({
            token: 'token',
            sessionId: 'session-1',
            socket: socket as any,
            knownPendingVersion: 4,
        })).rejects.toBe(socketError);
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
                content: { t: 'encrypted', c: 'cipher-provider-claim' },
                deliveryState: { mode: 'provider', unresolved: true },
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
        await expect(materializeNextPendingQueueV2Message({
            token: 'token',
            sessionId: 'session-1',
            socket: { connected: false } as any,
            deliveryStateOptIn: true,
        })).rejects.toThrow('Provider pending materialization requires the bound session socket');

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
            { localId: 'delivering', status: 'delivering' },
            { localId: 'blocked', status: 'blocked' },
            { localId: 'discarded', status: 'discarded' },
        ]);
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
            { localId: ' request-1', status: 'delivering' },
            { localId: 'request-1 ', status: 'delivering' },
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

        await expect(readBlockedPendingQueueV2DeliveryByLocalIdFromServer({
            token: 'token',
            sessionId: 'session/with spaces',
            localId: 'blocked-local',
        })).resolves.toEqual({
            localId: 'blocked-local',
            reason: 'payload_too_large',
        });
    });
});
