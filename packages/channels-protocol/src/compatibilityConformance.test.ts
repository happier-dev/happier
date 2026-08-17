import {
    compilePluginJsonSchema,
    isValidPluginJsonSchemaValue,
} from '@happier-dev/plugin-sdk/manifest';
import { describe, expect, it } from 'vitest';

import * as root from './index.js';
import * as testingV1 from './testing/v1/index.js';
import * as v1 from './v1/index.js';
import {
    MAX_CONVERSATION_CHECKPOINT_UTF8_BYTES,
    MAX_CONVERSATION_CONNECTIONS_PER_ACCOUNT,
    MAX_CONVERSATION_DELIVERY_TEXT_UTF8_BYTES,
    MAX_CONVERSATION_ENDPOINT_DISPLAY_LABEL_CODE_POINTS,
    MAX_CONVERSATION_ENDPOINT_STABLE_ID_UTF8_BYTES,
    MAX_CONVERSATION_INGRESS_TEXT_UTF8_BYTES,
    MAX_CONVERSATION_PROVIDER_CONFIG_UTF8_BYTES,
    MAX_CONVERSATION_RESOLUTION_CANDIDATES,
} from './v1/bounds.js';
import {
    ConversationJsonObjectV1ProtocolSchema,
} from './v1/json.js';
import {
    ConversationProviderConnectionsSnapshotV1Schema,
    ConversationProviderConnectionInputV1Schema,
} from './v1/provider/connection.js';
import {
    ConversationDeliveryInputV1Schema,
} from './v1/provider/delivery.js';
import {
    ConversationPollInputV1Schema,
} from './v1/provider/observations.js';
import {
    ConversationBindingCreateInputV1Schema,
} from './v1/management/bindings.js';
import {
    ConversationConnectionCreateInputV1Schema,
} from './v1/management/connections.js';
import {
    ConversationEndpointIdentityV1Schema,
    ConversationResolvedEndpointV1Schema,
} from './v1/provider/resolution.js';
import { ConversationProviderSetupResultV1Schema } from './v1/provider/setup.js';
import { defineProtocolObject } from '@happier-dev/plugin-sdk/protocol';

type ProtocolSchema = {
    readonly jsonSchema: Record<string, unknown>;
    readonly parse: (value: unknown) => unknown;
    readonly safeParse: (value: unknown) => { success: boolean; data?: unknown };
};

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

const opaqueProviderConfig = {
    providerFuture: {
        nested: [true, { preserved: 'by-owner' }],
    },
} as const;

const connectionInput = {
    v: 1,
    connectionId: 'connection-1',
    providerConnectionKey: 'telegram:primary',
    providerConfigVersion: 1,
    providerConfig: opaqueProviderConfig,
    credentialRef: null,
} as const;

const endpoint = {
    kind: 'direct',
    audience: 'direct',
    id: 'endpoint-1',
} as const;

const bindingCreateInput = {
    connectionId: 'connection-1',
    expectedConnectionRevision: 7,
    endpointSelection: {
        query: 'endpoint-1',
        selected: endpoint,
    },
    principalSelection: {
        query: 'principal-1',
        selected: [{ id: 'principal-1', kind: 'human' }],
    },
    target: {
        kind: 'automation',
        automationId: 'automation-1',
        expectedTemplateVersion: 1,
        policy: { resultDelivery: 'finalResult' },
    },
} as const;

const deliveryInput = {
    ...connectionInput,
    endpoint,
    content: 'A bounded outbound message.',
    deliveryKey: 'delivery-key-1',
    mentionPolicy: 'suppress',
    linkPreviewPolicy: 'suppress',
} as const;

const pollInput = {
    ...connectionInput,
    checkpoint: { cursor: { providerOpaque: true } },
    limit: 1,
    waitMs: 0,
} as const;

const reconciliationSnapshot = {
    ...connectionInput,
    authorityEpoch: 1,
    enabled: true,
    deletionState: 'none',
    requiresFullSharedMessageContent: false,
} as const;

