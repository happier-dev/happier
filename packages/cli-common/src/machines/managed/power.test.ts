import type { JsonValue } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';
import { ManagedMachineV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { executeManagedMachinePowerIntent } from './power.js';

const machine = ManagedMachineV1Schema.parse({
    id: 'retained', homeId: 'home', custodianAccountId: 'owner',
    launch: { provider: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, name: 'guest', choices: {} },
    resource: { contributionRef: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, value: { id: 'same-native' } },
    allocation: 'bound', creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 1,
    retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
});

describe('shared admitted native power', () => {
    it('executes the selected role once and keeps native acknowledgement separate from observed power', async () => {
        const calls: Array<{ role: string; body: unknown }> = [];
        const observation = { observedAt: 1, availability: 'present' as const, power: 'stopped' as const };
        const value = await executeManagedMachinePowerIntent({ machine, invoke: async (role, body) => {
            calls.push({ role, body });
            return role === 'power' ? { kind: 'confirmed' } : observation;
        } });
        expect(calls).toEqual([{ role: 'power', body: { resource: { id: 'same-native' }, intent: 'start' } },
            { role: 'inspect', body: { resource: { id: 'same-native' } } }]);
        expect(value).toEqual({ result: { kind: 'confirmed' }, observation });
    });
    it('does not inspect a definite refusal and does not retry ambiguous delivery', async () => {
        const roles: string[] = [];
        expect(await executeManagedMachinePowerIntent({ machine, invoke: async role => {
            roles.push(role); return { kind: 'refused', code: 'provider_unavailable' };
        } })).toEqual({ result: { kind: 'refused', code: 'provider_unavailable' } });
        expect(roles).toEqual(['power']);
        roles.length = 0;
        await expect(executeManagedMachinePowerIntent({ machine, invoke: async role => {
            roles.push(role); throw new Error('connection lost after dispatch');
        } })).rejects.toThrow('connection lost after dispatch');
        expect(roles).toEqual(['power']);
    });
    it('preserves acknowledgement when observation is unavailable', async () => {
        expect(await executeManagedMachinePowerIntent({ machine, invoke: async role => {
            if (role === 'inspect') throw new Error('temporarily unavailable');
            return { kind: 'confirmed' };
        } })).toEqual({ result: { kind: 'confirmed' } });
    });
    it('keeps the admitted native observation owner advancing without another power call', async () => {
        const roles: string[] = [];
        const published: string[] = [];
        let waits = 0;
        const value = await executeManagedMachinePowerIntent({ machine,
            waitForObservation: async () => { waits++; },
            onObservation: async observation => { published.push(observation.power ?? 'unknown'); },
            invoke: async (role): Promise<JsonValue> => {
                roles.push(role);
                return role === 'power' ? { kind: 'confirmed' } : { observedAt: waits + 1, availability: 'present',
                    power: waits ? 'running' : 'stopped', storage: 'retained' };
            } });
        expect(value.observation?.power).toBe('running');
        expect(roles).toEqual(['power', 'inspect', 'inspect']);
        expect(published).toEqual(['stopped']);
        expect(waits).toBe(1);
    });
});
