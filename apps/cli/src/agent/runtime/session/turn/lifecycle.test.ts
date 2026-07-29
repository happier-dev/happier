import { describe, expect, it, vi } from 'vitest';

import type { SessionTurnMutationV1 } from '@happier-dev/protocol';

import { createSessionTurnLifecycle } from './lifecycle';

describe('createSessionTurnLifecycle', () => {
    it('records exact begin marker custody before publishing the server begin mutation', async () => {
        let recordMarker!: () => void;
        const markerRecorded = new Promise<void>((resolve) => {
            recordMarker = resolve;
        });
        const enqueueSessionTurnMutation = vi.fn(async () => undefined);
        const onAcceptedTurnLifecycle = vi.fn(async () => {
            await markerRecorded;
        });
        const lifecycle = createSessionTurnLifecycle({
            session: {
                sessionId: 'session-1',
                enqueueSessionTurnMutation,
            },
            onAcceptedTurnLifecycle,
        });

        lifecycle.observeRuntimeEvent({
            kind: 'turn-start',
            sessionId: 'session-1',
            emittedAtMs: 100,
            turnId: 'turn-1',
        });
        await vi.waitFor(() => expect(onAcceptedTurnLifecycle).toHaveBeenCalledOnce());
        expect(enqueueSessionTurnMutation).not.toHaveBeenCalled();

        recordMarker();
        await lifecycle.drainAcceptedLifecycle();
        expect(onAcceptedTurnLifecycle).toHaveBeenCalledWith({
            event: 'task_started',
            turnId: 'turn-1',
        });
        expect(enqueueSessionTurnMutation).toHaveBeenCalledWith(expect.objectContaining({
            action: 'begin',
            turnId: 'turn-1',
        }));
        expect(onAcceptedTurnLifecycle.mock.invocationCallOrder[0]).toBeLessThan(
            enqueueSessionTurnMutation.mock.invocationCallOrder[0]!,
        );
    });

    it('retains exact marker custody when server begin persistence rejects', async () => {
        const onAcceptedTurnLifecycle = vi.fn();
        const lifecycle = createSessionTurnLifecycle({
            session: {
                sessionId: 'session-1',
                enqueueSessionTurnMutation: async (mutation) => {
                    if (mutation.action === 'begin') throw new Error('outbox unavailable');
                },
            },
            onAcceptedTurnLifecycle,
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
        await lifecycle.drainAcceptedLifecycle();

        expect(onAcceptedTurnLifecycle).toHaveBeenCalledTimes(1);
        expect(onAcceptedTurnLifecycle).toHaveBeenCalledWith({
            event: 'task_started',
            turnId: 'turn-1',
        });
    });

    it('serializes exact begin before accepted matching terminal publication', async () => {
        let releaseBeginNotification!: () => void;
        const beginNotificationReleased = new Promise<void>((resolve) => {
            releaseBeginNotification = resolve;
        });
        const observed: string[] = [];
        const lifecycle = createSessionTurnLifecycle({
            session: {
                sessionId: 'session-1',
                enqueueSessionTurnMutation: async () => undefined,
            },
            onAcceptedTurnLifecycle: async (input) => {
                observed.push(`${input.event}:${input.turnId}`);
                if (input.event === 'task_started') await beginNotificationReleased;
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
        await vi.waitFor(() => expect(observed).toEqual(['task_started:turn-1']));

        releaseBeginNotification();
        await vi.waitFor(() => {
            expect(observed).toEqual([
                'task_started:turn-1',
                'assistant_message_end:turn-1',
            ]);
        });
    });

    it('retries rejected exact begin publication and drains the retained obligation before cleanup', async () => {
        let releasePublishedBegin!: () => void;
        const publishedBegin = new Promise<void>((resolve) => {
            releasePublishedBegin = resolve;
        });
        const onAcceptedTurnLifecycle = vi.fn(async () => {
            if (onAcceptedTurnLifecycle.mock.calls.length === 1) {
                throw new Error('marker was not updated');
            }
            await publishedBegin;
        });
        const lifecycle = createSessionTurnLifecycle({
            session: {
                sessionId: 'session-1',
                enqueueSessionTurnMutation: async () => undefined,
            },
            onAcceptedTurnLifecycle,
        });

        lifecycle.observeRuntimeEvent({
            kind: 'turn-start',
            sessionId: 'session-1',
            emittedAtMs: 100,
            turnId: 'turn-1',
        });

        await vi.waitFor(() => expect(onAcceptedTurnLifecycle).toHaveBeenCalledTimes(2));
        let drained = false;
        const drain = lifecycle.drainAcceptedLifecycle().then(() => {
            drained = true;
        });
        await Promise.resolve();
        expect(drained).toBe(false);

        releasePublishedBegin();
        await drain;
        expect(drained).toBe(true);
    });

    it('authors no broad terminal when session-ended has no active exact turn', () => {
        const mutations: SessionTurnMutationV1[] = [];
        const lifecycle = createSessionTurnLifecycle({
            session: {
                sessionId: 'session-1',
                enqueueSessionTurnMutation: (mutation) => {
                    mutations.push(mutation);
                },
            },
        });

        lifecycle.observeRuntimeEvent({
            kind: 'session-ended',
            sessionId: 'session-1',
            emittedAtMs: 100,
        });

        expect(mutations).toEqual([]);
    });

    it('authors no broad terminal when session-ended clears an active runtime turn', () => {
        const mutations: SessionTurnMutationV1[] = [];
        const lifecycle = createSessionTurnLifecycle({
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
            turnId: 'turn-1',
        });
        lifecycle.observeRuntimeEvent({
            kind: 'session-ended',
            sessionId: 'session-1',
            emittedAtMs: 200,
        });

        expect(mutations.map((mutation) => mutation.action)).toEqual(['begin']);
        expect(lifecycle.hasActiveTurn()).toBe(false);
    });

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

    it('marks a persisted rollback-applied affected turn rather than the restored target turn', () => {
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

    it('does not reopen rollback eligibility when a late boundary follows an applied rollback', async () => {
        const mutations: SessionTurnMutationV1[] = [];
        const lifecycle = createSessionTurnLifecycle({
            agentId: 'grok',
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
            turnId: 'rolled-turn',
        });
        lifecycle.observeRuntimeEvent({
            kind: 'turn-rollback-boundary-observed',
            sessionId: 'session-1',
            emittedAtMs: 110,
            turnId: 'rolled-turn',
            providerCheckpoint: { promptIndex: 4 },
        });
        lifecycle.observeRuntimeEvent({
            kind: 'turn-complete',
            sessionId: 'session-1',
            emittedAtMs: 120,
            turnId: 'rolled-turn',
        });
        lifecycle.observeRuntimeEvent({
            kind: 'turn-rollback-applied',
            sessionId: 'session-1',
            emittedAtMs: 130,
            turnId: 'rolled-turn',
            restoredToTurnId: 'rolled-turn',
        });
        lifecycle.observeRuntimeEvent({
            kind: 'turn-rollback-boundary-observed',
            sessionId: 'session-1',
            emittedAtMs: 140,
            turnId: 'rolled-turn',
            providerCheckpoint: { promptIndex: 4 },
        });
        await Promise.resolve();

        expect(mutations.map((mutation) => mutation.action)).toEqual([
            'begin',
            'complete',
            'mark_rolled_back',
        ]);
    });

    it('persists an exact checkpoint only for its matching known turn', async () => {
        const mutations: SessionTurnMutationV1[] = [];
        const lifecycle = createSessionTurnLifecycle({
            agentId: 'grok',
            session: {
                sessionId: 'session-history',
                enqueueSessionTurnMutation: async (mutation) => {
                    mutations.push(mutation);
                },
            },
            onAcceptedTurnLifecycle: async () => undefined,
        });

        lifecycle.observeRuntimeEvent({
            kind: 'turn-rollback-boundary-observed',
            sessionId: 'session-history',
            emittedAtMs: 90,
            turnId: 'unknown-turn',
            providerCheckpoint: { kind: 'grok_prompt_index', promptIndex: 41 },
        });
        lifecycle.observeRuntimeEvent({
            kind: 'turn-start',
            sessionId: 'session-history',
            emittedAtMs: 100,
            turnId: 'turn-42',
        });
        lifecycle.observeRuntimeEvent({
            kind: 'turn-rollback-boundary-observed',
            sessionId: 'session-history',
            emittedAtMs: 110,
            turnId: 'turn-42',
            startUserMessageSeq: 7,
            providerCheckpoint: { kind: 'grok_prompt_index', promptIndex: 42 },
        });
        lifecycle.observeRuntimeEvent({
            kind: 'turn-complete',
            sessionId: 'session-history',
            emittedAtMs: 120,
            turnId: 'turn-42',
        });
        await lifecycle.drainAcceptedLifecycle();

        expect(mutations.filter((mutation) => (
            mutation.action === 'mark_rollback_eligible'
        ))).toEqual([
            expect.objectContaining({
                action: 'mark_rollback_eligible',
                turnId: 'turn-42',
                transcriptAnchors: {
                    startUserMessageSeq: 7,
                    providerCheckpoint: {
                        kind: 'grok_prompt_index',
                        promptIndex: 42,
                    },
                },
            }),
        ]);
    });

    it('publishes rollback eligibility only after its matching turn completes', async () => {
        const actions: SessionTurnMutationV1['action'][] = [];
        const lifecycle = createSessionTurnLifecycle({
            agentId: 'grok',
            session: {
                sessionId: 'session-history-order',
                enqueueSessionTurnMutation: async (mutation) => {
                    actions.push(mutation.action);
                },
            },
            onAcceptedTurnLifecycle: async () => undefined,
        });

        lifecycle.observeRuntimeEvent({
            kind: 'turn-start',
            sessionId: 'session-history-order',
            emittedAtMs: 100,
            turnId: 'turn-1',
        });
        lifecycle.observeRuntimeEvent({
            kind: 'turn-rollback-boundary-observed',
            sessionId: 'session-history-order',
            emittedAtMs: 200,
            turnId: 'turn-1',
            startUserMessageSeq: 7,
            providerCheckpoint: { kind: 'grok_prompt_index', promptIndex: 1 },
        });
        await lifecycle.drainAcceptedLifecycle();
        expect(actions).toEqual(['begin']);

        lifecycle.observeRuntimeEvent({
            kind: 'turn-complete',
            sessionId: 'session-history-order',
            emittedAtMs: 200,
            turnId: 'turn-1',
        });
        await lifecycle.drainAcceptedLifecycle();

        expect(actions).toEqual(['begin', 'complete', 'mark_rollback_eligible']);
    });
});
