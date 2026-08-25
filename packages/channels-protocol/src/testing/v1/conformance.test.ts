import { definePlugin } from '@happier-dev/plugin-sdk';
import type { PluginJsonSchema } from '@happier-dev/plugin-sdk/protocol';
import { describe, expect, it } from 'vitest';

import { ConversationProvidersContributionProtocolV1 } from '../../v1/provider/contribution.js';
import {
    assertConversationProviderContributionV1,
    createConversationProviderSetupResultV1Fixture,
} from './index.js';

const providerOperations = ConversationProvidersContributionProtocolV1.operations;

const EXTERNAL_ACTION_IDS = {
    setup: 'author/setup-session',
    setupRemediation: 'author/resolve-setup',
    connectionTest: 'author/probe-link',
    messageDeliver: 'author/publish-text',
    connectionStop: 'author/close-socket',
} as const;

const contributorDefinedSetupInputSchema: PluginJsonSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
        installationToken: { type: 'string', minLength: 1 },
    },
    required: ['installationToken'],
};

type MutableProviderManifest = {
    contributes: {
        actions: Array<{
            id: string;
            execution: { target: 'daemon' };
            dangerLevel: string;
            surfaces: string[];
            placementBindings?: string[];
            inputSchema?: unknown;
            resultSchema?: unknown;
        }>;
        targetedPluginContributions: Array<{
            operations: Record<string, string>;
            protocol: {
                id: string;
                version: number;
            };
        }>;
    };
};

function createExternalProviderManifest() {
    return definePlugin({
        id: 'example.comet-chat',
        version: '1.0.0',
        actions: {
            [EXTERNAL_ACTION_IDS.setup]: {
                title: 'Connect Comet Chat',
                execution: { target: 'daemon' },
                scopes: ['global'],
                inputSchema: contributorDefinedSetupInputSchema,
                resultSchema: providerOperations.setup.declaration.resultSchema.jsonSchema,
                surfaces: providerOperations.setup.declaration.surfaces,
                dangerLevel: providerOperations.setup.declaration.dangerLevel,
                run: async () => createConversationProviderSetupResultV1Fixture({
                    providerConnectionKey: 'comet:fixture',
                }),
            },
            [EXTERNAL_ACTION_IDS.setupRemediation]: {
                title: 'Resolve Comet Chat setup',
                execution: { target: 'daemon' },
                description: 'Remove the selected Comet Chat setup conflict.',
                scopes: ['global'],
                inputSchema: contributorDefinedSetupInputSchema,
                resultSchema: providerOperations.setupRemediation.declaration.resultSchema.jsonSchema,
                surfaces: providerOperations.setupRemediation.declaration.surfaces,
                dangerLevel: providerOperations.setupRemediation.declaration.dangerLevel,
                confirmation: {
                    title: 'Resolve Comet Chat setup?',
                    body: 'This changes the selected Comet Chat configuration.',
                    confirmLabel: 'Resolve setup',
                },
                run: async () => ({ kind: 'remediated' }),
            },
            [EXTERNAL_ACTION_IDS.connectionTest]: {
                title: 'Probe Comet Chat',
                execution: { target: 'daemon' },
                scopes: ['global'],
                inputSchema: providerOperations.connectionTest.declaration.input.schema.jsonSchema,
                resultSchema: providerOperations.connectionTest.declaration.resultSchema.jsonSchema,
                surfaces: providerOperations.connectionTest.declaration.surfaces,
                dangerLevel: providerOperations.connectionTest.declaration.dangerLevel,
                run: async () => ({ kind: 'ready' }),
            },
            [EXTERNAL_ACTION_IDS.messageDeliver]: {
                title: 'Publish Comet Chat message',
                execution: { target: 'daemon' },
                scopes: ['global'],
                inputSchema: providerOperations.messageDeliver.declaration.input.schema.jsonSchema,
                resultSchema: providerOperations.messageDeliver.declaration.resultSchema.jsonSchema,
                surfaces: providerOperations.messageDeliver.declaration.surfaces,
                dangerLevel: providerOperations.messageDeliver.declaration.dangerLevel,
                run: async () => ({ kind: 'delivered' }),
            },
            [EXTERNAL_ACTION_IDS.connectionStop]: {
                title: 'Close Comet Chat socket',
                execution: { target: 'daemon' },
                scopes: ['global'],
                inputSchema: providerOperations.connectionStop.declaration.input.schema.jsonSchema,
                resultSchema: providerOperations.connectionStop.declaration.resultSchema.jsonSchema,
                surfaces: providerOperations.connectionStop.declaration.surfaces,
                dangerLevel: providerOperations.connectionStop.declaration.dangerLevel,
                run: async () => ({ kind: 'stopped' }),
            },
        },
        contributesTo: {
            'happier.channels': {
                providers: {
                    'comet-chat': ConversationProvidersContributionProtocolV1.contribute({
                        operations: {
                            setup: providerOperations.setup.bind(EXTERNAL_ACTION_IDS.setup),
                            setupRemediation: providerOperations.setupRemediation.bind(
                                EXTERNAL_ACTION_IDS.setupRemediation,
                            ),
                            connectionTest: providerOperations.connectionTest.bind(EXTERNAL_ACTION_IDS.connectionTest),
                            messageDeliver: providerOperations.messageDeliver.bind(EXTERNAL_ACTION_IDS.messageDeliver),
                            connectionStop: providerOperations.connectionStop.bind(EXTERNAL_ACTION_IDS.connectionStop),
                        },
                    }),
                },
            },
        },
    }).manifest;
}

