import { readFileSync } from 'node:fs';

import { afterEach, describe, expect, it } from 'vitest';

import { MetadataSchema } from '@/sync/domains/state/storageTypes';
import { createProviderBindingSecurityFingerprintV1 } from '@happier-dev/protocol';

import { resolveContextWarningWindowTokens, resolveContextWindowTokens } from './resolveContextWarningWindowTokens';

describe('resolveContextWarningWindowTokens', () => {
    it('prefers the canonical snapshot window over legacy live telemetry', () => {
        expect(resolveContextWindowTokens({
            agentId: 'codex',
            metadata: null,
            usageData: {
                contextWindowTokens: 258_400,
                contextSnapshot: {
                    v: 1,
                    modelId: 'gpt-5.4',
                    usedTokens: 42_000,
                    windowTokens: 400_000,
                    totalProcessedTokens: 120_000,
                    baselineTokens: 12_000,
                    isAutoCompactEnabled: null,
                    categories: null,
                    observedAtMs: 1_000,
                    source: 'provider_turn',
                },
            },
        } as any)).toBe(400_000);
    });

    it('prefers live usage telemetry over metadata when resolving the warning window', () => {
        const metadata = MetadataSchema.parse({
            path: '/tmp/project',
            host: 'localhost',
            sessionModelsV1: {
                v: 1,
                agentId: 'codex',
                updatedAt: 1,
                currentModelId: 'gpt-5',
                availableModels: [
                    {
                        id: 'gpt-5',
                        name: 'GPT 5',
                        contextWindowTokens: 400000,
                    },
                ],
            },
        });

        expect(resolveContextWarningWindowTokens({
            agentId: 'codex',
            metadata,
            usageData: {
                contextWindowTokens: 258400,
            },
        } as any)).toBe(245480);
    });

    it('reads the current model context window from parsed session model metadata', () => {
        const metadata = MetadataSchema.parse({
            path: '/tmp/project',
            host: 'localhost',
            sessionModelsV1: {
                v: 1,
                agentId: 'codex',
                updatedAt: 1,
                currentModelId: 'gpt-5',
                availableModels: [
                    {
                        id: 'gpt-5',
                        name: 'GPT 5',
                        contextWindowTokens: 258000,
                    },
                ],
            },
        });

        expect(resolveContextWarningWindowTokens({
            agentId: 'codex',
            metadata,
            sessionActive: false,
        } as any)).toBe(245100);
    });

    it('falls back to Claude default warning windows when no live or metadata value exists', () => {
        expect(resolveContextWarningWindowTokens({
            agentId: 'claude',
            metadata: null,
            sessionActive: false,
        } as any)).toBe(190000);
    });

    it('uses the catalog context window for legacy Claude Opus 4.7 session metadata without context-window fields', () => {
        const metadata = MetadataSchema.parse({
            path: '/tmp/project',
            host: 'localhost',
            sessionModelsV1: {
                v: 1,
                agentId: 'claude',
                updatedAt: 1,
                currentModelId: 'claude-opus-4-7',
                availableModels: [
                    {
                        id: 'claude-opus-4-7',
                        name: 'Opus 4.7',
                        description: 'Newest highest-capability Claude model for the hardest coding and reasoning tasks.',
                    },
                ],
            },
        } as any);

        expect(resolveContextWarningWindowTokens({
            agentId: 'claude',
            metadata,
            sessionActive: false,
        } as any)).toBe(950000);
    });

    it.each(['claude-sonnet-5', 'claude-mythos-5'])(
        'uses the exact always-on 1M window for a proposed native %s session',
        (modelId) => {
            const metadata = MetadataSchema.parse({
                path: '/tmp/project',
                host: 'localhost',
                modelSelectionIntentV1: {
                    v: 1,
                    updatedAt: 2,
                    selection: {
                        agentTargetKey: 'backend:claude',
                        providerConnectionId: null,
                        modelId,
                    },
                },
            });

            expect(resolveContextWarningWindowTokens({
                agentId: 'claude',
                metadata,
                sessionActive: false,
            })).toBe(950_000);
        },
    );

    it('prefers reported Claude session model context window over the static Opus catalog fallback', () => {
        const metadata = MetadataSchema.parse({
            path: '/tmp/project',
            host: 'localhost',
            modelOverrideV1: {
                v: 1,
                updatedAt: 1,
                modelId: 'claude-opus-4-7',
            },
            sessionModelsV1: {
                v: 1,
                agentId: 'claude',
                updatedAt: 1,
                currentModelId: 'claude-opus-4-7',
                availableModels: [
                    {
                        id: 'claude-opus-4-7',
                        name: 'Opus 4.7',
                        contextWindowTokens: 200000,
                    },
                ],
            },
        } as any);

        expect(resolveContextWarningWindowTokens({
            agentId: 'claude',
            metadata,
            sessionActive: false,
        } as any)).toBe(190000);
    });

    it('uses the canonical provider-bound selection instead of a stale session current-model id', () => {
        const metadata = MetadataSchema.parse({
            path: '/tmp/project',
            host: 'localhost',
            modelSelectionIntentV1: {
                v: 1,
                updatedAt: 2,
                selection: {
                    agentTargetKey: 'backend:claude',
                    providerConnectionId: 'pc_01J00000000000000000000000',
                    modelId: 'claude-opus-4-7',
                },
            },
            sessionModelsV1: {
                v: 1,
                agentId: 'claude',
                updatedAt: 1,
                currentModelId: 'claude-sonnet-4-5',
                availableModels: [
                    {
                        id: 'claude-sonnet-4-5',
                        name: 'Sonnet',
                        contextWindowTokens: 200000,
                    },
                    {
                        id: 'claude-opus-4-7',
                        name: 'Opus 4.7',
                        contextWindowTokens: 1000000,
                    },
                ],
            },
        } as any);

        expect(resolveContextWarningWindowTokens({
            agentId: 'claude',
            metadata,
            sessionActive: false,
        } as any)).toBe(950000);
    });

    it('keeps the active runtime context window while a different native model awaits restart', () => {
        const currentRunnerProcessIdentity = {
            pid: 123,
            processStartTimeMs: 1_000,
        };
        const metadata = MetadataSchema.parse({
            path: '/tmp/project',
            host: 'localhost',
            modelSelectionIntentV1: {
                v: 1,
                updatedAt: 2,
                selection: {
                    agentTargetKey: 'backend:claude',
                    providerConnectionId: null,
                    modelId: 'claude-opus-4-7',
                },
            },
            sessionModelsV1: {
                v: 1,
                agentId: 'claude',
                updatedAt: 1,
                currentModelId: 'claude-sonnet-4-6',
                activeSelectionV1: {
                    v: 1,
                    selection: {
                        agentTargetKey: 'backend:claude',
                        providerConnectionId: null,
                        modelId: 'claude-sonnet-4-6',
                    },
                    source: 'runtime_readback',
                    runner: currentRunnerProcessIdentity,
                },
                availableModels: [
                    {
                        id: 'claude-sonnet-4-6',
                        name: 'Sonnet 4.6',
                        contextWindowTokens: 200_000,
                    },
                    {
                        id: 'claude-opus-4-7',
                        name: 'Opus 4.7',
                        contextWindowTokens: 1_000_000,
                    },
                ],
            },
        });

        expect(resolveContextWarningWindowTokens({
            agentId: 'claude',
            metadata,
            sessionActive: true,
            currentRunnerProcessIdentity,
        })).toBe(190_000);
    });

    it('uses exact active context truth for a configured backend target', () => {
        const agentTargetKey = 'backend:claude:configured:claude';
        const currentRunnerProcessIdentity = {
            pid: 123,
            processStartTimeMs: 1_000,
        };
        const metadata = MetadataSchema.parse({
            path: '/tmp/project',
            host: 'localhost',
            modelSelectionIntentV1: {
                v: 1,
                updatedAt: 2,
                selection: {
                    agentTargetKey,
                    providerConnectionId: null,
                    modelId: 'claude-opus-4-7',
                },
            },
            sessionModelsV1: {
                v: 1,
                agentId: 'claude',
                updatedAt: 1,
                currentModelId: 'claude-sonnet-4-6',
                activeSelectionV1: {
                    v: 1,
                    selection: {
                        agentTargetKey,
                        providerConnectionId: null,
                        modelId: 'claude-sonnet-4-6',
                    },
                    source: 'runtime_readback',
                    runner: currentRunnerProcessIdentity,
                },
                availableModels: [{
                    id: 'claude-sonnet-4-6',
                    name: 'Sonnet 4.6',
                    contextWindowTokens: 200_000,
                }],
            },
        });

        expect(resolveContextWarningWindowTokens({
            agentId: 'claude',
            agentTargetKey,
            metadata,
            sessionActive: true,
            currentRunnerProcessIdentity,
        })).toBe(190_000);
    });

    it('does not promote a fallback current-model catalog entry into active context truth', () => {
        const metadata = MetadataSchema.parse({
            path: '/tmp/project',
            host: 'localhost',
            modelSelectionIntentV1: {
                v: 1,
                updatedAt: 2,
                selection: {
                    agentTargetKey: 'backend:claude',
                    providerConnectionId: null,
                    modelId: 'proposed-custom-model',
                },
            },
            sessionModelsV1: {
                v: 1,
                agentId: 'claude',
                updatedAt: 1,
                currentModelId: 'claude-opus-4-7',
                availableModels: [
                    {
                        id: 'claude-opus-4-7',
                        name: 'Fallback Opus 4.7',
                        contextWindowTokens: 1_000_000,
                    },
                    {
                        id: 'proposed-custom-model',
                        name: 'Proposed custom model',
                        contextWindowTokens: 400_000,
                    },
                ],
            },
        });

        expect(resolveContextWarningWindowTokens({
            agentId: 'claude',
            metadata,
            sessionActive: true,
        })).toBeNull();
    });

    it('uses proposed intent for the explicit next-launch disposition', () => {
        const metadata = MetadataSchema.parse({
            path: '/tmp/project',
            host: 'localhost',
            modelSelectionIntentV1: {
                v: 1,
                updatedAt: 2,
                selection: {
                    agentTargetKey: 'backend:claude',
                    providerConnectionId: null,
                    modelId: 'claude-opus-4-7',
                },
            },
            sessionModelsV1: {
                v: 1,
                agentId: 'claude',
                updatedAt: 1,
                currentModelId: 'claude-sonnet-4-6',
                availableModels: [
                    {
                        id: 'claude-sonnet-4-6',
                        name: 'Sonnet 4.6',
                        contextWindowTokens: 200_000,
                    },
                    {
                        id: 'claude-opus-4-7',
                        name: 'Opus 4.7',
                        contextWindowTokens: 1_000_000,
                    },
                ],
            },
        });

        expect(resolveContextWarningWindowTokens({
            agentId: 'claude',
            metadata,
            sessionActive: false,
        })).toBe(950_000);
    });

    it('does not infer next-launch intent when the session disposition is unknown', () => {
        const metadata = MetadataSchema.parse({
            path: '/tmp/project',
            host: 'localhost',
            modelSelectionIntentV1: {
                v: 1,
                updatedAt: 2,
                selection: {
                    agentTargetKey: 'backend:claude',
                    providerConnectionId: null,
                    modelId: 'claude-opus-4-7',
                },
            },
            sessionModelsV1: {
                v: 1,
                agentId: 'claude',
                updatedAt: 1,
                currentModelId: 'claude-sonnet-4-6',
                availableModels: [{
                    id: 'claude-opus-4-7',
                    name: 'Proposed Opus 4.7',
                    contextWindowTokens: 1_000_000,
                }],
            },
        });

        expect(resolveContextWarningWindowTokens({
            agentId: 'claude',
            metadata,
        })).toBeNull();
    });

    it('returns null when the provider metadata does not expose a valid context window', () => {
        const metadata = MetadataSchema.parse({
            path: '/tmp/project',
            host: 'localhost',
            sessionModelsV1: {
                v: 1,
                agentId: 'claude',
                updatedAt: 1,
                currentModelId: 'sonnet',
                availableModels: [
                    {
                        id: 'sonnet',
                        name: 'Claude Sonnet',
                    },
                ],
            },
        } as any);

        expect(resolveContextWarningWindowTokens({
            agentId: 'opencode',
            metadata,
            sessionActive: false,
        } as any)).toBeNull();
    });

    it('uses exact Provider context facts without Claude id inference', () => {
        const metadata = MetadataSchema.parse({
            path: '/tmp/project',
            host: 'localhost',
            providerBindingV1: {
                v: 1,
                connectionId: 'pc_deepseek',
                contributionKey: 'happier.provider.deepseek/deepseek',
                connectionRevision: 1,
                protocol: 'anthropic',
                materialization: 'spawnEnv',
                compatibilityFingerprint: 'compatibility-v1',
                bindingSecurityFingerprint: 'security-v1',
                displaySnapshot: {
                    providerName: 'DeepSeek',
                    connectionName: 'DeepSeek',
                    connectionRole: 'default',
                    connectionDisplayNameMode: 'automatic',
                },
            },
            modelSelectionIntentV1: {
                v: 1,
                updatedAt: 2,
                selection: {
                    agentTargetKey: 'backend:claude',
                    providerConnectionId: 'pc_deepseek',
                    modelId: 'deepseek-ai/DeepSeek-V3.1',
                },
            },
            sessionModelsV1: {
                v: 1,
                agentId: 'claude',
                updatedAt: 2,
                currentModelId: 'deepseek-ai/DeepSeek-V3.1',
                availableModels: [{
                    id: 'deepseek-ai/DeepSeek-V3.1',
                    name: 'DeepSeek V3.1',
                    contextWindowTokens: 128_000,
                }],
            },
        } as any);

        expect(resolveContextWindowTokens({
            agentId: 'claude',
            metadata,
            sessionActive: false,
        } as any)).toBe(128_000);
    });

    it('uses a V2-proven active Provider descriptor and fails closed when the witness mismatches', () => {
        const currentRunnerProcessIdentity = {
            pid: 123,
            processStartTimeMs: 1_000,
        };
        const bindingSecurityFingerprint = createProviderBindingSecurityFingerprintV1({
            agentTargetKey: 'backend:claude',
            connectionId: 'pc_provider',
            modelId: 'provider-active',
            modelCapabilities: {},
            endpointTemplateId: 'responses',
            endpointUrl: 'https://provider.example/v1',
            protocol: 'openai-responses',
            publicHeaders: { 'x-provider': 'openrouter' },
            materialization: 'engineConfig',
            adapterBindingKey: 'openrouter',
            credentialDestination: {
                kind: 'httpHeader',
                name: 'authorization',
                format: 'bearer',
            },
            compatibilityFingerprint: 'compatibility-v1',
            adapterVersion: 1,
        });
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
                bindingSecurityFingerprint,
                displaySnapshot: {
                    providerName: 'OpenRouter',
                    connectionName: 'Work',
                    connectionRole: 'named',
                    connectionDisplayNameMode: 'custom',
                },
                model: {
                    id: 'provider-active',
                    name: 'Provider Active',
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
            modelSelectionIntentV1: {
                v: 1,
                updatedAt: 2,
                selection: {
                    agentTargetKey: 'backend:claude',
                    providerConnectionId: 'pc_provider',
                    modelId: 'provider-proposed',
                },
            },
            sessionModelsV1: {
                v: 1,
                agentId: 'claude',
                updatedAt: 1,
                currentModelId: 'provider-active',
                activeSelectionV1: {
                    v: 1,
                    selection: {
                        agentTargetKey: 'backend:claude',
                        providerConnectionId: 'pc_provider',
                        modelId: 'provider-active',
                    },
                    source: 'runtime_readback',
                    runner: currentRunnerProcessIdentity,
                },
                availableModels: [
                    {
                        id: 'provider-active',
                        name: 'Provider Active',
                        contextWindowTokens: 400_000,
                    },
                    {
                        id: 'provider-proposed',
                        name: 'Provider Proposed',
                        contextWindowTokens: 1_000_000,
                    },
                ],
            },
        });

        expect(resolveContextWindowTokens({
            agentId: 'claude',
            metadata,
            sessionActive: true,
            currentRunnerProcessIdentity,
        })).toBe(400_000);
        expect(resolveContextWindowTokens({
            agentId: 'claude',
            metadata,
            sessionActive: true,
            currentRunnerProcessIdentity: {
                pid: 123,
                processStartTimeMs: 1_001,
            },
        })).toBeNull();
    });

    it('keeps Provider-bound context unknown instead of applying Claude defaults', () => {
        const metadata = MetadataSchema.parse({
            path: '/tmp/project',
            host: 'localhost',
            providerBindingV1: {
                v: 1,
                connectionId: 'pc_deepseek',
                contributionKey: 'happier.provider.deepseek/deepseek',
                connectionRevision: 1,
                protocol: 'anthropic',
                materialization: 'spawnEnv',
                compatibilityFingerprint: 'compatibility-v1',
                bindingSecurityFingerprint: 'security-v1',
                displaySnapshot: {
                    providerName: 'DeepSeek',
                    connectionName: 'DeepSeek',
                    connectionRole: 'default',
                    connectionDisplayNameMode: 'automatic',
                },
            },
            modelSelectionIntentV1: {
                v: 1,
                updatedAt: 2,
                selection: {
                    agentTargetKey: 'backend:claude',
                    providerConnectionId: 'pc_deepseek',
                    modelId: 'deepseek-ai/DeepSeek-V3.1',
                },
            },
            sessionModelsV1: {
                v: 1,
                agentId: 'claude',
                updatedAt: 2,
                currentModelId: 'deepseek-ai/DeepSeek-V3.1',
                availableModels: [{
                    id: 'deepseek-ai/DeepSeek-V3.1',
                    name: 'DeepSeek V3.1',
                }],
            },
        } as any);

        expect(resolveContextWindowTokens({
            agentId: 'claude',
            metadata,
            sessionActive: false,
        } as any)).toBeNull();
    });
});

