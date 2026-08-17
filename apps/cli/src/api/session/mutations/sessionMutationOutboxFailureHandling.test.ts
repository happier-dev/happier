import { describe, expect, it } from 'vitest';

import { createTranscriptMessageAppendMutation } from './sessionMutationTypes';
import { shouldDeadLetterFailedMutation } from './sessionMutationOutboxFailureHandling';

const queuedTranscriptMutation = {
    kind: 'transcript_message_append' as const,
    mutationId: 'transcript:session-1:message-1',
    payload: createTranscriptMessageAppendMutation({
        sessionId: 'session-1',
        localId: 'message-1',
        messageRole: 'agent',
        content: { t: 'plain' as const, v: { role: 'agent' as const, content: { type: 'text' as const, text: 'Hello' } } },
        createdAt: 1_000,
        updatedAt: 1_000,
        provenance: { kind: 'non_dependent', source: 'history' },
    }),
    createdAt: 1_000,
    attempts: 1,
    nextAttemptAt: 0,
};

describe('shouldDeadLetterFailedMutation', () => {
    it('terminally quarantines a permanently invalid required mutation', () => {
        expect(shouldDeadLetterFailedMutation(queuedTranscriptMutation, 2_000, {
            status: 'permanent_invalid_payload',
            reason: 'transcript_observation_invalid',
        })).toBe(true);
    });

    it('does not exhaust a required mutation for retryable transport failure', () => {
        expect(shouldDeadLetterFailedMutation({
            ...queuedTranscriptMutation,
            attempts: Number.MAX_SAFE_INTEGER,
        }, 2_000, {
            status: 'retryable',
            reason: 'transcript_observation_transport_unavailable',
        })).toBe(false);
    });
});
