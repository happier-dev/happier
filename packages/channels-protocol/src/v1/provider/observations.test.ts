import { describe, expect, it } from 'vitest';

import {
    ConversationPollInputV1Schema,
    ConversationPollResultV1Schema,
} from './observations.js';

describe('Channels V1 provider observations', () => {
    it('owns one poll input/output boundary rather than a provider checkpoint writer', () => {
        const input = {
            v: 1,
            connectionId: 'connection-1',
            providerConnectionKey: 'provider:connection-1',
            providerConfigVersion: 1,
            providerConfig: { installation: 'installation-1' },
            credentialRef: null,
            checkpoint: { cursor: 'before' },
            limit: 100,
            waitMs: 60_000,
        } as const;
        const result = {
            kind: 'checkpointOnly',
            checkpointAfterBatch: { cursor: 'after' },
            retryHint: { retryAfterMs: 500 },
        } as const;

        expect(ConversationPollInputV1Schema.parse(input)).toEqual(input);
        expect(ConversationPollResultV1Schema.parse(result)).toEqual(result);
        expect(ConversationPollInputV1Schema.safeParse({
            ...input,
            limit: 101,
        }).success).toBe(false);
        expect(ConversationPollResultV1Schema.safeParse({
            ...result,
            checkpointTransition: { providerOwned: true },
        }).success).toBe(false);
        expect(ConversationPollResultV1Schema.safeParse({
            kind: 'historyGap',
            reason: 'applicationAdmissionLost',
        }).success).toBe(false);
    });

    it('carries each checkpointed occurrence as the same observed-entry owner used by direct ingress', () => {
        const result = {
            kind: 'batch',
            observations: [{
                observation: {
                    kind: 'fullText',
                    observation: {
                        v: 1,
                        occurrenceId: 'update-42',
                        occurredAt: 1_700_000_000_000,
                        transport: { kind: 'poll' },
                        endpoint: { kind: 'direct', audience: 'direct', id: 'chat-42' },
                        actor: {
                            principalId: 'user-42',
                            kind: 'human',
                            isIntegrationSelf: false,
                        },
                        message: {
                            id: 'message-42',
                            text: 'Run the deployment.',
                            addressingEvidence: 'directIntegrationMention',
                            contentProvenance: 'original',
                            providerTimestamp: 1_700_000_000_000,
                        },
                    },
                },
                eventCandidate: {
                    eventRef: {
                        pluginId: 'happier.channel.telegram',
                        localId: 'automation/chat-message-v1',
                    },
                    sourceInstanceId: 'telegram:chat:123:42',
                    sourceContractVersion: 1,
                    payload: { chatId: '42', messageId: 'message-42' },
                },
            }],
            checkpointAfterBatch: { cursor: 'after' },
        } as const;

        expect(ConversationPollResultV1Schema.parse(result)).toEqual(result);
        expect(ConversationPollResultV1Schema.safeParse({
            ...result,
            observations: [{
                ...result.observations[0],
                eventCandidate: {
                    ...result.observations[0].eventCandidate,
                    sourceInstanceId: '',
                },
            }],
        }).success).toBe(false);
    });
});
