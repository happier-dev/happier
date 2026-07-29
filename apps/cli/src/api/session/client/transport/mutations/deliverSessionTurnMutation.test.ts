import axios from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { deliverSessionTurnMutation } from './deliverSessionTurnMutation';

vi.mock('axios');

const mutation = {
    v: 1,
    sessionId: 'session-1',
    mutationId: 'mutation-1',
    action: 'end_session',
    turnId: 'turn-1',
    observedAt: 200,
} as const;

function receipt(overrides: Record<string, unknown> = {}) {
    return {
        ...mutation,
        decision: 'applied',
        appliedAt: 250,
        ...overrides,
    };
}

describe('deliverSessionTurnMutation exact end', () => {
    beforeEach(() => {
        vi.mocked(axios.post).mockReset();
    });

    it.each(['applied', 'duplicate-terminal'] as const)(
        'releases exact custody for the positive %s socket receipt',
        async (decision) => {
            const socket = {
                connected: true,
                emit: vi.fn(),
                timeout: () => socket,
                emitWithAck: vi.fn(async () => ({ result: 'success', receipt: receipt({ decision }) })),
            };

            await expect(deliverSessionTurnMutation({ token: 'token', socket, mutation })).resolves.toEqual({
                delivered: true,
                path: 'socket',
            });
            expect(axios.post).not.toHaveBeenCalled();
        },
    );

    it('does not treat generic socket or HTTP success as exact delivery', async () => {
        const socket = {
            connected: true,
            emit: vi.fn(),
            timeout: () => socket,
            emitWithAck: vi.fn(async () => ({ result: 'success' })),
        };
        vi.mocked(axios.post).mockResolvedValue({ status: 200, data: { success: true } } as never);

        await expect(deliverSessionTurnMutation({ token: 'token', socket, mutation })).resolves.toMatchObject({
            delivered: false,
            reason: 'exact_session_turn_mutation_not_delivered',
            diagnostic: { classification: 'receipt_mismatch' },
        });
    });

    it.each(['duplicate-mutation', 'missing-turn', 'stale-in-progress', 'stale-terminal'] as const)(
        'retains exact custody for non-positive decision %s',
        async (decision) => {
            const socket = {
                connected: true,
                emit: vi.fn(),
                timeout: () => socket,
                emitWithAck: vi.fn(async () => ({ result: 'success', receipt: receipt({ decision }) })),
            };
            vi.mocked(axios.post).mockResolvedValue({
                status: 200,
                data: { success: true, receipt: receipt({ decision }) },
            } as never);

            await expect(deliverSessionTurnMutation({ token: 'token', socket, mutation })).resolves.toMatchObject({
                delivered: false,
                reason: 'exact_session_turn_mutation_not_delivered',
                diagnostic: { classification: 'semantic_non_positive', decision },
            });
        },
    );

    it('keeps ordinary mutation delivery behavior unchanged', async () => {
        const socket = {
            connected: true,
            emit: vi.fn(),
            timeout: () => socket,
            emitWithAck: vi.fn(async () => ({ result: 'success' })),
        };

        await expect(deliverSessionTurnMutation({
            token: 'token',
            socket,
            mutation: {
                v: 1,
                sessionId: 'session-1',
                mutationId: 'touch-1',
                action: 'touch_active',
                turnId: 'turn-1',
                observedAt: 201,
            },
        })).resolves.toEqual({ delivered: true, path: 'socket' });
    });
});
