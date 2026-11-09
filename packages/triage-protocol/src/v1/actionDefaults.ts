import {
    defineProtocolLiteral, defineProtocolObject, defineProtocolString, defineProtocolUnion,
    ProtocolLaunchProfileIdV2Schema,
    ProtocolLaunchProfilePlacementPreferenceV1Schema, ProtocolLaunchProfileCheckoutPreferenceV1Schema,
} from '@happier-dev/plugin-sdk/protocol';
import { TriageActionIdV1Schema, TriageActionLabelV1Schema } from './identity.js';
import { TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1 } from './bounds.js';

/** Save is an operation of the incumbent action-catalog writer. */
export const TRIAGE_SAVE_ACTION_DEFAULTS_ACTION_REF_V1 = Object.freeze({
    pluginId: TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1, localId: 'actions/administer-v1',
} as const);

export const TRIAGE_SAVE_ACTION_DEFAULTS_WORKSPACE_MODE_REASON_V1 = 'workspaceMode';

export const TriageSaveActionDefaultsInputV1Schema = defineProtocolObject({
    v: defineProtocolLiteral(1), kind: defineProtocolLiteral('saveDefaults'), actionId: TriageActionIdV1Schema,
    label: TriageActionLabelV1Schema,
    promptText: defineProtocolString(), profileId: ProtocolLaunchProfileIdV2Schema.nullable(),
    placement: ProtocolLaunchProfilePlacementPreferenceV1Schema,
    checkout: ProtocolLaunchProfileCheckoutPreferenceV1Schema,
    launchMode: defineProtocolUnion([defineProtocolLiteral('review'), defineProtocolLiteral('start')]),
}, { policy: 'closed' });
export type TriageSaveActionDefaultsInputV1 = ReturnType<typeof TriageSaveActionDefaultsInputV1Schema.parse>;

/** Read the saved Profile from the incumbent catalog writer's applied result. */
export function readTriageSavedActionDefaultProfileIdV1(value: unknown, actionId: string): string | undefined {
    if (value === null || typeof value !== 'object' || !('status' in value) || value.status !== 'applied'
        || !('actions' in value) || !Array.isArray(value.actions)) return undefined;
    const actions: readonly unknown[] = value.actions;
    for (const action of actions) {
        if (action === null || typeof action !== 'object' || !('actionId' in action) || action.actionId !== actionId
            || !('profileId' in action)) continue;
        const profileId = ProtocolLaunchProfileIdV2Schema.safeParse(action.profileId);
        return profileId.success ? profileId.data : undefined;
    }
    return undefined;
}
