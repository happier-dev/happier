import * as React from 'react';
import type { ConnectedServiceId, QualifiedConnectedAccountPurposeBindingTargetV1 } from '@happier-dev/protocol';

import { useQualifiedConnectedAccountQuota } from '@/hooks/server/connectedServices/useQualifiedConnectedAccountQuota';
import { useConnectedAccountIdentityPrivacy } from '@/hooks/ui/useConnectedAccountIdentityPrivacy';

import { useAgentDefaultChoices } from '../defaults/useAgentDefaultChoices';
import { AccountDetailFactsSections, AccountDetailUsedBySection, AccountDetailWorksOnSection } from './AccountDetailSections';
import { QualifiedAccountDetailView, type QualifiedAccountDetailViewProps } from './QualifiedAccountDetailView';

/**
 * The live account detail (lab `csvc` D1/D2): the presentational view with its identity through the one
 * privacy presenter, the plan from the account's usage record, ★ the per-agent default choices, and the
 * usage, subscription, resets, used-by and works-on sections read by their own leaves.
 */
export const QualifiedAccountDetail = React.memo(function QualifiedAccountDetail(
    props: Omit<QualifiedAccountDetailViewProps, 'planLabel' | 'agentDefaults' | 'usageSection' | 'usedBySection' | 'worksOnSection'> & Readonly<{
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
    const signedOut = props.status === 'needs_reauth';
    return (
        <QualifiedAccountDetailView
            {...props}
            presentation={presentation}
            providerEmail={shown.email}
            providerAccountId={shown.accountId}
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
            usedBySection={<AccountDetailUsedBySection account={props.account} />}
            worksOnSection={<AccountDetailWorksOnSection />}
        />
    );
});
