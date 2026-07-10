import { beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';

import {
    blockPendingQueueV2ProviderDeliveriesOnAttach,
    listPendingQueueV2DeliveryStatusesFromServer,
    listPendingQueueV2ProviderDeliveryLocalIdsFromServer,
    materializeNextPendingQueueV2Message,
    materializeNextPendingQueueV2MessageViaHttp,
    readBlockedPendingQueueV2DeliveryByLocalIdFromServer,
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
                deliveryState: { mode: 'awaiting_runtime_idle', unresolved: true },
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
            deliveryState: { mode: 'awaiting_runtime_idle', unresolved: true },
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
                deliveryState: { mode: 'awaiting_runtime_idle', unresolved: true },
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
            deliveryState: { mode: 'awaiting_runtime_idle', unresolved: true },
        });

        expect(socket.emitWithAck).toHaveBeenCalledWith('pending-materialize-next', {
            sid: 'session-1',
            deliveryTiming: 'after_runtime_idle',
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

    it('fails closed through the socket/http materializer when provider delivery opt-in is rejected', async () => {
        const error = { response: { status: 422 } };
        mockPost.mockRejectedValueOnce(error);

        await expect(materializeNextPendingQueueV2Message({
            token: 'token',
            sessionId: 'session-1',
            socket: { connected: false } as any,
            deliveryStateOptIn: true,
        })).rejects.toBe(error);

        expect(mockPost).toHaveBeenCalledTimes(1);
        expect(mockPost.mock.calls[0]?.[1]).toEqual({ deliveryState: 'provider' });
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

    it('posts provider delivery state actions to dedicated pending routes', async () => {
        const transport = await import('./pendingQueueV2Transport');
        mockPost
            .mockResolvedValueOnce({
                data: {
                    ok: true,
                    pendingCount: 1,
                    pendingBlockedCount: 0,
                    pendingVersion: 4,
                    message: {
                        id: 'accepted-message',
                        seq: 44,
                        localId: 'local/with spaces',
                        messageRole: 'user',
                        content: {
                            t: 'plain',
                            v: {
                                role: 'user',
                                content: { type: 'text', text: 'accepted prompt' },
                            },
                        },
                        createdAt: 4_000,
                        updatedAt: 4_000,
                    },
                },
            })
            .mockResolvedValueOnce({ data: { ok: true, pendingCount: 0, pendingVersion: 5, resolvedLocalIds: ['accepted-through-seq-local'] } })
            .mockResolvedValueOnce({ data: { ok: true, pendingCount: 1, pendingVersion: 6 } });

        await expect((transport as any).resolveAcceptedPendingQueueV2Delivery({
            token: 'token',
            sessionId: 'session-1',
            localId: 'local/with spaces',
        })).resolves.toEqual({
            pendingQueueState: { known: true, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 4 },
            message: expect.objectContaining({
                id: 'accepted-message',
                seq: 44,
                localId: 'local/with spaces',
            }),
        });
        await expect((transport as any).reconcileAcceptedPendingQueueV2DeliveriesThroughSeq({
            token: 'token',
            sessionId: 'session-1',
            maxAcceptedSeq: 42,
        })).resolves.toEqual({
            pendingQueueState: { known: true, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 5 },
            resolvedLocalIds: ['accepted-through-seq-local'],
        });
        await expect((transport as any).blockPendingQueueV2Delivery({
            token: 'token',
            sessionId: 'session-1',
            localId: 'blocked-local',
            reason: 'provider_acceptance_timeout',
        })).resolves.toEqual({
            pendingQueueState: { known: true, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 6 },
        });

        expect(mockPost.mock.calls[0]?.[0]).toContain('/v2/sessions/session-1/pending/local%2Fwith%20spaces/delivery/accepted');
        expect(mockPost.mock.calls[0]?.[1]).toEqual({});
        expect(mockPost.mock.calls[1]?.[0]).toContain('/v2/sessions/session-1/pending/delivery/accepted-through-seq');
        expect(mockPost.mock.calls[1]?.[1]).toEqual({ maxAcceptedSeq: 42 });
        expect(mockPost.mock.calls[2]?.[0]).toContain('/v2/sessions/session-1/pending/blocked-local/delivery/block');
        expect(mockPost.mock.calls[2]?.[1]).toEqual({ reason: 'provider_acceptance_timeout' });
    });

    it('posts provider-attach stale-claim blocking to the dedicated pending route', async () => {
        mockPost.mockResolvedValueOnce({
            data: {
                ok: true,
                pendingCount: 2,
                pendingBlockedCount: 1,
                pendingVersion: 8,
            },
        });

        await expect(blockPendingQueueV2ProviderDeliveriesOnAttach({
            token: 'token',
            sessionId: 'session/with spaces',
        })).resolves.toEqual({
            pendingQueueState: { known: true, pendingCount: 2, pendingBlockedCount: 1, pendingVersion: 8 },
        });

        expect(mockPost).toHaveBeenCalledWith(
            expect.stringContaining('/v2/sessions/session%2Fwith%20spaces/pending/delivery/provider-attach'),
            {},
            expect.objectContaining({
                headers: expect.objectContaining({
                    Authorization: 'Bearer token',
                    'Content-Type': 'application/json',
                }),
                timeout: 10_000,
            }),
        );
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
