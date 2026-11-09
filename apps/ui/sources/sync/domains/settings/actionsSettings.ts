import type { ActionId} from '@happier-dev/protocol/actions/actionIds';
import type { ActionSettingsActionId } from '@happier-dev/protocol/actions/actionSettings';
import { isActionEnabledByActionsSettings, normalizeActionsSettingsV1, type ActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
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
    ctx?: Readonly<{ surface?: string | null; placement?: string | null }>,
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

/**
 * The person's Source Control preference (`scmRemoteConfirmPolicy`, kept from 0.2) is the UI default
 * confirmation of the remote pull and push Actions. It is a default like the protocol's own: a present
 * person's UI press asks once, in place, unless the person already answered this exact press in a dialog
 * of their own (`presentUserConfirmation`) or set the Action to Allowed. An explicit Ask first stays the
 * Action policy's own approval, so the two never stack.
 */
function scmRemotePreferenceAsks(
    actionId: ActionSettingsActionId,
    accountSettings: ActionSettingsAccountSnapshot | null | undefined,
    ctx: ApprovalContext,
): boolean {
    const kind = actionId === 'scm.remote.pull' ? 'pull' : actionId === 'scm.remote.push' ? 'push' : null;
    if (!kind || ctx?.surface !== 'ui' || ctx.authority !== 'present_user') return false;
    if (ctx.presentUserConfirmation?.actionId === actionId) return false;
    if (resolveActionsSettingsV1FromState({ settings: accountSettings }).approvalWaivedSurfaces?.[actionId]?.includes('ui')) return false;
    return shouldConfirmRemoteOperation(normalizeScmRemoteConfirmPolicy(accountSettings?.scmRemoteConfirmPolicy), kind);
}

/**
 * Whether an Action invocation needs approval under the person's Account settings: the Action policy
 * (Settings → Actions) plus the Source Control preference as the remote Actions' UI default. The one
 * resolver for the executor's approval hook and every UI prediction of it.
 */
export function isActionApprovalRequiredByAccountSettings(
    actionId: ActionSettingsActionId,
    accountSettings: ActionSettingsAccountSnapshot | null | undefined,
    ctx: ApprovalContext,
    options?: Readonly<{ defaultSafety?: Parameters<typeof isApprovalRequiredByActionsSettings>[3]; defaultUiConfirmation?: boolean; contributedApprovalDefault?: boolean; input?: unknown;
      approvedOperation?: Parameters<typeof isApprovalRequiredByActionsSettings>[8]; approvalScope?: Parameters<typeof isApprovalRequiredByActionsSettings>[9] }>,
): boolean {
    return isApprovalRequiredByActionsSettings(
        actionId, resolveActionsSettingsV1FromState({ settings: accountSettings }), ctx,
        options?.defaultSafety, options?.contributedApprovalDefault, options?.input, options?.defaultUiConfirmation,
        undefined, options?.approvedOperation, options?.approvalScope,
    ) || scmRemotePreferenceAsks(actionId, accountSettings, ctx);
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
