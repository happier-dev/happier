import { describe, expect, it } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { PluginProjectionV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { createVoiceSettingsOwner } from '@happier-dev/protocol/voice/settings/voiceSettings';
import { createCliSettingsCatalogServices, projectCliProviderStateSharingRiskAgentIdsV1 } from './settingsCatalogServices';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { readCurrentContributionRegistry } from '@/agent/catalog/snapshot';
import { getAgentCore, isBundledAgentId } from '@happier-dev/agents';
import { readProviderStateSharingRiskAgentIdsV1 } from '@happier-dev/protocol/actions/settings/providerStateSharingMutations';

describe('exact remote Voice Agent catalog admission', () => {
    it('distinguishes an unactivated empty snapshot from a proven activated empty native catalog', () => {
        const empty = createResolvedContributionRegistry({});
        expect(projectCliProviderStateSharingRiskAgentIdsV1(empty, { activated: false, unavailable: false })).toBeNull();
        expect(projectCliProviderStateSharingRiskAgentIdsV1(empty, { activated: true, unavailable: false })).toEqual([]);
        expect(projectCliProviderStateSharingRiskAgentIdsV1(empty, { activated: true, unavailable: true })).toBeNull();
    });
    it('derives named sharing risks only from genuine current bundled capabilities', () => {
        const entries = [...readCurrentContributionRegistry().agentDefinitionsById.values()];
        const services = createCliSettingsCatalogServices({});
        if (entries.some(entry => entry.provenance !== 'first_party' || !isBundledAgentId(entry.id))) {
            expect(services.readProviderStateSharingRiskAgentIds()).toBeNull();
        } else {
            const risks = readProviderStateSharingRiskAgentIdsV1(entries.map(entry => ({ agentId: entry.id,
                capability: isBundledAgentId(entry.id) ? getAgentCore(entry.id).connectedServices?.providerStateSharing : null,
            })));
            expect(services.readProviderStateSharingRiskAgentIds()).toEqual(risks);
            expect(risks).toContain('codex');
        }
    });
    it('uses the selected remote routing tuple and refuses its captured proof after a real projection generation change', async () => {
        const owner = createVoiceSettingsOwner({ bundledContributions: [] });
        const settings = { ...accountSettingsParse({}), voice: {
            ...owner.voiceSettingsDefaults, executionMachine: { mode: 'fixed' as const, machineId: 'remote-computer' },
        } };
        let generation = 7;
        const services = createCliSettingsCatalogServices({ credentials: { token: 'fixture', encryption: null },
            serverId: 'server', expectedAccountId: 'account', voiceOwner: owner,
            // The machine RPC is the external boundary; projection parsing and selection remain real.
            readMachineAgentProjection: async machineId => machineId === 'remote-computer'
                ? PluginProjectionV2Schema.parse({ v: 2, generation, familiesById: {}, agentsById: {
                    remote: { id: 'remote-routing-id', identity: { pluginId: 'acme.agent', localId: 'remote' }, isBuiltIn: false },
                } }) : null,
        });
        const catalog = await services.readAgentCatalog!(settings);
        expect(catalog?.entries).toEqual([{ agentId: 'remote-routing-id', backendTargetKey: 'agent:acme.agent/remote',
            identity: { pluginId: 'acme.agent', localId: 'remote' }, projectionGeneration: 7, isBuiltIn: false, enabled: true }]);
        expect(catalog?.isCurrent({ ...settings, voice: { ...settings.voice,
            executionMachine: { mode: 'fixed', machineId: 'other-computer' } } })).toBe(false);
        expect(await services.isCurrent()).toBe(true);
        generation = 8;
        expect(await services.isCurrent()).toBe(false);
        expect(await services.readAgentCatalog!({ ...settings, voice: { ...settings.voice,
            executionMachine: { mode: 'auto', machineId: null } } })).toBeNull();
    });
});
