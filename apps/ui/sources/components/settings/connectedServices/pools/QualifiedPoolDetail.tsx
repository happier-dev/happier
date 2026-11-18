import { createActionExecuteFailureError } from '@happier-dev/protocol/actions/actionExecutionResult';
import * as React from 'react';
import { Modal } from '@/modal';
import { t } from '@/text';
import { CONNECTED_SERVICE_CONFIGURATION_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/connect/configurationActionsV1';
import { resolveConnectedServiceSettingsErrorMessage } from '../connectedServiceSettingsErrors';
import { resolveAgentUiBehavior } from '@/agents/registry/registryUiBehavior';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';

import { useConnectedServiceQuotaSnapshots } from '@/hooks/server/connectedServices/useConnectedServiceQuotaSnapshots';
import { useConnectedAccountIdentityPrivacy } from '@/hooks/ui/useConnectedAccountIdentityPrivacy';
import { buildConnectedAccountSettingsRoute } from '@/sync/domains/connectedServices/connectedAccountSettingsRoute';
import type { QualifiedConnectedAccountPurposeBindingTargetV1 } from '@happier-dev/protocol/connect/connected-account-purpose-bindings';
import type { QualifiedConnectedAccountRef } from '@happier-dev/protocol/connect/qualified-connected-account-persistence';
import { presentConnectSheet } from '../setup/ConnectedServiceSetupModal';
import { ConnectedAccountSettled } from '../setup/ConnectedAccountSettled';
import type { ConnectedAccountSetupCompletion, ConnectedAccountSetupFacts } from '../account/useConnectedAccountSetupCompletion';
import { useConnectedServicesIndex } from '../model/useConnectedServicesIndex';
import { useConnectedServicesAgents } from '../model/useConnectedServicesAgents';
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
    props: Omit<QualifiedPoolDetailViewProps, 'poolSettings' | 'memberQuotaByAccountId' | 'presentIdentity' | 'agentDefaults' | 'gatewayUsage' | 'presentGatewayTarget' | 'onOpenGateway' | 'onOpenGatewayDraft' | 'onOpenAccount' | 'now' | 'onResetLabel' | 'onSetLabel'>,
) {
    const router = useRouter();
    const scope = useActiveServerAccountScope();
    const [settled, setSettled] = React.useState<ConnectedAccountSetupCompletion | null>(null);
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
    const target = React.useMemo<Extract<QualifiedConnectedAccountPurposeBindingTargetV1, { kind: 'group' }>>(() => ({
        kind: 'group',
        service: group.ref.service,
        groupId: group.ref.groupId,
    }), [group.ref.groupId, group.ref.service]);
    const agentDefaults = useAgentDefaultChoices(target);
    const { agentEntries, appShellProjection } = useConnectedServicesAgents({ agents: 'cached' });
    const poolSettings = React.useMemo(() => agentEntries.flatMap((agent) =>
        resolveAgentUiBehavior(agent.agentId, appShellProjection.machineId, scope).connectedServices?.poolSettings ?? [],
    ), [agentEntries, appShellProjection.machineId, scope]);
    const providersEnabled = useFeatureEnabled('providers');
    const providerTarget = useProviderSettingsTarget();
    const gatewayUsage = usePoolGatewayChoices({ target, enabled: providersEnabled, resolveTarget: providerTarget.resolveCurrentTarget,
        accountServerId: providerTarget.accountServerId, accountAddressAvailable: providerTarget.accountAddressAvailable });

    const profile = useProfile(profile => ({
        connectedAccountsV4: profile.connectedAccountsV4,
        connectedAccountGroupsV4: profile.connectedAccountGroupsV4,
    }), ['connectedAccountsV4', 'connectedAccountGroupsV4']);
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
    const setLabel = React.useCallback(async (label: string): Promise<boolean> => {
        try {
            const subject = { kind: 'group' as const, service, groupId: group.ref.groupId };
            const result = label ? await labelExecution.execute('connectedServices.labels.set', { subject, label })
                : await labelExecution.execute('connectedServices.labels.reset', { subject });
            if (!result.ok) throw createActionExecuteFailureError(result);
            return CONNECTED_SERVICE_CONFIGURATION_ACTION_OUTPUT_SCHEMAS_V1['connectedServices.labels.set'].safeParse(result.result).success;
        } catch (error) {
            await Modal.alert(t('common.error'), resolveConnectedServiceSettingsErrorMessage(error));
            return false;
        }
    }, [group.ref.groupId, labelExecution.execute, service]);
    const resetLabel = React.useCallback(() => {
        fireAndForget(labelExecution.execute('connectedServices.labels.reset', {
            subject: { kind: 'group', service, groupId: group.ref.groupId },
        }), { tag: 'QualifiedPoolDetail.resetLabel' });
    }, [group.ref.groupId, labelExecution.execute, service]);
    const openAccount = React.useCallback((account: QualifiedConnectedAccountRef) => {
        const route = buildConnectedAccountSettingsRoute(service, { kind: 'account', accountId: account.accountId });
        if (route) router.push(route);
    }, [router, service]);

    return (
        <>
        <ConnectedAccountActionApprovalNotice execution={agentDefaults.execution} testID="connected-pool-default-approval-pending" />
        <ConnectedAccountActionApprovalNotice execution={labelExecution} testID="connected-pool-label-approval-pending" />
        <QualifiedPoolDetailView
            {...props}
            poolSettings={poolSettings}
            settled={settled ? <PoolConnectedAccountSettled account={settled.account} completion={settled} onDismiss={() => setSettled(null)} /> : null}
            memberQuotaByAccountId={memberQuotaByAccountId}
            presentIdentity={present}
            agentDefaults={agentDefaults}
            gatewayUsage={gatewayUsage}
            presentGatewayTarget={presentGatewayTarget}
            onOpenGateway={openGateway}
            onOpenGatewayDraft={route => {
                const result = runGuardedNavigation(() => router.push(route as never));
                if (result !== true) fireAndForget(result, { tag: 'QualifiedPoolDetail.openGatewayDraft' });
            }}
            onOpenAccount={openAccount}
            onResetLabel={resetLabel}
            onSetLabel={setLabel}
            legacyServiceId={getQualifiedConnectedServiceRegistryEntry(service)?.legacyServiceId ?? null}
            onConnectAccount={() => {
                fireAndForget(presentConnectSheet({ scope, service, intent: 'add' }).then(result => {
                    if (result.kind !== 'dismissed') setSettled(result);
                }), { tag: 'QualifiedPoolDetail.connect' });
            }}
        />
        </>
    );
});

function PoolConnectedAccountSettled(props: Readonly<{ account: QualifiedConnectedAccountRef; completion?: ConnectedAccountSetupFacts; onDismiss: () => void }>) {
    const index = useConnectedServicesIndex({ agents: 'cached', serviceKey: buildQualifiedPluginContributionKey(props.account.service) });
    return <ConnectedAccountSettled {...props} model={index.indexModel} agents={index.agentEntries}
        machineId={index.appShellProjection.machineId ?? undefined} />;
}
