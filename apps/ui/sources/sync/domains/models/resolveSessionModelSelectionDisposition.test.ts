import { describe, expect, it } from 'vitest';

import { MetadataSchema } from '@/sync/domains/state/storageTypes';

import { resolveSessionModelSelectionDisposition } from './resolveSessionModelSelectionDisposition';

describe('resolveSessionModelSelectionDisposition', () => {
    it('keeps an active proposal pending until exact runner authority proves it active', () => {
        const metadata = MetadataSchema.parse({
            path: '/tmp/project',
            host: 'localhost',
            modelSelectionIntentV1: {
                v: 1,
                updatedAt: 11,
                selection: {
                    agentTargetKey: 'backend:claude',
                    providerConnectionId: null,
                    modelId: 'proposed-model',
                },
            },
            sessionModelsV1: {
                v: 1,
                agentId: 'claude',
                updatedAt: 10,
                currentModelId: 'last-reported-model',
                availableModels: [],
            },
        });

        expect(resolveSessionModelSelectionDisposition({
            agentId: 'claude',
            agentTargetKey: 'backend:claude',
            metadata,
            sessionActive: true,
            currentRunnerProcessIdentity: null,
        })).toMatchObject({
            activeSelection: null,
            selectionTransitionPending: true,
            reportedSelection: {
                agentTargetKey: 'backend:claude',
                providerConnectionId: null,
                modelId: 'last-reported-model',
            },
            reportedSelectionStatus: 'last_reported',
            contextSelection: null,
        });
    });

    it('does not project an incoherent Provider binding as last-reported model truth', () => {
        const metadata = MetadataSchema.parse({
            path: '/tmp/project',
            host: 'localhost',
            providerBindingV1: {
                v: 1,
                connectionId: 'pc_provider',
                contributionKey: 'plugin.openrouter/openrouter',
                connectionRevision: 3,
                protocol: 'openai-responses',
                materialization: 'engineConfig',
                adapterBindingKey: 'openrouter',
                compatibilityFingerprint: 'compatibility-v1',
                bindingSecurityFingerprint: 'incoherent-fingerprint',
                displaySnapshot: {
                    providerName: 'OpenRouter',
                    connectionName: 'Work',
                    connectionRole: 'named',
                    connectionDisplayNameMode: 'custom',
                },
                model: {
                    id: 'provider-last-reported',
                    name: 'Provider last reported',
                    contextWindowTokens: 400_000,
                },
                runtimeBindingBasis: {
                    v: 1,
                    deployment: { kind: 'external' },
                    agentTargetKey: 'backend:claude',
                    connectionId: 'pc_provider',
                    contributionKey: 'plugin.openrouter/openrouter',
                    endpoint: {
                        endpointTemplateId: 'responses',
                        normalizedUrl: 'https://provider.example/v1',
                        protocol: 'openai-responses',
                        publicHeaders: { 'x-provider': 'openrouter' },
                    },
                    runtimeCredentialTransport: {
                        id: 'runtime-bearer',
                        protocols: ['openai-responses'],
                        uses: ['runtime'],
                        destination: {
                            kind: 'httpHeader',
                            name: 'authorization',
                            format: 'bearer',
                        },
                    },
                    prepared: {
                        v: 1,
                        materialization: 'engineConfig',
                        adapterBindingKey: 'openrouter',
                    },
                    adapterVersion: 1,
                    credentialAuthorization: {
                        connectionSecurityFingerprint: 'connection-security-v1',
                        grantFingerprint: 'grant-v1',
                        selectedSecretBindingId: 'binding-v1',
                        selectedSecretRecordFingerprint: 'record-v1',
                    },
                    agentSupport: {
                        acceptsProtocols: ['openai-responses'],
                        required: { streaming: true },
                        credentialSupport: {
                            supportsNoAuth: false,
                            apiKeyTransports: [{
                                protocol: 'openai-responses',
                                destination: {
                                    kind: 'httpHeader',
                                    names: ['authorization'],
                                    formats: ['bearer'],
                                },
                            }],
                        },
                        authIsolation: {
                            suppressConnectedServiceIds: [],
                            ownedEnvKeys: ['OPENAI_API_KEY'],
                        },
                        materialization: 'engineConfig',
                        applyPolicy: 'live',
                        supportsFreeformModelIds: true,
                    },
                },
            },
            sessionModelsV1: {
                v: 1,
                agentId: 'claude',
                updatedAt: 1,
                currentModelId: 'provider-last-reported',
                availableModels: [{
                    id: 'provider-last-reported',
                    name: 'Provider last reported',
                    contextWindowTokens: 400_000,
                }],
            },
        });

        expect(resolveSessionModelSelectionDisposition({
            agentId: 'claude',
            agentTargetKey: 'backend:claude',
            metadata,
            sessionActive: false,
            currentRunnerProcessIdentity: null,
        })).toMatchObject({
            reportedSelection: null,
            reportedSelectionStatus: null,
            contextSelection: null,
        });
    });
});
