import { describe, expect, it, vi } from 'vitest';

import {
    SESSION_TRANSCRIPT_OBSERVATION_CAPABILITY_EVENT_V1,
    SESSION_TRANSCRIPT_OBSERVATION_CAPABILITY_V1,
    SESSION_TRANSCRIPT_OBSERVATION_EVENT_V1,
} from '@happier-dev/protocol';

import { deliverTranscriptMessageMutation } from './deliverTranscriptMessageMutation';
import { createTranscriptMessageAppendMutation } from './sessionMutationTypes';

const mutation = createTranscriptMessageAppendMutation({
    sessionId: 'session-1',
    localId: 'claude-jsonl:main:assistant:message-1',
    messageRole: 'agent',
    content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'Hello' } } },
    createdAt: 1_000,
    updatedAt: 1_000,
    provenance: { kind: 'non_dependent', source: 'history' },
});

function socketReturningObservationAck(ack: unknown) {
    return {
        connected: true,
        emitWithAck: vi.fn(async (event: string) => {
            if (event === SESSION_TRANSCRIPT_OBSERVATION_CAPABILITY_EVENT_V1) {
                return { ok: true, capability: SESSION_TRANSCRIPT_OBSERVATION_CAPABILITY_V1 };
            }
            if (event === SESSION_TRANSCRIPT_OBSERVATION_EVENT_V1) return ack;
            throw new Error(`Unexpected event: ${event}`);
        }),
    };
}

describe('deliverTranscriptMessageMutation', () => {
    it('classifies an invalid observation as permanent instead of retryable transport failure', async () => {
        await expect(deliverTranscriptMessageMutation({
            token: 'token',
            socket: socketReturningObservationAck({ ok: false, error: 'invalid_observation' }),
            mutation,
        })).resolves.toEqual({
            status: 'permanent_invalid_payload',
            reason: 'transcript_observation_invalid',
        });
    });

    it('keeps an internal observation failure retryable', async () => {
        await expect(deliverTranscriptMessageMutation({
            token: 'token',
            socket: socketReturningObservationAck({ ok: false, error: 'internal' }),
            mutation,
        })).resolves.toEqual({
            status: 'retryable',
            reason: 'transcript_observation_transport_unavailable',
        });
    });
});
