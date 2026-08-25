import { describe, expect, it } from 'vitest';

import {
    ConversationAuthenticatedObservationShellV1Schema,
    ConversationNormalizedIngressV1Schema,
    ConversationObservationV1Schema,
    ConversationProviderObservationIngestInputV1Schema,
} from './ingress.js';

const endpoint = {
    kind: 'direct',
    audience: 'direct',
    id: 'dm-42',
} as const;

const observation = {
    v: 1,
    occurrenceId: 'delivery-42',
    occurredAt: 1_700_000_000_000,
    transport: {
        kind: 'poll',
        providerDeliveryId: 'provider-delivery-42',
    },
    endpoint,
    actor: {
        principalId: 'user-42',
        kind: 'human',
        isIntegrationSelf: false,
    },
    message: {
        id: 'message-42',
        text: 'Please investigate this failure.',
        replyToMessageId: 'integration-message-17',
        addressingEvidence: 'replyToIntegration',
        contentProvenance: 'original',
        providerTimestamp: 1_700_000_000_000,
    },
} as const;

describe('Channels V1 normalized ingress', () => {
    it('accepts strictly authenticated full-text evidence and emits a closed projection', () => {
        expect(ConversationObservationV1Schema.parse(observation)).toEqual(observation);
        expect(ConversationObservationV1Schema.jsonSchema).toMatchObject({
            type: 'object',
            additionalProperties: false,
            required: ['v', 'occurrenceId', 'occurredAt', 'transport', 'endpoint', 'actor', 'message'],
            properties: {
                v: { const: 1 },
                message: { anyOf: expect.any(Array) },
            },
        });

        const { replyToMessageId: _replyToMessageId, ...messageWithoutReply } = observation.message;
        const malformed = [
            {
                ...observation,
                providerPluginId: 'provider-cannot-supply-caller-authority',
            },
            {
                ...observation,
                endpoint: {
                    ...endpoint,
                    audience: 'shared',
                },
            },
            {
                ...observation,
                // 65 UTF-16 units but 129 UTF-8 bytes: only the byte bound rejects it.
                occurrenceId: `${'é'.repeat(64)}a`,
            },
            {
                ...observation,
                message: {
                    ...messageWithoutReply,
                },
            },
        ] as const;

        for (const invalid of malformed) {
            expect(ConversationObservationV1Schema.safeParse(invalid).success).toBe(false);
        }
    });

    it('only carries a bodyless shell for non-admission and requires a revision for unsupported edits', () => {
        const shell = {
            ...observation,
            message: {
                id: observation.message.id,
                revision: 'immutable-revision-2',
                replyToMessageId: observation.message.replyToMessageId,
                addressingEvidence: observation.message.addressingEvidence,
                contentProvenance: observation.message.contentProvenance,
                providerTimestamp: observation.message.providerTimestamp,
            },
        } as const;
        const editIngress = {
            kind: 'routableNonAdmission',
            shell,
            reason: 'unsupportedEdit',
        } as const;
        const { revision: _revision, ...shellMessageWithoutRevision } = shell.message;
        const unsupportedContentIngress = {
            kind: 'routableNonAdmission',
            shell: {
                ...shell,
                message: shellMessageWithoutRevision,
            },
            reason: 'unsupportedContent',
        } as const;
        expect(ConversationAuthenticatedObservationShellV1Schema.parse(shell)).toEqual(shell);
        expect(ConversationNormalizedIngressV1Schema.parse(editIngress)).toEqual(editIngress);
        expect(ConversationNormalizedIngressV1Schema.parse(unsupportedContentIngress))
            .toEqual(unsupportedContentIngress);
        expect(ConversationAuthenticatedObservationShellV1Schema.jsonSchema).toMatchObject({
            type: 'object',
            additionalProperties: false,
            properties: { message: { anyOf: expect.any(Array) } },
        });
        expect(ConversationNormalizedIngressV1Schema.jsonSchema).toMatchObject({
            anyOf: expect.any(Array),
        });

        const shellWithBody = {
            ...shell,
            message: {
                ...shell.message,
                text: 'A rejected body must never survive in the shell.',
            },
        };
        const editWithoutRevision = {
            ...editIngress,
            shell: {
                ...shell,
                message: {
                    ...shellMessageWithoutRevision,
                },
            },
        };

        expect(ConversationAuthenticatedObservationShellV1Schema.safeParse(shellWithBody).success).toBe(false);
        expect(ConversationNormalizedIngressV1Schema.safeParse(editWithoutRevision).success).toBe(false);
        expect(ConversationNormalizedIngressV1Schema.safeParse({
            ...editIngress,
            observation,
        }).success).toBe(false);
    });

    it('accepts one observed ingress entry with its provider-owned Automation Event candidate at the provider-to-core boundary', () => {
        const entry = {
            observation: {
                kind: 'fullText',
                observation,
            },
            eventCandidate: {
                eventRef: {
                    pluginId: 'happier.channel.telegram',
                    localId: 'automation/chat-message-v1',
                },
                sourceInstanceId: 'telegram:chat:123:100',
                sourceContractVersion: 1,
                payload: {
                    chatId: '100',
                    messageId: 'message-42',
                    text: observation.message.text,
                },
            },
        } as const;
        const input = {
            connectionId: 'connection-1',
            entry,
        } as const;
        expect(ConversationProviderObservationIngestInputV1Schema.parse(input)).toEqual(input);
        expect(ConversationProviderObservationIngestInputV1Schema.jsonSchema).toMatchObject({
            type: 'object',
            additionalProperties: false,
            required: ['connectionId', 'entry'],
        });

        for (const invalid of [
            {
                ...input,
                authorityEpoch: 7,
            },
            {
                ...input,
                checkpointAfter: { cursor: 'provider-owned-checkpoint' },
            },
            {
                ...input,
                entry: {
                    ...entry,
                    eventCandidate: {
                        ...entry.eventCandidate,
                        sourceContractVersion: 0,
                    },
                },
            },
        ]) {
            expect(ConversationProviderObservationIngestInputV1Schema.safeParse(invalid).success)
                .toBe(false);
        }
    });
});
