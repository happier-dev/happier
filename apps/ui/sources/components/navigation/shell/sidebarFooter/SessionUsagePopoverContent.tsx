import * as React from 'react';
import { useRouter } from 'expo-router';

import { getAgentCore, isBundledAgentId } from '@/agents/catalog/catalog';
import type { UsageSummary } from '@/components/hub/usage/useUsageSummary';
import type { AccountUsageResetsAction } from '@/components/settings/connectedServices/usage/AccountUsageFacts';
import type { ConnectedAccountIdentityPresenter } from '@/hooks/ui/useConnectedAccountIdentityPrivacy';
import { connectedServiceProfileKey } from '@/sync/domains/connectedServices/connectedServiceProfilePreferences';
import { isPoolUsageLimitSwitchEnabled } from '@/sync/domains/connectedServices/connectedServicePoolPolicy';
import type { ConnectedServiceQuotaGaugeViewModel } from '@/sync/domains/connectedServices/connectedServiceQuotaGauge';
import { resolveQuotaTone } from '@/sync/domains/connectedServices/resolveQuotaTone';
import { resolveSessionUsageAccount } from '@/sync/domains/connectedServices/resolveSessionUsageAccount';
import { useProfile } from '@/sync/store/hooks';
import { t } from '@/text';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import type { AccountProfile } from '@happier-dev/protocol/account/profile';
import type { ConnectedServiceAuthGroupPolicyV1 } from '@happier-dev/protocol/connect/connected-service-schemas';

import {
    SidebarUsagePopoverView,
    useUsagePopoverData,
    useUsagePopoverHandlers,
    type UsagePopoverSession,
} from './SidebarUsagePopoverContent';

type ConnectedAccountGroupV4 = AccountProfile['connectedAccountGroupsV4'][number];

/**
 * What a pool does when the session's account runs out, from the pool's own policy (lab `csvc` U3). It
 * names the rule, never a predicted member: the daemon's selection owner picks the member at switch time.
 */
export function describePoolNextMove(params: Readonly<{
    policy: ConnectedServiceAuthGroupPolicyV1;
    pool: string;
    account: string;
}>): string {
    const { policy } = params;
    const switches = isPoolUsageLimitSwitchEnabled(policy);
    if (!switches) return t('sidebarFooter.usageNextStays', { pool: params.pool, account: params.account });
    return policy.strategy === 'priority'
        ? t('sidebarFooter.usageNextInOrder', { account: params.account })
        : t('sidebarFooter.usageNextMostLeft', { account: params.account });
}

/**
 * The session's scope for the one Usage popover: which account it signs in with (only from its own
 * binding, `resolveSessionUsageAccount`), how it signs in, and its pool's next move. A session that
 * signs in on its own shows its gauge's windows; an unknown account shows every account.
 */
