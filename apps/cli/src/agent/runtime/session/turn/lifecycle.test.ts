import { describe, expect, it, vi } from 'vitest';

import {
    AgentSessionRuntimeEventV1Schema,
    type AgentSessionRuntimeEventV1,
    type SessionTurnMutationV1,
} from '@happier-dev/protocol';

import { createSessionTurnLifecycle } from './lifecycle';

let nextRuntimeEventSequence = 0;

function canonicalRuntimeEvent(input: Readonly<Record<string, unknown>>): AgentSessionRuntimeEventV1 {
    return AgentSessionRuntimeEventV1Schema.parse({
        sequence: ++nextRuntimeEventSequence,
        ...input,
        ...(input.kind === 'turn-start' && input.startedBy === undefined
            ? { startedBy: 'host' }
            : {}),
    });
}

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

        lifecycle.observeRuntimeEvent(canonicalRuntimeEvent({
            kind: 'turn-start',
            sessionId: 'session-1',
            emittedAtMs: 100,
            turnId: 'turn-1',
        }));
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

        lifecycle.observeRuntimeEvent(canonicalRuntimeEvent({
            kind: 'turn-start',
            sessionId: 'session-1',
            emittedAtMs: 100,
            turnId: 'turn-1',
        }));
        lifecycle.observeRuntimeEvent(canonicalRuntimeEvent({
            kind: 'turn-complete',
            sessionId: 'session-1',
            emittedAtMs: 200,
            turnId: 'turn-1',
        }));
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

        lifecycle.observeRuntimeEvent(canonicalRuntimeEvent({
            kind: 'turn-start',
            sessionId: 'session-1',
            emittedAtMs: 100,
            turnId: 'turn-1',
        }));
        lifecycle.observeRuntimeEvent(canonicalRuntimeEvent({
            kind: 'turn-complete',
            sessionId: 'session-1',
            emittedAtMs: 200,
            turnId: 'turn-1',
        }));
        await vi.waitFor(() => expect(observed).toEqual(['task_started:turn-1']));

        releaseBeginNotification();
        await vi.waitFor(() => {
            expect(observed).toEqual([
                'task_started:turn-1',
                'assistant_message_end:turn-1',
            ]);
        });
    });

    it('publishes a terminal admission override as failed without duplicating a follow-up mutation', async () => {
        const mutations: SessionTurnMutationV1[] = [];
        const onAcceptedTurnLifecycle = vi.fn();
        const lifecycle = createSessionTurnLifecycle({
            session: {
                sessionId: 'session-1',
                enqueueSessionTurnMutation: async (mutation) => {
                    mutations.push(mutation);
                    return mutation.action === 'complete'
                        ? { terminalStatusOverride: 'failed' as const }
                        : undefined;
                },
            },
            onAcceptedTurnLifecycle,
        });

        lifecycle.observeRuntimeEvent(canonicalRuntimeEvent({
            kind: 'turn-start',
            sessionId: 'session-1',
            emittedAtMs: 100,
            turnId: 'turn-admission-failed',
        }));
        lifecycle.observeRuntimeEvent(canonicalRuntimeEvent({
            kind: 'turn-complete',
            sessionId: 'session-1',
            emittedAtMs: 200,
            turnId: 'turn-admission-failed',
        }));
        await lifecycle.drainAcceptedLifecycle();

        expect(onAcceptedTurnLifecycle).toHaveBeenLastCalledWith({
            event: 'assistant_message_end',
            turnId: 'turn-admission-failed',
            terminalStatus: 'failed',
        });
        expect(mutations.map((mutation) => mutation.action)).toEqual(['begin', 'complete']);
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

        lifecycle.observeRuntimeEvent(canonicalRuntimeEvent({
            kind: 'turn-start',
            sessionId: 'session-1',
            emittedAtMs: 100,
            turnId: 'turn-1',
        }));

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

    it('authors no broad terminal when runtime-ended has no active exact turn', () => {
        const mutations: SessionTurnMutationV1[] = [];
        const lifecycle = createSessionTurnLifecycle({
            session: {
                sessionId: 'session-1',
                enqueueSessionTurnMutation: (mutation) => {
                    mutations.push(mutation);
                },
            },
        });

        lifecycle.observeRuntimeEvent(canonicalRuntimeEvent({
            kind: 'runtime-ended',
            sessionId: 'session-1',
            emittedAtMs: 100,
            cause: 'providerEnded',
            retryable: false,
        }));

        expect(mutations).toEqual([]);
    });

    it('authors no broad terminal when runtime-ended clears an active runtime turn', () => {
        const mutations: SessionTurnMutationV1[] = [];
        const lifecycle = createSessionTurnLifecycle({
            session: {
                sessionId: 'session-1',
                enqueueSessionTurnMutation: (mutation) => {
                    mutations.push(mutation);
                },
            },
        });

        lifecycle.observeRuntimeEvent(canonicalRuntimeEvent({
            kind: 'turn-start',
            sessionId: 'session-1',
            emittedAtMs: 100,
            turnId: 'turn-1',
        }));
        lifecycle.observeRuntimeEvent(canonicalRuntimeEvent({
            kind: 'runtime-ended',
            sessionId: 'session-1',
            emittedAtMs: 200,
            cause: 'providerEnded',
            retryable: false,
        }));

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

        lifecycle.observeRuntimeEvent(canonicalRuntimeEvent({
            kind: 'turn-progress',
            sessionId: 'session-1',
            emittedAtMs: 90,
            turnId: 'turn-1',
        }));
        lifecycle.observeRuntimeEvent(canonicalRuntimeEvent({
            kind: 'turn-start',
            sessionId: 'session-1',
            emittedAtMs: 100,
            turnId: 'turn-1',
            agentTurnId: 'provider-turn-1',
        }));
        lifecycle.observeRuntimeEvent(canonicalRuntimeEvent({
            kind: 'turn-progress',
            sessionId: 'session-1',
            emittedAtMs: 250,
            turnId: 'turn-1',
            agentTurnId: 'provider-turn-1',
        }));
        lifecycle.observeRuntimeEvent(canonicalRuntimeEvent({
            kind: 'turn-progress',
            sessionId: 'session-1',
            emittedAtMs: 260,
            turnId: 'turn-1',
            agentTurnId: 'provider-turn-1',
        }));
        lifecycle.observeRuntimeEvent(canonicalRuntimeEvent({
            kind: 'turn-progress',
            sessionId: 'session-1',
            emittedAtMs: 60_251,
            turnId: 'turn-1',
            agentTurnId: 'provider-turn-1',
        }));
        lifecycle.observeRuntimeEvent(canonicalRuntimeEvent({
            kind: 'turn-complete',
            sessionId: 'session-1',
            emittedAtMs: 60_300,
            turnId: 'turn-1',
            agentTurnId: 'provider-turn-1',
        }));
        lifecycle.observeRuntimeEvent(canonicalRuntimeEvent({
            kind: 'turn-progress',
            sessionId: 'session-1',
            emittedAtMs: 60_350,
            turnId: 'turn-1',
            agentTurnId: 'provider-turn-1',
        }));

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

        lifecycle.observeRuntimeEvent(canonicalRuntimeEvent({
            kind: 'turn-start',
            sessionId: 'session-1',
            emittedAtMs: 100,
            turnId: 'turn-1',
        }));

        expect(() => lifecycle.observeRuntimeEvent(canonicalRuntimeEvent({
            kind: 'turn-complete',
            sessionId: 'session-1',
            emittedAtMs: 200,
            turnId: 'turn-1',
        }))).not.toThrow();

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

        lifecycle.observeRuntimeEvent(canonicalRuntimeEvent({
            kind: 'turn-start',
            sessionId: 'session-1',
            emittedAtMs: 100,
            turnId: 'turn-1',
        }));
        lifecycle.observeRuntimeEvent(canonicalRuntimeEvent({
            kind: 'turn-complete',
            sessionId: 'session-1',
            emittedAtMs: 200,
            turnId: 'turn-1',
        }));
        await Promise.resolve();

        expect(enqueueSessionTurnMutation).toHaveBeenCalledTimes(2);
        expect(lifecycle.hasActiveTurn()).toBe(false);
    });

    it('leaves canonical rollback-boundary persistence to the native session owner', async () => {
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

        lifecycle.observeRuntimeEvent(canonicalRuntimeEvent({
            kind: 'turn-start',
            sessionId: 'session-1',
            emittedAtMs: 100,
            turnId: 'turn-1',
        }));
        lifecycle.observeRuntimeEvent(canonicalRuntimeEvent({
            kind: 'turn-rollback-boundary',
            sessionId: 'session-1',
            emittedAtMs: 120,
            turnId: 'turn-1',
            agentTurnId: 'provider-turn-1',
            providerCheckpoint: { kind: 'codex_checkpoint', turn: 1 },
        }));
        lifecycle.observeRuntimeEvent(canonicalRuntimeEvent({
            kind: 'turn-complete',
            sessionId: 'session-1',
            emittedAtMs: 130,
            turnId: 'turn-1',
            agentTurnId: 'provider-turn-1',
        }));
        await lifecycle.drainAcceptedLifecycle();

        expect(mutations.map((mutation) => mutation.action)).toEqual(['begin', 'complete']);
    });
});
