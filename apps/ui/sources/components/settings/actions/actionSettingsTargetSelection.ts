import { applyActionPolicyMutation } from '@happier-dev/protocol/actions/actionAudiencePolicy';
import { isActionEnabledByActionsSettings, isActionSettingsOptInPlacement, type ActionSettingsActionId, type ActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';

import {
    resolveActionSettingsTargetDefinition,
    type ActionSettingsTargetDefinition,
    type ActionSettingsTargetId,
} from './actionSettingsTargetDefinitions';

export function getActionSettingsTargetPreferenceSelected(params: Readonly<{
    settings: ActionsSettingsV1;
    actionId: ActionSettingsActionId;
    targetId: ActionSettingsTargetId;
    target?: ActionSettingsTargetDefinition;
}>): boolean {
    // Selection is a hot read path. Its typed callers already crossed the settings
    // normalization boundary, so reparsing here multiplies full-document work by every target.
    const target = resolveActionSettingsTargetDefinition(params);
    const actionEntry = params.settings.actions[params.actionId];

    if (target.kind === 'placement') {
        if (isActionSettingsOptInPlacement(target.placement)) {
            return actionEntry?.enabledPlacements.includes(target.placement) === true;
        }
        return actionEntry?.disabledPlacements.includes(target.placement) !== true;
    }

    if (target.surface === 'foreign_session_html') return isActionEnabledByActionsSettings(
        params.actionId, params.settings, { surface: 'ui', callerSurface: target.surface },
    );
    return actionEntry?.disabledSurfaces.includes(target.surface) !== true;
}

/** The selection a target has when its Action carries no choice of its own (opt-in placements start off). */
export function getActionSettingsTargetDefaultSelected(params: Readonly<{
    settings: ActionsSettingsV1;
    actionId: ActionSettingsActionId;
    targetId: ActionSettingsTargetId;
    target?: ActionSettingsTargetDefinition;
}>): boolean {
    const { [params.actionId]: _ownChoice, ...actions } = params.settings.actions;
    return getActionSettingsTargetPreferenceSelected({ ...params, settings: { ...params.settings, actions } });
}

export function getActionSettingsTargetSelected(params: Readonly<{
    settings: ActionsSettingsV1;
    actionId: ActionSettingsActionId;
    targetId: ActionSettingsTargetId;
    target?: ActionSettingsTargetDefinition;
}>): boolean {
    if (params.settings.actions[params.actionId]?.enabled === false) {
        return false;
    }

    return getActionSettingsTargetPreferenceSelected(params);
}

export function setActionEnabled(params: Readonly<{
    settings: ActionsSettingsV1;
    actionId: ActionSettingsActionId;
    enabled: boolean;
}>): ActionsSettingsV1 {
    return applyActionPolicyMutation(params.settings, {
        actionId: params.actionId, change: { kind: 'enabled', enabled: params.enabled },
    }).settings;
}

export function setActionTargetSelected(params: Readonly<{
    settings: ActionsSettingsV1;
    actionId: ActionSettingsActionId;
    targetId: ActionSettingsTargetId;
    target?: ActionSettingsTargetDefinition;
    selected: boolean;
}>): ActionsSettingsV1 {
    const target = resolveActionSettingsTargetDefinition(params);
    return applyActionPolicyMutation(params.settings, {
        actionId: params.actionId,
        change: target.kind === 'placement'
            ? { kind: 'placement', placement: target.placement, enabled: params.selected }
            : { kind: 'audience_enabled', audience: target.surface, enabled: params.selected },
    }).settings;
}
