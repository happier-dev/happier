import { describe, expect, it } from 'vitest';

import {
    ConversationConnectionPollRetryManagementActionDeclarationV1,
    ConversationConnectionPollRetryInputV1Schema,
    ConversationConnectionPollRetryResultV1Schema,
} from './pollRetry.js';
import { CONVERSATION_MANAGEMENT_ACTION_DECLARATIONS_V1 } from './index.js';

describe('Channels V1 connection poll retry management contract', () => {
    it('accepts only the exact guarded connection retry CAS and projects it as a closed schema', () => {
        const input = {
            connectionId: 'connection-1',
            expectedRevision: 7,
            authorityEpoch: 3,
        } as const;
        const result = {
            kind: 'retryScheduled',
            connectionId: input.connectionId,
            revision: 8,
            authorityEpoch: input.authorityEpoch,
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
            required: ['connectionId', 'expectedRevision', 'authorityEpoch'],
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
