import axios from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionTurnMutationV1 } from '@happier-dev/protocol';

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

const ordinaryMutations = [
    {
        v: 1,
        sessionId: 'session-1',
        mutationId: 'begin-1',
        action: 'begin',
        turnId: 'turn-1',
        observedAt: 201,
    },
    {
        v: 1,
        sessionId: 'session-1',
        mutationId: 'touch-1',
        action: 'touch_active',
        turnId: 'turn-1',
        observedAt: 202,
    },
    {
        v: 1,
        sessionId: 'session-1',
        mutationId: 'attach-1',
        action: 'attach_agent_turn_id',
        turnId: 'turn-1',
        agentTurnId: 'agent-turn-1',
        observedAt: 203,
    },
    {
        v: 1,
        sessionId: 'session-1',
        mutationId: 'anchors-1',
        action: 'append_transcript_anchors',
        turnId: 'turn-1',
        transcriptAnchors: { startUserMessageSeq: 1 },
        observedAt: 204,
    },
    {
        v: 1,
        sessionId: 'session-1',
        mutationId: 'complete-1',
        action: 'complete',
        turnId: 'turn-1',
        observedAt: 205,
    },
    {
        v: 1,
        sessionId: 'session-1',
        mutationId: 'fail-1',
        action: 'fail',
        turnId: 'turn-1',
        issue: {
            v: 1,
            scope: 'primary_session',
            status: 'failed',
            code: 'test_failure',
            source: 'unknown',
            occurredAt: 206,
        },
        observedAt: 206,
    },
    {
        v: 1,
        sessionId: 'session-1',
        mutationId: 'cancel-1',
        action: 'cancel',
        turnId: 'turn-1',
        observedAt: 207,
    },
    {
        v: 1,
        sessionId: 'session-1',
        mutationId: 'rollback-eligible-1',
        action: 'mark_rollback_eligible',
        turnId: 'turn-1',
        observedAt: 208,
    },
    {
        v: 1,
        sessionId: 'session-1',
        mutationId: 'rolled-back-1',
        action: 'mark_rolled_back',
        turnId: 'turn-1',
        observedAt: 209,
    },
] as const satisfies readonly SessionTurnMutationV1[];

function ordinaryReceipt(mutation: SessionTurnMutationV1, overrides: Record<string, unknown> = {}) {
    return {
        v: mutation.v,
        sessionId: mutation.sessionId,
        mutationId: mutation.mutationId,
        ...('turnId' in mutation && mutation.turnId ? { turnId: mutation.turnId } : {}),
        action: mutation.action,
        decision: 'applied',
        observedAt: mutation.observedAt,
        appliedAt: mutation.observedAt + 1,
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

    it.each(ordinaryMutations)('releases ordinary $action custody only for a matching socket receipt', async (ordinaryMutation) => {
        const socket = {
            connected: true,
            emit: vi.fn(),
            timeout: () => socket,
            emitWithAck: vi.fn(async () => ({
                result: 'success',
                receipt: ordinaryReceipt(ordinaryMutation),
            })),
        };

        await expect(deliverSessionTurnMutation({
            token: 'token',
            socket,
            mutation: ordinaryMutation,
        })).resolves.toEqual({ delivered: true, path: 'socket' });
        expect(axios.post).not.toHaveBeenCalled();
    });

    it('does not treat generic socket or HTTP success as ordinary mutation delivery', async () => {
        const ordinaryMutation = ordinaryMutations[0];
        const socket = {
            connected: true,
            emit: vi.fn(),
            timeout: () => socket,
            emitWithAck: vi.fn(async () => ({ result: 'success' })),
        };
        vi.mocked(axios.post).mockResolvedValue({ status: 200, data: { success: true } } as never);

        await expect(deliverSessionTurnMutation({
            token: 'token',
            socket,
            mutation: ordinaryMutation,
        })).resolves.toMatchObject({
            delivered: false,
            reason: 'session_turn_mutation_receipt_mismatch',
        });
        expect(axios.post).toHaveBeenCalledOnce();
    });

    it('falls back from anonymous socket success to a matching HTTP receipt', async () => {
        const ordinaryMutation = ordinaryMutations[2];
        const socket = {
            connected: true,
            emit: vi.fn(),
            timeout: () => socket,
            emitWithAck: vi.fn(async () => ({ result: 'success' })),
        };
        vi.mocked(axios.post).mockResolvedValue({
            status: 200,
            data: {
                success: true,
                receipt: ordinaryReceipt(ordinaryMutation),
            },
        } as never);

        await expect(deliverSessionTurnMutation({
            token: 'token',
            socket,
            mutation: ordinaryMutation,
        })).resolves.toEqual({ delivered: true, path: 'http' });
    });

    it('treats a matching ordinary rejection receipt as deterministic server settlement', async () => {
        const ordinaryMutation = ordinaryMutations[0];
        const socket = {
            connected: true,
            emit: vi.fn(),
            timeout: () => socket,
            emitWithAck: vi.fn(async () => ({
                result: 'success',
                applied: false,
                receipt: ordinaryReceipt(ordinaryMutation, { decision: 'missing-turn' }),
            })),
        };

        await expect(deliverSessionTurnMutation({
            token: 'token',
            socket,
            mutation: ordinaryMutation,
        })).resolves.toEqual({ delivered: true, path: 'socket' });
        expect(axios.post).not.toHaveBeenCalled();
    });

    it('does not settle ordinary custody from another mutation receipt', async () => {
        const ordinaryMutation = ordinaryMutations[1];
        const socket = {
            connected: true,
            emit: vi.fn(),
            timeout: () => socket,
            emitWithAck: vi.fn(async () => ({
                result: 'success',
                receipt: ordinaryReceipt(ordinaryMutation, { mutationId: 'different-socket-mutation' }),
            })),
        };
        vi.mocked(axios.post).mockResolvedValue({
            status: 200,
            data: {
                success: true,
                receipt: ordinaryReceipt(ordinaryMutation, { observedAt: ordinaryMutation.observedAt + 100 }),
            },
        } as never);

        await expect(deliverSessionTurnMutation({
            token: 'token',
            socket,
            mutation: ordinaryMutation,
        })).resolves.toMatchObject({
            delivered: false,
            reason: 'session_turn_mutation_receipt_mismatch',
        });
        expect(axios.post).toHaveBeenCalledOnce();
    });
});