function assertExecutableJsonSchemaParity(
    schema: ProtocolSchema,
    valid: unknown,
    invalid: unknown,
): void {
    const validates = compilePluginJsonSchema(schema.jsonSchema);

    const parsed = schema.safeParse(valid);
    expect(parsed.success).toBe(true);
    expect(isValidPluginJsonSchemaValue(validates, valid)).toBe(true);

    expect(schema.safeParse(invalid).success).toBe(false);
    expect(isValidPluginJsonSchemaValue(validates, invalid)).toBe(false);
}

function schemaEntries(): Array<[string, ProtocolSchema]> {
    return Object.entries(v1)
        .filter(([name, value]) => (
            name.endsWith('Schema')
            && !name.endsWith('JsonSchema')
            && typeof value === 'object'
            && value !== null
            && 'safeParse' in value
            && 'jsonSchema' in value
        ))
        .map(([name, value]) => [name, value as ProtocolSchema]);
}

describe('Channels V1 compatibility policy and schema projections', () => {
    it('keeps structural cross-field alternatives identical at executable and JSON-schema boundaries', () => {
        const botSelection = {
            ...bindingCreateInput,
            principalSelection: {
                ...bindingCreateInput.principalSelection,
                selected: [{ id: 'bot-1', kind: 'bot' }],
            },
        } as const;
        assertExecutableJsonSchemaParity(
            ConversationBindingCreateInputV1Schema,
            { ...botSelection, allowBotSenders: true },
            botSelection,
        );

        assertExecutableJsonSchemaParity(
            ConversationProviderConnectionsSnapshotV1Schema,
            {
                'connection-1': {
                    ...reconciliationSnapshot,
                    enabled: false,
                    deletionState: 'finalizingDelete',
                },
            },
            {
                'connection-1': {
                    ...reconciliationSnapshot,
                    deletionState: 'finalizingDelete',
                },
            },
        );

        const setup = testingV1.createConversationProviderSetupResultV1Fixture({
            pairingDeepLinkTemplate: 'https://example.test/pair?token={{token}}',
        });
        const validatesSetup = compilePluginJsonSchema(ConversationProviderSetupResultV1Schema.jsonSchema);
        expect(ConversationProviderSetupResultV1Schema.safeParse(setup).success).toBe(true);
        expect(isValidPluginJsonSchemaValue(validatesSetup, setup)).toBe(true);
        for (const pairingDeepLinkTemplate of [
            'https://example.test/pair',
            'https://example.test/pair?token={{token}}&copy={{token}}',
        ]) {
            const invalidSetup = { ...setup, pairingDeepLinkTemplate };
            expect(ConversationProviderSetupResultV1Schema.safeParse(invalidSetup).success).toBe(false);
            expect(isValidPluginJsonSchemaValue(validatesSetup, invalidSetup)).toBe(false);
        }
    });

    it('keeps the display-label code-point limit identical at executable and JSON-schema boundaries', () => {
        const validates = compilePluginJsonSchema(ConversationResolvedEndpointV1Schema.jsonSchema);
        const atLimit = {
            kind: 'direct',
            audience: 'direct',
            id: 'endpoint-1',
            label: '\ud83d\ude00'.repeat(MAX_CONVERSATION_ENDPOINT_DISPLAY_LABEL_CODE_POINTS),
        } as const;
        const overLimit = {
            ...atLimit,
            label: `${atLimit.label}\ud83d\ude00`,
        } as const;

        expect(ConversationResolvedEndpointV1Schema.safeParse(atLimit).success).toBe(true);
        expect(isValidPluginJsonSchemaValue(validates, atLimit)).toBe(true);
        expect(ConversationResolvedEndpointV1Schema.safeParse(overLimit).success).toBe(false);
        expect(isValidPluginJsonSchemaValue(validates, overLimit)).toBe(false);
    });

    it('keeps the public root, V1, and testing/V1 entry points explicit and identity-safe', () => {
        expect(root.ConversationDeliveryInputV1Schema)
            .toBe(v1.ConversationDeliveryInputV1Schema);
        expect(root.ConversationProviderSetupOutcomeV1Schema)
            .toBe(v1.ConversationProviderSetupOutcomeV1Schema);
        expect(testingV1.assertConversationProviderContributionV1).toEqual(expect.any(Function));
        expect(testingV1.checkConversationProviderContributionV1).toEqual(expect.any(Function));
        expect(Object.keys(root).filter((name) => /(?:latest|current|default)/i.test(name))).toEqual([]);
    });

    it('projects every public executable schema through its paired JSON-schema export', () => {
        const entries = schemaEntries();
        expect(entries.length).toBeGreaterThan(20);

        for (const [name, schema] of entries) {
            const jsonSchemaName = `${name.slice(0, -'Schema'.length)}JsonSchema`;
            expect((v1 as Record<string, unknown>)[jsonSchemaName], jsonSchemaName)
                .toBe(schema.jsonSchema);
            expect(() => compilePluginJsonSchema(schema.jsonSchema), name).not.toThrow();
        }
    });

    it('keeps identity, routing, mutation, and lifecycle facts closed at every nested object boundary', () => {
        assertExecutableJsonSchemaParity(
            ConversationEndpointIdentityV1Schema,
            endpoint,
            { ...endpoint, providerAuthority: 'must-not-cross-the-seam' },
        );
        assertExecutableJsonSchemaParity(
            ConversationConnectionCreateInputV1Schema,
            {
                providerSelection,
                providerSetupInput: { setupFuture: { nested: true } },
                credentialRef: null,
                selectedTransport: 'checkpointedPull',
                maximumObservationAgeMs: 60_000,
            },
            {
                providerSelection: {
                    ...providerSelection,
                    contributor: {
                        ...providerSelection.contributor,
                        hostAuthority: true,
                    },
                },
                providerSetupInput: {},
                credentialRef: null,
                selectedTransport: 'checkpointedPull',
                maximumObservationAgeMs: 60_000,
            },
        );
        assertExecutableJsonSchemaParity(
            ConversationBindingCreateInputV1Schema,
            bindingCreateInput,
            {
                ...bindingCreateInput,
                endpointSelection: {
                    ...bindingCreateInput.endpointSelection,
                    selected: { ...endpoint, hostAuthority: true },
                },
            },
        );
        assertExecutableJsonSchemaParity(
            ConversationDeliveryInputV1Schema,
            deliveryInput,
            { ...deliveryInput, endpoint: { ...endpoint, hostAuthority: true } },
        );

        expect(ConversationEndpointIdentityV1Schema.jsonSchema).toMatchObject({
            anyOf: expect.arrayContaining([
                expect.objectContaining({ additionalProperties: false }),
            ]),
        });
        const bindingCreateJsonSchema = ConversationBindingCreateInputV1Schema.jsonSchema as Readonly<{
            anyOf?: readonly unknown[];
        }>;
        expect(bindingCreateJsonSchema.anyOf).toHaveLength(2);
        for (const branch of bindingCreateJsonSchema.anyOf ?? []) {
            expect(branch).toMatchObject({ type: 'object', additionalProperties: false });
            expect(branch).toHaveProperty('properties.endpointSelection.additionalProperties', false);
            expect(branch).toHaveProperty('properties.principalSelection.additionalProperties', false);
        }
    });

    it('preserves only opaque provider/config and checkpoint data, while keeping their containing contracts closed', () => {
        const parsedConnection = ConversationProviderConnectionInputV1Schema.parse(connectionInput);
        expect(parsedConnection).toEqual(connectionInput);
        expect(parsedConnection.providerConfig).toEqual(opaqueProviderConfig);
        expect(ConversationProviderConnectionInputV1Schema.safeParse({
            ...connectionInput,
            futureConnectionField: true,
        }).success).toBe(false);

        const parsedPoll = ConversationPollInputV1Schema.parse(pollInput);
        expect(parsedPoll.checkpoint).toEqual(pollInput.checkpoint);
        expect(ConversationPollInputV1Schema.safeParse({
            ...pollInput,
            futurePollField: true,
        }).success).toBe(false);
        expect(ConversationPollInputV1Schema.jsonSchema).toMatchObject({
            type: 'object',
            additionalProperties: false,
            properties: {
                providerConfig: {},
                checkpoint: {},
            },
        });

        const recipeSchema = defineProtocolObject({
            recipe: ConversationJsonObjectV1ProtocolSchema,
        }, { policy: 'closed' });
        const recipe = {
            recipe: {
                futureOuter: {
                    nested: { futureInner: true },
                },
            },
        } as const;
        expect(recipeSchema.parse(recipe)).toEqual(recipe);
        expect(recipeSchema.safeParse({ ...recipe, rootAuthority: true }).success).toBe(false);
        expect(recipeSchema.jsonSchema).toMatchObject({
            properties: {
                recipe: {
                    additionalProperties: expect.any(Object),
                },
            },
            additionalProperties: false,
        });
    });

    it('keeps the intentionally open connection map typed and bounded while reconciliation owns key/value coherence', () => {
        const futureConnection = {
            ...reconciliationSnapshot,
            connectionId: 'connection-future',
        } as const;
        const snapshot = {
            [reconciliationSnapshot.connectionId]: reconciliationSnapshot,
            [futureConnection.connectionId]: futureConnection,
        } as const;

        expect(ConversationProviderConnectionsSnapshotV1Schema.parse(snapshot)).toEqual(snapshot);
        expect(ConversationProviderConnectionsSnapshotV1Schema.safeParse({
            ...snapshot,
            'connection-future': {
                ...futureConnection,
                unknownSnapshotField: true,
            },
        }).success).toBe(false);
        expect(ConversationProviderConnectionsSnapshotV1Schema.safeParse({
            'connection-other': futureConnection,
        }).success).toBe(true);
        const connectionMapJsonSchema = ConversationProviderConnectionsSnapshotV1Schema.jsonSchema as Readonly<{
            additionalProperties?: Readonly<{ anyOf?: readonly unknown[] }>;
        }>;
        expect(connectionMapJsonSchema).toMatchObject({ type: 'object' });
        expect(connectionMapJsonSchema.additionalProperties?.anyOf).toHaveLength(2);
        for (const branch of connectionMapJsonSchema.additionalProperties?.anyOf ?? []) {
            expect(branch).toMatchObject({ type: 'object', additionalProperties: false });
        }
        expect(ConversationProviderConnectionsSnapshotV1Schema.jsonSchema)
            .not.toHaveProperty('propertyNames');

        const atLimit = Object.fromEntries(Array.from(
            { length: MAX_CONVERSATION_CONNECTIONS_PER_ACCOUNT },
            (_, index) => {
                const connectionId = `connection-${index + 1}`;
                return [connectionId, { ...reconciliationSnapshot, connectionId }];
            },
        ));
        expect(ConversationProviderConnectionsSnapshotV1Schema.safeParse(atLimit).success).toBe(true);
        const aboveLimit = {
            ...atLimit,
            'connection-over-limit': { ...reconciliationSnapshot, connectionId: 'connection-over-limit' },
        };
        expect(ConversationProviderConnectionsSnapshotV1Schema.safeParse(aboveLimit).success).toBe(true);
    });
});

