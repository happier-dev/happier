import {
    ActionIdSchema,
    isAgentInitiatedApprovalRequiredByDefault,
    type ActionId,
    type ActionSettingsActionId,
    type ActionSurfaces,
    type ActionsSettingsV1,
} from '@happier-dev/protocol';

import { getActionSettingsTargetPreferenceSelected, setActionTargetSelected } from './actionSettingsTargetSelection';
import {
    getActionTargetApprovalRequired,
    isActionSettingsApprovalAction,
    resolveActionSettingsApprovalSurface,
    setActionTargetApprovalRequired,
} from './actionSettingsTargetApproval';
import type { ActionSettingsTargetDefinition, ActionSettingsTargetId } from './actionSettingsTargetDefinitions';

export type ActionSettingsApprovalControlValue = 'off' | 'ask_first' | 'allowed';
export type ActionSettingsBooleanControlValue = 'off' | 'on';
export type ActionSettingsTargetControlKind = 'approval' | 'switch' | 'unavailable';

export type ActionSettingsTargetControlState =
    | Readonly<{
        kind: 'approval';
        value: ActionSettingsApprovalControlValue;
        approvalSurface: keyof ActionSurfaces;
        /**
         * True when this action is floored by the agent danger/egress policy on `agent`
         * (CON-5). The settings UI must display the EFFECTIVE floor: it clamps the value to
         * `ask_first` and forbids the `allowed` option, since a floored action can never run on the
         * agent surface without human consent.
         */
        floored: boolean;
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
    actionId: ActionSettingsActionId;
    targetId: ActionSettingsTargetId;
    target?: ActionSettingsTargetDefinition;
    available?: boolean;
}>;

type ApplyActionSettingsTargetControlStateParams = Readonly<{
    settings: ActionsSettingsV1;
    actionId: ActionSettingsActionId;
    targetId: ActionSettingsTargetId;
    target?: ActionSettingsTargetDefinition;
    value: ActionSettingsApprovalControlValue | ActionSettingsBooleanControlValue;
}>;

function resolveApprovalControlSurface(params: Readonly<{
    actionId: ActionSettingsActionId;
    targetId: ActionSettingsTargetId;
    target?: ActionSettingsTargetDefinition;
    available: boolean;
}>): keyof ActionSurfaces | null {
    if (!params.available || isActionSettingsApprovalAction(params.actionId)) {
        return null;
    }
    return resolveActionSettingsApprovalSurface(params.actionId, params.targetId, params.target);
}

function isHostActionId(actionId: ActionSettingsActionId): actionId is ActionId {
    return ActionIdSchema.safeParse(actionId).success;
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

    // CON-5: the EFFECTIVE agent floor. On `agent`, a danger/egress-floored action can never
    // run without human consent, so the settings UI must never present it as `allowed`. We clamp to
    // `ask_first` and surface `floored: true` so the control disables the `allowed` option. We reuse
    // the canonical policy predicate (no duplicated floor list).
    const floored = isHostActionId(params.actionId)
        && approvalSurface === 'agent'
        && isAgentInitiatedApprovalRequiredByDefault(params.actionId);

    if (!selected) {
        return {
            kind: 'approval',
            value: 'off',
            approvalSurface,
            floored,
        };
    }

    const persistedApprovalRequired = getActionTargetApprovalRequired({
        settings: params.settings,
        actionId: params.actionId,
        targetId: params.targetId,
        ...(params.target ? { target: params.target } : {}),
    });

    return {
        kind: 'approval',
        value: floored || persistedApprovalRequired ? 'ask_first' : 'allowed',
        approvalSurface,
        floored,
    };
}

export function applyActionSettingsTargetControlState(params: ApplyActionSettingsTargetControlStateParams): ActionsSettingsV1 {
    if (params.value === 'off') {
        const next = setActionTargetSelected({
            settings: params.settings,
            actionId: params.actionId,
            targetId: params.targetId,
            ...(params.target ? { target: params.target } : {}),
            selected: false,
        });
        return setActionTargetApprovalRequired({
            settings: next,
            actionId: params.actionId,
            targetId: params.targetId,
            ...(params.target ? { target: params.target } : {}),
            approvalRequired: false,
        });
    }

    if (params.value === 'ask_first') {
        const selected = setActionTargetSelected({
            settings: params.settings,
            actionId: params.actionId,
            targetId: params.targetId,
            ...(params.target ? { target: params.target } : {}),
            selected: true,
        });
        if (isActionSettingsApprovalAction(params.actionId) || !resolveActionSettingsApprovalSurface(
            params.actionId,
            params.targetId,
            params.target,
        )) {
            return selected;
        }
        return setActionTargetApprovalRequired({
            settings: selected,
            actionId: params.actionId,
            targetId: params.targetId,
            ...(params.target ? { target: params.target } : {}),
            approvalRequired: true,
        });
    }

    if (params.value === 'allowed') {
        const selected = setActionTargetSelected({
            settings: params.settings,
            actionId: params.actionId,
            targetId: params.targetId,
            ...(params.target ? { target: params.target } : {}),
            selected: true,
        });
        // CON-5: a floored action can never be `allowed` on `agent`. If a caller still
        // attempts to write `allowed` (e.g. a stale control), clamp the persisted state to
        // approval-required rather than silently dropping the floor (fail-closed).
        const approvalSurface = resolveActionSettingsApprovalSurface(params.actionId, params.targetId, params.target);
        const floored = isHostActionId(params.actionId)
            && approvalSurface === 'agent'
            && isAgentInitiatedApprovalRequiredByDefault(params.actionId);
        return setActionTargetApprovalRequired({
            settings: selected,
            actionId: params.actionId,
            targetId: params.targetId,
            ...(params.target ? { target: params.target } : {}),
            approvalRequired: floored,
        });
    }

    return setActionTargetSelected({
        settings: params.settings,
        actionId: params.actionId,
        targetId: params.targetId,
        ...(params.target ? { target: params.target } : {}),
        selected: true,
    });
}
