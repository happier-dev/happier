import {
    type ActionSettingsActionId,
    type ActionsSettingsV1,
} from '@happier-dev/protocol/actions/actionSettings';
import { applyActionPolicyMutation } from '@happier-dev/protocol/actions/actionAudiencePolicy';
import { ActionPolicyInputSchemas, type ActionPolicySetInput } from '@happier-dev/protocol/actions/actionPolicyActionFamily';
import { ActionIdSchema } from '@happier-dev/protocol/actions/actionIds';
import { getActionSpec, resolveActionPermissionChangingV1 } from '@happier-dev/protocol/actions/actionSpecs';
import type { ActionApprovalScopeV1, ActionPolicyAudienceV1 } from '@happier-dev/protocol/actions/actionSettings';

import { getActionSettingsTargetPreferenceSelected } from './actionSettingsTargetSelection';
import {
    getActionTargetApprovalOverride,
    getActionTargetApprovalPolicy,
    isActionSettingsApprovalAction,
    resolveActionSettingsApprovalSurface,
    setActionTargetApprovalRequired,
} from './actionSettingsTargetApproval';
import { resolveActionSettingsTargetDefinition, type ActionSettingsTargetDefinition, type ActionSettingsTargetId } from './actionSettingsTargetDefinitions';

export type ActionSettingsApprovalControlValue = 'off' | 'default' | 'ask_first' | 'allowed';
export type ActionSettingsBooleanControlValue = 'off' | 'on';
export type ActionSettingsTargetControlKind = 'approval' | 'switch' | 'unavailable';

export type ActionApprovalLooseningNoticeData = Readonly<{ keepAskFirst: ActionPolicySetInput }>;

/** Settings, Machine and Environment presenters share metadata and exact-key revert DATA. */
export function resolveActionApprovalLooseningNoticeData(params: Readonly<{
    spec: Parameters<typeof resolveActionPermissionChangingV1>[0];
    admittedInput?: unknown;
    actionId: ActionSettingsActionId;
    audience: ActionPolicyAudienceV1;
    scope?: ActionApprovalScopeV1;
    mode: ActionSettingsApprovalControlValue;
    approvalRequiredByPolicy: boolean;
    approvalWaivable: boolean;
    /** The presenter's own Ask first intent, when it knows the inherited answer (Settings does). */
    keepAskFirst?: ActionPolicySetInput;
}>): ActionApprovalLooseningNoticeData | undefined {
    if (params.mode !== 'allowed' || params.approvalRequiredByPolicy || !params.approvalWaivable
        || !resolveActionPermissionChangingV1(params.spec, params.admittedInput)) return undefined;
    return { keepAskFirst: params.keepAskFirst ?? ActionPolicyInputSchemas['actions.policy.set'].parse({
        actionId: params.actionId, audience: params.audience,
        ...(params.scope ? { scope: params.scope } : {}), mode: 'ask_first' }) };
}

export type ActionSettingsTargetControlState =
    | Readonly<{
        kind: 'approval';
        /** The persisted choice: `default` means this target inherits the policy. */
        value: ActionSettingsApprovalControlValue;
        approvalSurface: ActionPolicyAudienceV1;
        /** Resource RPC has no approval continuation; Ask remains refused. */
        approvalPromptUnavailable?: true;
        /**
         * What the canonical Actions approval policy answers for this target with
         * these settings. `value` alone cannot say whether the inherited `default`
         * confirms, and readers must not re-derive that answer: an in-app target is
         * admitted with a present user and inherits no prompt, while the same
         * dangerous Action still confirms on Agent, MCP and CLI.
         */
        approvalRequiredByPolicy: boolean;
        /** Whether an explicit waiver actually suppresses confirmation on this surface. */
        approvalWaivable: boolean;
        /**
         * The inherited default asks only because the Source Control preference does (remote pull and push);
         * the row names that so `Default` is not read as "does not ask".
         */
        approvalAskedBySourceControl: boolean;
        permissionChanging?: true;
        approvalLooseningNotice?: ActionApprovalLooseningNoticeData;
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
    /** Scope comes from the admitted subject, never the ambient selected Machine. */
    scope?: ActionApprovalScopeV1;
    actionId: ActionSettingsActionId;
    targetId: ActionSettingsTargetId;
    target?: ActionSettingsTargetDefinition;
    available?: boolean;
    /** The Source Control preference, which is the UI default of the remote pull and push Actions. */
    scmRemoteConfirmPolicy?: unknown;
}>;

type ApplyActionSettingsTargetControlStateParams = Readonly<{
    settings: ActionsSettingsV1;
    scope?: ActionApprovalScopeV1;
    actionId: ActionSettingsActionId;
    targetId: ActionSettingsTargetId;
    target?: ActionSettingsTargetDefinition;
    value: ActionSettingsApprovalControlValue | ActionSettingsBooleanControlValue;
    scmRemoteConfirmPolicy?: unknown;
}>;

