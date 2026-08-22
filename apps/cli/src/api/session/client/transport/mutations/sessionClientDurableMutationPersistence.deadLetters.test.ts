import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { configurationMock } = vi.hoisted(() => ({
    configurationMock: {
        activeServerDir: '',
    },
}));

vi.mock('@/configuration', () => ({
    configuration: configurationMock,
}));

import {
    appendSessionClientDurableMutationDeadLetters,
    loadSessionClientDurableMutationDeadLetters,
    recoverAuthoritativeSessionClientDurableMutationDeadLetters,
} from './sessionClientDurableMutationPersistence';
import type { VoiceAgentTranscriptTurnMutationV1 } from './sessionClientDurableMutationTypes';

function createVoiceMutation(): VoiceAgentTranscriptTurnMutationV1 {
    const createMessage = (params: Readonly<{
        localId: string;
        messageRole: 'user' | 'agent';
        content: string;
    }>) => ({
        v: 1 as const,
        sessionId: 'session-1',
        mutationId: `transcript:session-1:${params.localId}`,
        source: 'transcript_message_append' as const,
        localId: params.localId,
        sidechainId: null,
        messageRole: params.messageRole,
        content: params.content,
        createdAt: 100,
        updatedAt: 100,
        provenance: { kind: 'non_dependent' as const, source: 'external' as const },
    });
    return {
        v: 1,
        sessionId: 'session-1',
        mutationId: 'voice-agent-transcript-turn:session-1:turn-1',
        source: 'voice_agent_transcript_turn',
        turnId: 'turn-1',
        user: createMessage({ localId: 'voice-user', messageRole: 'user', content: 'question' }),
        assistant: createMessage({ localId: 'voice-assistant', messageRole: 'agent', content: 'answer' }),
        observedAt: 100,
    };
}

describe('durable mutation dead-letter persistence', () => {
    beforeEach(async () => {
        configurationMock.activeServerDir = await mkdtemp(join(tmpdir(), 'happier-session-dead-letters-'));
    });

    afterEach(async () => {
        await rm(configurationMock.activeServerDir, { recursive: true, force: true });
    });

    it('appends terminal evidence idempotently by session, mutation kind, and mutation id', async () => {
        await appendSessionClientDurableMutationDeadLetters('session-1', [{
            v: 1,
            kind: 'transcript_message_append',
            sessionId: 'session-1',
            mutationId: 'shared-mutation-id',
            reason: 'first-terminal-reason',
            deadLetteredAt: 100,
        }]);
        await appendSessionClientDurableMutationDeadLetters('session-1', [{
            v: 1,
            kind: 'transcript_message_append',
            sessionId: 'session-1',
            mutationId: 'shared-mutation-id',
            reason: 'duplicate-terminal-reason',
            deadLetteredAt: 200,
        }, {
            v: 1,
            kind: 'registered_session_state_field',
            sessionId: 'session-1',
            mutationId: 'shared-mutation-id',
            reason: 'distinct-kind-terminal-reason',
            deadLetteredAt: 300,
        }]);

        await expect(loadSessionClientDurableMutationDeadLetters('session-1')).resolves.toEqual([
            expect.objectContaining({
                kind: 'transcript_message_append',
                mutationId: 'shared-mutation-id',
                reason: 'first-terminal-reason',
            }),
            expect.objectContaining({
                kind: 'registered_session_state_field',
                mutationId: 'shared-mutation-id',
                reason: 'distinct-kind-terminal-reason',
            }),
        ]);
    });

    it('does not recover a definitively invalid authoritative voice transcript', async () => {
        const mutation = createVoiceMutation();
        await appendSessionClientDurableMutationDeadLetters('session-1', [{
            v: 1,
            kind: 'voice_agent_transcript_turn',
            sessionId: 'session-1',
            mutationId: mutation.mutationId,
            reason: 'transcript_message_invalid_observation',
            deadLetteredAt: 100,
            queuedMutation: {
                kind: 'voice_agent_transcript_turn',
                mutationId: mutation.mutationId,
                payload: mutation,
                createdAt: 100,
                attempts: 1,
                nextAttemptAt: 0,
            },
        }]);

        await expect(
            recoverAuthoritativeSessionClientDurableMutationDeadLetters('session-1'),
        ).resolves.toEqual([]);
    });
});
