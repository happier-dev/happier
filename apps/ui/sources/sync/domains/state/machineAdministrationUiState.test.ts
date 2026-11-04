import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearPersistenceStorage, getPersistenceStorage } from './persistenceStorage';
import { loadAccountSettings } from './accountSettingsPersistence';
import { loadLocalSettings } from './settingsPersistence';
import { accountSettingsScopeKeySuffix } from '@/sync/domains/settings/scope/accountSettingsScope';
import { serverAccountScopedResourceKey } from '@/sync/domains/scope/serverAccountScope';
import { writePersistedBackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';

afterEach(() => { vi.restoreAllMocks(); clearPersistenceStorage(); });

describe('Machine navigation state migration', () => {
    const scope = { serverId: 'srv_navigation', accountId: 'alice' };
    const target = { serverIdentityId: 'srv_navigation', machineId: 'machine-a' };
    const sourceKey = `account-settings:v2:${accountSettingsScopeKeySuffix(scope)}`;

    it('imports the predecessor last-used target once into device memory and removes the Account cache source', async () => {
        const device = getPersistenceStorage();
        device.set(sourceKey, JSON.stringify({ version: 7, settings: {
            lastUsedBackendTarget: { kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot', sourceKind: 'configured' },
            lastUsedAgent: 'codex',
        } }));
        const loaded = loadAccountSettings(scope);
        expect(loaded.settings).not.toHaveProperty('lastUsedBackendTarget');
        const { readLastUsedBackendSelection, rememberLastUsedBackendSelection } = await import('./newSessionTargetUiState');
        expect(readLastUsedBackendSelection(scope).lastUsedBackendTarget).toEqual(writePersistedBackendTargetRefV2({
            kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot', sourceKind: 'configured',
        }));
        const current = { kind: 'backend', backendId: 'newer-bot', configuredBackendId: 'newer-bot', sourceKind: 'configured' } as const;
        rememberLastUsedBackendSelection(scope, { lastUsedBackendTarget: current });
        // A stale cache from an older binary cannot overwrite the current owner.
        device.set(sourceKey, JSON.stringify({ version: 7, settings: { lastUsedBackendTarget: { kind: 'backend', backendId: 'codex' } } }));
        loadAccountSettings(scope);
        expect(readLastUsedBackendSelection(scope).lastUsedBackendTarget).toEqual(writePersistedBackendTargetRefV2(current));
        expect(readLastUsedBackendSelection({ ...scope, accountId: 'bob' }).lastUsedBackendTarget).toBeNull();
        const writes = vi.spyOn(device, 'set');
        loadAccountSettings(scope);
        expect(writes).not.toHaveBeenCalled();
    });

    it.each(['plugin.lastRunOn:acme.plugin', 'machines.managed'])('moves %s last-use history into exact device/Account/Home observations without consuming named defaults', (historyKey) => {
        const device = getPersistenceStorage();
        const current = { ...target, machineId: 'newer-machine' };
        const namedDefaults = { 'plugin.runOn:acme.plugin': target, 'machines.managed.default': target };
        const historyDestination = `ui-state:machine-target-observations-v1:${serverAccountScopedResourceKey(scope, historyKey)}`;
        device.set(sourceKey, JSON.stringify({ version: 7, settings: { machineAdministrationTargetsLocalV1: {
            ...namedDefaults, [historyKey]: target,
        } } }));
        device.set(historyDestination, JSON.stringify(current));
        expect(loadAccountSettings(scope)).toMatchObject({ version: 7, settings: { machineAdministrationTargetsLocalV1: {
            ...namedDefaults,
        } } });
        expect(Reflect.get(Reflect.get(loadAccountSettings(scope).settings as object, 'machineAdministrationTargetsLocalV1'), historyKey)).toBeUndefined();
        expect(JSON.parse(device.getString(historyDestination)!)).toEqual(current);
        expect(JSON.parse(device.getString(sourceKey)!).settings.machineAdministrationTargetsLocalV1).toEqual(namedDefaults);
        const writes = vi.spyOn(device, 'set');
        loadAccountSettings(scope);
        expect(writes).not.toHaveBeenCalled();
        expect(loadAccountSettings({ ...scope, accountId: 'bob' }).settings).toEqual({});
    });

    it.each(['plugin.lastRunOn:acme.plugin', 'machines.managed'])('retains %s source on a refused destination write and safely retries', (historyKey) => {
        const device = getPersistenceStorage();
        const raw = JSON.stringify({ version: 7, settings: { machineAdministrationTargetsLocalV1: {
            'plugin.runOn:acme.plugin': target, [historyKey]: target,
        } } });
        device.set(sourceKey, raw);
        const write = device.set.bind(device);
        const refused = vi.spyOn(device, 'set').mockImplementation((key, value) => {
            if (key.startsWith('ui-state:machine-target-observations-v1:')) throw new Error('device full');
            write(key, value);
        });
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        expect(() => loadAccountSettings(scope)).not.toThrow();
        expect(device.getString(sourceKey)).toBe(raw);
        refused.mockRestore();
        loadAccountSettings(scope);
        const historyDestination = `ui-state:machine-target-observations-v1:${serverAccountScopedResourceKey(scope, historyKey)}`;
        expect(JSON.parse(device.getString(historyDestination)!)).toEqual(target);
        expect(JSON.parse(device.getString(sourceKey)!).settings.machineAdministrationTargetsLocalV1).toEqual({ 'plugin.runOn:acme.plugin': target });
    });

    it('moves unscoped rail observations out of settings without giving its global cursor authority over any Account', () => {
        const device = getPersistenceStorage();
        const seen = { look: { '["srv_navigation","machine-a"]': ['disk:data'] }, guardSeenAt: 100 };
        device.set('local-settings', JSON.stringify({ themePreference: 'dark', machinesRailSeenV1: seen }));
        expect(loadLocalSettings().themePreference).toBe('dark');
        const persisted = JSON.parse(device.getString('local-settings')!);
        expect(persisted).toMatchObject({ themePreference: 'dark' });
        expect(persisted).not.toHaveProperty('machinesRailSeenV1');
        expect(JSON.parse(device.getString('ui-state:machines-rail-seen-v1:legacy-unscoped')!)).toEqual(seen);
    });
});
