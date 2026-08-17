import { defineProtocolObject } from '@happier-dev/plugin-sdk/protocol';
import { describe, expect, it } from 'vitest';

import {
    ConversationCheckpointV1ProtocolSchema,
    ConversationJsonObjectV1ProtocolSchema,
    ConversationProviderConfigV1ProtocolSchema,
} from './json.js';

describe('Channels V1 JSON-object leaf', () => {
    it('projects arbitrary bounded JSON members through structural additionalProperties', () => {
        const schema = defineProtocolObject({
            recipe: ConversationJsonObjectV1ProtocolSchema,
        }, { policy: 'closed' });
        const input = {
            recipe: {
                label: 'sync replies',
                options: { retainHistory: true },
            },
        } as const;

        expect(schema.parse(input)).toEqual(input);
        expect(schema.jsonSchema).toMatchObject({
            type: 'object',
            properties: {
                recipe: {
                    type: 'object',
                    properties: {},
                    additionalProperties: expect.any(Object),
                },
            },
        });
        expect(schema.jsonSchema.properties?.recipe).not.toHaveProperty('propertyNames');
    });

    it('uses the feature-owned serialized UTF-8 ceiling for provider configuration and checkpoints', () => {
        const schema = defineProtocolObject({
            providerConfig: ConversationProviderConfigV1ProtocolSchema,
            checkpoint: ConversationCheckpointV1ProtocolSchema,
        }, { policy: 'closed' });
        const asciiAtLimit = 'x'.repeat((48 * 1024) - 2);
        const asciiOverLimit = 'x'.repeat((48 * 1024) - 1);
        const multibyteAtLimit = `😀${'x'.repeat((48 * 1024) - 6)}`;
        const multibyteOverLimit = `😀${'x'.repeat((48 * 1024) - 5)}`;
        const nestedAsciiAtLimit = { payload: 'x'.repeat((48 * 1024) - 14) };
        const nestedAsciiOverLimit = { payload: 'x'.repeat((48 * 1024) - 13) };
        const nestedMultibyteAtLimit = { payload: `😀${'x'.repeat((48 * 1024) - 18)}` };
        const nestedMultibyteOverLimit = { payload: `😀${'x'.repeat((48 * 1024) - 17)}` };

        for (const value of [
            asciiAtLimit,
            multibyteAtLimit,
            nestedAsciiAtLimit,
            nestedMultibyteAtLimit,
        ]) {
            expect(schema.safeParse({ providerConfig: value, checkpoint: value }).success).toBe(true);
        }
        for (const value of [
            asciiOverLimit,
            multibyteOverLimit,
            nestedAsciiOverLimit,
            nestedMultibyteOverLimit,
        ]) {
            expect(schema.safeParse({ providerConfig: value, checkpoint: value }).success).toBe(false);
        }
        for (const value of [undefined, Number.NaN, Number.POSITIVE_INFINITY, 1n, new Date(0)]) {
            expect(schema.safeParse({ providerConfig: value, checkpoint: null }).success).toBe(false);
            expect(schema.safeParse({ providerConfig: null, checkpoint: value }).success).toBe(false);
        }
        expect(schema.jsonSchema).toMatchObject({
            properties: {
                providerConfig: {},
                checkpoint: {},
            },
        });
    });
});
