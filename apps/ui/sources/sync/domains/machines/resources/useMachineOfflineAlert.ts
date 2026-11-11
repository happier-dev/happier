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
    failed: boolean;
    set(enabled: boolean): Promise<MachineOfflineAlertSetResult>;
}>;

type OfflineAlertMutation = {
    machineId: string;
    serverId: string | undefined;
    desired: boolean | null;
    saving: Promise<MachineOfflineAlertSetResult> | null;
};

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
    const mutationRef = React.useRef<OfflineAlertMutation | null>(null);
    if (!mutationRef.current || mutationRef.current.machineId !== machineId || mutationRef.current.serverId !== serverId) {
        // A retained Machine page may change targets while the old target's admitted
        // write finishes. Its next choice belongs to a separate mutation.
        mutationRef.current = { machineId, serverId, desired: null, saving: null };
    }
    const mutation = mutationRef.current;
    const [presentation, setPresentation] = React.useState<Readonly<{
        mutation: OfflineAlertMutation; pending: boolean | null; failed: boolean;
    }> | null>(null);
    const set = React.useCallback((value: boolean): Promise<MachineOfflineAlertSetResult> => {
        const before = readConsent(storage.getState(), { machineId, serverId });
        const fail = (reason: string) => {
            setPresentation(current => current?.mutation === mutation ? { ...current, failed: true } : current);
            return { saved: false, enabled: readConsent(storage.getState(), { machineId, serverId })?.enabled ?? null, reason };
        };
        if (!before) return Promise.resolve(fail('account_unavailable'));
        mutation.desired = value;
        setPresentation({ mutation, pending: value, failed: false });
        if (mutation.saving) return mutation.saving;
        const operation = (async (): Promise<MachineOfflineAlertSetResult> => {
            try {
                const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
                const executor = createDefaultActionExecutor();
                let confirmed = before.enabled;
                while (mutation.desired !== confirmed) {
                    const next = mutation.desired!;
                    const result = await executor.execute('settings.set', { anchor: 'notifications.machineOffline', key: machineId, value: next },
                        { surface: 'ui', serverId: before.scope.serverId, expectedAccountId: before.scope.accountId });
                    const after = readConsent(storage.getState(), { machineId, serverId });
                    if (!after || !areAccountSettingsScopesEqual(before.scope, after.scope)) return fail('account_scope_changed');
                    if (!result.ok) return fail(result.errorCode ?? 'action_failed');
                    const parsed = SettingsDeclarationActionOutputSchemasV1['settings.set'].safeParse(result.result);
                    if (!parsed.success || parsed.data.anchor !== 'notifications.machineOffline' || !('value' in parsed.data) || typeof parsed.data.value !== 'boolean') return fail('invalid_setting_result');
                    confirmed = parsed.data.value;
                    if (mutation.desired === next) break;
                }
                return { saved: true, enabled: confirmed };
            } catch {
                return fail('action_failed');
            } finally {
                mutation.desired = null;
                mutation.saving = null;
                setPresentation(current => current?.mutation === mutation ? { ...current, pending: null } : current);
            }
        })();
        mutation.saving = operation;
        return operation;
    }, [machineId, serverId, mutation]);
    const pending = presentation?.mutation === mutation ? presentation.pending : null;
    const failed = presentation?.mutation === mutation && presentation.failed;
    return React.useMemo(() => ({ status: enabled === null ? 'unavailable' : 'ready', enabled: enabled === null ? null : pending ?? enabled, failed, set }), [enabled, pending, failed, set]);
}
