import { describe, expect, it } from 'vitest';
import { settingsDefaults, settingsParse } from '@/sync/domains/settings/settings';
import { saveAccountSettings, loadAccountSettings } from '@/sync/domains/state/accountSettingsPersistence';
import { getPersistenceStorage } from '@/sync/domains/state/persistenceStorage';
import { stripLocalOnlyAccountSettings } from '@/sync/domains/settings/localOnlyAccountSettings';
import {
    clearMachineAdministrationTargetPreference,
    clearPluginMachineExecutionOriginPreference,
    readMachineAdministrationTargetPreference,
    readPluginMachineExecutionTargetPreference,
    setMachineAdministrationTargetPreference,
    setPluginMachineExecutionOriginPreference,
} from './selectionPreferences';

describe('machine administration selection preferences', () => {
    const pluginId = 'acme.plugin';
    const origin = { serverIdentityId: 'srv_one', sourceRef: { machineId: 'machine-a', pluginId,
        sourceCustody: { kind: 'development' as const, registeredRootId: '/registered/source' } } };
    it('keeps a deliberate managed-Machine choice at its declared key without importing it as an observation', () => {
        const scope = { serverId: 'srv_one', accountId: 'managed-preference-test' };
        const target = { serverIdentityId: 'srv_one', machineId: 'machine-a' };
        const next = setMachineAdministrationTargetPreference({}, 'machines.managed', target);
        expect(next).toEqual({ 'machines.managed': target });
        saveAccountSettings(scope, { ...settingsDefaults, machineAdministrationTargetsLocalV1: next }, 1);
        const restored = settingsParse(loadAccountSettings(scope).settings).machineAdministrationTargetsLocalV1;
        expect(readMachineAdministrationTargetPreference(restored, 'machines.managed')).toEqual(target);
        expect(clearMachineAdministrationTargetPreference(restored, 'machines.managed')).toEqual({});
    });
    it('accepts a canonical maximum-length plugin id as a named local target', () => {
        const longId = `${'a'.repeat(250)}.tools`;
        const next = setPluginMachineExecutionOriginPreference({}, longId, { ...origin, sourceRef: { ...origin.sourceRef, pluginId: longId } });
        expect(readPluginMachineExecutionTargetPreference(next, longId)).toEqual({ serverIdentityId: 'srv_one', machineId: 'machine-a' });
    });
    it('remembers only the Machine, preserving sibling Administration targets', () => {
        const current = { agents: { serverIdentityId: 'srv_one', machineId: 'machine-b' } };
        const next = setPluginMachineExecutionOriginPreference(current, pluginId, origin);
        expect(next).toEqual({ ...current, 'plugin.runOn:acme.plugin': { serverIdentityId: 'srv_one', machineId: 'machine-a' } });
        expect(readPluginMachineExecutionTargetPreference(next, pluginId)).toEqual({ serverIdentityId: 'srv_one', machineId: 'machine-a' });
        expect(clearPluginMachineExecutionOriginPreference(next, pluginId)).toEqual(current);
        expect(() => setPluginMachineExecutionOriginPreference(current, 'another.plugin', origin)).toThrow();
    });
    it('persists per device and Home without transmitting a local choice through Account settings', () => {
        const scope = { serverId: 'srv_one', accountId: 'runon-preference-test' };
        const otherHome = { ...scope, serverId: 'srv_two' };
        const local = setPluginMachineExecutionOriginPreference({}, pluginId, origin);
        const other = setPluginMachineExecutionOriginPreference({}, pluginId, { ...origin, serverIdentityId: 'srv_two' });
        saveAccountSettings(scope, { ...settingsDefaults, machineAdministrationTargetsLocalV1: local }, 1);
        saveAccountSettings(otherHome, { ...settingsDefaults, machineAdministrationTargetsLocalV1: other }, 1);
        expect(settingsParse(loadAccountSettings(scope).settings).machineAdministrationTargetsLocalV1).toEqual(local);
        expect(settingsParse(loadAccountSettings(otherHome).settings).machineAdministrationTargetsLocalV1).toEqual(other);
        const transmitted = stripLocalOnlyAccountSettings({ machineAdministrationTargetsLocalV1: other });
        expect(settingsParse(transmitted).machineAdministrationTargetsLocalV1).toEqual({});
        // Swap the test MMKV boundary's contents to represent a second device.
        const device = getPersistenceStorage();
        const firstDevice = device.getAllKeys().map(key => [key, device.getString(key)] as const);
        try {
            device.clearAll();
            saveAccountSettings(scope, { ...settingsDefaults, machineAdministrationTargetsLocalV1: other }, 1);
            expect(settingsParse(loadAccountSettings(scope).settings).machineAdministrationTargetsLocalV1).toEqual(other);
        } finally {
            device.clearAll();
            for (const [key, value] of firstDevice) if (value !== undefined) device.set(key, value);
        }
        expect(settingsParse(loadAccountSettings(scope).settings).machineAdministrationTargetsLocalV1).toEqual(local);
    });
    it('updates and clears only the named device-local target through the domain schema', () => {
        const current = { agents: { serverIdentityId: 'srv_one', machineId: 'machine-a' } };
        const next = setMachineAdministrationTargetPreference(current, 'plugins.home', { serverIdentityId: 'srv_two', machineId: 'machine-b' });
        expect(clearMachineAdministrationTargetPreference(next, 'plugins.home')).toEqual(current);
        expect(() => setMachineAdministrationTargetPreference({}, 'plugins.home', { serverIdentityId: 'profile-local-1', machineId: 'machine-a' })).toThrow();
    });
});
