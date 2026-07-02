import { describe, expect, it } from 'vitest';

import type { SessionTurnMutationV1 } from '@happier-dev/protocol';

import { createSessionTurnLifecycle } from './lifecycle';

describe('createSessionTurnLifecycle', () => {
    it('marks the rollback-applied affected turn rather than the restored target turn', () => {
        const mutations: SessionTurnMutationV1[] = [];
        const lifecycle = createSessionTurnLifecycle({
            provider: 'codex',
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
            providerTurnId: 'provider-rolled',
        });

        expect(mutations.at(-1)).toMatchObject({
            action: 'mark_rolled_back',
            turnId: 'rolled-turn',
            restoredToTurnId: 'target-turn',
            providerTurnId: 'provider-rolled',
        });
    });
});
