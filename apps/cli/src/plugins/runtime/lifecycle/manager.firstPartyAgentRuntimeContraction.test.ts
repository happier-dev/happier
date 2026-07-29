import { AGENT_IDS, type AgentId } from '@happier-dev/agents';
import { describe, expect, it } from 'vitest';

import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { isPrimaryAgentContributionDefinition } from '@/plugins/projection/registry/agentContributionDefinition';
import { resolveBuiltInContributions } from '@/plugins/projection/registry/resolveBuiltInContributions';
import { BUNDLED_FIRST_PARTY_PLUGIN_PACKAGE_NAMES } from '@/plugins/projection/registry/sources/generatedBundledPlugins';
import { createBundledActivationSourceResolver } from '@/plugins/runtime/bundledActivationSource';

import { activatePluginRuntimeRegistry } from './manager';

const NATIVE_ONLY_AGENT_ID = 'grok' satisfies AgentId;
const V1_COMPATIBILITY_FACTORY_SYMBOL =
    'happier.plugin-sdk.agentRuntimeV1CompatibilityFactory';

describe('first-party AgentRuntime contraction', () => {
    it('activates all sixteen predecessor Agents as native runtimes with no V1 compatibility owner', async () => {
        const predecessorAgentIds = AGENT_IDS.filter((agentId) => agentId !== NATIVE_ONLY_AGENT_ID);
        expect(predecessorAgentIds).toHaveLength(16);

        const contributes = createResolvedContributionRegistry(resolveBuiltInContributions());
        const activated = await activatePluginRuntimeRegistry({
            contributes,
            generation: 1,
            resolveActivationSource: createBundledActivationSourceResolver({
                bundledPackageNames: BUNDLED_FIRST_PARTY_PLUGIN_PACKAGE_NAMES,
            }),
        });

        try {
            const demands = predecessorAgentIds.map((agentId) => {
                const contribution = contributes.agents.find((entry) => entry.id === agentId);
                expect(contribution?.pluginId, agentId).toBeTruthy();
                expect(contribution?.identity, agentId).toBeTruthy();
                if (!contribution?.pluginId || !contribution.identity) {
                    throw new Error(`Missing bundled contribution identity for '${agentId}'`);
                }
                return {
                    pluginId: contribution.pluginId,
                    family: 'agents' as const,
                    localId: contribution.identity.localId,
                };
            });

            const results = await activated.activateContributionsOnDemand(demands);
            expect(results).toHaveLength(16);
            expect(results.every((result) => result.diagnostics.length === 0)).toBe(true);

            for (const agentId of predecessorAgentIds) {
                const lease = activated.agentRuntimesByAgentId.get(agentId);
                expect(lease, agentId).toMatchObject({
                    agentId,
                    hasPrimaryRuntime: true,
                });
                if (!lease?.hasPrimaryRuntime) {
                    throw new Error(`Missing primary runtime lease for '${agentId}'`);
                }

                const runtime = await lease.createRuntime({
                    signal: new AbortController().signal,
                });
                const definition = contributes.agents.find((entry) => entry.id === agentId)
                    ?.richDefinition?.definition;
                if (!definition || !isPrimaryAgentContributionDefinition(definition)) {
                    throw new Error(`Missing primary Agent definition for '${agentId}'`);
                }
                expect(
                    Object.getOwnPropertySymbols(runtime).map((symbol) => Symbol.keyFor(symbol)),
                    agentId,
                ).not.toContain(V1_COMPATIBILITY_FACTORY_SYMBOL);
                expect(runtime.sessions !== undefined, `${agentId}: sessions capability`)
                    .toBe(definition.capabilities.sessions !== undefined);
                expect(runtime.executionRuns !== undefined, `${agentId}: execution-runs capability`)
                    .toBe(definition.capabilities.executionRuns !== undefined);
                expect(runtime.surfaces?.terminal !== undefined, `${agentId}: terminal capability`)
                    .toBe(definition.capabilities.surfaces?.includes('terminal') === true);
            }
        } finally {
            await activated.dispose();
        }
    });

    it('keeps the native-only Grok consumer outside the sixteen-Agent migration denominator', async () => {
        const contributes = createResolvedContributionRegistry(resolveBuiltInContributions());
        const activated = await activatePluginRuntimeRegistry({
            contributes,
            generation: 1,
            resolveActivationSource: createBundledActivationSourceResolver({
                bundledPackageNames: BUNDLED_FIRST_PARTY_PLUGIN_PACKAGE_NAMES,
            }),
        });

        try {
            const contribution = contributes.agents.find((entry) => entry.id === NATIVE_ONLY_AGENT_ID);
            if (!contribution?.pluginId || !contribution.identity) {
                throw new Error('Missing bundled Grok contribution identity');
            }
            await expect(activated.activateContributionsOnDemand([{
                pluginId: contribution.pluginId,
                family: 'agents',
                localId: contribution.identity.localId,
            }])).resolves.toEqual([{
                pluginId: contribution.pluginId,
                diagnostics: [],
            }]);

            const lease = activated.agentRuntimesByAgentId.get(NATIVE_ONLY_AGENT_ID);
            if (!lease?.hasPrimaryRuntime) {
                throw new Error('Missing primary runtime lease for Grok');
            }
            const runtime = await lease.createRuntime({
                signal: new AbortController().signal,
            });
            const definition = contribution.richDefinition?.definition;
            if (!definition || !isPrimaryAgentContributionDefinition(definition)) {
                throw new Error('Missing primary Agent definition for Grok');
            }
            expect(
                Object.getOwnPropertySymbols(runtime).map((symbol) => Symbol.keyFor(symbol)),
            ).not.toContain(V1_COMPATIBILITY_FACTORY_SYMBOL);
            expect(runtime.sessions !== undefined).toBe(definition.capabilities.sessions !== undefined);
            expect(runtime.executionRuns !== undefined)
                .toBe(definition.capabilities.executionRuns !== undefined);
            expect(runtime.surfaces?.terminal !== undefined)
                .toBe(definition.capabilities.surfaces?.includes('terminal') === true);
        } finally {
            await activated.dispose();
        }
    });
});