export function buildUsagePopoverSession(params: Readonly<{
    metadata: unknown;
    agentId: string | null;
    viewModel: ConnectedServiceQuotaGaugeViewModel | null;
    groups: readonly ConnectedAccountGroupV4[];
    usage: UsageSummary;
    present: ConnectedAccountIdentityPresenter;
    /** The session's own reset action (it signs in on its own, so the account consume does not apply). */
    resetAction: AccountUsageResetsAction | null;
}>): UsagePopoverSession {
    const agentId = params.agentId ?? '';
    const agent = isBundledAgentId(agentId) ? t(getAgentCore(agentId).displayNameKey) : null;
    const account = resolveSessionUsageAccount({ metadata: params.metadata, agentId });
    const findGroup = (service: Readonly<{ pluginId: string; localId: string }>, groupId: string) => params.groups.find((group) => (
        group.ref.groupId === groupId
        && group.ref.service.pluginId === service.pluginId
        && group.ref.service.localId === service.localId
    )) ?? null;

    if (account.status === 'known') {
        const accountKey = connectedServiceProfileKey({
            serviceId: buildQualifiedPluginContributionKey(account.account.service),
            profileId: account.account.accountId,
        });
        const group = account.groupId ? findGroup(account.account.service, account.groupId) : null;
        const pool = group?.displayName ?? t('sidebarFooter.usagePoolFallback');
        const row = params.usage.accounts.find((candidate) => candidate.key === accountKey) ?? null;
        const shown = params.present({ label: row?.accountLabel ?? null, email: row?.accountEmail ?? null, accountId: account.account.accountId });
        const name = shown.label ?? shown.email ?? shown.accountId ?? account.account.accountId;
        return {
            scopeLine: agent === null
                ? null
                : account.groupId
                    ? t('sidebarFooter.usageSessionThroughPool', { agent, pool })
                    : t('sidebarFooter.usageSessionWithAccount', { agent }),
            accountKey,
            ownSignIn: null,
            nextMove: group ? describePoolNextMove({ policy: group.policy, pool, account: name }) : null,
        };
    }
    if (account.status === 'unknown') {
        const group = account.pool ? findGroup(account.pool.service, account.pool.groupId) : null;
        return {
            scopeLine: agent !== null && account.pool
                ? t('sidebarFooter.usageSessionThroughPool', { agent, pool: group?.displayName ?? t('sidebarFooter.usagePoolFallback') })
                : null,
            accountKey: null,
            ownSignIn: null,
            nextMove: null,
        };
    }
    const viewModel = params.viewModel;
    return {
        scopeLine: agent === null ? null : t('sidebarFooter.usageSessionOwnSignIn', { agent }),
        accountKey: null,
        ownSignIn: viewModel && viewModel.allMeterRows.length > 0 ? {
            title: viewModel.providerDisplayName ?? agent ?? '',
            legacyServiceId: viewModel.serviceId,
            // The gauge carries the session's resets as a summary; the resets line reads that projection.
            recoveryCredits: viewModel.recoveryCreditSummary ? {
                availableCount: viewModel.recoveryCreditSummary.availableCount,
                nextExpiresAtMs: viewModel.recoveryCreditSummary.nextExpiresAtMs,
                credits: [],
            } : null,
            resetAction: params.resetAction,
            windows: viewModel.allMeterRows.map((row) => ({
                meterId: row.meterId,
                label: row.label,
                remainingPct: row.remainingPct,
                resetsAt: row.resetsAt,
                tone: resolveQuotaTone(row.remainingPct),
            })),
        } : null,
        nextMove: null,
    };
}

/**
 * The composer ring's popover (lab `csvc` U3): the rail's Usage popover scoped to this session's
 * account, with "All accounts" to widen it. Mounted only while the popover is open.
 */
export function SessionUsagePopoverContent(props: Readonly<{
    close: () => void;
    metadata: unknown;
    agentId: string | null;
    viewModel: ConnectedServiceQuotaGaugeViewModel | null;
    /** The session's own usage-reset action, for a session that signs in on its own. */
    onUseReset?: () => void;
    resetPending?: boolean;
}>) {
    const router = useRouter();
    const handlers = useUsagePopoverHandlers({ close: props.close, router });
    const data = useUsagePopoverData();
    const profile = useProfile();
    const groups = profile.connectedAccountGroupsV4;
    const { onUseReset } = props;
    const resetPending = props.resetPending === true;
    const resetAction = React.useMemo(
        () => (onUseReset ? { onUse: onUseReset, pending: resetPending } : null),
        [onUseReset, resetPending],
    );
    const session = React.useMemo(() => buildUsagePopoverSession({
        metadata: props.metadata,
        agentId: props.agentId,
        viewModel: props.viewModel,
        groups,
        usage: data.usage,
        present: data.privacy.present,
        resetAction,
    }), [data.privacy.present, data.usage, groups, props.agentId, props.metadata, props.viewModel, resetAction]);
    return (
        <SidebarUsagePopoverView
            usage={data.usage}
            facts={data.facts}
            privacy={data.privacy}
            refresh={data.refresh}
            session={session}
            onOpenConnectedServices={handlers.openConnectedServices}
            onSignInAgain={handlers.signInAgain}
        />
    );
}
