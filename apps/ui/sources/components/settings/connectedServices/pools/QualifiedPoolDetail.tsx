import * as React from 'react';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';

import { useConnectedServiceQuotaSnapshots } from '@/hooks/server/connectedServices/useConnectedServiceQuotaSnapshots';
import { useConnectedAccountIdentityPrivacy } from '@/hooks/ui/useConnectedAccountIdentityPrivacy';
import { buildConnectedAccountSettingsRoute } from '@/sync/domains/connectedServices/connectedAccountSettingsRoute';
import { buildQualifiedPluginContributionKey, type QualifiedConnectedAccountPurposeBindingTargetV1, type QualifiedConnectedAccountRef } from '@happier-dev/protocol';
import { buildConnectedServiceSetupRoute } from '../setup/connectMoreBlocks';
import { getQualifiedConnectedServiceRegistryEntry } from '@/sync/domains/connectedServices/connectedServiceRegistry';

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
    props: Omit<QualifiedPoolDetailViewProps, 'memberQuotaByAccountId' | 'presentIdentity' | 'agentDefaults' | 'onOpenAccount' | 'now'>,
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

    const target = React.useMemo<QualifiedConnectedAccountPurposeBindingTargetV1>(() => ({
        kind: 'group',
        service: group.ref.service,
        groupId: group.ref.groupId,
    }), [group.ref.groupId, group.ref.service]);
    const agentDefaults = useAgentDefaultChoices(target);

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
            onOpenAccount={openAccount}
            legacyServiceId={getQualifiedConnectedServiceRegistryEntry(service)?.legacyServiceId ?? null}
            onConnectAccount={() => router.push(buildConnectedServiceSetupRoute({ kind: 'service', serviceKey: buildQualifiedPluginContributionKey(service) }))}
        />
    );
});
