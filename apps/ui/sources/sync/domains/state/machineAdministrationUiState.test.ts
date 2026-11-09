import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearPersistenceStorage, getPersistenceStorage } from './persistenceStorage';
import { loadAccountSettings } from './accountSettingsPersistence';
import { accountSettingsScopeKeySuffix } from '@/sync/domains/settings/scope/accountSettingsScope';
import { serverAccountScopedResourceKey } from '@/sync/domains/scope/serverAccountScope';
import { loadPendingAccountSettingsState, pendingAccountSettingsKey } from './pendingAccountSettingsPersistence';
import { readMachineAdministrationTargetObservation, rememberMachineAdministrationTargetObservation } from './machineAdministrationUiState';
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

    it.each(['plugin.lastRunOn:acme.plugin', 'machines.managed'])('does not import never-shipped %s Settings observations', (historyKey) => {
        const device = getPersistenceStorage();
        const source = { machineAdministrationTargetsLocalV1: { [historyKey]: target } };
        device.set(sourceKey, JSON.stringify({ version: 7, settings: source }));
        device.set(pendingAccountSettingsKey(scope), JSON.stringify(source));
        loadAccountSettings(scope);
        loadPendingAccountSettingsState(scope);
        expect(readMachineAdministrationTargetObservation(scope, historyKey)).toBeNull();
        expect(device.getString(`ui-state:machine-target-observations-v1:${serverAccountScopedResourceKey(scope, historyKey)}`)).toBeUndefined();
        rememberMachineAdministrationTargetObservation(scope, historyKey, target);
        expect(readMachineAdministrationTargetObservation(scope, historyKey)).toEqual(target);
        expect(readMachineAdministrationTargetObservation({ ...scope, accountId: 'bob' }, historyKey)).toBeNull();
    });

});
