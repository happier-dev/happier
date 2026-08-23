import type { ActionSettingsActionId, ActionsSettingsV1 } from '@happier-dev/protocol';

import { normalizeActionsSettings } from './normalizeActionsSettings';
import {
    resolveActionSettingsTargetDefinition,
    type ActionSettingsSurface,
    type ActionSettingsTargetDefinition,
    type ActionSettingsTargetId,
} from './actionSettingsTargetDefinitions';
import {
    getMutableActionSettingsEntry,
    sortUniqueActionSettingsValues,
    writeActionSettingsEntry,
} from './actionSettingsTargetSelection';

export function isActionSettingsApprovalAction(actionId: ActionSettingsActionId): boolean {
    return actionId === 'approval.request.create' || actionId === 'approval.request.decide';
}

export function resolveActionSettingsApprovalSurface(
    actionId: ActionSettingsActionId,
    targetId: ActionSettingsTargetId,
    target?: ActionSettingsTargetDefinition,
): ActionSettingsSurface | null {
    const resolvedTarget = resolveActionSettingsTargetDefinition({ actionId, targetId, target });
    if (resolvedTarget.kind === 'surface') {
        return resolvedTarget.surface;
    }

    if (resolvedTarget.kind === 'placement' && resolvedTarget.placement === 'slash_command') {
        return 'ui';
    }

    return null;
}

export function getActionTargetApprovalRequired(params: Readonly<{
    settings: ActionsSettingsV1;
    actionId: ActionSettingsActionId;
    targetId: ActionSettingsTargetId;
    target?: ActionSettingsTargetDefinition;
}>): boolean {
    const normalizedSettings = normalizeActionsSettings(params.settings);
    const entry = normalizedSettings.actions[params.actionId];
    if (!entry) {
        return false;
    }

    const surface = resolveActionSettingsApprovalSurface(params.actionId, params.targetId, params.target);
    if (!surface) {
        return false;
    }

    return entry.approvalRequiredSurfaces?.includes(surface) === true;
}

export function setActionTargetApprovalRequired(params: Readonly<{
    settings: ActionsSettingsV1;
    actionId: ActionSettingsActionId;
    targetId: ActionSettingsTargetId;
    target?: ActionSettingsTargetDefinition;
    approvalRequired: boolean;
}>): ActionsSettingsV1 {
    const normalizedSettings = normalizeActionsSettings(params.settings);
    const entry = getMutableActionSettingsEntry(normalizedSettings, params.actionId);
    const surface = resolveActionSettingsApprovalSurface(params.actionId, params.targetId, params.target);
    if (!surface) {
        return normalizedSettings;
    }

    entry.approvalRequiredSurfaces = params.approvalRequired
        ? sortUniqueActionSettingsValues([...entry.approvalRequiredSurfaces, surface])
        : entry.approvalRequiredSurfaces.filter((value) => value !== surface);

    return writeActionSettingsEntry(normalizedSettings, params.actionId, entry);
}
