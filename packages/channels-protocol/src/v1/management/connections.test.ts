import { describe, expect, it } from 'vitest';

import {
    CONVERSATION_CONNECTION_WEBHOOK_SOURCE_INSTANCE_ID_PREFIX_V1,
    ConversationConnectionCreateInputV1Schema,
    ConversationConnectionCreateResultV1Schema,
    ConversationConnectionDeleteInputV1Schema,
    ConversationConnectionDeleteResultV1Schema,
    ConversationConnectionTransferInputV1Schema,
    ConversationConnectionTransferResultV1Schema,
    ConversationConnectionUpdateInputV1Schema,
    ConversationConnectionUpdateResultV1Schema,
    conversationConnectionWebhookSourceInstanceIdV1,
} from './connections.js';

describe('Channels V1 connection management contracts', () => {
    it('derives a bounded deterministic webhook source identity from the canonical connection id', () => {
        expect(CONVERSATION_CONNECTION_WEBHOOK_SOURCE_INSTANCE_ID_PREFIX_V1)
            .toBe('channels.connection.');
        expect(conversationConnectionWebhookSourceInstanceIdV1('connection-1'))
            .toBe('channels.connection.connection-1');
        expect(conversationConnectionWebhookSourceInstanceIdV1('x'.repeat(96)))
            .toBe('channels.connection.' + 'x'.repeat(96));

        for (const invalid of ['', 'x'.repeat(97), 'connection!1']) {
            expect(() => conversationConnectionWebhookSourceInstanceIdV1(invalid)).toThrow();
        }
    });

    it('admits the complete create contract through the host-admitted provider selection and the strict endpoint relay', () => {
        const providerSelection = {
            target: {
                pluginId: 'happier.channels',
                immutableGenerationId: 'generation-channels-1',
            },
            point: {
                pointId: 'providers',
                protocol: { id: 'happier.channels/providers', version: 1 },
            },
            contributor: {
                pluginId: 'happier.channel.telegram',
                contributionId: 'provider',
                immutableGenerationId: 'generation-telegram-1',
            },
        } as const;
        const checkpointedPull = {
            providerSelection,
            providerSetupInput: { botToken: 'opaque' },
            credentialRef: null,
            selectedTransport: 'checkpointedPull',
            maximumObservationAgeMs: 60_000,
        } as const;

        expect(ConversationConnectionCreateInputV1Schema.parse(checkpointedPull)).toEqual(checkpointedPull);
        expect(ConversationConnectionCreateInputV1Schema.parse({
            ...checkpointedPull,
            selectedTransport: 'socket',
        })).toEqual({
            ...checkpointedPull,
            selectedTransport: 'socket',
        });

        // Durable push joins the create contract as the strict two-call
        // journey: the same closed input admits the first call and the
        // endpoint-ensure continuation, while every caller-owned endpoint
        // authority outside that relay stays rejected.
        const durablePush = {
            ...checkpointedPull,
            selectedTransport: 'durablePush',
        } as const;
        expect(ConversationConnectionCreateInputV1Schema.parse(durablePush)).toEqual(durablePush);
        const durablePushContinuation = {
            ...durablePush,
            endpointContinuation: {
                connectionId: 'connection-1',
                webhookEndpointId: 'wh_ep_AAECAwQFBgcICQoLDA0ODw',
            },
        } as const;
        expect(ConversationConnectionCreateInputV1Schema.parse(durablePushContinuation))
            .toEqual(durablePushContinuation);
        expect(ConversationConnectionCreateInputV1Schema.safeParse({
            ...durablePush,
            endpointContinuation: {
                ...durablePushContinuation.endpointContinuation,
                setupAttemptId: 'caller-second-attempt-authority',
            },
        }).success).toBe(false);
        expect(ConversationConnectionCreateInputV1Schema.safeParse({
            ...durablePush,
            endpointContinuation: {
                ...durablePushContinuation.endpointContinuation,
                webhookEndpointId: 'caller-owned-url.example/webhook',
            },
        }).success).toBe(false);
        expect(ConversationConnectionCreateInputV1Schema.safeParse({
            ...checkpointedPull,
            preallocatedConnectionId: 'connection-1',
        }).success).toBe(false);
        expect(ConversationConnectionCreateInputV1Schema.safeParse({
            ...checkpointedPull,
            webhookEndpointId: 'wh_ep_AAECAwQFBgcICQoLDA0ODw',
        }).success).toBe(false);
        expect(ConversationConnectionCreateInputV1Schema.safeParse({
            ...checkpointedPull,
            providerSetupAction: { pluginId: 'happier.channel.telegram', localId: 'setup' },
        }).success).toBe(false);
    });

    it('keeps connection transfer caller-owned, revision-guarded, and limited to the executable non-durable transports', () => {
        const providerSelection = {
            target: {
                pluginId: 'happier.channels',
                immutableGenerationId: 'generation-channels-1',
            },
            point: {
                pointId: 'providers',
                protocol: { id: 'happier.channels/providers', version: 1 },
            },
            contributor: {
                pluginId: 'happier.channel.telegram',
                contributionId: 'provider',
                immutableGenerationId: 'generation-telegram-1',
            },
        } as const;
        const transfer = {
            connectionId: 'connection-1',
            expectedRevision: 7,
            providerSelection,
            providerSetupInput: { botToken: 'opaque' },
            credentialRef: null,
            selectedTransport: 'checkpointedPull',
        } as const;

        expect(ConversationConnectionTransferInputV1Schema.parse(transfer)).toEqual(transfer);
        expect(ConversationConnectionTransferInputV1Schema.parse({
            ...transfer,
            selectedTransport: 'socket',
        })).toEqual({ ...transfer, selectedTransport: 'socket' });
        expect(ConversationConnectionTransferInputV1Schema.safeParse({
            ...transfer,
            selectedTransport: 'durablePush',
        }).success).toBe(false);
        expect(ConversationConnectionTransferInputV1Schema.safeParse({
            ...transfer,
            maximumObservationAgeMs: 60_000,
        }).success).toBe(false);
        expect(ConversationConnectionTransferInputV1Schema.safeParse({
            ...transfer,
            transportOrigin: {
                serverIdentityId: 'caller-owned',
            },
        }).success).toBe(false);
        expect(ConversationConnectionTransferInputV1Schema.safeParse({
            ...transfer,
            preallocatedConnectionId: 'connection-2',
        }).success).toBe(false);

        const pending = {
            kind: 'transferPendingOldStop',
            connectionId: transfer.connectionId,
            revision: 8,
            authorityEpoch: 4,
        } as const;
        expect(ConversationConnectionTransferResultV1Schema.parse(pending)).toEqual(pending);
        expect(ConversationConnectionTransferResultV1Schema.parse({
            ...pending,
            kind: 'rejoined',
        })).toEqual({ ...pending, kind: 'rejoined' });
        expect(ConversationConnectionTransferResultV1Schema.parse({
            ...pending,
            kind: 'transferred',
        })).toEqual({ ...pending, kind: 'transferred' });
        expect(ConversationConnectionTransferResultV1Schema.safeParse({
            ...pending,
            kind: 'transferPendingOldStop',
            acceptedPossibleLoss: true,
        }).success).toBe(false);
    });

    it('keeps connection mutations guarded, bounded, and free of provider invocation authority', () => {
        const connectionId = 'connection-1';
        const updateInput = {
            connectionId,
            expectedRevision: 7,
            enabled: true,
            maximumObservationAgeMs: 60_000,
        } as const;
        const updateResult = {
            kind: 'updated',
            connectionId,
            revision: 8,
            authorityEpoch: 3,
        } as const;

        expect(ConversationConnectionUpdateInputV1Schema.parse(updateInput)).toEqual(updateInput);
        expect(ConversationConnectionUpdateResultV1Schema.parse(updateResult)).toEqual(updateResult);
        expect(ConversationConnectionDeleteInputV1Schema.parse({
            connectionId,
            expectedRevision: 7,
        })).toEqual({ connectionId, expectedRevision: 7 });
        expect(ConversationConnectionDeleteResultV1Schema.parse({
            kind: 'deletePending',
            connectionId,
            revision: 8,
            authorityEpoch: 3,
            acceptedPossibleLoss: false,
        })).toEqual({
            kind: 'deletePending',
            connectionId,
            revision: 8,
            authorityEpoch: 3,
            acceptedPossibleLoss: false,
        });
        const acceptedTransferRejoin = {
            kind: 'rejoined',
            connectionId,
            revision: 8,
            authorityEpoch: 3,
            acceptedPossibleLoss: true,
        } as const;
        expect(ConversationConnectionDeleteResultV1Schema.parse(
            JSON.parse(JSON.stringify(acceptedTransferRejoin)),
        )).toEqual(acceptedTransferRejoin);
        expect(ConversationConnectionCreateResultV1Schema.parse({
            kind: 'created',
            connectionId,
        })).toEqual({ kind: 'created', connectionId });

        expect(ConversationConnectionUpdateInputV1Schema.safeParse({
            ...updateInput,
            connectionId: 'connection id',
        }).success).toBe(false);
        expect(ConversationConnectionUpdateInputV1Schema.safeParse({
            ...updateInput,
            maximumObservationAgeMs: 59_999,
        }).success).toBe(false);
        expect(ConversationConnectionUpdateInputV1Schema.safeParse({
            ...updateInput,
            providerSetupAction: { localId: 'bypass' },
        }).success).toBe(false);
        expect(ConversationConnectionDeleteResultV1Schema.safeParse({
            kind: 'deleteFinalizing',
            connectionId,
            revision: 8,
            authorityEpoch: 3,
        }).success).toBe(false);
        expect(ConversationConnectionUpdateInputV1Schema.jsonSchema).toMatchObject({
            type: 'object',
            additionalProperties: false,
            required: ['connectionId', 'expectedRevision', 'enabled', 'maximumObservationAgeMs'],
        });
        expect(ConversationConnectionCreateResultV1Schema.jsonSchema).toMatchObject({
            anyOf: expect.arrayContaining([
                expect.objectContaining({
                    type: 'object',
                    additionalProperties: false,
                    required: ['kind', 'connectionId'],
                }),
            ]),
        });
    });

    it('admits the strict durable-push endpointRequired arm with core-minted facts only', () => {
        const endpointRequired = {
            kind: 'endpointRequired',
            connectionId: 'connection-1',
            webhookContribution: {
                pluginId: 'happier.channel.github',
                localId: 'issues-webhook',
            },
            targetMaterialization: {
                pluginId: 'happier.channel.github',
                machineId: 'machine-1',
                materializationId: 'materialization-1',
            },
            sourceInstanceId: 'channels.connection.connection-1',
            webhookEndpointSetup: {
                kind: 'accountEndpointV1',
                credential: 'serverGenerated',
            },
            webhookEndpointIdempotencyKey: 'endpoint-attempt-0123456789abcdef',
        } as const;

        expect(ConversationConnectionCreateResultV1Schema.parse(endpointRequired))
            .toEqual(endpointRequired);
        // The source instance must carry the Channels-owned derivation prefix
        // and the generic routing charset; a provider-shaped source is
        // rejected. Cross-field equality with the result's connectionId is
        // enforced by the core runtime owner that builds this result (its
        // discriminating mismatch test lives beside that owner).
        expect(ConversationConnectionCreateResultV1Schema.safeParse({
            ...endpointRequired,
            sourceInstanceId: 'github:repo:1',
        }).success).toBe(false);
        expect(ConversationConnectionCreateResultV1Schema.safeParse({
            ...endpointRequired,
            sourceInstanceId: 'channels.connection.' + 'x'.repeat(200),
        }).success).toBe(false);
        // The generic WH idempotency key is the sole setup-attempt identity;
        // Channels neither accepts nor publishes a second attempt token.
        expect(ConversationConnectionCreateResultV1Schema.safeParse({
            ...endpointRequired,
            setupAttemptId: 'endpoint-attempt-0123456789abcdef',
        }).success).toBe(false);
        expect(ConversationConnectionCreateResultV1Schema.safeParse({
            ...endpointRequired,
            webhookEndpointIdempotencyKey: 'caller key',
        }).success).toBe(false);
        // The pinned setup arm is the Account endpoint whose secret the server
        // mints; other setup arms stay with their own held producers.
        expect(ConversationConnectionCreateResultV1Schema.safeParse({
            ...endpointRequired,
            webhookEndpointSetup: {
                kind: 'githubSharedInstallationV1',
                installationId: '1',
                installationAuthorizationRef: 'ref',
            },
        }).success).toBe(false);
        // The result never carries an endpoint ID: the present-user ensure
        // result is its only producer, and only the continuation input relays
        // it back.
        expect(ConversationConnectionCreateResultV1Schema.safeParse({
            ...endpointRequired,
            webhookEndpointId: 'wh_ep_AAECAwQFBgcICQoLDA0ODw',
        }).success).toBe(false);
    });
});