function mutableManifest(): MutableProviderManifest {
    return JSON.parse(JSON.stringify(createExternalProviderManifest())) as MutableProviderManifest;
}

describe('Channels V1 provider-contribution conformance', () => {
    it('accepts a public, external-style provider with arbitrary local Action ids', () => {
        const manifest = createExternalProviderManifest();

        expect(() => assertConversationProviderContributionV1(manifest)).not.toThrow();
    });

    it('accepts a provider Action that also serves another declared surface', () => {
        const manifest = mutableManifest();
        const action = manifest.contributes.actions.find((candidate) => (
            candidate.id === EXTERNAL_ACTION_IDS.setup
        ));
        if (!action) throw new Error('Expected external setup Action fixture');
        action.surfaces = ['plugin', 'ui'];
        action.placementBindings = ['commandPalette'];

        expect(() => assertConversationProviderContributionV1(manifest)).not.toThrow();
    });

    it('rejects a missing required role binding', () => {
        const manifest = mutableManifest();
        delete manifest.contributes.targetedPluginContributions[0]!.operations.messageDeliver;

        expect(() => assertConversationProviderContributionV1(manifest)).toThrow(/messageDeliver/u);
    });

    it('accepts an absent optional role binding', () => {
        const manifest = mutableManifest();
        delete manifest.contributes.targetedPluginContributions[0]!.operations.connectionStop;

        expect(() => assertConversationProviderContributionV1(manifest)).not.toThrow();
    });

    it('accepts an arbitrary external remediation Action with host confirmation metadata', () => {
        const manifest = createExternalProviderManifest();
        const remediation = manifest.contributes.actions?.find((action) => (
            action.id === EXTERNAL_ACTION_IDS.setupRemediation
        ));

        expect(remediation).toMatchObject({
            dangerLevel: 'writesRemote',
            confirmation: {
                title: 'Resolve Comet Chat setup?',
                confirmLabel: 'Resolve setup',
            },
        });
        expect(() => assertConversationProviderContributionV1(manifest)).not.toThrow();
    });

    it('rejects a contribution that declares a different protocol epoch', () => {
        const manifest = mutableManifest();
        manifest.contributes.targetedPluginContributions[0]!.protocol.version = 2;

        expect(() => assertConversationProviderContributionV1(manifest)).toThrow(/protocol/u);
    });

    it('rejects a role outside the Channels V1 provider contract', () => {
        const manifest = mutableManifest();
        manifest.contributes.targetedPluginContributions[0]!.operations.webhookReceive = EXTERNAL_ACTION_IDS.setup;

        expect(() => assertConversationProviderContributionV1(manifest)).toThrow(/webhookReceive/u);
    });

    it('rejects a bound Action with the wrong danger level', () => {
        const manifest = mutableManifest();
        const action = manifest.contributes.actions.find((candidate) => (
            candidate.id === EXTERNAL_ACTION_IDS.messageDeliver
        ));
        if (!action) throw new Error('Expected external delivery Action fixture');
        action.dangerLevel = 'safe';

        expect(() => assertConversationProviderContributionV1(manifest)).toThrow(/danger level/u);
    });

    it('rejects a bound Action with an incompatible Channels result schema', () => {
        const manifest = mutableManifest();
        const action = manifest.contributes.actions.find((candidate) => (
            candidate.id === EXTERNAL_ACTION_IDS.connectionTest
        ));
        if (!action) throw new Error('Expected external test Action fixture');
        action.resultSchema = { type: 'string' };

        expect(() => assertConversationProviderContributionV1(manifest)).toThrow(/result schema/u);
    });

    it('rejects a setup Action without its contributor-defined input schema', () => {
        const manifest = mutableManifest();
        const action = manifest.contributes.actions.find((candidate) => (
            candidate.id === EXTERNAL_ACTION_IDS.setup
        ));
        if (!action) throw new Error('Expected external setup Action fixture');
        delete action.inputSchema;

        expect(() => assertConversationProviderContributionV1(manifest)).toThrow(/contributor-defined input schema/u);
    });

    it('rejects a protocol-defined role with an incompatible input schema', () => {
        const manifest = mutableManifest();
        const action = manifest.contributes.actions.find((candidate) => (
            candidate.id === EXTERNAL_ACTION_IDS.connectionTest
        ));
        if (!action) throw new Error('Expected external test Action fixture');
        action.inputSchema = { type: 'string' };

        expect(() => assertConversationProviderContributionV1(manifest)).toThrow(/input schema/u);
    });

    it('rejects a bound Action with the wrong surface', () => {
        const manifest = mutableManifest();
        const action = manifest.contributes.actions.find((candidate) => (
            candidate.id === EXTERNAL_ACTION_IDS.connectionTest
        ));
        if (!action) throw new Error('Expected external test Action fixture');
        action.surfaces = ['cli'];

        expect(() => assertConversationProviderContributionV1(manifest)).toThrow(/surface/u);
    });
});