function resolveApprovalControlSurface(params: Readonly<{
    actionId: ActionSettingsActionId;
    targetId: ActionSettingsTargetId;
    target?: ActionSettingsTargetDefinition;
    available: boolean;
}>): ActionPolicyAudienceV1 | null {
    if (!params.available || isActionSettingsApprovalAction(params.actionId) || params.actionId === 'capture.view') {
        return null;
    }
    return resolveActionSettingsApprovalSurface(params.actionId, params.targetId, params.target);
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
        ...(params.target ? { target: params.target } : {}),
    });
    const approvalSurface = resolveApprovalControlSurface({
        actionId: params.actionId,
        targetId: params.targetId,
        target: params.target,
        available,
    });

    if (!approvalSurface) {
        return {
            kind: 'switch',
            value: selected ? 'on' : 'off',
        };
    }

    const approvalPolicy = getActionTargetApprovalPolicy({
        settings: params.settings,
        scope: params.scope,
        actionId: params.actionId,
        targetId: params.targetId,
        ...(params.target ? { target: params.target } : {}),
        scmRemoteConfirmPolicy: params.scmRemoteConfirmPolicy,
    });

    const hostId = ActionIdSchema.safeParse(params.actionId);
    const spec = hostId.success ? getActionSpec(hostId.data) : undefined;
    const permissionChanging = spec ? resolveActionPermissionChangingV1(spec) : false;
    const resourcePolicy = params.target?.resource ? { approvalPromptUnavailable: true as const } : {};
    if (!selected) {
        return {
            kind: 'approval',
            value: 'off',
            approvalSurface,
            ...(permissionChanging ? { permissionChanging: true as const } : {}),
            ...approvalPolicy,
            ...resourcePolicy,
        };
    }

    const approvalOverride = getActionTargetApprovalOverride({
        settings: params.settings,
        scope: params.scope,
        actionId: params.actionId,
        targetId: params.targetId,
        ...(params.target ? { target: params.target } : {}),
    });

    const value = !approvalPolicy.approvalWaivable ? 'ask_first'
        : approvalOverride === null ? 'default' : approvalOverride ? 'ask_first' : 'allowed';
    const inheritsGlobalWaiver = value === 'default' && params.scope !== undefined
        && getActionTargetApprovalOverride({ ...params, scope: undefined }) === false;
    const effectiveMode = inheritsGlobalWaiver ? 'allowed' : value;
    const approvalLooseningNotice = spec && effectiveMode === 'allowed' ? resolveActionApprovalLooseningNoticeData({
        spec, actionId: params.actionId, audience: approvalSurface, scope: params.scope,
        mode: effectiveMode, ...approvalPolicy,
        // Keep Ask first is the same choice as picking Ask first on this row: it restores inheritance
        // when the inherited answer already asks, and writes only this exact key.
        keepAskFirst: resolveActionSettingsTargetPolicyInput({ ...params, value: 'ask_first' }),
    }) : undefined;
    return {
        kind: 'approval',
        value,
        approvalSurface,
        ...(permissionChanging ? { permissionChanging: true as const } : {}),
        ...(approvalLooseningNotice ? { approvalLooseningNotice } : {}),
        ...approvalPolicy,
        ...resourcePolicy,
    };
}

/** Translate the displayed target choice into one admitted semantic policy intent. */
export function resolveActionSettingsTargetPolicyInput(params: ApplyActionSettingsTargetControlStateParams): ActionPolicySetInput {
    let value = params.value;
    if (params.targetId !== 'foreign_session_html' && (value === 'ask_first' || value === 'allowed')) {
        const inheritedSettings = setActionTargetApprovalRequired({ ...params, approvalRequired: null });
        const inheritedPolicy = getActionTargetApprovalPolicy({ ...params, settings: inheritedSettings });
        // Choosing the inherited answer restores inheritance, including after a waiver.
        if ((value === 'ask_first') === inheritedPolicy.approvalRequiredByPolicy) value = 'default';
    }
    const target = resolveActionSettingsTargetDefinition(params);
    if (params.scope) return ActionPolicyInputSchemas['actions.policy.set'].parse({
        actionId: params.actionId, scope: params.scope,
        audience: target.kind === 'surface' ? target.surface : undefined,
        mode: value === 'allowed' && !getActionTargetApprovalPolicy(params).approvalWaivable ? 'default' : value,
    });
    if (target.kind === 'surface') {
        if (value === 'on') return { actionId: params.actionId,
            change: { kind: 'audience_enabled', audience: target.surface, enabled: true } };
        const mode = value === 'allowed' && !getActionTargetApprovalPolicy(params).approvalWaivable ? 'default' : value;
        return { actionId: params.actionId, audience: target.surface, mode };
    }
    if (target.placement === 'slash_command' && value !== 'on') {
        return { actionId: params.actionId,
            change: { kind: 'placement_policy', placement: target.placement, mode: value } };
    }
    return { actionId: params.actionId,
        change: { kind: 'placement', placement: target.placement, enabled: value !== 'off' } };
}

export function applyActionSettingsTargetControlState(params: ApplyActionSettingsTargetControlStateParams): ActionsSettingsV1 {
    return applyActionPolicyMutation(params.settings, resolveActionSettingsTargetPolicyInput(params)).settings;
}
