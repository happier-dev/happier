import { describe, expect, it } from 'vitest';

import {
    ConversationConnectionPollRetryManagementActionDeclarationV1,
    ConversationConnectionPollRetryInputV1Schema,
    ConversationConnectionPollRetryResultV1Schema,
} from './pollRetry.js';
import { CONVERSATION_MANAGEMENT_ACTION_DECLARATIONS_V1 } from './index.js';
import { ConversationConnectionRetestInputV1Schema } from './retest.js';

describe('Channels V1 connection poll retry management contract', () => {
    it('retests the current saved connection with only its identity', () => {
        const input = { connectionId: 'connection-1' };
        expect(ConversationConnectionRetestInputV1Schema.parse(input)).toEqual(input);
        expect(ConversationConnectionRetestInputV1Schema.safeParse({ ...input, expectedRevision: 7 }).success).toBe(false);
        expect(ConversationConnectionRetestInputV1Schema.safeParse({ ...input, authorityEpoch: 3 }).success).toBe(false);
    });

    it('retries the current connection without a stale list version witness', () => {
        const input = {
            connectionId: 'connection-1',
        } as const;
        const result = {
            kind: 'retryScheduled',
            connectionId: input.connectionId,
            revision: 8,
            authorityEpoch: 3,
        } as const;

        expect(ConversationConnectionPollRetryInputV1Schema.parse(input)).toEqual(input);
        expect(ConversationConnectionPollRetryResultV1Schema.parse(result)).toEqual(result);

        expect(ConversationConnectionPollRetryInputV1Schema.safeParse({
            ...input,
            pollFailure: { kind: 'blocked' },
        }).success).toBe(false);
        expect(ConversationConnectionPollRetryInputV1Schema.safeParse({
            ...input,
            expectedRevision: 0,
        }).success).toBe(false);
        expect(ConversationConnectionPollRetryInputV1Schema.safeParse({
            ...input,
            connectionId: 'connection id with whitespace',
        }).success).toBe(false);
        expect(ConversationConnectionPollRetryResultV1Schema.safeParse({
            ...result,
            providerInvoked: true,
        }).success).toBe(false);
        expect(ConversationConnectionPollRetryResultV1Schema.safeParse({
            ...result,
            authorityEpoch: 0,
        }).success).toBe(false);

        expect(ConversationConnectionPollRetryInputV1Schema.jsonSchema).toMatchObject({
            type: 'object',
            additionalProperties: false,
            required: ['connectionId'],
        });
        expect(ConversationConnectionPollRetryResultV1Schema.jsonSchema).toMatchObject({
            type: 'object',
            additionalProperties: false,
            required: ['kind', 'connectionId', 'revision', 'authorityEpoch'],
            properties: { kind: { const: 'retryScheduled' } },
        });
        expect(ConversationConnectionPollRetryManagementActionDeclarationV1).toEqual({
            inputSchema: ConversationConnectionPollRetryInputV1Schema.jsonSchema,
            resultSchema: ConversationConnectionPollRetryResultV1Schema.jsonSchema,
        });
        expect(CONVERSATION_MANAGEMENT_ACTION_DECLARATIONS_V1.connectionPollRetry)
            .toBe(ConversationConnectionPollRetryManagementActionDeclarationV1);
    });
});
