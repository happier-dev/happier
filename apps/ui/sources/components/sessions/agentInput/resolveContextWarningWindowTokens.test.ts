import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { MetadataSchema } from '@/sync/domains/state/storageTypes';

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
        } as any);

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
        } as any);

        expect(resolveContextWarningWindowTokens({
            agentId: 'codex',
            metadata,
        } as any)).toBe(245100);
    });

    it('falls back to Claude default warning windows when no live or metadata value exists', () => {
        expect(resolveContextWarningWindowTokens({
            agentId: 'claude',
            metadata: null,
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
        } as any)).toBe(950000);
    });

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
        } as any)).toBe(950000);
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
        } as any)).toBe(128_000);
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
        } as any)).toBeNull();
    });
});

describe('resolveContextWindowTokens observed-usage evidence bump (Claude)', () => {
    it('bumps a stale 200k assumption to 1M when observed usage exceeds it (incident 733k/200k)', () => {
        expect(resolveContextWindowTokens({
            agentId: 'claude',
            metadata: null,
            usageData: { contextSize: 733_000 },
        } as any)).toBe(1_000_000);
    });

    it('keeps the assumed window when observed usage fits', () => {
        expect(resolveContextWindowTokens({
            agentId: 'claude',
            metadata: null,
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
            usageData: { contextSize: 733_000 },
        } as any)).toBe(1_000_000);
    });

    it('trusts observed usage beyond every known Claude window so percent math never exceeds 100%', () => {
        expect(resolveContextWindowTokens({
            agentId: 'claude',
            metadata: null,
            usageData: { contextSize: 1_200_000 },
        } as any)).toBe(1_200_000);
    });

    it('does not apply the Claude window ladder to the Codex cold-start fallback', () => {
        expect(resolveContextWindowTokens({
            agentId: 'codex',
            metadata: null,
            usageData: { contextSize: 733_000 },
        } as any)).toBe(372_000);
    });
});

describe('resolveContextWindowTokens provider registry boundary', () => {
    it('does not branch on Claude provider ids in the generic AgentInput resolver', () => {
        const source = readFileSync(new URL('./resolveContextWarningWindowTokens.ts', import.meta.url), 'utf8');

        expect(source).not.toMatch(/agentId\s*(?:={2,3}|!==?)\s*['"]claude['"]/);
        expect(source).not.toMatch(/sessionModelsState\.provider\s*(?:={2,3}|!==?)\s*['"]claude['"]/);
    });
});
