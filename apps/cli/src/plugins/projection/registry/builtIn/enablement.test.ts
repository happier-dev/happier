import { describe, expect, it } from 'vitest';

import { resolveBundledPluginEnablement } from './enablement';
import { getResolvedContributionRegistry } from './snapshot';

describe('bundled plugin admission enablement', () => {
    it('defaults on, combines Account and Machine intent once, and restores declarations on re-enable', () => {
        const ids = ['happier.agent.pi', 'happier.language.typescript', 'happier.machine.fly', 'happier.deploy.neon', 'happier.channels'];
        const account = new Map(ids.map(id => [id, true]));
        const machine = Object.fromEntries(ids.map(id => [id, true]));
        const admitted = () => getResolvedContributionRegistry({
            pluginEnablementById: resolveBundledPluginEnablement({ pluginIds: ids, accountEnabledById: account, machineEnabledById: machine }),
        });
        const enabled = admitted();
        for (const pluginId of ids) {
            expect(enabled.pluginDeclarations?.some(plugin => plugin.pluginId === pluginId)).toBe(true);
        }
        account.set(ids[0]!, false);
        machine[ids[1]!] = false;
        account.set(ids[2]!, false);
        machine[ids[2]!] = false;
        machine[ids[3]!] = false;
        account.set(ids[4]!, false);
        const disabled = admitted();
        for (const pluginId of ids) {
            expect(disabled.pluginEnablementById?.[pluginId]?.enabled).toBe(false);
            expect(disabled.pluginDeclarations?.some(plugin => plugin.pluginId === pluginId)).toBe(false);
            expect(disabled.activationTargets.some(target => target.pluginId === pluginId)).toBe(false);
        }
        expect(disabled.unavailableAgentPluginsByBackendId?.pi).toMatchObject({ pluginId: ids[0], code: 'plugin_disabled' });
        // Independent healthy peers remain available when one family withdraws.
        expect(disabled.pluginDeclarations?.some(plugin => plugin.pluginId === 'happier.agent.codex')).toBe(true);
        for (const pluginId of ids) { account.set(pluginId, true); machine[pluginId] = true; }
        const restored = admitted();
        for (const pluginId of ids) expect(restored.pluginDeclarations?.some(plugin => plugin.pluginId === pluginId)).toBe(true);
        expect(restored.unavailableAgentPluginsByBackendId).toEqual({});
        expect(resolveBundledPluginEnablement({ pluginIds: ['default'] }).default).toEqual({ accountEnabled: true, machineEnabled: true, enabled: true });
    });

    it('reads each scope once per admission and shares the result across consumers', () => {
        let accountReads = 0;
        let machineReads = 0;
        const account = new Map([['happier.agent.pi', false]]);
        const readAccount = { get(id: string) { accountReads++; return account.get(id); } };
        const machine = Object.defineProperty({}, 'happier.agent.pi', { get() { machineReads++; return true; } });
        const facts = resolveBundledPluginEnablement({ pluginIds: ['happier.agent.pi'], accountEnabledById: readAccount, machineEnabledById: machine });
        const registry = getResolvedContributionRegistry({ pluginEnablementById: facts });
        for (let i = 0; i < 10; i++) {
            expect(registry.pluginEnablementById?.['happier.agent.pi']).toBe(facts['happier.agent.pi']);
            expect(registry.agents.some(agent => agent.pluginId === 'happier.agent.pi')).toBe(false);
        }
        expect({ accountReads, machineReads }).toEqual({ accountReads: 1, machineReads: 1 });
    });
});
