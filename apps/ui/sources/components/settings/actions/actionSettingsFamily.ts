import {
    ACTION_ID_FAMILIES_V1,
    type ActionId,
    type ActionIdFamilyV1,
} from '@happier-dev/protocol';

import type { TranslationKey } from '@/text';

/**
 * Coarse, user-facing action family (FINALIZATION-PLAN §3.3). The action-settings UI groups
 * actions by these families so a user can scan and configure each runtime family (browser,
 * simulator, plugin, local-services, …) together — including the per-family enable + require-
 * approval controls that live on each grouped action's row/detail. This is a presentation
 * grouping derived from the canonical protocol taxonomy (`ACTION_ID_FAMILIES_V1`); it does NOT
 * introduce a second source of truth for action membership.
 */
export type ActionSettingsFamily =
    | 'browser'
    | 'simulator'
    | 'localServices'
    | 'plugins'
    | 'session'
    | 'scm'
    | 'general';

/**
 * Stable render order for family sections. Runtime families (the §3.3 focus) lead; `general`
 * (unclassified / cross-cutting) is always last.
 */
export const ACTION_SETTINGS_FAMILY_ORDER: readonly ActionSettingsFamily[] = [
    'browser',
    'simulator',
    'localServices',
    'plugins',
    'session',
    'scm',
    'general',
] as const;

export const ACTION_SETTINGS_FAMILY_TITLE_KEYS: Readonly<Record<ActionSettingsFamily, Extract<TranslationKey, `settingsActions.families.${string}.title`>>> = {
    browser: 'settingsActions.families.browser.title',
    simulator: 'settingsActions.families.simulator.title',
    localServices: 'settingsActions.families.localServices.title',
    plugins: 'settingsActions.families.plugins.title',
    session: 'settingsActions.families.session.title',
    scm: 'settingsActions.families.scm.title',
    general: 'settingsActions.families.general.title',
};

/**
 * Map a canonical protocol action-id family to its coarse user-facing settings family. Protocol
 * families not listed here fold into `general`.
 */
const PROTOCOL_FAMILY_TO_SETTINGS_FAMILY: Partial<Record<ActionIdFamilyV1, ActionSettingsFamily>> = {
    browser_control: 'browser',
    browser_diagnostics: 'browser',
    browser_context: 'browser',
    browser_automation: 'browser',
    browser_recording: 'browser',
    devices_simulator: 'simulator',
    local_services_inventory: 'localServices',
    local_services_launcher: 'localServices',
    local_services_preview: 'localServices',
    local_services_public_preview: 'localServices',
    local_services_actions: 'localServices',
    plugin_permission_grants: 'plugins',
    session_lifecycle: 'session',
    messaging: 'session',
    session_control: 'session',
    session_targeting: 'session',
    session_transcripts: 'session',
    session_permissions: 'session',
    external_sessions: 'session',
    scm_pull_request: 'scm',
    scm_repository: 'scm',
    scm_diff_summary: 'scm',
};

function buildActionIdFamilyIndex(): ReadonlyMap<ActionId, ActionSettingsFamily> {
    const index = new Map<ActionId, ActionSettingsFamily>();
    for (const [protocolFamily, actionIds] of Object.entries(ACTION_ID_FAMILIES_V1)) {
        const settingsFamily = PROTOCOL_FAMILY_TO_SETTINGS_FAMILY[protocolFamily as ActionIdFamilyV1];
        if (!settingsFamily) {
            continue;
        }
        for (const actionId of actionIds) {
            index.set(actionId as ActionId, settingsFamily);
        }
    }
    return index;
}

const ACTION_ID_FAMILY_INDEX = buildActionIdFamilyIndex();

/**
 * Resolve the coarse user-facing settings family for an action id. Unclassified ids fold into
 * `general` (never undefined) so the grouped list stays exhaustive.
 */
export function resolveActionSettingsFamily(actionId: ActionId): ActionSettingsFamily {
    return ACTION_ID_FAMILY_INDEX.get(actionId) ?? 'general';
}
