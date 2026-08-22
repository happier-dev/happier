import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { deliverSessionEndMutation } from './deliverSessionEndMutation';
import type { SessionEndMutationV1 } from './sessionClientDurableMutationTypes';

vi.mock('axios');

const originalSessionEndDeliveryConcurrency = process.env.HAPPIER_SESSION_END_DELIVERY_CONCURRENCY;
const legacyDeliveryAttemptAt = 700_001;

const mutation = {
    v: 1,
    sessionId: 's1',
    mutationId: 'm1',
    source: 'session_end',
    observedAt: 1_000,
} satisfies SessionEndMutationV1;

describe('deliverSessionEndMutation', () => {
    beforeEach(() => {
        vi.mocked(axios.post).mockReset();
        vi.mocked(axios.get).mockReset();
        vi.mocked(axios.get).mockRejectedValue(new Error('session-end proof unavailable'));
        vi.spyOn(Date, 'now').mockReturnValue(legacyDeliveryAttemptAt);
        delete process.env.HAPPIER_SESSION_END_DELIVERY_CONCURRENCY;
    });

    afterEach(() => {
        vi.restoreAllMocks();
        if (originalSessionEndDeliveryConcurrency === undefined) {
            delete process.env.HAPPIER_SESSION_END_DELIVERY_CONCURRENCY;
        } else {
            process.env.HAPPIER_SESSION_END_DELIVERY_CONCURRENCY = originalSessionEndDeliveryConcurrency;
        }
    });

    it('does not emit legacy session-end when connected HTTP delivery succeeds', async () => {
        vi.mocked(axios.post).mockResolvedValue({ status: 200, data: { success: true, applied: true } } as never);
        const socket = {
            connected: true,
            emit: vi.fn(),
        };

        await expect(deliverSessionEndMutation({ token: 'tok', socket, mutation })).resolves.toBe(true);

        expect(socket.emit).not.toHaveBeenCalled();
        expect(vi.mocked(axios.post).mock.calls[0]?.[0]).toContain('/v1/sessions/s1/end');
    });

    it('does not emit legacy session-end when HTTP delivery fails with a retryable error', async () => {
        vi.mocked(axios.post).mockRejectedValue(new Error('offline'));
        const socket = {
            connected: true,
            emit: vi.fn(),
        };

        await expect(deliverSessionEndMutation({ token: 'tok', socket, mutation })).resolves.toBe(false);

        expect(socket.emit).not.toHaveBeenCalled();
        expect(vi.mocked(axios.post).mock.calls[0]?.[0]).toContain('/v1/sessions/s1/end');
    });

    it('preserves legacy session-end emit without confirming unsupported HTTP delivery', async () => {
        vi.mocked(axios.post).mockRejectedValue({ response: { status: 404 } });
        const socket = {
            connected: true,
            emit: vi.fn(),
        };

        await expect(deliverSessionEndMutation({ token: 'tok', socket, mutation })).resolves.toBe(false);

        expect(socket.emit).toHaveBeenCalledWith('session-end', { sid: 's1', time: legacyDeliveryAttemptAt });
        expect(vi.mocked(axios.post).mock.calls[0]?.[0]).toContain('/v1/sessions/s1/end');
    });

    it('refreshes only the legacy socket attempt timestamp so v0.2.1 can accept an old durable end', async () => {
        vi.mocked(axios.post).mockRejectedValue({ response: { status: 404 } });
        let active = true;
        vi.mocked(axios.get).mockImplementation(async () => ({
            status: 200,
            data: { session: { id: 's1', active } },
        }) as never);
        const socket = {
            connected: true,
            emit: vi.fn((_event: string, payload: { time: number }) => {
                if (payload.time >= legacyDeliveryAttemptAt - 600_000) active = false;
            }),
        };

        await expect(deliverSessionEndMutation({ token: 'tok', socket, mutation })).resolves.toBe(true);

        expect(socket.emit).toHaveBeenCalledWith('session-end', {
            sid: 's1',
            time: legacyDeliveryAttemptAt,
        });
        expect(mutation.observedAt).toBe(1_000);
    });

    it('confirms unsupported HTTP session-end through socket ack before proof polling', async () => {
        vi.mocked(axios.post).mockRejectedValue({ response: { status: 404 } });
        const socket = {
            connected: true,
            emit: vi.fn(),
            emitWithAck: vi.fn(async () => ({ ok: true, applied: true })),
        };

        await expect(deliverSessionEndMutation({ token: 'tok', socket, mutation })).resolves.toBe(true);

        expect(socket.emitWithAck).toHaveBeenCalledWith('session-end', { sid: 's1', time: legacyDeliveryAttemptAt });
        expect(socket.emit).not.toHaveBeenCalled();
        expect(vi.mocked(axios.get)).not.toHaveBeenCalled();
    });

    it('confirms unsupported HTTP session-end when legacy socket delivery is proven inactive from v1 list state', async () => {
        vi.mocked(axios.post).mockRejectedValue({ response: { status: 404 } });
        vi.mocked(axios.get)
            .mockRejectedValueOnce({ response: { status: 404 } })
            .mockResolvedValueOnce({
                status: 200,
                data: {
                    sessions: [
                        { id: 's1', active: false },
                    ],
                },
            } as never);
        const socket = {
            connected: true,
            emit: vi.fn(),
        };

        await expect(deliverSessionEndMutation({ token: 'tok', socket, mutation })).resolves.toBe(true);

        expect(socket.emit).toHaveBeenCalledWith('session-end', { sid: 's1', time: legacyDeliveryAttemptAt });
        expect(vi.mocked(axios.get).mock.calls.map(([url]) => String(url))).toEqual([
            expect.stringContaining('/v2/sessions/s1'),
            expect.stringContaining('/v1/sessions'),
        ]);
    });

    it('confirms legacy session-end proof when unsupported HTTP uses a direct status shape', async () => {
        vi.mocked(axios.post).mockRejectedValue({ status: 501 });
        vi.mocked(axios.get).mockResolvedValueOnce({
            status: 200,
            data: { session: { id: 's1', active: false } },
        } as never);
        const socket = {
            connected: true,
            emit: vi.fn(),
        };

        await expect(deliverSessionEndMutation({ token: 'tok', socket, mutation })).resolves.toBe(true);

        expect(socket.emit).toHaveBeenCalledWith('session-end', { sid: 's1', time: legacyDeliveryAttemptAt });
        expect(vi.mocked(axios.get).mock.calls[0]?.[0]).toEqual(expect.stringContaining('/v2/sessions/s1'));
        expect(vi.mocked(axios.get).mock.calls[0]?.[1]?.headers).toMatchObject({
            'X-Happier-Request-Purpose': 'session-detail:legacy-compat-proof',
        });
    });

    it('keeps unsupported HTTP session-end unconfirmed when proof still shows the session active', async () => {
        vi.mocked(axios.post).mockRejectedValue({ response: { status: 404 } });
        vi.mocked(axios.get).mockResolvedValueOnce({
            status: 200,
            data: { session: { id: 's1', active: true } },
        } as never);
        const socket = {
            connected: true,
            emit: vi.fn(),
        };

        await expect(deliverSessionEndMutation({ token: 'tok', socket, mutation })).resolves.toBe(false);

        expect(socket.emit).toHaveBeenCalledWith('session-end', { sid: 's1', time: legacyDeliveryAttemptAt });
    });

    it('confirms disconnected session-end delivery through HTTP', async () => {
        vi.mocked(axios.post).mockResolvedValue({ status: 200, data: { success: true, applied: true } } as never);
        const socket = {
            connected: false,
            emit: vi.fn(),
        };

        await expect(deliverSessionEndMutation({ token: 'tok', socket, mutation })).resolves.toBe(true);

        expect(socket.emit).not.toHaveBeenCalled();
        expect(vi.mocked(axios.post).mock.calls[0]?.[1]).toEqual({ time: 1_000 });
    });

    it('confirms accepted no-op HTTP session-end responses', async () => {
        vi.mocked(axios.post).mockResolvedValue({ status: 200, data: { success: true, applied: false } } as never);
        const socket = {
            connected: false,
            emit: vi.fn(),
        };

        await expect(deliverSessionEndMutation({ token: 'tok', socket, mutation })).resolves.toBe(true);
    });

    it('limits concurrent session-end delivery attempts', async () => {
        process.env.HAPPIER_SESSION_END_DELIVERY_CONCURRENCY = '1';
        const firstDelivery = new Promise<{ status: number; data: { success: true } }>((resolve) => {
            setTimeout(() => resolve({ status: 200, data: { success: true } }), 50);
        });
        let activeDeliveries = 0;
        let maxActiveDeliveries = 0;
        vi.mocked(axios.post).mockImplementation(async () => {
            activeDeliveries += 1;
            maxActiveDeliveries = Math.max(maxActiveDeliveries, activeDeliveries);
            try {
                if (maxActiveDeliveries === 1) {
                    return await firstDelivery as never;
                }
                return { status: 200, data: { success: true } } as never;
            } finally {
                activeDeliveries -= 1;
            }
        });
        const socket = {
            connected: false,
            emit: vi.fn(),
        };

        await Promise.all([
            deliverSessionEndMutation({ token: 'tok', socket, mutation }),
            deliverSessionEndMutation({
                token: 'tok',
                socket,
                mutation: { ...mutation, mutationId: 'm2', sessionId: 's2' },
            }),
        ]);

        expect(maxActiveDeliveries).toBe(1);
    });
});
