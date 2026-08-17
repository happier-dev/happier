import { describe, expect, it } from 'vitest';

import {
    ConversationDeliveryReplyContextV1Schema,
    ConversationDeliveryInputV1Schema,
    ConversationDeliveryReconcileInputV1Schema,
    ConversationDeliveryResultV1JsonSchema,
    ConversationDeliveryResultV1Schema,
} from './delivery.js';

describe('Channels V1 provider delivery results', () => {
    it('preserves the core-derived delivery identity and prevents reconciliation from re-sending content', () => {
        const connection = {
            v: 1,
            connectionId: 'connection-1',
            providerConnectionKey: 'provider:connection-1',
            providerConfigVersion: 1,
            providerConfig: { installation: 'installation-1' },
            credentialRef: null,
        } as const;
        const delivery = {
            ...connection,
            endpoint: { kind: 'thread', audience: 'shared', id: 'thread-1' },
            content: 'A bounded reply',
            deliveryKey: 'binding-1:reply-1',
            replyContext: { replyToMessageId: 'message-1' },
            mentionPolicy: 'suppress',
            linkPreviewPolicy: 'suppress',
        } as const;
        const reconciliation = {
            ...connection,
            endpoint: delivery.endpoint,
            deliveryKey: delivery.deliveryKey,
        } as const;

        expect(ConversationDeliveryInputV1Schema.parse(delivery)).toEqual(delivery);
        expect(ConversationDeliveryReconcileInputV1Schema.parse(reconciliation)).toEqual(reconciliation);
        expect(ConversationDeliveryInputV1Schema.safeParse({
            ...delivery,
            mentionPolicy: 'allow',
        }).success).toBe(false);
        expect(ConversationDeliveryReconcileInputV1Schema.safeParse({
            ...reconciliation,
            content: 'must not cross the reconciliation boundary',
        }).success).toBe(false);
        expect(ConversationDeliveryInputV1Schema.safeParse({
            ...delivery,
            providerOptions: { raw: true },
        }).success).toBe(false);
    });

    it('keeps reply context closed and requires a real reply or thread target', () => {
        const context = {
            replyToMessageId: '\u00e9'.repeat(256),
            threadId: 'thread-1',
        } as const;

        expect(ConversationDeliveryReplyContextV1Schema.parse(context)).toEqual(context);
        expect(ConversationDeliveryReplyContextV1Schema.safeParse({}).success).toBe(false);
        expect(ConversationDeliveryReplyContextV1Schema.safeParse({
            replyToMessageId: 'message-1',
            providerThread: 'not public',
        }).success).toBe(false);
        expect(ConversationDeliveryReplyContextV1Schema.safeParse({
            replyToMessageId: '\u00e9'.repeat(257),
        }).success).toBe(false);
    });

    it('preserves distinct delivery outcomes and forbids retrying accepted partial effects', () => {
        const partial = {
            kind: 'partial',
            providerMessageIds: ['message-1'],
            failedChunk: 1,
            retrySafe: false,
        } as const;

        expect(ConversationDeliveryResultV1Schema.parse(partial)).toEqual(partial);
        expect(ConversationDeliveryResultV1Schema.parse({
            kind: 'notDelivered',
            retry: 'after',
            retryAfterMs: 1_000,
        })).toEqual({
            kind: 'notDelivered',
            retry: 'after',
            retryAfterMs: 1_000,
        });
        expect(ConversationDeliveryResultV1Schema.parse({
            kind: 'outcomeUnknown',
            providerMessageIds: ['message-1'],
        })).toEqual({
            kind: 'outcomeUnknown',
            providerMessageIds: ['message-1'],
        });
        const retryablePartial = {
            ...partial,
            retrySafe: true,
        } as const;
        expect(ConversationDeliveryResultV1Schema.safeParse(retryablePartial).success).toBe(false);
        expect(ConversationDeliveryResultV1Schema.safeParse({
            kind: 'endpointArchived',
            recovery: 'retry',
        }).success).toBe(false);
        expect(ConversationDeliveryResultV1Schema.safeParse({
            kind: 'delivered',
            providerMessageIds: Array.from({ length: 33 }, () => 'message'),
        }).success).toBe(false);
        expect(ConversationDeliveryResultV1Schema.safeParse({
            ...partial,
            providerEvidence: 'must stay provider-local',
        }).success).toBe(false);
        expect(ConversationDeliveryResultV1JsonSchema).toMatchObject({
            anyOf: expect.any(Array),
        });
    });
});
