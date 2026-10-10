import {
    type PeerMediationFlowKindV1,
} from '@happier-dev/protocol/account/settings/peerMediationPreferencesV1';

import { readAccountSettingsForScope } from '@/sync/domains/state/accountSettingsPersistence';
import { storage } from '@/sync/domains/state/storage';
import type { AccountSettingsScope } from './scope/accountSettingsScope';

/** Read route choices from the existing exact Account scope, never the focused Account by accident. */
export function resolvePeerMediationDirectPreferencesForScope(input: Readonly<{
    scope: AccountSettingsScope;
    machineId: string;
    flowKind: PeerMediationFlowKindV1;
}>): Readonly<{
    accountDefaultPreference: PeerDirectPreferenceV1;
    accountMachinePreference: PeerDirectPreferenceV1;
}> {
    const state = storage.getState();
    const settings = readAccountSettingsForScope({
        scope: input.scope,
        focusedScope: state.settingsScope,
        focusedSettings: state.settings,
    });
    const preferences = settings.peerMediationPreferencesV1;
    return {
        accountDefaultPreference: preferences.flows[input.flowKind]?.direct ?? 'inherit',
        accountMachinePreference: preferences.byMachineId[input.machineId]?.flows[input.flowKind]?.direct ?? 'inherit',
    };
}

/**
 * The Settings rows' view of the same preference (E-OE F11): one account-wide choice and one choice
 * per machine, each written back into `peerMediationPreferencesV1` for every flow at once. People
 * decide whether their devices may connect directly, not per transport; the flow granularity stays
 * the fold owner's (`resolveEffectivePeerDirectRoutePolicy`).
 */
export { readDirectConnectionsEnabled, withDirectConnectionsEnabled, readMachineDirectConnectionChoice, withMachineDirectConnectionChoice } from '@happier-dev/protocol/account/settings/peerMediationPreferencesV1';
export type { MachineDirectConnectionChoice } from '@happier-dev/protocol/account/settings/peerMediationPreferencesV1';
