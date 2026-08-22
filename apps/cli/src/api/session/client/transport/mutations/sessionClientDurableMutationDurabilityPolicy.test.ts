import { describe, expect, it } from 'vitest';

import { shouldDeadLetterSessionClientDurableMutation } from './sessionClientDurableMutationDurabilityPolicy';
import type { QueuedSessionClientDurableMutation } from './sessionClientDurableMutationTypes';

function createQueuedRegisteredField(
    fieldId: 'runtime.workState' | 'display.title',
    deliveryClass: 'durable_required' | 'durable_best_effort',
): QueuedSessionClientDurableMutation {
    return {
        kind: 'registered_session_state_field',
        mutationId: `field:${fieldId}`,
        payload: {
            v: 1,
            sessionId: 'session-1',
            mutationId: `field:${fieldId}`,
            fieldId,
            deliveryClass,
            op: fieldId === 'runtime.workState'
                ? { kind: 'set', value: { v: 1, backendId: 'test', updatedAt: 1, items: [] } }
                : { kind: 'set', value: 'Title' },
            source: 'runtime',
            observedAt: 1,
        },
        createdAt: 1,
        attempts: 1,
        nextAttemptAt: 1,
    };
}

describe('session durable mutation durability policy', () => {
    it('never exhausts family facts and registry-owned durable-required fields', () => {
        const transcript: QueuedSessionClientDurableMutation = {
            kind: 'transcript_message_append',
            mutationId: 'transcript:session-1:message-1',
            payload: {
                v: 1,
                sessionId: 'session-1',
                mutationId: 'transcript:session-1:message-1',
                source: 'transcript_message_append',
                localId: 'message-1',
                content: 'ciphertext',
                createdAt: 1,
                updatedAt: 1,
                provenance: { kind: 'non_dependent', source: 'external' },
            },
            createdAt: 1,
            attempts: 1,
            nextAttemptAt: 1,
        };

        expect(shouldDeadLetterSessionClientDurableMutation(transcript)).toBe(false);
        expect(shouldDeadLetterSessionClientDurableMutation(
            createQueuedRegisteredField('runtime.workState', 'durable_best_effort'),
        )).toBe(false);
    });

    it('retains bounded exhaustion for registry-owned durable-best-effort fields', () => {
        expect(shouldDeadLetterSessionClientDurableMutation(
            createQueuedRegisteredField('display.title', 'durable_required'),
        )).toBe(true);
    });
});
