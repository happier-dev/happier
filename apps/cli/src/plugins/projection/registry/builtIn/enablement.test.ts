import { describe, expect, it } from 'vitest';

import { resolveBundledPluginEnablement } from './enablement';
import { getResolvedContributionRegistry } from './snapshot';
import { bindMachineRoleAdmission } from './machineRoles';

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

    it('keeps a role-gated plugin admitted but marks its roles inactive while its Machine role is off', () => {
        const ids = ['happier.channels', 'happier.agent.codex'];
        let applied: unknown = {};
        const release = bindMachineRoleAdmission(() => applied);
        try {
            const admitted = () => getResolvedContributionRegistry({ pluginEnablementById: resolveBundledPluginEnablement({ pluginIds: ids }) });
            // Missing field = every core role, so the Channels part of Work intake is on.
            expect(admitted().pluginEnablementById?.['happier.channels']?.inactiveMachineRoleIds).toBeUndefined();
            applied = { rolesV1: { active: ['sessions', 'broker'] } };
            const off = admitted();
            expect(off.pluginEnablementById?.['happier.channels']).toEqual({ accountEnabled: true, machineEnabled: true, enabled: true,
                inactiveMachineRoleIds: ['happier.channels/intake'] });
            // The summary declaration still shows the role; only activation is refused.
            expect(off.machineRoles?.some(role => role.pluginId === 'happier.channels' && role.definition.partOf === 'intake')).toBe(true);
            expect(off.pluginDeclarations?.some(plugin => plugin.pluginId === 'happier.channels')).toBe(true);
            expect(off.pluginEnablementById?.['happier.agent.codex']?.inactiveMachineRoleIds).toBeUndefined();
            applied = { rolesV1: { active: ['intake'] } };
            expect(admitted().pluginEnablementById?.['happier.channels']?.inactiveMachineRoleIds).toBeUndefined();
        } finally {
            release();
        }
    });

    it('resolves the built-in declarations once for equal enablement and again only when enablement changes', () => {
        const ids = ['happier.agent.pi', 'happier.channels'];
        const admitted = (piEnabled: boolean) => getResolvedContributionRegistry({ pluginEnablementById: resolveBundledPluginEnablement({
            pluginIds: ids, accountEnabledById: new Map([['happier.agent.pi', piEnabled]]) }) });
        const first = admitted(true);
        // A fresh but equal enablement (every boot consumer reads its own) reuses the same declarations.
        expect(admitted(true).pluginDeclarations).toBe(first.pluginDeclarations);
        const changed = admitted(false);
        expect(changed.pluginDeclarations).not.toBe(first.pluginDeclarations);
        expect(changed.pluginDeclarations?.some(plugin => plugin.pluginId === 'happier.agent.pi')).toBe(false);
        expect(admitted(false).pluginDeclarations).toBe(changed.pluginDeclarations);
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
