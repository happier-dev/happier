import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { EmptyState } from '@/components/ui/empty/EmptyState';
import { Switch } from '@/components/ui/forms/Switch';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { StatusPill } from '@/components/ui/status/StatusPill';
import { Modal } from '@/modal';
import { deriveAccountHealth } from '@/sync/domains/connectedServices/deriveAccountHealth';
import type { QualifiedConnectedAccountUiGroup } from '@/sync/domains/connectedServices/qualifiedConnectedAccountUiSource';
import { t } from '@/text';
import { type QualifiedConnectedAccountRef } from '@happier-dev/protocol';

import { parseDisplayableCredentialHealthStatus } from '@/sync/domains/connectedServices/parseDisplayableCredentialHealthStatus';
import {
    presentQualifiedConnectedAccountTarget,
    type QualifiedConnectedAccountTargetPresentation,
} from '@/sync/domains/connectedServices/qualifiedConnectedAccountTargetPresentation';
import { resolveAccountHealthVariant } from './accountBlockModel';
import { CONNECTED_SERVICE_RECONNECT_ICON } from './buildConnectedServiceAccountRowActions';
import { resolveConnectedAccountCredentialStatusLabel } from './connectedAccountCredentialStatusLabel';

export type QualifiedAccountDetailViewProps = Readonly<{
    /** Qualified identity of the account this screen describes. */
    account: QualifiedConnectedAccountRef;
    /** Resolved service display name (already translated by the caller). */
    serviceLabel: string;
    /** Canonical qualified-target presentation from the current service owner. */
    presentation: QualifiedConnectedAccountTargetPresentation;
    /** Provider-reported email, when the credential exposes one. */
    providerEmail?: string | null;
    /** Provider-side account identifier, when the credential exposes one. */
    providerAccountId?: string | null;
    /**
     * RAW credential health status. Unrecognized values render no status row
     * rather than guessing a state the caller did not report.
     */
    status?: unknown;
    /**
     * Pools of this account's service. Membership is derived here from the
     * qualified account id so one rule owns it. Omit this prop to hide the pools
     * section entirely (pools not applicable for this service); an empty array
     * still renders the section with its empty state.
     *
     * This screen READS memberships only — editing them belongs to the pool
     * detail, which owns the member list, its ordering and its policy.
     */
    groups?: readonly QualifiedConnectedAccountUiGroup[];
    isDefault?: boolean;
    /**
     * Every callback below gates its affordance: an absent callback removes the
     * row instead of disabling it, so the screen never implies a mutation the
     * caller cannot reach (permissions, unsupported peer, read-only surface).
     */
    onOpenPool?: (groupId: string) => void;
    onToggleDefault?: () => void;
    onEditLabel?: () => void;
    onReconnect?: () => void;
    onDisconnect?: () => void | Promise<void>;
    testID?: string;
}>;

const DEFAULT_TEST_ID = 'qualified-account-detail';

const NO_LOCAL_PROFILE_LABELS: Readonly<Record<string, string | undefined>> = Object.freeze({});

function isMemberOf(
    group: QualifiedConnectedAccountUiGroup,
    account: QualifiedConnectedAccountRef,
): boolean {
    return group.members.some((member) => (
        member.ref.accountId === account.accountId
        && member.ref.service.pluginId === account.service.pluginId
        && member.ref.service.localId === account.service.localId
    ));
}

/**
 * Per-account detail screen for dev's qualified connected accounts.
 *
 * Presentational: identity, memberships and permissions all arrive as props so
 * the screen has one wiring owner and stays renderable from a test or a
 * preview. The only local state is the in-flight disconnect guard, which keeps
 * a second press from stacking confirmation dialogs.
 *
 * The account's NAME (header title, disconnect confirmation) arrives from the
 * canonical qualified-target presenter, shared with Provider, pool and Voice
 * paths. This view therefore never re-ranks labels or invents an id fallback.
 *
 * Identity row labels follow dev's vocabulary, where "account" names the
 * QUALIFIED identity: `connectedServices.profile.accountId` ("Account id")
 * carries `ref.accountId`, and the provider-reported id is namespaced as
 * `connectedServices.profile.providerAccountId` ("Provider account id").
 */
