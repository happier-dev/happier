import { pluginActionRequiresPresentUserIntent, pluginActionConfirmationDependsOnInput } from '@happier-dev/protocol/plugins/actions/invocation';
import { hasInputDependentAgentApprovalDefaultV1, resolveActionApprovalRouting, type ActionApprovalPolicyScopeV1 } from '@happier-dev/protocol/actions/actionApprovalPolicy';
import { setActionAudiencePolicy } from '@happier-dev/protocol/actions/actionAudiencePolicy';
import { readScopedActionApprovalPreference, setScopedActionApprovalPreference, setActionApprovalOverride,
    actionPolicyAudienceContextV1, type ActionApprovalScopeV1, type ActionSettingsActionId, type ActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';

import { scmRemotePreferenceAsks } from '@/sync/domains/settings/actionsSettings';
import { normalizeScmRemoteConfirmPolicy } from '@/scm/settings/remoteConfirmationPolicy';
import { ActionIdSchema } from '@happier-dev/protocol/actions/actionIds';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { normalizeActionsSettings } from './normalizeActionsSettings';
import {
    resolveActionSettingsTargetDefinition,
    isVoiceTargetId,
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

/** Execution policy is distinct from the placement's visibility control. */
export function resolveActionSettingsExecutionSurface(
    actionId: ActionSettingsActionId,
    targetId: ActionSettingsTargetId,
    target?: ActionSettingsTargetDefinition,
): ReturnType<typeof actionPolicyAudienceContextV1>['surface'] {
    const resolvedTarget = resolveActionSettingsTargetDefinition({ actionId, targetId, target });
    return resolvedTarget.kind === 'surface' ? actionPolicyAudienceContextV1(resolvedTarget.surface).surface
        : isVoiceTargetId(resolvedTarget.id) ? 'voice' : 'ui';
}

/**
 * What the canonical Actions approval policy answers for this target with these
 * settings — the confirmation the runtime will actually apply, not a settings-local
 * restatement of it.
 *
 * Every `ui` target on this screen is an in-app surface, and the app's own Action
 * executor admits those invocations with `authority: 'present_user'` and a host caller
 * (`sync/api/session/sessionAccessApi.ts`, `sync/ops/actions/defaultActionExecutor.ts`).
 * The row and preference serializer must supply that same attribution: own reversible
 * UI actions default direct, while irreversible effects and explicit Ask remain
 * governed by the shared policy. Other surfaces do not acquire host authority here.
 * The canonical policy also determines whether a waiver can change confirmation.
 */
export function getActionTargetApprovalRequired(params: Readonly<{
    settings: ActionsSettingsV1;
    scope?: ActionApprovalScopeV1;
    actionId: ActionSettingsActionId;
    targetId: ActionSettingsTargetId;
    target?: ActionSettingsTargetDefinition;
}>): boolean {
    return getActionTargetApprovalPolicy(params).approvalRequiredByPolicy;
}

/**
 * Projects effective confirmation and whether a waiver can change it from the shared policy. The Source
 * Control preference (`scmRemoteConfirmPolicy`) is the UI default of remote pull and push, so it is part of
 * the answer; `approvalAskedBySourceControl` names the case where it, and nothing in the Actions policy,
 * makes the inherited default ask. `approvalAskedForInput` names a declared input consequence the
 * inherited default still asks for.
 */
export function getActionTargetApprovalPolicy(params: Readonly<{
    settings: ActionsSettingsV1;
    scope?: ActionApprovalScopeV1;
    approvalScope?: ActionApprovalPolicyScopeV1;
    actionId: ActionSettingsActionId;
    targetId: ActionSettingsTargetId;
    target?: ActionSettingsTargetDefinition;
    scmRemoteConfirmPolicy?: unknown;
}>): Readonly<{ approvalRequiredByPolicy: boolean; approvalWaivable: boolean; approvalAskedBySourceControl: boolean;
    approvalAskedForInput?: true }> {
    const normalizedSettings = normalizeActionsSettings(params.settings);
    const surface = resolveActionSettingsExecutionSurface(params.actionId, params.targetId, params.target);
    const foreign = params.targetId === 'foreign_session_html';
    const context: NonNullable<Parameters<typeof resolveActionApprovalRouting>[0]['context']> = {
        surface,
        ...(foreign ? { authority: 'account_automation' as const, callerSurface: 'foreign_session_html' as const }
            : surface === 'ui' ? { authority: 'present_user' as const, actionCaller: { kind: 'host' as const } } : {}),
    };
    // The same manifest default used by the daemon's contributed Action gate.
    const contributedApprovalDefault = params.target?.contributedAction
        ? pluginActionRequiresPresentUserIntent(params.target.contributedAction, surface, undefined, context.authority)
        : undefined;
    const waivedSettings = foreign ? setActionAudiencePolicy(normalizedSettings, params.actionId,
        'foreign_session_html', 'allowed') : params.scope ? setScopedActionApprovalPreference({
        settings: normalizedSettings, actionId: params.actionId, surface, scope: params.scope, mode: 'waived',
    }) : setActionApprovalOverride({
        settings: normalizedSettings,
        actionId: params.actionId,
        surface,
        approvalRequired: false,
    });
    const hostId = ActionIdSchema.safeParse(params.actionId);
    const spec = getActionSpec(hostId.success ? hostId.data : 'action.invoke');
    const requiredBy = (actionsSettingsV1: ActionsSettingsV1, scmRemoteConfirmPolicy: unknown) => {
        const routing = resolveActionApprovalRouting({
            actionId: spec.id, profileActionId: params.actionId, spec, settings: actionsSettingsV1, context,
            approvalScope: params.approvalScope ?? params.scope,
            ...(contributedApprovalDefault === undefined ? {} : {
                defaultConfirmation: contributedApprovalDefault, defaultUiConfirmation: contributedApprovalDefault,
            }),
        });
        return routing.required || routing.uiConfirmationRequired === true
            || scmRemotePreferenceAsks(params.actionId, { actionsSettingsV1, scmRemoteConfirmPolicy: normalizeScmRemoteConfirmPolicy(scmRemoteConfirmPolicy) }, context);
    };
    const approvalRequiredByPolicy = requiredBy(normalizedSettings, params.scmRemoteConfirmPolicy);
    return {
        approvalRequiredByPolicy,
        approvalWaivable: !requiredBy(waivedSettings, params.scmRemoteConfirmPolicy),
        approvalAskedBySourceControl: approvalRequiredByPolicy && !requiredBy(normalizedSettings, 'never'),
        // Input-dependent defaults cannot represent an explicit Ask or Allowed choice.
        ...(hasInputDependentAgentApprovalDefaultV1(params.actionId, context)
            || surface === 'ui' && spec.approvalPolicy?.uiConfirmationForInput !== undefined
            || params.target?.contributedAction && pluginActionConfirmationDependsOnInput(
                params.target.contributedAction, surface, context.authority)
            ? { approvalAskedForInput: true as const } : {}),
    };
}

/**
 * Reads the persisted setting, rather than its effective policy result. The
 * settings UI needs this distinction so a person can restore the canonical
 * default after explicitly requiring or waiving approval.
 */
export function getActionTargetApprovalOverride(params: Readonly<{
    settings: ActionsSettingsV1;
    scope?: ActionApprovalScopeV1;
    actionId: ActionSettingsActionId;
    targetId: ActionSettingsTargetId;
    target?: ActionSettingsTargetDefinition;
}>): boolean | null {
    const normalizedSettings = normalizeActionsSettings(params.settings);
    const surface = resolveActionSettingsApprovalSurface(params.actionId, params.targetId, params.target);
    if (!surface) return null;
    if (surface === 'foreign_session_html') {
        const mode = normalizedSettings.callerSurfacePolicies?.foreign_session_html?.[params.actionId];
        return mode === 'ask_first' ? true : mode === 'allowed' ? false : null;
    }
    if (params.scope) {
        const scoped = readScopedActionApprovalPreference(normalizedSettings, params.actionId, params.scope);
        return scoped?.approvalRequiredSurfaces.includes(surface) ? true
            : scoped?.approvalWaivedSurfaces.includes(surface) ? false : null;
    }
    if (normalizedSettings.actions[params.actionId]?.approvalRequiredSurfaces.includes(surface)) return true;
    if (normalizedSettings.approvalWaivedSurfaces?.[params.actionId]?.includes(surface)) return false;
    return null;
}

export function setActionTargetApprovalRequired(params: Readonly<{
    settings: ActionsSettingsV1;
    scope?: ActionApprovalScopeV1;
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
    if (surface === 'foreign_session_html') return setActionAudiencePolicy(
        normalizedSettings, params.actionId, surface,
        params.approvalRequired === null ? 'default' : params.approvalRequired ? 'ask_first' : 'allowed',
    );

    const approvalRequired = params.approvalRequired === false && !getActionTargetApprovalPolicy(params).approvalWaivable
        ? null : params.approvalRequired;
    if (params.scope) return setScopedActionApprovalPreference({
        settings: normalizedSettings, actionId: params.actionId, scope: params.scope, surface,
        mode: approvalRequired === true ? 'required' : approvalRequired === false ? 'waived' : 'inherit',
    });
    return setActionApprovalOverride({
        settings: normalizedSettings,
        actionId: params.actionId,
        surface,
        approvalRequired,
    });
}
