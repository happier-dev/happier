import { isApprovalRequiredByActionsSettings } from '@happier-dev/protocol/actions/actionApprovalPolicy';
import { pluginActionRequiresPresentUserIntent } from '@happier-dev/protocol/plugins/actions/invocation';
import { setActionApprovalOverride, type ActionSettingsActionId, type ActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';

import { normalizeActionsSettings } from './normalizeActionsSettings';
import {
    resolveActionSettingsTargetDefinition,
    type ActionSettingsSurface,
    type ActionSettingsTargetDefinition,
    type ActionSettingsTargetId,
} from './actionSettingsTargetDefinitions';

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

/**
 * What the canonical Actions approval policy answers for this target with these
 * settings — the confirmation the runtime will actually apply, not a settings-local
 * restatement of it.
 *
 * Every `ui` target on this screen is an in-app surface, and the app's own Action
 * executor admits those invocations with `authority: 'present_user'`
 * (`sync/api/session/sessionAccessApi.ts`, `sync/ops/actions/defaultActionExecutor.ts`).
 * The policy suppresses its dangerous-Action confirmation floor for that pair only
 * where the app hosts its own confirmation, and keeps it as the default where it
 * does not (Session responsibility assignment), so the row must ask with the same
 * authority the runtime supplies. The canonical policy also determines whether
 * an explicit waiver can change that confirmation.
 */
export function getActionTargetApprovalRequired(params: Readonly<{
    settings: ActionsSettingsV1;
    actionId: ActionSettingsActionId;
    targetId: ActionSettingsTargetId;
    target?: ActionSettingsTargetDefinition;
}>): boolean {
    return getActionTargetApprovalPolicy(params).approvalRequiredByPolicy;
}

/** Projects effective confirmation and whether a waiver can change it from the shared policy. */
export function getActionTargetApprovalPolicy(params: Readonly<{
    settings: ActionsSettingsV1;
    actionId: ActionSettingsActionId;
    targetId: ActionSettingsTargetId;
    target?: ActionSettingsTargetDefinition;
}>): Readonly<{ approvalRequiredByPolicy: boolean; approvalWaivable: boolean }> {
    const normalizedSettings = normalizeActionsSettings(params.settings);
    const surface = resolveActionSettingsApprovalSurface(params.actionId, params.targetId, params.target);
    if (!surface) {
        return { approvalRequiredByPolicy: false, approvalWaivable: false };
    }
    const context = {
        surface,
        ...(surface === 'ui' ? { authority: 'present_user' as const } : {}),
    };
    // The same manifest default used by the daemon's contributed Action gate.
    const contributedApprovalDefault = params.target?.contributedAction
        ? pluginActionRequiresPresentUserIntent(params.target.contributedAction, surface)
        : undefined;
    const waivedSettings = setActionApprovalOverride({
        settings: normalizedSettings,
        actionId: params.actionId,
        surface,
        approvalRequired: false,
    });
    return {
        approvalRequiredByPolicy: isApprovalRequiredByActionsSettings(params.actionId, normalizedSettings, context, undefined, contributedApprovalDefault),
        approvalWaivable: !isApprovalRequiredByActionsSettings(params.actionId, waivedSettings, context, undefined, contributedApprovalDefault),
    };
}

/**
 * Reads the persisted setting, rather than its effective policy result. The
 * settings UI needs this distinction so a person can restore the canonical
 * default after explicitly requiring or waiving approval.
 */
export function getActionTargetApprovalOverride(params: Readonly<{
    settings: ActionsSettingsV1;
    actionId: ActionSettingsActionId;
    targetId: ActionSettingsTargetId;
    target?: ActionSettingsTargetDefinition;
}>): boolean | null {
    const normalizedSettings = normalizeActionsSettings(params.settings);
    const surface = resolveActionSettingsApprovalSurface(params.actionId, params.targetId, params.target);
    if (!surface) return null;
    if (normalizedSettings.actions[params.actionId]?.approvalRequiredSurfaces.includes(surface)) return true;
    if (normalizedSettings.approvalWaivedSurfaces?.[params.actionId]?.includes(surface)) return false;
    return null;
}

export function setActionTargetApprovalRequired(params: Readonly<{
    settings: ActionsSettingsV1;
    actionId: ActionSettingsActionId;
    targetId: ActionSettingsTargetId;
    target?: ActionSettingsTargetDefinition;
    approvalRequired: boolean | null;
}>): ActionsSettingsV1 {
    const normalizedSettings = normalizeActionsSettings(params.settings);
    const surface = resolveActionSettingsApprovalSurface(params.actionId, params.targetId, params.target);
    if (!surface) {
        return normalizedSettings;
    }

    return setActionApprovalOverride({
        settings: normalizedSettings,
        actionId: params.actionId,
        surface,
        approvalRequired: params.approvalRequired === false && !getActionTargetApprovalPolicy(params).approvalWaivable
            ? null
            : params.approvalRequired,
    });
}
