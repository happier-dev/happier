import type { ActionSettingsTargetId } from './actionSettingsTargets';

const UI_APP_UNSUPPORTED_ACTION_TARGET_IDS = new Set<ActionSettingsTargetId>([
    'session_header',
    'run_list',
    'run_card',
]);

export function isActionSettingsTargetSupportedInUiApp(targetId: ActionSettingsTargetId): boolean {
    return !UI_APP_UNSUPPORTED_ACTION_TARGET_IDS.has(targetId);
}
