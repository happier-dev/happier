import {
    PeerMediationFlowKindV1Schema,
    type PeerDirectPreferenceV1,
    type PeerMediationFlowKindV1,
    type PeerMediationPreferencesV1,
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
export type MachineDirectConnectionChoice = 'default' | 'direct' | 'relay';

const DIRECT_FLOW_KINDS = PeerMediationFlowKindV1Schema.options;

type FlowPreferences = PeerMediationPreferencesV1['flows'];

function flowsWith(direct: PeerDirectPreferenceV1): FlowPreferences {
    return Object.fromEntries(DIRECT_FLOW_KINDS.map((flow) => [flow, { direct }])) as FlowPreferences;
}

/** On unless a flow is turned off: untouched flows follow the product default, which connects directly. */
export function readDirectConnectionsEnabled(preferences: PeerMediationPreferencesV1): boolean {
    return DIRECT_FLOW_KINDS.every((flow) => preferences.flows[flow]?.direct !== 'disabled');
}

/** Off writes `disabled` for every flow; on returns every flow to the product default. */
export function withDirectConnectionsEnabled(
    preferences: PeerMediationPreferencesV1,
    enabled: boolean,
): PeerMediationPreferencesV1 {
    return { ...preferences, flows: enabled ? {} : flowsWith('disabled') };
}

export function readMachineDirectConnectionChoice(
    preferences: PeerMediationPreferencesV1,
    machineId: string,
): MachineDirectConnectionChoice {
    const flows = preferences.byMachineId[machineId]?.flows;
    if (!flows) return 'default';
    const values = DIRECT_FLOW_KINDS.map((flow) => flows[flow]?.direct ?? 'inherit');
    // Written only as a whole; a hand-edited mix reads as the stricter answer.
    if (values.includes('disabled')) return 'relay';
    if (values.includes('enabled')) return 'direct';
    return 'default';
}

export function withMachineDirectConnectionChoice(
    preferences: PeerMediationPreferencesV1,
    machineId: string,
    choice: MachineDirectConnectionChoice,
): PeerMediationPreferencesV1 {
    const { [machineId]: _previous, ...others } = preferences.byMachineId;
    if (choice === 'default') return { ...preferences, byMachineId: others };
    return {
        ...preferences,
        byMachineId: { ...others, [machineId]: { flows: flowsWith(choice === 'direct' ? 'enabled' : 'disabled') } },
    };
}
