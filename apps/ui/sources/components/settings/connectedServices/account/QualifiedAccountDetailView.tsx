import * as React from 'react';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Platform, View } from 'react-native';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { PAGE_LIST_METRICS } from '@/components/ui/lists/pageListMetrics';

import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { Text } from '@/components/ui/text/Text';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { Modal } from '@/modal';
import type { QualifiedConnectedAccountUiGroup } from '@/sync/domains/connectedServices/qualifiedConnectedAccountUiSource';
import { t } from '@/text';
import { type QualifiedConnectedAccountRef } from '@happier-dev/protocol';

import { parseDisplayableCredentialHealthStatus } from '@/sync/domains/connectedServices/parseDisplayableCredentialHealthStatus';
import {
    presentQualifiedConnectedAccountTarget,
    type QualifiedConnectedAccountTargetPresentation,
} from '@/sync/domains/connectedServices/qualifiedConnectedAccountTargetPresentation';
import { resolveConnectedAccountCredentialStatusLabel } from './connectedAccountCredentialStatusLabel';
import { ConnectedAccountIdentityText } from '../ConnectedAccountIdentityText';
import { ConnectedAccountRenamePopover } from './ConnectedAccountRenamePopover';
import { ConnectedServiceMark } from '../ConnectedServiceMark';
import { AgentDefaultMenuButton } from '../defaults/AgentDefaultMenuButton';
import type { AgentDefaultChoice } from '../defaults/agentDefaultChoices';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { formatAsOfTime } from '@/utils/time/formatAsOfTime';

export type QualifiedAccountDetailViewProps = Readonly<{
    /** Qualified identity of the account this screen describes. */
    account: QualifiedConnectedAccountRef;
    /** Resolved service display name (already translated by the caller). */
    serviceLabel: string;
    /** Released built-in service id, used only to show the service's brand mark. */
    legacyServiceId?: string | null;
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
    /** The plan the provider reports ("Pro"), shown with the service in the header. */
    planLabel?: string | null;
    /** ★ "Default for <agent>": the per-agent default menu (never a per-service default). */
    agentDefaults?: Readonly<{
        choices: readonly AgentDefaultChoice[];
        setDefault: (agentId: string, makeDefault: boolean) => void;
    }> | null;
    /**
     * Every callback below gates its affordance: an absent callback removes the
     * row instead of disabling it, so the screen never implies a mutation the
     * caller cannot reach (permissions, unsupported peer, read-only surface).
     */
    onOpenPool?: (groupId: string) => void;
    /** Rename in place (lab D2): the name people gave the account, and the writer of a new one. */
    rename?: Readonly<{ currentLabel: string; onRename: (label: string) => void }>;
    /** Starts the canonical Team credential offer journey for this source. */
    onShareWithTeam?: () => void;
    sharedWithTeamsAdministration?: React.ReactNode;
    onReconnect?: () => void;
    onRefresh?: () => void;
    refreshing?: boolean;
    onConfigureAccount?: () => void;
    accountConfigurationBlocked?: boolean;
    configurationDisabled?: boolean;
    serviceConfigurations?: readonly Readonly<{
        modeId: string;
        title: string;
        blocked: boolean;
        onConfigure: () => void;
    }>[];
    onDisconnect?: () => void | Promise<void>;
    /**
     * Account-level sections read by their own leaves (lab `csvc` D1): what is left in each window
     * (first), which agents use the account, and the machines it works on. The wiring owner mounts
     * them so this view stays presentational.
     */
    usageSection?: React.ReactNode;
    usedBySection?: React.ReactNode;
    worksOnSection?: React.ReactNode;
    /** How the account signed in ("Signed in with a code") and when a session last used it. */
    authenticationModeTitle?: string | null;
    lastUsedAt?: number | null;
    testID?: string;
}>;

const DEFAULT_TEST_ID = 'qualified-account-detail';

const NO_LOCAL_PROFILE_LABELS: Readonly<Record<string, string | undefined>> = Object.freeze({});

