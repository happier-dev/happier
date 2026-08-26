import { describe, expect, it } from 'vitest';
import {
    ProviderAgentTargetKeySchema,
    ProviderConnectionIdSchema,
    ProviderContributionKeySchema,
    ProviderLocalIdSchema,
    ProviderModelIdSchema,
} from '@happier-dev/protocol';

import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';

import type { PluginRuntimeRegistryLease } from '../reload/controller';
import {
    materializeLeasedAgentProviderBinding,
    prepareLeasedAgentProviderBinding,
    readLeasedAgentProviderBindingAdapter,
} from './adapter';

const bundledCases = [
    { agentId: 'claude', pluginId: 'happier.agent.claude', protocol: 'anthropic', materialization: 'spawnEnv' },
    { agentId: 'codex', pluginId: 'happier.agent.codex', protocol: 'openai-responses', materialization: 'engineConfig' },
    { agentId: 'opencode', pluginId: 'happier.agent.opencode', protocol: 'openai-responses', materialization: 'configFile' },
] as const;

describe('bundled provider-binding activation parity', () => {
    it('materializes every bundled Agent through its real manifest requirements and registered adapter', async () => {
        const registry = await resolveExecutablePluginRuntimeRegistry();
        const lease: PluginRuntimeRegistryLease = {
            registry,
            source: 'ephemeral',
            durableRevision: registry.durableRevision ?? -1,
            release: async () => undefined,
        };

        try {
            for (const entry of bundledCases) {
                const agent = registry.contributes.agentDefinitionsById.get(entry.agentId);
                expect(agent?.identity).toEqual({
                    pluginId: entry.pluginId,
                    localId: entry.agentId,
                });
                if (!agent?.identity) {
                    throw new Error(`Missing bundled Agent identity for '${entry.agentId}'`);
                }
                const activation = await registry.activateContributionsOnDemand([{
                    pluginId: agent.identity.pluginId,
                    family: 'agents',
                    localId: agent.identity.localId,
                }]);
                expect(activation).toEqual([{
                    pluginId: entry.pluginId,
                    diagnostics: [],
                }]);
                expect(registry.pluginDiagnosticsByPluginId[entry.pluginId] ?? []).toEqual([]);
                expect(registry.targetActivationFacts?.filter((fact) => (
                    fact.pluginId === entry.pluginId
                    && fact.status === 'active'
                ))).toHaveLength(1);

                const resolved = readLeasedAgentProviderBindingAdapter({ lease, agentId: entry.agentId });
                expect(resolved).toMatchObject({
                    pluginId: entry.pluginId,
                    support: { materialization: entry.materialization },
                });

                const agentTargetKey = ProviderAgentTargetKeySchema.parse(`backend:${entry.agentId}:built_in`);
                const connectionId = ProviderConnectionIdSchema.parse(`pc_${entry.agentId}_fixture`);
                const prepared = prepareLeasedAgentProviderBinding({
                    lease,
                    agentId: entry.agentId,
                    input: { v: 1, agentTargetKey, connectionId },
                });
                const materialization = await materializeLeasedAgentProviderBinding({
                    lease,
                    agentId: entry.agentId,
                    prepared,
                    binding: {
                        v: 1,
                        agentTargetKey,
                        selection: {
                            connectionId,
                            model: {
                                id: ProviderModelIdSchema.parse('fixture-model'),
                                name: 'Fixture model',
                            },
                        },
                        contributionKey: ProviderContributionKeySchema.parse('happier.provider.fixture/fixture'),
                        endpoint: {
                            endpointTemplateId: ProviderLocalIdSchema.parse('fixture'),
                            normalizedUrl: 'https://provider.example.test/v1',
                            protocol: entry.protocol,
                            publicHeaders: {},
                        },
                        runtimeCredentialTransport: null,
                        compatibilityFingerprint: `pcf1:${entry.agentId}:fixture`,
                    },
                    credential: { kind: 'none' },
                });
                expect(materialization.kind).toBe(entry.materialization);
            }
        } finally {
            await registry.dispose();
        }
    });
});
