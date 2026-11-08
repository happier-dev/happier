import * as React from 'react';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';

import { useConnectedServiceQuotaSnapshots } from '@/hooks/server/connectedServices/useConnectedServiceQuotaSnapshots';
import { useConnectedAccountIdentityPrivacy } from '@/hooks/ui/useConnectedAccountIdentityPrivacy';
import { buildConnectedAccountSettingsRoute } from '@/sync/domains/connectedServices/connectedAccountSettingsRoute';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import type { QualifiedConnectedAccountPurposeBindingTargetV1 } from '@happier-dev/protocol/connect/connected-account-purpose-bindings';
import type { QualifiedConnectedAccountRef } from '@happier-dev/protocol/connect/qualified-connected-account-persistence';
import { presentConnectSheet } from '../setup/ConnectedServiceSetupModal';
import { ConnectedAccountSettled } from '../setup/ConnectedAccountSettled';
import { useConnectedServicesIndex } from '../model/useConnectedServicesIndex';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { getQualifiedConnectedServiceRegistryEntry } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useProviderSettingsTarget } from '@/providers/hooks/targetMachine';
import { usePoolGatewayChoices } from './usePoolGatewayChoices';
import { resolveConnectedAccountPurposeTargetDisplay } from '@/sync/domains/connectedServices/connectedAccountPurposeTargetChoices';
import { useProfile } from '@/sync/store/hooks';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';
import type { PoolGatewayChoice } from './poolGatewayChoices';

import { useAgentDefaultChoices } from '../defaults/useAgentDefaultChoices';
import { ConnectedAccountActionApprovalNotice } from '../ConnectedAccountActionApprovalNotice';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import {
    QualifiedPoolDetailView,
    type PoolMemberQuota,
    type QualifiedPoolDetailViewProps,
} from './QualifiedPoolDetailView';

/**
 * The live pool page: the presentational view fed by the batched member-usage owner (one polling read
 * for every member, the same store the account rows read), the one identity presenter (privacy) and
 * the ★ per-agent default choices. The pool itself and every write come from the caller's
 * `useQualifiedConnectedAccountGroups`.
 */
