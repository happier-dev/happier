import * as React from 'react';
import { storage } from '@/sync/domains/state/storageStore';
import type { MachineResourceKey } from './machineRpc';
import { readMachineOfflineAlertSetting } from '@happier-dev/protocol/actions/settings/machineOfflineAlertSetting';
import { SettingsDeclarationActionOutputSchemasV1 } from '@happier-dev/protocol/actions/settingsDeclarationActionFamily';
import { areAccountSettingsScopesEqual } from '@/sync/domains/settings/scope/accountSettingsScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';

export type MachineOfflineAlertSetResult = Readonly<{ saved: boolean; enabled: boolean | null; reason?: string }>;
export type MachineOfflineAlertState = Readonly<{
    status: 'ready' | 'unavailable'; enabled: boolean | null;
    set(enabled: boolean): Promise<MachineOfflineAlertSetResult>;
}>;

function readConsent(state: ReturnType<typeof storage.getState>, input: MachineResourceKey) {
    const scope = state.settingsScope;
    if (!scope || !areAccountSettingsScopesEqual(scope, state.profileScope)
        || (input.serverId && !areServerProfileIdentifiersEquivalent(scope.serverId, input.serverId))) return null;
    return { scope, enabled: readMachineOfflineAlertSetting(state.settings, input.machineId) };
}

export function useMachineOfflineAlert(input: MachineResourceKey): MachineOfflineAlertState {
    const { machineId, serverId } = input;
    const enabled = storage(React.useCallback((state: ReturnType<typeof storage.getState>) => readConsent(state, { machineId, serverId })?.enabled ?? null, [machineId, serverId]),
        { settings: ['machineOfflineAlertsV1'], settingsScope: true, profileScope: true });
    const set = React.useCallback(async (value: boolean): Promise<MachineOfflineAlertSetResult> => {
        const before = readConsent(storage.getState(), { machineId, serverId });
        const failed = (reason: string) => ({ saved: false, enabled: readConsent(storage.getState(), { machineId, serverId })?.enabled ?? null, reason });
        if (!before) return failed('account_unavailable');
        try {
            const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
            const result = await createDefaultActionExecutor().execute('settings.set', { anchor: 'notifications.machineOffline', key: machineId, value },
                { surface: 'ui', serverId: before.scope.serverId, expectedAccountId: before.scope.accountId });
            const after = readConsent(storage.getState(), { machineId, serverId });
            if (!after || !areAccountSettingsScopesEqual(before.scope, after.scope)) return failed('account_scope_changed');
            if (!result.ok) return failed(result.errorCode ?? 'action_failed');
            const parsed = SettingsDeclarationActionOutputSchemasV1['settings.set'].safeParse(result.result);
            if (!parsed.success || parsed.data.anchor !== 'notifications.machineOffline' || !('value' in parsed.data) || typeof parsed.data.value !== 'boolean') return failed('invalid_setting_result');
            return { saved: true, enabled: parsed.data.value };
        } catch {
            return failed('action_failed');
        }
    }, [machineId, serverId]);
    return React.useMemo(() => ({ status: enabled === null ? 'unavailable' : 'ready', enabled, set }), [enabled, set]);
}