describe('resolveContextWindowTokens observed-usage evidence bump (Claude)', () => {
    it('bumps a stale 200k assumption to 1M when observed usage exceeds it (incident 733k/200k)', () => {
        expect(resolveContextWindowTokens({
            agentId: 'claude',
            metadata: null,
            sessionActive: false,
            usageData: { contextSize: 733_000 },
        } as any)).toBe(1_000_000);
    });

    it('keeps the assumed window when observed usage fits', () => {
        expect(resolveContextWindowTokens({
            agentId: 'claude',
            metadata: null,
            sessionActive: false,
            usageData: { contextSize: 150_000 },
        } as any)).toBe(200_000);
    });

    it('bumps a stale session-models window using observed usage evidence', () => {
        const metadata = MetadataSchema.parse({
            path: '/tmp/project',
            host: 'localhost',
            sessionModelsV1: {
                v: 1,
                agentId: 'claude',
                updatedAt: 1,
                currentModelId: 'claude-sonnet-4-6',
                availableModels: [
                    {
                        id: 'claude-sonnet-4-6',
                        name: 'Sonnet 4.6',
                        contextWindowTokens: 200_000,
                    },
                ],
            },
        } as any);

        expect(resolveContextWindowTokens({
            agentId: 'claude',
            metadata,
            sessionActive: false,
            usageData: { contextSize: 733_000 },
        } as any)).toBe(1_000_000);
    });

    it('trusts observed usage beyond every known Claude window so percent math never exceeds 100%', () => {
        expect(resolveContextWindowTokens({
            agentId: 'claude',
            metadata: null,
            sessionActive: false,
            usageData: { contextSize: 1_200_000 },
        } as any)).toBe(1_200_000);
    });

    it('does not apply the Claude window ladder to the Codex cold-start fallback', () => {
        expect(resolveContextWindowTokens({
            agentId: 'codex',
            metadata: null,
            sessionActive: false,
            usageData: { contextSize: 733_000 },
        } as any)).toBe(372_000);
    });
});