export const QualifiedPoolDetail = React.memo(function QualifiedPoolDetail(
    props: Omit<QualifiedPoolDetailViewProps, 'memberQuotaByAccountId' | 'presentIdentity' | 'agentDefaults' | 'gatewayUsage' | 'presentGatewayTarget' | 'onOpenGateway' | 'onOpenAccount' | 'now' | 'onCheckStale'>,
) {
    const router = useRouter();
    const scope = useActiveServerAccountScope();
    const [settled, setSettled] = React.useState<QualifiedConnectedAccountRef | null>(null);
    const { present } = useConnectedAccountIdentityPrivacy();
    const { group } = props;
    const refs = React.useMemo(() => group.members.map((member) => ({ ref: member.ref })), [group.members]);
    const quotas = useConnectedServiceQuotaSnapshots(refs);
    const memberQuotaByAccountId = React.useMemo(() => {
        const byAccountId: Record<string, PoolMemberQuota> = {};
        for (const profile of quotas.profiles) {
            if (profile.kind !== 'qualified') continue;
            byAccountId[profile.ref.accountId] = {
                snapshot: quotas.snapshotsByKey[profile.key] ?? null,
                loading: quotas.loadingByKey[profile.key] === true,
                failed: quotas.errorsByKey[profile.key] != null,
            };
        }
        return byAccountId;
    }, [quotas.errorsByKey, quotas.loadingByKey, quotas.profiles, quotas.snapshotsByKey]);
    // The page's one on-demand check for members whose readings are old when it opens.
    const { profiles: quotaProfiles, refresh: refreshQuotas } = quotas;
    const checkStale = React.useCallback((accountIds: readonly string[]) => {
        const keys = quotaProfiles.flatMap((profile) => profile.kind === 'qualified' && accountIds.includes(profile.ref.accountId) ? [profile.key] : []);
        if (keys.length > 0) fireAndForget(refreshQuotas(keys), { tag: 'QualifiedPoolDetail.checkStale' });
    }, [quotaProfiles, refreshQuotas]);

    const target = React.useMemo<Extract<QualifiedConnectedAccountPurposeBindingTargetV1, { kind: 'group' }>>(() => ({
        kind: 'group',
        service: group.ref.service,
        groupId: group.ref.groupId,
    }), [group.ref.groupId, group.ref.service]);
    const agentDefaults = useAgentDefaultChoices(target);
    const providersEnabled = useFeatureEnabled('providers');
    const providerTarget = useProviderSettingsTarget();
    const gatewayUsage = usePoolGatewayChoices({ target, enabled: providersEnabled, resolveTarget: providerTarget.resolveCurrentTarget,
        accountServerId: providerTarget.accountServerId, accountAddressAvailable: providerTarget.accountAddressAvailable });

    const profile = useProfile();
    const { labelsByKey, serviceLabel } = props;
    // The account or pool a gateway draws on today, named as this page names its own accounts.
    const presentGatewayTarget = React.useCallback((held: QualifiedConnectedAccountPurposeBindingTargetV1) => (
        resolveConnectedAccountPurposeTargetDisplay({
            target: held,
            accounts: profile.connectedAccountsV4 ?? [],
            groups: profile.connectedAccountGroupsV4 ?? [],
            labelsByKey: labelsByKey ?? {},
            serviceTitle: serviceLabel,
            presentIdentity: present,
        })
    ), [labelsByKey, present, profile.connectedAccountGroupsV4, profile.connectedAccountsV4, serviceLabel]);
    const openGateway = React.useCallback((choice: PoolGatewayChoice) => {
        const result = runGuardedNavigation(() => router.push(choice.detailRoute as never));
        if (result !== true) fireAndForget(result, { tag: 'QualifiedPoolDetail.openGateway' });
    }, [router]);

    const service = group.ref.service;
    const labelExecution = useMountedActionExecution(scope);
    const resetLabel = React.useCallback(() => {
        fireAndForget(labelExecution.execute('connectedServices.labels.reset', {
            subject: { kind: 'group', service, groupId: group.ref.groupId },
        }), { tag: 'QualifiedPoolDetail.resetLabel' });
    }, [group.ref.groupId, labelExecution.execute, service]);
    const openAccount = React.useCallback((account: QualifiedConnectedAccountRef) => {
        router.push(buildConnectedAccountSettingsRoute(service, { kind: 'account', accountId: account.accountId }));
    }, [router, service]);

    return (
        <>
        <ConnectedAccountActionApprovalNotice execution={agentDefaults.execution} testID="connected-pool-default-approval-pending" />
        <ConnectedAccountActionApprovalNotice execution={labelExecution} testID="connected-pool-label-approval-pending" />
        <QualifiedPoolDetailView
            {...props}
            settled={settled ? <PoolConnectedAccountSettled account={settled} onDismiss={() => setSettled(null)} /> : null}
            memberQuotaByAccountId={memberQuotaByAccountId}
            presentIdentity={present}
            agentDefaults={agentDefaults}
            gatewayUsage={gatewayUsage}
            presentGatewayTarget={presentGatewayTarget}
            onOpenGateway={openGateway}
            onOpenAccount={openAccount}
            onCheckStale={checkStale}
            onResetLabel={resetLabel}
            legacyServiceId={getQualifiedConnectedServiceRegistryEntry(service)?.legacyServiceId ?? null}
            onConnectAccount={() => {
                fireAndForget(presentConnectSheet({ scope, service }).then(result => {
                    if (result.kind !== 'dismissed') setSettled(result.account);
                }), { tag: 'QualifiedPoolDetail.connect' });
            }}
        />
        </>
    );
});

function PoolConnectedAccountSettled(props: Readonly<{ account: QualifiedConnectedAccountRef; onDismiss: () => void }>) {
    const index = useConnectedServicesIndex({ agents: 'cached', serviceKey: buildQualifiedPluginContributionKey(props.account.service) });
    return <ConnectedAccountSettled {...props} model={index.indexModel} agents={index.agentEntries}
        machineId={index.appShellProjection.machineId ?? undefined} />;
}