/** "First of 2 · in use now": where the account sits in the pool's order, and whether it is the active one. */
function describeMembership(group: QualifiedConnectedAccountUiGroup, account: QualifiedConnectedAccountRef): string {
    const ordered = [...group.members].sort((left, right) => left.priority - right.priority);
    const position = ordered.findIndex((member) => member.ref.accountId === account.accountId) + 1;
    return [
        t('connectedServicesCollection.poolPosition', { position, count: ordered.length }),
        group.activeAccountId === account.accountId ? t('connectedServicesCollection.poolInUseNow') : null,
    ].filter(Boolean).join(' · ');
}

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
        onOpenPool,
        rename,
        onShareWithTeam,
        onReconnect,
        onDisconnect,
    } = props;
    const testID = props.testID ?? DEFAULT_TEST_ID;

    const [disconnectPending, setDisconnectPending] = React.useState(false);
    const [renameOpen, setRenameOpen] = React.useState(false);
    const [moreOpen, setMoreOpen] = React.useState(false);
    const [compact, setCompact] = React.useState(false);
    const renameAnchorRef = React.useRef<View>(null);
    const identityAnchorRef = React.useRef<View>(null);

    const status = parseDisplayableCredentialHealthStatus(props.status);
    const email = providerEmail?.trim() ?? '';
    const providerAccount = providerAccountId?.trim() ?? '';

    const memberships = React.useMemo(
        () => (groups ?? []).filter((group) => isMemberOf(group, account)),
        [account, groups],
    );
    const showPools = groups !== undefined;
    const poolLabel = (group: QualifiedConnectedAccountUiGroup) => presentQualifiedConnectedAccountTarget({
        target: { kind: 'group', service: group.ref.service, groupId: group.ref.groupId },
        accounts: [],
        groups: [group],
        labelsByKey: NO_LOCAL_PROFILE_LABELS,
        serviceTitle: serviceLabel,
    }).primaryLabel;

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
        <ItemList testID={testID} pageColumn="wide" onLayout={(event) => {
            const width = event.nativeEvent.layout.width;
            if (width > 0) setCompact(width < PAGE_LIST_METRICS.rowStackBelowWidthPx);
        }}>
            <View ref={identityAnchorRef} collapsable={false}>
            <SettingsPageHeader
                testID={`${testID}:header`}
                title={presentation.primaryLabel}
                alwaysShowTitle
                compactPresentation="centered"
                primaryAction={compact && rename ? { testID: `${testID}:action:edit-label`, title: t('connectedServicesPool.rename'), onPress: () => setRenameOpen(true) } : undefined}
                leading={<ConnectedServiceMark legacyServiceId={props.legacyServiceId ?? null} size="page" />}
                titleAccessory={rename ? (
                    <View ref={renameAnchorRef} collapsable={false}>
                        {!compact ? <IconButton
                            testID={`${testID}:action:edit-label`}
                            iconName="pencil-simple"
                            size={26}
                            iconSize={14}
                            variant="plain"
                            accessibilityLabel={t('connectedServices.detail.actions.editLabel')}
                            tooltip={t('connectedServices.detail.actions.editLabel')}
                            onPress={() => setRenameOpen(true)}
                        /> : null}
                        <ConnectedAccountRenamePopover
                            testID={`${testID}:rename`}
                            open={renameOpen}
                            anchorRef={compact ? identityAnchorRef : renameAnchorRef}
                            currentLabel={rename.currentLabel}
                            serviceLabel={serviceLabel}
                            onSave={(label) => {
                                setRenameOpen(false);
                                rename.onRename(label);
                            }}
                            onRequestClose={() => setRenameOpen(false)}
                        />
                    </View>
                ) : undefined}
                // Who the account is, on one line (lab `csvc` D1): the email and the provider id go through the
                // identity renderer so "Hide account emails and IDs" blurs exactly their hidden runs.
                details={(
                    <View style={[stylesheet.facts, compact ? { justifyContent: 'center' } : null]}>
                        {email ? (
                            <View style={stylesheet.fact}>
                                {!compact ? <Icon name="envelope" size={ICON_SIZE.xs} color={theme.colors.text.secondary} /> : null}
                                <ConnectedAccountIdentityText testID={`${testID}:meta:email`} value={email} style={stylesheet.factText} numberOfLines={1} />
                            </View>
                        ) : null}
                        <Text testID={`${testID}:meta:plan`} style={stylesheet.factText} numberOfLines={1}>
                            {[serviceLabel, props.planLabel].filter(Boolean).join(' ')}
                        </Text>
                        {providerAccount && !compact ? (
                            <ConnectedAccountIdentityText
                                testID={`${testID}:meta:account-id`}
                                value={t('connectedServicesCollection.accountIdFact', { id: providerAccount })}
                                style={[stylesheet.factText, stylesheet.mono]}
                                numberOfLines={1}
                            />
                        ) : null}
                        {/* A state that is neither healthy nor signed out (a refresh that failed) is a quiet fact;
                            signed out speaks once, in the banner below. */}
                        {status && status !== 'connected' && status !== 'needs_reauth' ? (
                            <View style={stylesheet.fact}>
                                <Icon name="warning" size={ICON_SIZE.xs} color={theme.colors.state.warning.foreground} />
                                <Text testID={`${testID}:meta:status`} style={stylesheet.factText}>
                                    {resolveConnectedAccountCredentialStatusLabel(status)}
                                </Text>
                            </View>
                        ) : null}
                    </View>
                )}
                actions={<View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    {props.agentDefaults && props.agentDefaults.choices.length > 0 ? (
                    <AgentDefaultMenuButton
                        testID={`${testID}:default-for`}
                        choices={props.agentDefaults.choices}
                        onChange={props.agentDefaults.setDefault}
                    />
                    ) : null}
                    {props.onRefresh && status !== 'needs_reauth' ? compact
                        ? <RoundButton testID={`${testID}:refresh`} size="small" display="inverted" title={t('common.refresh')} leading={<Icon name="arrow-clockwise" size={14} />} loading={props.refreshing} disabled={props.refreshing} onPress={props.onRefresh} />
                        : <IconButton testID={`${testID}:refresh`} iconName="arrow-clockwise" variant="plain" accessibilityLabel={t('common.refresh')} disabled={props.refreshing} onPress={props.onRefresh} />
                        : null}
                    {!compact && (rename || onReconnect || onDisconnect || onShareWithTeam) ? <DropdownMenu open={moreOpen} onOpenChange={setMoreOpen} items={[
                        ...(rename ? [{ id: 'rename', title: t('connectedServicesPool.rename') }] : []),
                        ...(onReconnect ? [{ id: 'reconnect', title: t('connectedServicesSettings.signInAgain') }] : []),
                        ...(onShareWithTeam ? [{ id: 'share', title: t('teams.credentials.create.action') }] : []),
                        ...(onDisconnect ? [{ id: 'disconnect', title: t('modals.disconnect'), destructive: true }] : []),
                    ]} onSelect={(id) => {
                        if (id === 'rename') setRenameOpen(true);
                        if (id === 'reconnect') onReconnect?.();
                        if (id === 'share') onShareWithTeam?.();
                        if (id === 'disconnect') void handleDisconnect();
                    }} trigger={({ toggle }) => <IconButton testID={`${testID}:more`} iconName="dots-three" variant="plain" accessibilityLabel={t('connectedServicesPool.moreActions')} onPress={toggle} />} rowKind="item" /> : null}
                </View>}
            />
            </View>
            {status === 'needs_reauth' ? (
                // Signed out blocks this account, so the banner lives here (and only here), with the fix.
                <AttentionBanner
                    compactActionPlacement="full-width"
                    testID={`${testID}:signed-out-banner`}
                    title={t('connectedServicesSettings.detailSignedOutTitle', { service: serviceLabel })}
                    description={t(compact ? 'connectedServicesCollection.signedOutConsequence' : 'connectedServicesSettings.detailSignedOutBody')}
                    action={onReconnect ? {
                        label: t('connectedServicesSettings.signInAgain'),
                        display: 'default',
                        testID: `${testID}:signed-out-banner:sign-in-again`,
                        onPress: onReconnect,
                    } : null}
                />
            ) : null}
            {props.usageSection ?? null}
            {compact && providerAccount ? <ItemGroup title={t('connectedServices.profile.providerAccountId')}><Item title={t('connectedServices.profile.providerAccountId')} subtitle={<ConnectedAccountIdentityText value={providerAccount} style={stylesheet.mono} />} showChevron={false} mode="info" /></ItemGroup> : null}
            {props.usedBySection ?? null}
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
                                subtitle={describeMembership(group, account)}
                                icon={<Icon name="stack" size={17} color={theme.colors.text.secondary} />}
                                onPress={onOpenPool ? () => onOpenPool(group.ref.groupId) : undefined}
                                showChevron={onOpenPool !== undefined}
                                mode={onOpenPool ? 'interactive' : 'info'}
                            />
                        ))
                    ) : (
                        <EmptyState
                            testID={`${testID}:pools-empty`}
                            layout="line"
                            titleTestID={`${testID}:pools-empty:title`}
                            icon={<Icon name="stack-simple" size={ICON_SIZE.md} color={theme.colors.text.secondary} />}
                            title={t('connectedServices.profile.pools.emptyTitle')}
                            subtitle={t('connectedServices.profile.pools.emptySubtitle')}
                        />
                    )}
                </ItemGroup>
            ) : null}

            {onShareWithTeam ? (
                <ItemGroup>
                    <Item
                        testID={`${testID}:action:share-with-team`}
                        title={t('teams.credentials.create.action')}
                        onPress={onShareWithTeam}
                    />
                </ItemGroup>
            ) : null}
            {props.sharedWithTeamsAdministration}

            {props.worksOnSection ?? null}

            {props.onConfigureAccount ? (
                <ItemGroup>
                    <Item
                        testID={`${testID}:configuration`}
                        title={t('connectedServices.account.configurationTitle')}
                        detail={props.accountConfigurationBlocked ? t('common.blocked') : undefined}
                        disabled={props.configurationDisabled}
                        onPress={props.onConfigureAccount}
                    />
                </ItemGroup>
            ) : null}
            {props.serviceConfigurations && props.serviceConfigurations.length > 0 ? (
                <ItemGroup
                    title={t('connectedServicesSettings.serviceSettingsTitle')}
                    description={t('connectedServicesSettings.serviceSettingsDescription')}
                >
                    {props.serviceConfigurations.map((configuration) => (
                        <Item
                            key={configuration.modeId}
                            testID={`connected-service-configuration-settings:${configuration.modeId}`}
                            title={t('connectedServices.account.configurationTitle')}
                            detail={[configuration.title, configuration.blocked ? t('common.blocked') : null].filter(Boolean).join(' · ')}
                            disabled={props.configurationDisabled}
                            onPress={configuration.onConfigure}
                        />
                    ))}
                </ItemGroup>
            ) : null}

            {onReconnect || props.authenticationModeTitle ? (
                <ItemGroup title={t('connectedServicesSettings.detailSignInTitle')}>
                    <Item
                        testID={`${testID}:sign-in`}
                        title={props.authenticationModeTitle ?? t('connectedServices.detail.actions.reconnect')}
                        subtitle={[
                            status === 'needs_reauth'
                                ? t('connectedServicesSettings.detailSignInNeeded')
                                : t('connectedServicesSettings.detailSignInKeptFresh'),
                            props.lastUsedAt
                                ? t('connectedServicesSettings.detailLastUsed', { time: formatAsOfTime(props.lastUsedAt) })
                                : null,
                        ].filter(Boolean).join(' · ')}
                        mode="info"
                        showChevron={false}
                        rightElement={onReconnect ? (
                            <RoundButton
                                testID={`${testID}:action:reconnect`}
                                size="small"
                                display="secondary"
                                title={t('connectedServicesSettings.signInAgain')}
                                onPress={onReconnect}
                            />
                        ) : undefined}
                        rightElementOutsidePressable
                    />
                </ItemGroup>
            ) : null}

            {onDisconnect ? (
                // The irreversible action closes the page as a quiet button row, with its
                // consequence said once underneath.
                <ItemGroup surface="none">
                    <View style={stylesheet.dangerRow}>
                        {/* A pool that uses the account would refuse its removal: the way out of the pool comes first. */}
                        {memberships.map((group) => (
                            <RoundButton
                                key={group.ref.groupId}
                                testID={`${testID}:action:leave-pool:${group.ref.groupId}`}
                                size="small"
                                display="secondary"
                                title={t('connectedServicesSettings.detailLeavePool', { pool: poolLabel(group) })}
                                disabled={!onOpenPool}
                                onPress={() => onOpenPool?.(group.ref.groupId)}
                            />
                        ))}
                        <RoundButton
                            testID={`${testID}:action:disconnect`}
                            size="small"
                            display="destructive"
                            title={t('modals.disconnect')}
                            loading={disconnectPending}
                            disabled={memberships.length > 0}
                            onPress={handleDisconnect}
                        />
                    </View>
                    <Text style={stylesheet.dangerNote}>
                        {memberships.length > 0
                            ? t('connectedServicesSettings.detailRemovePooledNote', { pool: poolLabel(memberships[0]!) })
                            : t('connectedServices.profile.disconnectSubtitle')}
                    </Text>
                </ItemGroup>
            ) : null}
        </ItemList>
    );
});

QualifiedAccountDetailView.displayName = 'QualifiedAccountDetailView';

const stylesheet = StyleSheet.create((theme) => ({
    facts: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        columnGap: 14,
        rowGap: 2,
    },
    fact: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
        minWidth: 0,
    },
    factText: {
        fontSize: 13.5,
        lineHeight: 19,
        color: theme.colors.text.secondary,
    },
    mono: {
        fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'ui-monospace, SFMono-Regular, Menlo, monospace' }),
        fontSize: 12.5,
    },
    dangerRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        justifyContent: 'flex-end',
        gap: 8,
    },
    dangerNote: {
        marginTop: 8,
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.text.secondary,
        textAlign: 'right',
    },
}));