/**
 * An installed Agent's context-window declaration is a fact of ONE machine, and
 * two machines in the same Account can hold different versions of it. A
 * machine-blind read here would warn a Session on machine B with machine A's
 * window, so the resolver has to use the Session's own machine.
 */
describe('resolveContextWindowTokens across two machines holding different descriptors', () => {
    const EXTERNAL_AGENT_ID = 'acme.agent';

    async function publishDisagreeingMachines() {
        const { publishProjectedAgentUiBehaviorDescriptors } = await import(
            '@/agents/registry/agentUiBehaviorProjection'
        );
        // `machine-a` sorts first, so it is what a machine-blind read returns.
        publishProjectedAgentUiBehaviorDescriptors({
            machineId: 'machine-a',
            descriptorsByAgentId: {
                [EXTERNAL_AGENT_ID]: { contextWindow: { defaultTokens: 111_000 } },
            },
        });
        publishProjectedAgentUiBehaviorDescriptors({
            machineId: 'machine-b',
            descriptorsByAgentId: {
                [EXTERNAL_AGENT_ID]: { contextWindow: { defaultTokens: 222_000 } },
            },
        });
    }

    afterEach(async () => {
        const { clearProjectedAgentUiBehaviorDescriptors } = await import(
            '@/agents/registry/agentUiBehaviorProjection'
        );
        clearProjectedAgentUiBehaviorDescriptors();
    });

    it('uses the owning machine’s declared default window', async () => {
        await publishDisagreeingMachines();

        expect(resolveContextWindowTokens({
            agentId: EXTERNAL_AGENT_ID,
            metadata: MetadataSchema.parse({ path: '/tmp/project', host: 'localhost', machineId: 'machine-b' }),
            sessionActive: false,
        } as any)).toBe(222_000);
    });

    it('still uses the other machine’s window for a Session that runs there', async () => {
        await publishDisagreeingMachines();

        expect(resolveContextWindowTokens({
            agentId: EXTERNAL_AGENT_ID,
            metadata: MetadataSchema.parse({ path: '/tmp/project', host: 'localhost', machineId: 'machine-a' }),
            sessionActive: false,
        } as any)).toBe(111_000);
    });
});

describe('resolveContextWindowTokens provider registry boundary', () => {
    it('does not branch on Claude provider ids in the generic AgentInput resolver', () => {
        const source = readFileSync(new URL('./resolveContextWarningWindowTokens.ts', import.meta.url), 'utf8');

        expect(source).not.toMatch(/agentId\s*(?:={2,3}|!==?)\s*['"]claude['"]/);
        expect(source).not.toMatch(/sessionModelsState\.provider\s*(?:={2,3}|!==?)\s*['"]claude['"]/);
    });
});
