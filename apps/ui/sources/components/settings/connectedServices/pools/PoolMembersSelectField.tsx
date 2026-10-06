import * as React from 'react';

import { Modal } from '@/modal';
import { t } from '@/text';

import { computePoolMembershipDiff } from './poolMembershipDiff';
import { MultiSelectField } from '@/components/ui/forms/dropdown/MultiSelectField';

/** An account eligible for pool membership. */
export type PoolMembershipCandidate = Readonly<{
    accountId: string;
    title: string;
    subtitle?: string;
}>;

export type PoolMembersSelectFieldProps = Readonly<{
    candidates: ReadonlyArray<PoolMembershipCandidate>;
    /** Current authoritative membership (account ids). */
    selectedAccountIds: ReadonlyArray<string>;
    /** Receives the target membership in candidate order when the draft is committed. */
    onCommit: (nextSelectedAccountIds: ReadonlyArray<string>) => void;
    disabled?: boolean;
    testID?: string;
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    renderTrigger?: React.ComponentProps<typeof MultiSelectField>['renderTrigger'];
    searchPlaceholder?: string;
    onConnectAccount?: () => void;
    serviceLabel?: string;
}>;

export const PoolMembersSelectField = React.memo(function PoolMembersSelectField(
    props: PoolMembersSelectFieldProps,
) {
    const { candidates, onCommit, selectedAccountIds } = props;
    const commitDraft = React.useCallback(async (nextSelectedAccountIds: ReadonlyArray<string>) => {
        const { toAdd, toRemove } = computePoolMembershipDiff(
            selectedAccountIds,
            nextSelectedAccountIds,
        );
        if (toAdd.length === 0 && toRemove.length === 0) return;

        if (toRemove.length > 0) {
            const removedTitles = toRemove.map((accountId) => (
                candidates.find((candidate) => candidate.accountId === accountId)?.title
                ?? t('common.unavailable')
            ));
            const ok = await Modal.confirm(
                t('connectedServices.detail.groupActions.removeMemberConfirmTitle'),
                t('connectedServices.detail.groupActions.removeMembersConfirmBody', {
                    count: toRemove.length,
                    members: removedTitles.join(', '),
                }),
                {
                    confirmText: t('connectedServices.detail.groupActions.removeMember'),
                    cancelText: t('common.cancel'),
                    destructive: true,
                },
            );
            if (!ok) return;
        }

        onCommit(nextSelectedAccountIds);
    }, [candidates, onCommit, selectedAccountIds]);

    return (
        <MultiSelectField
            candidates={candidates.map((candidate) => ({
                id: candidate.accountId,
                title: candidate.title,
                subtitle: candidate.subtitle,
            }))}
            selectedIds={selectedAccountIds}
            onCommit={commitDraft}
            title={t('connectedServices.detail.groupActions.manageMembersTitle')}
            subtitle={(count, total) => props.serviceLabel ? t('connectedServicesPool.membersSelectionSummary', { count, total, service: props.serviceLabel }) : t(
                'connectedServices.detail.groupActions.manageMembersSubtitle',
                { count, total },
            )}
            emptySubtitle={t('connectedServices.detail.profiles.empty')}
            searchPlaceholder={props.searchPlaceholder ?? t('connectedServices.detail.groupActions.searchMembersPlaceholder')}
            optionTestIDPrefix="qualified-connected-account-group:members:option"
            disabled={props.disabled}
            testID={props.testID}
            searchable
            menuChrome={Boolean(props.renderTrigger)}
            connectAction={props.onConnectAccount ? { label: props.serviceLabel ? t('connectedServicesPool.connectAnotherAccount', { service: props.serviceLabel }) : t('settings.connectAccount'), onPress: props.onConnectAccount } : undefined}
            open={props.open}
            onOpenChange={props.onOpenChange}
            renderTrigger={props.renderTrigger}
        />
    );
});
