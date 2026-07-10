import { describe, expect, it, vi } from 'vitest';

import type { SessionTurnMutationV1 } from '@happier-dev/protocol';

import { createSessionTurnLifecycle } from './lifecycle';

describe('createSessionTurnLifecycle', () => {
    it('maps active runtime turn progress to a durable touch mutation only while the turn is active', () => {
        const mutations: SessionTurnMutationV1[] = [];
        const lifecycle = createSessionTurnLifecycle({
            agentId: 'claude',
            session: {
                sessionId: 'session-1',
                enqueueSessionTurnMutation: (mutation) => {
                    mutations.push(mutation);
                },
            },
        });

        lifecycle.observeRuntimeEvent({
            kind: 'turn-progress',
            sessionId: 'session-1',
            emittedAtMs: 90,
            turnId: 'turn-1',
        });
        lifecycle.observeRuntimeEvent({
            kind: 'turn-start',
            sessionId: 'session-1',
            emittedAtMs: 100,
            turnId: 'turn-1',
            agentTurnId: 'provider-turn-1',
        });
        lifecycle.observeRuntimeEvent({
            kind: 'turn-progress',
            sessionId: 'session-1',
            emittedAtMs: 250,
            turnId: 'turn-1',
            agentTurnId: 'provider-turn-1',
        });
        lifecycle.observeRuntimeEvent({
            kind: 'turn-progress',
            sessionId: 'session-1',
            emittedAtMs: 260,
            turnId: 'turn-1',
            agentTurnId: 'provider-turn-1',
        });
        lifecycle.observeRuntimeEvent({
            kind: 'turn-progress',
            sessionId: 'session-1',
            emittedAtMs: 60_251,
            turnId: 'turn-1',
            agentTurnId: 'provider-turn-1',
        });
        lifecycle.observeRuntimeEvent({
            kind: 'turn-complete',
            sessionId: 'session-1',
            emittedAtMs: 60_300,
            turnId: 'turn-1',
            agentTurnId: 'provider-turn-1',
        });
        lifecycle.observeRuntimeEvent({
            kind: 'turn-progress',
            sessionId: 'session-1',
            emittedAtMs: 60_350,
            turnId: 'turn-1',
            agentTurnId: 'provider-turn-1',
        });

        expect(mutations.map((mutation) => mutation.action)).toEqual(['begin', 'touch_active', 'touch_active', 'complete']);
        expect(mutations[1]).toMatchObject({
            action: 'touch_active',
            turnId: 'turn-1',
            agentId: 'claude',
            agentTurnId: 'provider-turn-1',
            observedAt: 250,
        });
        expect(mutations[2]).toMatchObject({
            action: 'touch_active',
            turnId: 'turn-1',
            agentId: 'claude',
            agentTurnId: 'provider-turn-1',
            observedAt: 60_251,
        });
    });

    it('clears terminal turn state when a terminal mutation write throws synchronously', () => {
        const lifecycle = createSessionTurnLifecycle({
            agentId: 'claude',
            session: {
                sessionId: 'session-1',
                enqueueSessionTurnMutation: (mutation) => {
                    if (mutation.action === 'complete') throw new Error('outbox unavailable');
                },
            },
        });

        lifecycle.observeRuntimeEvent({
            kind: 'turn-start',
            sessionId: 'session-1',
            emittedAtMs: 100,
            turnId: 'turn-1',
        });

        expect(() => lifecycle.observeRuntimeEvent({
            kind: 'turn-complete',
            sessionId: 'session-1',
            emittedAtMs: 200,
            turnId: 'turn-1',
        })).not.toThrow();

        expect(lifecycle.hasActiveTurn()).toBe(false);
    });

    it('clears terminal turn state when a terminal mutation write rejects asynchronously', async () => {
        const enqueueSessionTurnMutation = vi.fn(async (mutation: SessionTurnMutationV1) => {
            if (mutation.action === 'complete') throw new Error('outbox unavailable');
        });
        const lifecycle = createSessionTurnLifecycle({
            agentId: 'claude',
            session: {
                sessionId: 'session-1',
                enqueueSessionTurnMutation,
            },
        });

        lifecycle.observeRuntimeEvent({
            kind: 'turn-start',
            sessionId: 'session-1',
            emittedAtMs: 100,
            turnId: 'turn-1',
        });
        lifecycle.observeRuntimeEvent({
            kind: 'turn-complete',
            sessionId: 'session-1',
            emittedAtMs: 200,
            turnId: 'turn-1',
        });
        await Promise.resolve();

        expect(enqueueSessionTurnMutation).toHaveBeenCalledTimes(2);
        expect(lifecycle.hasActiveTurn()).toBe(false);
    });

    it('marks the rollback-applied affected turn rather than the restored target turn', () => {
        const mutations: SessionTurnMutationV1[] = [];
        const lifecycle = createSessionTurnLifecycle({
            agentId: 'codex',
            session: {
                sessionId: 'session-1',
                enqueueSessionTurnMutation: (mutation) => {
                    mutations.push(mutation);
                },
            },
        });

        lifecycle.observeRuntimeEvent({
            kind: 'turn-start',
            sessionId: 'session-1',
            emittedAtMs: 100,
            turnId: 'target-turn',
        });
        lifecycle.observeRuntimeEvent({
            kind: 'turn-start',
            sessionId: 'session-1',
            emittedAtMs: 110,
            turnId: 'rolled-turn',
        });
        lifecycle.observeRuntimeEvent({
            kind: 'turn-rollback-applied',
            sessionId: 'session-1',
            emittedAtMs: 120,
            turnId: 'rolled-turn',
            restoredToTurnId: 'target-turn',
            agentTurnId: 'provider-rolled',
        });

        expect(mutations.at(-1)).toMatchObject({
            action: 'mark_rolled_back',
            turnId: 'rolled-turn',
            restoredToTurnId: 'target-turn',
            agentTurnId: 'provider-rolled',
        });
    });
});
