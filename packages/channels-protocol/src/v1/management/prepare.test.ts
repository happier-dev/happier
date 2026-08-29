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
            setupGuidance: {
                externalUrl: 'https://provider.example.test/install',
                requiredPermissionsLabel: 'Read messages, Send messages',
            },
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
        // Durable push is now a creatable transport, so preparation projects
        // it exactly when the provider declares it; the continuation journey
        // is the create contract's business rule, not a preparation limit.
        expect(ConversationConnectionPrepareResultV1Schema.parse({
            ...ready,
            supportedTransports: ['checkpointedPull', 'durablePush'],
        })).toEqual({
            ...ready,
            supportedTransports: ['checkpointedPull', 'durablePush'],
        });
        expect(ConversationConnectionPrepareResultV1Schema.parse({
            ...ready,
            recommendedTransport: 'durablePush',
        })).toEqual({
            ...ready,
            recommendedTransport: 'durablePush',
        });
        expect(ConversationConnectionPrepareResultV1Schema.safeParse({
            ...ready,
            recommendedTransport: 'socket',
        }).success).toBe(true);
        expect(ConversationConnectionPrepareResultV1Schema.safeParse({
            ...ready,
            supportedTransports: ['checkpointedPull', 'durablePush', 'socket', 'checkpointedPull'],
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
