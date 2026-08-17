import { describe, expect, it } from 'vitest';
import {
    compilePluginJsonSchema,
    isValidPluginJsonSchemaValue,
} from '@happier-dev/plugin-sdk/manifest';

import {
    ConversationApplicationAdmissionLostV1ProtocolSchema,
    ConversationConnectionHistoryGapFactV1Schema,
    ConversationProviderDiagnosticV1Schema,
    ConversationProviderFailureV1Schema,
    ConversationProviderHistoryUnavailableV1ProtocolSchema,
} from './diagnostics.js';

describe('Channels V1 diagnostics', () => {
    it('owns the bounded provider failure diagnostic as a closed public protocol value', () => {
        const failure = {
            kind: 'notReady',
            reason: 'rateLimited',
            retryAfterMs: 12_000,
            diagnostic: 'Try again after the provider rate limit resets.',
        } as const;

        expect(ConversationProviderFailureV1Schema.parse(failure)).toEqual(failure);
        expect(ConversationProviderFailureV1Schema.safeParse({
            ...failure,
            providerError: 'not public',
        }).success).toBe(false);
        expect(ConversationProviderFailureV1Schema.safeParse({
            ...failure,
            retryAfterMs: -1,
        }).success).toBe(false);
        expect(ConversationProviderFailureV1Schema.jsonSchema).toMatchObject({
            type: 'object',
            additionalProperties: false,
            required: ['kind', 'reason'],
            properties: {
                kind: { const: 'notReady' },
                retryAfterMs: { minimum: 0, maximum: 86_400_000 },
            },
        });
    });

    it('enforces the UTF-8 diagnostic ceiling through both executable and JSON-schema validation', () => {
        const validates = compilePluginJsonSchema(ConversationProviderDiagnosticV1Schema.jsonSchema);
        const atLimit = 'é'.repeat(512);
        const multibyteOverByteLimit = `${atLimit}é`;
        const asciiOverStructuralLimit = 'a'.repeat(1025);

        expect(ConversationProviderDiagnosticV1Schema.parse(atLimit)).toHaveLength(512);
        expect(isValidPluginJsonSchemaValue(validates, atLimit)).toBe(true);
        expect(ConversationProviderDiagnosticV1Schema.safeParse(multibyteOverByteLimit).success).toBe(false);
        expect(isValidPluginJsonSchemaValue(validates, multibyteOverByteLimit)).toBe(false);
        expect(ConversationProviderDiagnosticV1Schema.safeParse(asciiOverStructuralLimit).success).toBe(false);
        expect(isValidPluginJsonSchemaValue(validates, asciiOverStructuralLimit)).toBe(false);
        expect(ConversationProviderDiagnosticV1Schema.jsonSchema).toMatchObject({
            type: 'string',
            minLength: 1,
            'x-happier-max-utf8-bytes': 1024,
        });
    });

    it('keeps history-gap evidence closed and permits diagnostic disclosure only for provider history loss', () => {
        const providerHistoryGap = {
            reason: 'providerHistoryUnavailable',
            diagnostic: 'The retained provider window no longer includes the checkpoint.',
        } as const;

        expect(ConversationConnectionHistoryGapFactV1Schema.parse(providerHistoryGap)).toEqual(providerHistoryGap);
        expect(ConversationConnectionHistoryGapFactV1Schema.parse({
            reason: 'applicationAdmissionLost',
        })).toEqual({ reason: 'applicationAdmissionLost' });
        expect(ConversationConnectionHistoryGapFactV1Schema.safeParse({
            reason: 'applicationAdmissionLost',
            diagnostic: 'must stay undisclosed',
        }).success).toBe(false);
        expect(ConversationConnectionHistoryGapFactV1Schema.safeParse({
            reason: 'providerHistoryUnavailable',
            diagnostic: 'safe',
            unexpected: true,
        }).success).toBe(false);
        expect(ConversationConnectionHistoryGapFactV1Schema.jsonSchema).toMatchObject({
            anyOf: expect.any(Array),
        });
        expect(ConversationProviderHistoryUnavailableV1ProtocolSchema.safeParse(providerHistoryGap).success).toBe(true);
        expect(ConversationApplicationAdmissionLostV1ProtocolSchema.safeParse({
            reason: 'applicationAdmissionLost',
        }).success).toBe(true);
    });
});
