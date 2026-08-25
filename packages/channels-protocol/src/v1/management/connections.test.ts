import { describe, expect, it } from 'vitest';

import {
    ConversationConnectionCreateInputV1Schema,
    ConversationConnectionCreateResultV1Schema,
    ConversationConnectionDeleteInputV1Schema,
    ConversationConnectionDeleteResultV1Schema,
    ConversationConnectionTransferInputV1Schema,
    ConversationConnectionTransferResultV1Schema,
    ConversationConnectionUpdateInputV1Schema,
    ConversationConnectionUpdateResultV1Schema,
} from './connections.js';

describe('Channels V1 connection management contracts', () => {
    it('admits only the complete non-durable create contract through the host-admitted provider selection', () => {
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

        expect(ConversationConnectionCreateInputV1Schema.safeParse({
            ...checkpointedPull,
            selectedTransport: 'durablePush',
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
});
