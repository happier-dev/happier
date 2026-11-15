import { SCM_REMOTE_PUSH_ACTION_ID_V1, type ActionId } from '@happier-dev/protocol/actions/actionIds';
import type { ActionSettingsActionId } from '@happier-dev/protocol/actions/actionSettings';
import { isActionEnabledByActionsSettings, normalizeActionsSettingsV1, type ActionEnablementContext, type ActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { isApprovalRequiredByActionsSettings } from '@happier-dev/protocol/actions/actionApprovalPolicy';

import { isExecutionRunsFeatureAction } from '@/sync/domains/actions/isExecutionRunsFeatureAction';
import { resolveLocalFeaturePolicyEnabled } from '@/sync/domains/features/featureLocalPolicy';
import { normalizeScmRemoteConfirmPolicy, shouldConfirmRemoteOperation } from '@/scm/settings/remoteConfirmationPolicy';
import { storage } from '@/sync/domains/state/storage';
import { settingsDefaults, type Settings } from './settings';

export type ActionSettingsAccountSnapshot = Readonly<Partial<Settings>>;
const defaultActionPolicy = normalizeActionsSettingsV1(undefined);
type ActionSettingsState = Readonly<{ settings?: ActionSettingsAccountSnapshot | null }>;

/** Account ingress admits policy; render and invocation consumers retain that admitted value. */
export function resolveActionsSettingsV1FromState(state: ActionSettingsState): ActionsSettingsV1 {
    return state.settings?.actionsSettingsV1 ?? defaultActionPolicy;
}

export function isActionEnabledInState(
    state: ActionSettingsState,
    actionId: ActionId,
    ctx?: ActionEnablementContext,
): boolean {
    const settingsState = {
        experiments: state.settings?.experiments ?? settingsDefaults.experiments,
        featureToggles: state.settings?.featureToggles ?? settingsDefaults.featureToggles,
    };
    if (isExecutionRunsFeatureAction(actionId) && !resolveLocalFeaturePolicyEnabled('execution.runs', settingsState)) {
        return false;
    }

    const settings = resolveActionsSettingsV1FromState(state);
    return isActionEnabledByActionsSettings(actionId, settings, ctx);
}

type ApprovalContext = Parameters<typeof isApprovalRequiredByActionsSettings>[2];

/** The person's Source Control preference (`scmRemoteConfirmPolicy`, kept from 0.2) asks for this remote Action on the UI. */
function scmRemotePreferenceDefaultAsk(actionId: ActionSettingsActionId, accountSettings: ActionSettingsAccountSnapshot | null | undefined): boolean {
    const kind = actionId === 'scm.remote.pull' ? 'pull' : actionId === SCM_REMOTE_PUSH_ACTION_ID_V1 ? 'push' : null;
    if (!kind) return false;
    if (resolveActionsSettingsV1FromState({ settings: accountSettings }).approvalWaivedSurfaces?.[actionId]?.includes('ui')) return false;
    return shouldConfirmRemoteOperation(normalizeScmRemoteConfirmPolicy(accountSettings?.scmRemoteConfirmPolicy), kind);
}

/**
 * The Source Control preference as the remote pull and push Actions' UI default, for Settings' inherited
 * answer: a present person's UI press asks once, in place, unless the person already answered this exact
 * press in a dialog of their own (`presentUserConfirmation`) or set the Action to Allowed.
 */
export function scmRemotePreferenceAsks(
    actionId: ActionSettingsActionId,
    accountSettings: ActionSettingsAccountSnapshot | null | undefined,
    ctx: ApprovalContext,
): boolean {
    if (ctx?.surface !== 'ui' || ctx.authority !== 'present_user') return false;
    if (ctx.presentUserConfirmation?.actionId === actionId) return false;
    return scmRemotePreferenceDefaultAsk(actionId, accountSettings);
}

/**
 * The Actions settings the UI host routes with: the person's Action policy plus the Source Control
 * preference as a UI Ask on remote pull and push (the shared router answers it in place for the
 * person's own press, and an exact confirmed press answers it).
 */
export function resolveExecutorActionsSettingsV1(accountSettings: ActionSettingsAccountSnapshot | null | undefined): ActionsSettingsV1 {
    const withScmAsk = (settings: ActionsSettingsV1, actionId: ActionSettingsActionId): ActionsSettingsV1 => {
        const row = settings.actions[actionId];
        if (!scmRemotePreferenceDefaultAsk(actionId, accountSettings) || row?.approvalRequiredSurfaces.includes('ui')) return settings;
        return normalizeActionsSettingsV1({ ...settings, actions: { ...settings.actions,
            [actionId]: { ...(row ?? {}), approvalRequiredSurfaces: [...(row?.approvalRequiredSurfaces ?? []), 'ui'] } } });
    };
    return withScmAsk(withScmAsk(resolveActionsSettingsV1FromState({ settings: accountSettings }), 'scm.remote.pull'),
        SCM_REMOTE_PUSH_ACTION_ID_V1);
}

/**
 * Whether an Action invocation needs approval under the person's Account settings, as the UI host's
 * router sees them (`resolveExecutorActionsSettingsV1`). The one resolver for every UI prediction.
 */
export function isActionApprovalRequiredByAccountSettings(
    actionId: ActionSettingsActionId,
    accountSettings: ActionSettingsAccountSnapshot | null | undefined,
    ctx: ApprovalContext,
    options?: Readonly<{ defaultSafety?: Parameters<typeof isApprovalRequiredByActionsSettings>[3]; defaultUiConfirmation?: boolean; contributedApprovalDefault?: boolean; input?: unknown;
      approvedOperation?: Parameters<typeof isApprovalRequiredByActionsSettings>[8]; approvalScope?: Parameters<typeof isApprovalRequiredByActionsSettings>[9] }>,
): boolean {
    return isApprovalRequiredByActionsSettings(
        actionId, resolveExecutorActionsSettingsV1(accountSettings), ctx,
        options?.defaultSafety, options?.contributedApprovalDefault, options?.input, options?.defaultUiConfirmation,
        undefined, options?.approvedOperation, options?.approvalScope,
    );
}

/** The person's own Ask-first policy for one Action on one invoking surface. */
export function isActionApprovalRequiredInState(
    state: ActionSettingsState,
    actionId: ActionSettingsActionId,
    ctx: ApprovalContext,
    contributedApprovalDefault?: boolean,
): boolean {
    return isActionApprovalRequiredByAccountSettings(
        actionId, state.settings, ctx, { contributedApprovalDefault });
}

/** A scoped control reads the same captured Home settings as the UI Action host. */
export async function isActionApprovalRequiredForHome(
    actionId: ActionId,
    ctx: Parameters<typeof isApprovalRequiredByActionsSettings>[2],
    serverId?: string | null,
): Promise<boolean> {
    if (!serverId) return isActionApprovalRequiredInState(storage.getState(), actionId, ctx);
    const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
    const account = await captureLazyActionAccountContext(serverId);
    try {
        const settings = await account.readSettings();
        account.assertCurrent();
        return isActionApprovalRequiredInState({ settings }, actionId, ctx);
    } finally {
        account.dispose();
    }
}
