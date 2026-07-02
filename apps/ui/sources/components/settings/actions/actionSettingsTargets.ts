import type { ActionSettingsTargetId } from './actionSettingsTargetDefinitions';

export {
    getActionSettingsTargetContext,
    getActionSettingsTargetDefinition,
    isRunScopedPlacement,
    isVoiceTargetId,
    listActionSettingsTargetDefinitions,
    type ActionSettingsTargetCategory,
    type ActionSettingsTargetDefinition,
    type ActionSettingsTargetId,
} from './actionSettingsTargetDefinitions';
export {
    getActionSettingsTargetSelected,
    setActionEnabled,
    setActionTargetSelected,
} from './actionSettingsTargetSelection';
export {
    resolveActionSettingsToolExposureState,
    setActionSettingsToolExposureMode,
    type ActionSettingsToolExposureControlValue,
    type ActionSettingsToolExposureState,
} from './actionSettingsToolExposure';
export {
    getActionTargetApprovalRequired,
    isActionSettingsApprovalAction,
    resolveActionSettingsApprovalSurface,
    setActionTargetApprovalRequired,
} from './actionSettingsTargetApproval';
export {
    applyActionSettingsTargetControlState,
    resolveActionSettingsTargetControlState,
    type ActionSettingsApprovalControlValue,
    type ActionSettingsBooleanControlValue,
    type ActionSettingsTargetControlKind,
    type ActionSettingsTargetControlState,
} from './resolveActionSettingsControlState';

export function isMcpTarget(targetId: ActionSettingsTargetId): boolean {
    return targetId === 'mcp';
}
