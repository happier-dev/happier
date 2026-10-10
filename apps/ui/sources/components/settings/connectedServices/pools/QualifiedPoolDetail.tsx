import * as React from 'react';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';

import { useConnectedServiceQuotaSnapshots } from '@/hooks/server/connectedServices/useConnectedServiceQuotaSnapshots';
import { useConnectedAccountIdentityPrivacy } from '@/hooks/ui/useConnectedAccountIdentityPrivacy';
import { buildConnectedAccountSettingsRoute } from '@/sync/domains/connectedServices/connectedAccountSettingsRoute';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import type { QualifiedConnectedAccountPurposeBindingTargetV1 } from '@happier-dev/protocol/connect/connected-account-purpose-bindings';
import type { QualifiedConnectedAccountRef } from '@happier-dev/protocol/connect/qualified-connected-account-persistence';
import { buildConnectedServiceSetupRoute } from '../setup/connectMoreBlocks';
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
    props: Omit<QualifiedPoolDetailViewProps, 'memberQuotaByAccountId' | 'presentIdentity' | 'agentDefaults' | 'gatewayUsage' | 'presentGatewayTarget' | 'onOpenGateway' | 'onOpenAccount' | 'now'>,
) {
    const router = useRouter();
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
            };
        }
        return byAccountId;
    }, [quotas.loadingByKey, quotas.profiles, quotas.snapshotsByKey]);

    const target = React.useMemo<Extract<QualifiedConnectedAccountPurposeBindingTargetV1, { kind: 'group' }>>(() => ({
        kind: 'group',
        service: group.ref.service,
        groupId: group.ref.groupId,
    }), [group.ref.groupId, group.ref.service]);
    const agentDefaults = useAgentDefaultChoices(target);
    const providersEnabled = useFeatureEnabled('providers');
    const providerTarget = useProviderSettingsTarget();
    const gatewayUsage = usePoolGatewayChoices({ target, enabled: providersEnabled, resolveTarget: providerTarget.resolveCurrentTarget });

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
    const openAccount = React.useCallback((account: QualifiedConnectedAccountRef) => {
        router.push(buildConnectedAccountSettingsRoute(service, { kind: 'account', accountId: account.accountId }));
    }, [router, service]);

    return (
        <QualifiedPoolDetailView
            {...props}
            memberQuotaByAccountId={memberQuotaByAccountId}
            presentIdentity={present}
            agentDefaults={agentDefaults}
            gatewayUsage={gatewayUsage}
            presentGatewayTarget={presentGatewayTarget}
            onOpenGateway={openGateway}
            onOpenAccount={openAccount}
            legacyServiceId={getQualifiedConnectedServiceRegistryEntry(service)?.legacyServiceId ?? null}
            onConnectAccount={() => router.push(buildConnectedServiceSetupRoute({ kind: 'service', serviceKey: buildQualifiedPluginContributionKey(service) }))}
        />
    );
});
