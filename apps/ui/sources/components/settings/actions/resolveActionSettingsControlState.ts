import type { ActionId, ActionSurfaces, ActionsSettingsV1 } from '@happier-dev/protocol';

import { getActionSettingsTargetPreferenceSelected, setActionTargetSelected } from './actionSettingsTargetSelection';
import {
    getActionTargetApprovalRequired,
    isActionSettingsApprovalAction,
    resolveActionSettingsApprovalSurface,
    setActionTargetApprovalRequired,
} from './actionSettingsTargetApproval';
import type { ActionSettingsTargetId } from './actionSettingsTargetDefinitions';

export type ActionSettingsApprovalControlValue = 'off' | 'ask_first' | 'allowed';
export type ActionSettingsBooleanControlValue = 'off' | 'on';
export type ActionSettingsTargetControlKind = 'approval' | 'switch' | 'unavailable';

export type ActionSettingsTargetControlState =
    | Readonly<{
        kind: 'approval';
        value: ActionSettingsApprovalControlValue;
        approvalSurface: keyof ActionSurfaces;
    }>
    | Readonly<{
        kind: 'switch';
        value: ActionSettingsBooleanControlValue;
    }>
    | Readonly<{
        kind: 'unavailable';
        value: 'off';
    }>;

type ResolveActionSettingsTargetControlStateParams = Readonly<{
    settings: ActionsSettingsV1;
    actionId: ActionId;
    targetId: ActionSettingsTargetId;
    available?: boolean;
}>;

type ApplyActionSettingsTargetControlStateParams = Readonly<{
    settings: ActionsSettingsV1;
    actionId: ActionId;
    targetId: ActionSettingsTargetId;
    value: ActionSettingsApprovalControlValue | ActionSettingsBooleanControlValue;
}>;

function resolveApprovalControlSurface(params: Readonly<{
    actionId: ActionId;
    targetId: ActionSettingsTargetId;
    available: boolean;
}>): keyof ActionSurfaces | null {
    if (!params.available || isActionSettingsApprovalAction(params.actionId)) {
        return null;
    }
    return resolveActionSettingsApprovalSurface(params.actionId, params.targetId);
}

export function resolveActionSettingsTargetControlState(
    params: ResolveActionSettingsTargetControlStateParams,
): ActionSettingsTargetControlState {
    const available = params.available !== false;
    if (!available) {
        return { kind: 'unavailable', value: 'off' };
    }

    const selected = getActionSettingsTargetPreferenceSelected({
        settings: params.settings,
        actionId: params.actionId,
        targetId: params.targetId,
    });
    const approvalSurface = resolveApprovalControlSurface({
        actionId: params.actionId,
        targetId: params.targetId,
        available,
    });

    if (!approvalSurface) {
        return {
            kind: 'switch',
            value: selected ? 'on' : 'off',
        };
    }

    if (!selected) {
        return {
            kind: 'approval',
            value: 'off',
            approvalSurface,
        };
    }

    return {
        kind: 'approval',
        value: getActionTargetApprovalRequired({
            settings: params.settings,
            actionId: params.actionId,
            targetId: params.targetId,
        }) ? 'ask_first' : 'allowed',
        approvalSurface,
    };
}

export function applyActionSettingsTargetControlState(params: ApplyActionSettingsTargetControlStateParams): ActionsSettingsV1 {
    if (params.value === 'off') {
        const next = setActionTargetSelected({
            settings: params.settings,
            actionId: params.actionId,
            targetId: params.targetId,
            selected: false,
        });
        return setActionTargetApprovalRequired({
            settings: next,
            actionId: params.actionId,
            targetId: params.targetId,
            approvalRequired: false,
        });
    }

    if (params.value === 'ask_first') {
        const selected = setActionTargetSelected({
            settings: params.settings,
            actionId: params.actionId,
            targetId: params.targetId,
            selected: true,
        });
        if (isActionSettingsApprovalAction(params.actionId) || !resolveActionSettingsApprovalSurface(params.actionId, params.targetId)) {
            return selected;
        }
        return setActionTargetApprovalRequired({
            settings: selected,
            actionId: params.actionId,
            targetId: params.targetId,
            approvalRequired: true,
        });
    }

    if (params.value === 'allowed') {
        const selected = setActionTargetSelected({
            settings: params.settings,
            actionId: params.actionId,
            targetId: params.targetId,
            selected: true,
        });
        return setActionTargetApprovalRequired({
            settings: selected,
            actionId: params.actionId,
            targetId: params.targetId,
            approvalRequired: false,
        });
    }

    return setActionTargetSelected({
        settings: params.settings,
        actionId: params.actionId,
        targetId: params.targetId,
        selected: true,
    });
}
