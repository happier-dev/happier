import { describe, expect, it } from 'vitest';

import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { resolveBuiltInContributions } from '@/plugins/projection/registry/resolveBuiltInContributions';
import { BUNDLED_FIRST_PARTY_PLUGIN_PACKAGE_NAMES } from '@/plugins/projection/registry/sources/generatedBundledPlugins';
import { createBundledActivationSourceResolver } from '@/plugins/runtime/bundledActivationSource';

import { shouldActivateTargetAtStartup } from './activation/targets';
import { activatePluginRuntimeRegistry } from './manager';

describe('bundled PluginApi parity', () => {
    it('keeps ordinary bundled Agents cold and activates one exactly once on first Agent demand', async () => {
        const contributes = createResolvedContributionRegistry(resolveBuiltInContributions());
        const activated = await activatePluginRuntimeRegistry({
            contributes,
            generation: 1,
            resolveActivationSource: createBundledActivationSourceResolver({
                bundledPackageNames: BUNDLED_FIRST_PARTY_PLUGIN_PACKAGE_NAMES,
            }),
        });

        const diagnostics = Object.fromEntries(Object.entries(activated.pluginDiagnosticsByPluginId)
            .filter(([, entries]) => entries.length > 0));
        expect(diagnostics).toEqual({});
        const expectedStartupPluginIds = new Set(contributes.activationTargets
            .filter(shouldActivateTargetAtStartup)
            .map((target) => target.pluginId));
        expect([...expectedStartupPluginIds]).toEqual([]);
        expect(activated.activatedPluginIds).toEqual(expectedStartupPluginIds);
        expect(activated.pluginDiagnosticsByPluginId['happier.voice.google'] ?? []).toEqual([]);
        expect(activated.activatedPluginIds.has('happier.voice.google')).toBe(false);

        const agent = contributes.agents.find((entry) => entry.pluginId === 'happier.agent.auggie');
        expect(agent).toBeDefined();
        if (!agent?.pluginId || !agent.identity) {
            throw new Error('Expected bundled Auggie Agent contribution identity');
        }
        const agentPluginIds = new Set(contributes.agents.flatMap((entry) => (
            entry.pluginId ? [entry.pluginId] : []
        )));
        expect(agentPluginIds.size).toBeGreaterThan(0);
        for (const pluginId of agentPluginIds) {
            expect(activated.activatedPluginIds.has(pluginId), pluginId).toBe(false);
        }

        const agentDemand = [{
            pluginId: agent.pluginId,
            family: 'agents',
            localId: agent.identity.localId,
        }];
        await activated.activateContributionsOnDemand(agentDemand);
        await activated.activateContributionsOnDemand(agentDemand);

        expect(activated.activatedPluginIds.has(agent.pluginId)).toBe(true);
        expect(activated.targetActivationFacts.filter((fact) => (
            fact.pluginId === agent.pluginId && fact.status === 'active'
        ))).toHaveLength(1);
        for (const pluginId of agentPluginIds) {
            if (pluginId !== agent.pluginId) {
                expect(activated.activatedPluginIds.has(pluginId)).toBe(false);
            }
        }

        const reviewAgent = contributes.agents.find((entry) => (
            entry.pluginId === 'happier.review.coderabbit'
        ));
        expect(reviewAgent?.identity).toBeDefined();
        if (!reviewAgent?.pluginId || !reviewAgent.identity) {
            throw new Error('Expected bundled CodeRabbit review Agent contribution identity');
        }
        await activated.activateContributionsOnDemand([{
            pluginId: reviewAgent.pluginId,
            family: 'agents',
            localId: reviewAgent.identity.localId,
        }]);
        expect(activated.activatedPluginIds.has(reviewAgent.pluginId)).toBe(true);

        const scmDemands = [
            ...(contributes.scmBackends ?? []).flatMap((entry) => entry.pluginId ? [{
                pluginId: entry.pluginId,
                family: 'scmBackends',
                localId: entry.definition.id,
            }] : []),
            ...(contributes.scmHostingProviders ?? []).flatMap((entry) => entry.pluginId ? [{
                pluginId: entry.pluginId,
                family: 'scmHostingProviders',
                localId: entry.definition.id,
            }] : []),
        ];
        const scmPluginIds = new Set(scmDemands.map((demand) => demand.pluginId));
        expect(scmPluginIds.size).toBeGreaterThan(0);
        for (const pluginId of scmPluginIds) {
            expect(activated.activatedPluginIds.has(pluginId)).toBe(false);
        }

        await activated.activateContributionsOnDemand(scmDemands);

        for (const pluginId of scmPluginIds) {
            expect(activated.activatedPluginIds.has(pluginId)).toBe(true);
            expect(activated.pluginDiagnosticsByPluginId[pluginId] ?? []).toEqual([]);
        }

        await activated.dispose();
    });
});