export const QualifiedAccountDetailView = React.memo(function QualifiedAccountDetailView(
    props: QualifiedAccountDetailViewProps,
) {
    const { theme } = useUnistyles();
    const {
        account,
        serviceLabel,
        presentation,
        providerEmail,
        providerAccountId,
        groups,
        isDefault = false,
        onOpenPool,
        onToggleDefault,
        onEditLabel,
        onReconnect,
        onDisconnect,
    } = props;
    const testID = props.testID ?? DEFAULT_TEST_ID;

    const [disconnectPending, setDisconnectPending] = React.useState(false);

    const status = parseDisplayableCredentialHealthStatus(props.status);
    const email = providerEmail?.trim() ?? '';
    const providerAccount = providerAccountId?.trim() ?? '';

    const memberships = React.useMemo(
        () => (groups ?? []).filter((group) => isMemberOf(group, account)),
        [account, groups],
    );
    const showPools = groups !== undefined;
    const showSettings = onToggleDefault !== undefined || onEditLabel !== undefined;

    const handleDisconnect = React.useCallback(async () => {
        if (!onDisconnect || disconnectPending) return;
        setDisconnectPending(true);
        try {
            const confirmed = await Modal.confirm(
                t('modals.disconnect'),
                t('connectedServices.detail.disconnectConfirmBody', {
                    service: serviceLabel,
                    // Irreversible: name every identity the user could recognise
                    // this account by, not just the one shown in the header.
                    profileId: presentation.accessibilityLabel,
                }),
                {
                    confirmText: t('modals.disconnect'),
                    cancelText: t('common.cancel'),
                    destructive: true,
                },
            );
            if (!confirmed) return;
            await onDisconnect();
        } finally {
            setDisconnectPending(false);
        }
    }, [disconnectPending, onDisconnect, presentation.accessibilityLabel, serviceLabel]);

    return (
        <ItemList testID={testID}>
            <ItemGroup title={`${serviceLabel} • ${presentation.primaryLabel}`}>
                {status ? (
                    <Item
                        testID={`${testID}:row:status`}
                        title={t('connectedServices.profile.status')}
                        rightElement={(
                            <StatusPill
                                testID={`${testID}:status-pill`}
                                // The pill's colour is NOT decided here: the raw
                                // credential status is derived to `AccountHealth`
                                // by the canonical owner and painted by the one
                                // health->variant table, so this screen, the
                                // accounts list dot and the pool aggregate can
                                // never disagree about what a status looks like.
                                // Quota is out of scope on this row, hence
                                // `capacityPct: null`.
                                variant={resolveAccountHealthVariant(
                                    deriveAccountHealth({ status, capacityPct: null }),
                                )}
                                label={resolveConnectedAccountCredentialStatusLabel(status)}
                                labelVariant="phrase"
                            />
                        )}
                        mode="info"
                    />
                ) : null}
                {email ? (
                    <Item
                        testID={`${testID}:row:email`}
                        title={t('connectedServices.profile.email')}
                        subtitle={email}
                        subtitleTestID={`${testID}:row:email:subtitle`}
                        mode="info"
                    />
                ) : null}
                <Item
                    testID={`${testID}:row:account-id`}
                    title={t('connectedServices.profile.accountId')}
                    subtitle={account.accountId}
                    subtitleTestID={`${testID}:row:account-id:subtitle`}
                    mode="info"
                />
                {providerAccount ? (
                    <Item
                        testID={`${testID}:row:provider-account-id`}
                        title={t('connectedServices.profile.providerAccountId')}
                        subtitle={providerAccount}
                        subtitleTestID={`${testID}:row:provider-account-id:subtitle`}
                        mode="info"
                    />
                ) : null}
            </ItemGroup>

            {showPools ? (
                <ItemGroup title={t('connectedServices.profile.poolsGroupTitle')}>
                    {memberships.length > 0 ? (
                        memberships.map((group) => (
                            <Item
                                key={group.ref.groupId}
                                testID={`${testID}:pool:${group.ref.groupId}`}
                                title={presentQualifiedConnectedAccountTarget({
                                    target: {
                                        kind: 'group',
                                        service: group.ref.service,
                                        groupId: group.ref.groupId,
                                    },
                                    accounts: [],
                                    groups: [group],
                                    labelsByKey: NO_LOCAL_PROFILE_LABELS,
                                    serviceTitle: serviceLabel,
                                }).primaryLabel}
                                icon={<Icon name="stack-simple" size={ICON_SIZE.md} color={theme.colors.text.secondary} />}
                                onPress={onOpenPool ? () => onOpenPool(group.ref.groupId) : undefined}
                                showChevron={onOpenPool !== undefined}
                                mode={onOpenPool ? 'interactive' : 'info'}
                            />
                        ))
                    ) : (
                        <EmptyState
                            testID={`${testID}:pools-empty`}
                            titleTestID={`${testID}:pools-empty:title`}
                            icon={<Icon name="stack-simple" size={ICON_SIZE.xl} color={theme.colors.text.secondary} />}
                            title={t('connectedServices.profile.pools.emptyTitle')}
                            subtitle={t('connectedServices.profile.pools.emptySubtitle')}
                        />
                    )}
                </ItemGroup>
            ) : null}

            {showSettings ? (
                <ItemGroup title={t('connectedServices.profile.settingsGroupTitle')}>
                    {onToggleDefault ? (
                        <Item
                            testID={`${testID}:action:set-default`}
                            title={t('connectedServices.profile.setDefaultRowTitle')}
                            subtitle={isDefault
                                ? t('connectedServices.profile.defaultSubtitle')
                                : t('connectedServices.profile.setDefaultSubtitle')}
                            rightElement={(
                                <Switch
                                    testID={`${testID}:default-switch`}
                                    value={isDefault}
                                    onValueChange={onToggleDefault}
                                    accessibilityLabel={t(isDefault
                                        ? 'connectedServices.detail.actions.unsetDefault'
                                        : 'connectedServices.detail.actions.setDefault')}
                                />
                            )}
                            mode="info"
                        />
                    ) : null}
                    {onEditLabel ? (
                        <Item
                            testID={`${testID}:action:edit-label`}
                            title={t('connectedServices.detail.actions.editLabel')}
                            subtitle={t('connectedServices.detail.setProfileLabelSubtitle')}
                            icon={<Icon name="pencil" size={ICON_SIZE.md} color={theme.colors.accent.blue} />}
                            onPress={onEditLabel}
                        />
                    ) : null}
                </ItemGroup>
            ) : null}

            {onReconnect ? (
                <ItemGroup title={t('connectedServices.profile.connectionGroupTitle')}>
                    <Item
                        testID={`${testID}:action:reconnect`}
                        title={t('connectedServices.detail.actions.reconnect')}
                        subtitle={t('connectedServices.profile.reconnectSubtitle')}
                        icon={<Icon name={CONNECTED_SERVICE_RECONNECT_ICON} size={ICON_SIZE.md} color={theme.colors.accent.blue} />}
                        onPress={onReconnect}
                    />
                </ItemGroup>
            ) : null}

            {onDisconnect ? (
                <ItemGroup title={t('connectedServices.profile.removeGroupTitle')}>
                    <Item
                        testID={`${testID}:action:disconnect`}
                        title={t('modals.disconnect')}
                        subtitle={t('connectedServices.profile.disconnectSubtitle')}
                        icon={<Icon name="trash" size={ICON_SIZE.md} color={theme.colors.state.danger.foreground} />}
                        destructive
                        loading={disconnectPending}
                        onPress={handleDisconnect}
                    />
                </ItemGroup>
            ) : null}
        </ItemList>
    );
});

QualifiedAccountDetailView.displayName = 'QualifiedAccountDetailView';
