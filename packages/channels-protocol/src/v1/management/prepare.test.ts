import { describe, expect, it } from 'vitest';

import {
    ConversationConnectionPrepareResultV1Schema,
} from './prepare.js';

describe('Channels V1 connection preparation result', () => {
    it('projects structural transport facts while preparation admission enforces selected transport compatibility', () => {
        const ready = {
            kind: 'ready',
            supportedTransports: ['checkpointedPull', 'socket'],
            recommendedTransport: 'checkpointedPull',
            overlapSafety: 'safe',
            replayContinuity: 'none',
            outboundTextLimit: {
                maximum: 4_000,
                unit: 'unicodeCodePoints',
            },
            destinationLabel: 'Example destination',
        } as const;

        expect(ConversationConnectionPrepareResultV1Schema.parse(ready)).toEqual(ready);
        expect(ConversationConnectionPrepareResultV1Schema.parse({
            ...ready,
            destinationLabel: '\ud83d\ude00'.repeat(256),
        })).toEqual({
            ...ready,
            destinationLabel: '\ud83d\ude00'.repeat(256),
        });
        expect(ConversationConnectionPrepareResultV1Schema.parse({
            kind: 'requiresRemediation',
        })).toEqual({
            kind: 'requiresRemediation',
        });

        expect(ConversationConnectionPrepareResultV1Schema.safeParse({
            ...ready,
            supportedTransports: ['socket', 'socket'],
        }).success).toBe(false);
        expect(ConversationConnectionPrepareResultV1Schema.safeParse({
            ...ready,
            supportedTransports: ['checkpointedPull', 'durablePush'],
        }).success).toBe(false);
        expect(ConversationConnectionPrepareResultV1Schema.safeParse({
            ...ready,
            recommendedTransport: 'socket',
        }).success).toBe(true);
        expect(ConversationConnectionPrepareResultV1Schema.safeParse({
            ...ready,
            recommendedTransport: 'durablePush',
        }).success).toBe(false);
        expect(ConversationConnectionPrepareResultV1Schema.safeParse({
            ...ready,
            providerConnectionKey: 'private-provider-identity',
        }).success).toBe(false);
        expect(ConversationConnectionPrepareResultV1Schema.safeParse({
            ...ready,
            destinationLabel: '\ud83d\ude00'.repeat(257),
        }).success).toBe(false);

        expect(ConversationConnectionPrepareResultV1Schema.jsonSchema).toMatchObject({
            anyOf: expect.arrayContaining([
                expect.objectContaining({
                    properties: expect.objectContaining({
                        supportedTransports: expect.objectContaining({ uniqueItems: true }),
                    }),
                }),
            ]),
        });
    });
});