describe('Channels V1 bounded contract edges', () => {
    it('enforces the byte/code-point limits at the executable boundary', () => {
        const endpointIdAtLimit = 'é'.repeat(MAX_CONVERSATION_ENDPOINT_STABLE_ID_UTF8_BYTES / 2);
        const endpointIdAboveLimit = `${endpointIdAtLimit}é`;
        expect(ConversationEndpointIdentityV1Schema.safeParse({
            ...endpoint,
            id: endpointIdAtLimit,
        }).success).toBe(true);
        expect(ConversationEndpointIdentityV1Schema.safeParse({
            ...endpoint,
            id: endpointIdAboveLimit,
        }).success).toBe(false);

        const labelAtLimit = '😀'.repeat(MAX_CONVERSATION_ENDPOINT_DISPLAY_LABEL_CODE_POINTS);
        const labelAboveLimit = `${labelAtLimit}😀`;
        expect(ConversationResolvedEndpointV1Schema.safeParse({
            ...endpoint,
            label: labelAtLimit,
        }).success).toBe(true);
        expect(ConversationResolvedEndpointV1Schema.safeParse({
            ...endpoint,
            label: labelAboveLimit,
        }).success).toBe(false);

        const providerConfigAtLimit = 'x'.repeat(MAX_CONVERSATION_PROVIDER_CONFIG_UTF8_BYTES - 2);
        const providerConfigAboveLimit = 'x'.repeat(MAX_CONVERSATION_PROVIDER_CONFIG_UTF8_BYTES - 1);
        expect(ConversationProviderConnectionInputV1Schema.safeParse({
            ...connectionInput,
            providerConfig: providerConfigAtLimit,
        }).success).toBe(true);
        expect(ConversationProviderConnectionInputV1Schema.safeParse({
            ...connectionInput,
            providerConfig: providerConfigAboveLimit,
        }).success).toBe(false);

        const checkpointAtLimit = 'x'.repeat(MAX_CONVERSATION_CHECKPOINT_UTF8_BYTES - 2);
        const checkpointAboveLimit = 'x'.repeat(MAX_CONVERSATION_CHECKPOINT_UTF8_BYTES - 1);
        expect(ConversationPollInputV1Schema.safeParse({
            ...pollInput,
            checkpoint: checkpointAtLimit,
        }).success).toBe(true);
        expect(ConversationPollInputV1Schema.safeParse({
            ...pollInput,
            checkpoint: checkpointAboveLimit,
        }).success).toBe(false);

        const deliveryAtLimit = 'x'.repeat(MAX_CONVERSATION_DELIVERY_TEXT_UTF8_BYTES);
        const deliveryAboveLimit = `${deliveryAtLimit}x`;
        expect(ConversationDeliveryInputV1Schema.safeParse({
            ...deliveryInput,
            content: deliveryAtLimit,
        }).success).toBe(true);
        expect(ConversationDeliveryInputV1Schema.safeParse({
            ...deliveryInput,
            content: deliveryAboveLimit,
        }).success).toBe(false);
    });

    it('keeps bounded candidate and ingress text paths closed to additive root fields', () => {
        const candidates = Array.from({ length: MAX_CONVERSATION_RESOLUTION_CANDIDATES }, (_, index) => ({
            kind: 'direct' as const,
            audience: 'direct' as const,
            id: `endpoint-${index.toString().padStart(3, '0')}`,
            label: `Endpoint ${index.toString().padStart(3, '0')}`,
        }));
        const resolutionResult = v1.ConversationEndpointResolveResultV1Schema.safeParse({
            kind: 'resolved',
            candidates,
        });
        expect(resolutionResult.success).toBe(true);
        expect(v1.ConversationEndpointResolveResultV1Schema.safeParse({
            kind: 'resolved',
            candidates: [...candidates, {
                kind: 'direct',
                audience: 'direct',
                id: 'endpoint-over-limit',
                label: 'Endpoint over limit',
            }],
        }).success).toBe(false);

        const ingress = {
            v: 1,
            occurrenceId: 'occurrence-1',
            occurredAt: 1_700_000_000_000,
            transport: { kind: 'poll', providerDeliveryId: 'delivery-1' },
            endpoint,
            actor: { principalId: 'principal-1', kind: 'human', isIntegrationSelf: false },
            message: {
                id: 'message-1',
                text: 'x'.repeat(MAX_CONVERSATION_INGRESS_TEXT_UTF8_BYTES),
                addressingEvidence: 'none',
                contentProvenance: 'original',
                providerTimestamp: 1_700_000_000_000,
            },
        } as const;
        expect(v1.ConversationObservationV1Schema.safeParse(ingress).success).toBe(true);
        expect(v1.ConversationObservationV1Schema.safeParse({
            ...ingress,
            message: {
                ...ingress.message,
                text: `${ingress.message.text}x`,
            },
        }).success).toBe(false);
        expect(v1.ConversationObservationV1Schema.safeParse({
            ...ingress,
            unexpected: true,
        }).success).toBe(false);
    });
});
