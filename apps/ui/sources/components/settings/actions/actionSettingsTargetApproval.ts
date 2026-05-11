import type { ActionId, ActionsSettingsV1 } from '@happier-dev/protocol';

import { normalizeActionsSettings } from './normalizeActionsSettings';
import { getActionSettingsTargetDefinition, type ActionSettingsSurface, type ActionSettingsTargetId } from './actionSettingsTargetDefinitions';
import {
    getMutableActionSettingsEntry,
    sortUniqueActionSettingsValues,
    writeActionSettingsEntry,
} from './actionSettingsTargetSelection';

export function isActionSettingsApprovalAction(actionId: ActionId): boolean {
    return actionId === 'approval.request.create' || actionId === 'approval.request.decide';
}

export function resolveActionSettingsApprovalSurface(actionId: ActionId, targetId: ActionSettingsTargetId): ActionSettingsSurface | null {
    const target = getActionSettingsTargetDefinition(actionId, targetId);
    if (target.kind === 'surface') {
        return target.surface;
    }

    if (target.kind === 'placement' && target.placement === 'slash_command') {
        return 'ui';
    }

    return null;
}

export function getActionTargetApprovalRequired(params: Readonly<{
    settings: ActionsSettingsV1;
    actionId: ActionId;
    targetId: ActionSettingsTargetId;
}>): boolean {
    const normalizedSettings = normalizeActionsSettings(params.settings);
    const entry = normalizedSettings.actions[params.actionId];
    if (!entry) {
        return false;
    }

    const surface = resolveActionSettingsApprovalSurface(params.actionId, params.targetId);
    if (!surface) {
        return false;
    }

    return entry.approvalRequiredSurfaces?.includes(surface) === true;
}

export function setActionTargetApprovalRequired(params: Readonly<{
    settings: ActionsSettingsV1;
    actionId: ActionId;
    targetId: ActionSettingsTargetId;
    approvalRequired: boolean;
}>): ActionsSettingsV1 {
    const normalizedSettings = normalizeActionsSettings(params.settings);
    const entry = getMutableActionSettingsEntry(normalizedSettings, params.actionId);
    const surface = resolveActionSettingsApprovalSurface(params.actionId, params.targetId);
    if (!surface) {
        return normalizedSettings;
    }

    entry.approvalRequiredSurfaces = params.approvalRequired
        ? sortUniqueActionSettingsValues([...entry.approvalRequiredSurfaces, surface])
        : entry.approvalRequiredSurfaces.filter((value) => value !== surface);

    return writeActionSettingsEntry(normalizedSettings, params.actionId, entry);
}
