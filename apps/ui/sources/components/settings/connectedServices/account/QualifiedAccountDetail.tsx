import * as React from 'react';
import { isConnectedAccountSignedOut, parseDisplayableCredentialHealthStatus } from '@/sync/domains/connectedServices/parseDisplayableCredentialHealthStatus';
import type { ConnectedServiceId} from '@happier-dev/protocol/connect/connected-service-bindings';
import type { QualifiedConnectedAccountPurposeBindingTargetV1 } from '@happier-dev/protocol/connect/connectedAccountPurposeBindings';

import { useQualifiedConnectedAccountQuota } from '@/hooks/server/connectedServices/useQualifiedConnectedAccountQuota';
import { useConnectedAccountIdentityPrivacy } from '@/hooks/ui/useConnectedAccountIdentityPrivacy';
import { useMachine, useMachineDisplayById } from '@/sync/store/hooks';
import type { MachineDisplayRenderable } from '@/sync/domains/machines/machineDisplayRenderable';
import { getSettledMachineDisplayName } from '@/utils/sessions/machineDisplayNames';

import { useAgentDefaultChoices } from '../defaults/useAgentDefaultChoices';
import { ConnectedAccountActionApprovalNotice } from '../ConnectedAccountActionApprovalNotice';
import { AccountDetailFactsSections, AccountDetailUsedBySection, AccountDetailWorksOnSection } from './AccountDetailSections';
import { QualifiedAccountDetailView, type QualifiedAccountDetailViewProps } from './QualifiedAccountDetailView';

/**
 * The name this Home gives the Machine an account last signed in on, or null when the Machine is not
 * one of this Home's (the row then says when it signed in, not where).
 */
function useAuthenticationMachineName(provenance: QualifiedAccountDetailViewProps['authenticationProvenance']): string | null {
    const machineId = provenance?.machine.machineId ?? null;
    const machine = useMachine(machineId ?? '', machineId !== null);
    const display = useMachineDisplayById(React.useCallback(
        (displays: Record<string, MachineDisplayRenderable>) => (machineId ? displays[machineId] ?? null : null),
        [machineId],
    ));
    if (!machine) return null;
    // A locked body never discloses an older held name.
    const named = machine.availability?.kind === 'locked' ? machine : display ?? machine;
    return getSettledMachineDisplayName(named);
}

/**
 * The live account detail (lab `csvc` D1/D2): the presentational view with its identity through the one
 * privacy presenter, the plan from the account's usage record, ★ the per-agent default choices, and the
 * usage, subscription, resets, used-by and works-on sections read by their own leaves.
 */
export const QualifiedAccountDetail = React.memo(function QualifiedAccountDetail(
    props: Omit<QualifiedAccountDetailViewProps, 'planLabel' | 'agentDefaults' | 'usageSection' | 'renderUsedBy' | 'worksOnSection'> & Readonly<{
        legacyServiceId: ConnectedServiceId | null;
        machineId?: string | null;
    }>,
) {
    const { present, hidden } = useConnectedAccountIdentityPrivacy();
    const quota = useQualifiedConnectedAccountQuota(props.account, { refreshMachineId: props.machineId });
    const target = React.useMemo<QualifiedConnectedAccountPurposeBindingTargetV1>(
        () => ({ kind: 'account', account: props.account }),
        [props.account],
    );
    const agentDefaults = useAgentDefaultChoices(target);
    const shown = present({
        label: props.presentation.primaryLabel,
        labelKind: props.presentation.primaryLabelKind,
        email: props.providerEmail ?? null,
        accountId: props.providerAccountId ?? null,
    });
    const presentation = hidden ? {
        ...props.presentation,
        primaryLabel: shown.label ?? props.presentation.primaryLabel,
        secondaryLabel: Array.from(new Set([props.serviceLabel, shown.email, shown.accountId]))
            .filter((part) => part && part !== shown.label).join(' · ') || undefined,
        // What a confirmation or a screen reader says follows the same privacy as what is shown.
        accessibilityLabel: Array.from(new Set([props.serviceLabel, shown.label, shown.email, shown.accountId])).filter(Boolean).join(' · '),
    } : props.presentation;
    const signedOut = isConnectedAccountSignedOut(parseDisplayableCredentialHealthStatus(props.status));
    const authenticationMachineName = useAuthenticationMachineName(props.authenticationProvenance);
    return (
        <>
        <ConnectedAccountActionApprovalNotice execution={agentDefaults.execution} testID="connected-account-default-approval-pending" />
        <QualifiedAccountDetailView
            {...props}
            presentation={presentation}
            providerEmail={shown.email}
            providerAccountId={shown.accountId}
            authenticationMachineName={authenticationMachineName}
            planLabel={quota.snapshot?.planLabel ?? null}
            agentDefaults={agentDefaults}
            onRefresh={props.machineId !== null && quota.supported !== false ? () => { void quota.refresh(); } : undefined}
            refreshing={quota.refreshing}
            usageSection={(
                <AccountDetailFactsSections
                    account={props.account}
                    legacyServiceId={props.legacyServiceId}
                    serviceLabel={props.serviceLabel}
                    signedOut={signedOut}
                    machineId={props.machineId}
                />
            )}
            renderUsedBy={(slots) => <AccountDetailUsedBySection account={props.account} {...slots} />}
            worksOnSection={<AccountDetailWorksOnSection />}
        />
        </>
    );
});
