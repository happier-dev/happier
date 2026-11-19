import * as React from 'react';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { View } from 'react-native';
import { readHappierVisibleLayoutWidth } from '@happier-dev/plugin-ui/presentation/pageMetrics';
import { PageHeaderMenu, type PageHeaderMenuIntent } from '@/components/ui/layout/PageHeaderEntityParts';
import { PAGE_LIST_METRICS } from '@/components/ui/lists/pageListMetrics';

import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { SurfaceFreshnessOnSheetProvider } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import type { QualifiedConnectedAccountUiGroup } from '@/sync/domains/connectedServices/qualifiedConnectedAccountUiSource';
import { t } from '@/text';
import { type QualifiedConnectedAccountRef } from '@happier-dev/protocol/connect/qualifiedConnectedAccountPersistence';
import type { QualifiedConnectedAccountProfileV4 } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';

import { isConnectedAccountSignedOut, parseDisplayableCredentialHealthStatus } from '@/sync/domains/connectedServices/parseDisplayableCredentialHealthStatus';
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
import { CredentialShareButton, useCredentialShareAction } from '@/components/sharing/credentials/CredentialShareSheet';
import type { TeamCredentialSourceHint } from '@/components/settings/teams/teamsRoutes';
import { AccountDetailUsedBySectionView, type AccountDetailUsedBySlots } from './AccountDetailSections';
import { formatAsOfTime } from '@/utils/time/formatAsOfTime';
import { useCopyProviderAccountId } from './useCopyProviderAccountId';
import {
    describeConnectedAccountIncludedApiKey,
    presentConnectedAccountAccessMode,
    type ConnectedAccountAccessMode,
    type ConnectedAccountIncludedApiKey,
} from '../model/presentConnectedAccountAccessMode';

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
    statusReason?: QualifiedConnectedAccountProfileV4['statusReason'];
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
    labelsByKey?: Readonly<Record<string, string | undefined>>;
    /** The plan the provider reports ("Pro"), shown with the service in the header. */
    planLabel?: string | null;
    /** Subscription or API key, from the account's record; the header's meta says it once (lab `muse-accounts` A1). */
    accessMode?: ConnectedAccountAccessMode | null;
    /** A key the account created when it connected: a fact row in Sign-in, never its value. */
    includedApiKey?: ConnectedAccountIncludedApiKey | null;
    /** ★ "Default for <agent>": the per-agent default menu (never a per-service default). */
    agentDefaults?: Readonly<{
        choices: readonly AgentDefaultChoice[];
        setDefault: (agentId: string, makeDefault: boolean) => void | Promise<void>;
        disabledReason?: string;
    }> | null;
    /**
     * Every callback below gates its affordance: an absent callback removes the
     * row instead of disabling it, so the screen never implies a mutation the
     * caller cannot reach (permissions, unsupported peer, read-only surface).
     */
    onOpenPool?: (groupId: string) => void;
    /** Rename in place (lab D2): the name people gave the account, and the writer of a new one. */
    rename?: Readonly<{ currentLabel: string; onRename: (label: string) => void | boolean | Promise<void | boolean> }>;
    /** Where this account is shared from: the header Share action opens the one credential share sheet. */
    shareSource?: TeamCredentialSourceHint;
    /** An API-key account's key (value, Replace, what else picks it), from its Saved Secret record. */
    keySection?: React.ReactNode;
    sharedWithTeamsAdministration?: React.ReactNode;
    onReconnect?: () => void;
    /** One shared Action, presented in Sign-in and overflow for every connected account. */
    testConnection?: Readonly<{
        run(): void | Promise<void>;
        pending: boolean;
        disabledReason?: string;
        message?: string;
    }>;
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
    /**
     * Used by (lab `s2svc:account`): one section for the agents that sign in with the account, the pools
     * that hold it and the ★ default control. The wiring owner supplies the agent rows' reader; this view
     * hands it the pool rows and the default control, so the section stays one card.
     */
    renderUsedBy?: (slots: AccountDetailUsedBySlots) => React.ReactNode;
    worksOnSection?: React.ReactNode;
    machineSetupSection?: React.ReactNode;
    /**
     * The one quiet line saying which machine signing in again and removing run on, when none is usable.
     * It is a row of the Sign-in group, not a sheet of its own.
     */
    machineScopeLine?: React.ReactNode;
    /** A reconnect stays inside this account's existing Sign-in section. */
    signInFlow?: React.ReactNode;
    /** How the account signed in ("Signed in with a code") and when a session last used it. */
    authenticationModeTitle?: string | null;
    /** Held authentication evidence; absence is unknown, including native imports. */
    authenticationProvenance?: QualifiedConnectedAccountProfileV4['authenticationProvenance'];
    /** The provenance Machine's name when this Home knows it; otherwise the row says when, not where. */
    authenticationMachineName?: string | null;
    /** Credential-health refresh time, not quota freshness or a new sign-in. */
    lastRefreshSuccessAt?: QualifiedConnectedAccountProfileV4['lastRefreshSuccessAt'];
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
 * a second press from stacking shared Action invocations.
 *
 * The account's NAME (header title and identity) arrives from the
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
        onReconnect,
        onDisconnect,
    } = props;
    const testID = props.testID ?? DEFAULT_TEST_ID;
    const planLabel = props.planLabel?.trim();
    const planIncludesService = planLabel === serviceLabel || planLabel?.startsWith(`${serviceLabel} `);
    const servicePlanLabel = planIncludesService ? planLabel : [serviceLabel, planLabel].filter(Boolean).join(' ');
    // With a recorded mode the meta says it once: the plan (or "Subscription"), or "API key · ends 7Qa2".
    const modeLabel = props.accessMode
        ? presentConnectedAccountAccessMode(props.accessMode, planLabel ? servicePlanLabel : null)
        : servicePlanLabel;

    const [disconnectPending, setDisconnectPending] = React.useState(false);
    const [renameOpen, setRenameOpen] = React.useState(false);
    const { copyProviderAccountId, onMenuOpenChange } = useCopyProviderAccountId();
    const share = useCredentialShareAction({ name: presentation.primaryLabel, source: props.shareSource });
    const [compact, setCompact] = React.useState(false);
    const renameAnchorRef = React.useRef<View>(null);

    const status = parseDisplayableCredentialHealthStatus(props.status);
    const signedOut = isConnectedAccountSignedOut(status);
    // An account titled by its email (no name of its own, or a name that is that address) doesn't repeat it.
    const providerEmailText = providerEmail?.trim() ?? '';
    const email = presentation.primaryLabelKind === 'email' || presentation.primaryLabel.trim() === providerEmailText
        ? '' : providerEmailText;
    const providerAccount = providerAccountId?.trim() ?? '';
    const provenance = props.authenticationProvenance;
    const signInFacts = [
        props.lastRefreshSuccessAt
            ? t('connectedServicesSettings.detailRefreshedAt', { time: formatAsOfTime(props.lastRefreshSuccessAt) })
            : null,
        provenance
            ? props.authenticationMachineName
                ? t('connectedServicesSettings.detailSignedInOnMachine', { time: formatAsOfTime(provenance.authenticatedAt), machine: props.authenticationMachineName })
                : t('connectedServicesSettings.detailSignedInAt', { time: formatAsOfTime(provenance.authenticatedAt) })
            : null,
    ].filter((fact): fact is string => fact !== null);
    const lastUsedFact = props.lastUsedAt
        ? t('connectedServicesSettings.detailLastUsed', { time: formatAsOfTime(props.lastUsedAt) })
        : null;

    const memberships = React.useMemo(
        () => (groups ?? []).filter((group) => isMemberOf(group, account)),
        [account, groups],
    );
    const showPools = groups !== undefined;
    const poolLabel = (group: QualifiedConnectedAccountUiGroup) => presentQualifiedConnectedAccountTarget({
        target: { kind: 'group', service: group.ref.service, groupId: group.ref.groupId },
        accounts: [],
        groups: [group],
        labelsByKey: props.labelsByKey ?? NO_LOCAL_PROFILE_LABELS,
        serviceTitle: serviceLabel,
    }).primaryLabel;

    const handleDisconnect = React.useCallback(async () => {
        if (!onDisconnect || disconnectPending) return;
        setDisconnectPending(true);
        try {
            await onDisconnect();
        } finally {
            setDisconnectPending(false);
        }
    }, [disconnectPending, onDisconnect]);

    // "email · ChatGPT Pro · in Codex pool" (lab `s2svc:account`): one line of facts, read left to right.
    const factSeparator = <Text style={stylesheet.factSeparator} accessibilityElementsHidden importantForAccessibility="no">·</Text>;
    const connectionTest = props.testConnection;
    const connectionTestUnavailable = connectionTest?.disabledReason
        ?? (!connectionTest ? t('connectedServicesSettings.testConnectionUnsupported') : undefined);
    const connectionTestTitle = t('connectedServicesSettings.testConnection');
    // A key has no sign-in (lab `muse-accounts` A1): Replace lives with the key and the page ends with "Remove key".
    const isKey = props.accessMode?.kind === 'apiKey';
    const disconnectTitle = isKey ? t('connectedServicesSettings.detailRemoveKey') : t('connectedServicesSettings.detailRemoveAccount');
    const hasSignInRow = Boolean(onReconnect || props.authenticationModeTitle || props.signInFlow);
    const signInFlow = props.signInFlow ? <SectionContentRow>
        <SurfaceFreshnessOnSheetProvider>{props.signInFlow}</SurfaceFreshnessOnSheetProvider>
    </SectionContentRow> : null;
    const defaultControl = props.agentDefaults ? (
        <AgentDefaultMenuButton
            testID={`${testID}:default-for`}
            choices={props.agentDefaults.choices}
            onChange={props.agentDefaults.setDefault}
            disabledReason={props.agentDefaults.disabledReason}
        />
    ) : null;
    // The pools that hold the account sit with the agents it serves (lab `s2svc:account` Used by).
    const poolRows = showPools ? (memberships.length > 0 ? memberships.map((group) => (
        <Item
            key={group.ref.groupId}
            testID={`${testID}:pool:${group.ref.groupId}`}
            title={poolLabel(group)}
            subtitle={describeMembership(group, account)}
            icon={<Icon name="stack" size={17} color={theme.colors.text.secondary} />}
            onPress={onOpenPool ? () => onOpenPool(group.ref.groupId) : undefined}
            showChevron={onOpenPool !== undefined}
            mode={onOpenPool ? 'interactive' : 'info'}
        />
    )) : (
        <EmptyState
            testID={`${testID}:pools-empty`}
            layout="line"
            titleTestID={`${testID}:pools-empty:title`}
            icon={<Icon name="stack-simple" size={ICON_SIZE.md} color={theme.colors.text.secondary} />}
            title={t('connectedServices.profile.pools.emptyTitle')}
            subtitle={t('connectedServices.profile.pools.emptySubtitle')}
        />
    )) : null;
    const usedBySlots: AccountDetailUsedBySlots = { action: defaultControl, children: poolRows };
    const usedBy = props.renderUsedBy
        ? props.renderUsedBy(usedBySlots)
        : <AccountDetailUsedBySectionView rows={[]} {...usedBySlots} />;

    return (
        <ItemList testID={testID} pageColumn="wide" onLayout={(event) => {
            const width = readHappierVisibleLayoutWidth(event.nativeEvent.layout.width);
            if (width !== null) setCompact(width < PAGE_LIST_METRICS.rowStackBelowWidthPx);
        }}>
            <SettingsPageHeader
                testID={`${testID}:header`}
                title={presentation.primaryLabel}
                alwaysShowTitle
                compactPresentation="centered"
                leading={<ConnectedServiceMark service={props.account.service} legacyServiceId={props.legacyServiceId ?? null} size="page" />}
                titleAccessory={rename ? (
                    <View ref={renameAnchorRef} collapsable={false}>
                        {/* Renaming is rare: the pencil beside the name, on a phone too, never the bar's primary. */}
                        {<IconButton
                            testID={`${testID}:action:edit-label`}
                            iconName="pencil-simple"
                            size={26}
                            iconSize={14}
                            variant="plain"
                            accessibilityLabel={t('connectedServices.detail.actions.editLabel')}
                            tooltip={t('connectedServices.detail.actions.editLabel')}
                            onPress={() => setRenameOpen(true)}
                        />}
                        <ConnectedAccountRenamePopover
                            testID={`${testID}:rename`}
                            open={renameOpen}
                            anchorRef={renameAnchorRef}
                            currentLabel={rename.currentLabel}
                            serviceLabel={serviceLabel}
                            onSave={async (label) => {
                                if (await rename.onRename(label) !== false) setRenameOpen(false);
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
                                <ConnectedAccountIdentityText testID={`${testID}:meta:email`} value={email} style={stylesheet.factText} numberOfLines={1} />
                            </View>
                        ) : null}
                        {email ? factSeparator : null}
                        <Text testID={`${testID}:meta:plan`} style={stylesheet.factText} numberOfLines={1}>
                            {modeLabel}
                        </Text>
                        {memberships.length > 0 ? factSeparator : null}
                        {memberships.length > 0 ? (
                            <Text testID={`${testID}:meta:pool`} style={stylesheet.factText} numberOfLines={1}>
                                {t('connectedServicesSettings.detailInPool', { pool: poolLabel(memberships[0]!) })}
                            </Text>
                        ) : null}
                        {/* A state that is neither healthy nor signed out (a refresh that failed) is a quiet fact;
                            signed out speaks once, in the banner below. */}
                        {status && status !== 'connected' && !signedOut ? (
                            <View style={stylesheet.fact}>
                                <Icon name="warning" size={ICON_SIZE.xs} color={theme.colors.state.warning.foreground} />
                                <Text testID={`${testID}:meta:status`} style={stylesheet.factText}>
                                    {resolveConnectedAccountCredentialStatusLabel(status)}
                                </Text>
                            </View>
                        ) : null}
                    </View>
                )}
                actions={<View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space.s8 }}>
                    {/* Wide, Share is the header's one button (lab `muse-accounts` A1); a phone keeps it in the ⋯ menu. */}
                    {share && !compact && props.shareSource ? (
                        <CredentialShareButton testID={`${testID}:share`} name={presentation.primaryLabel} source={props.shareSource} />
                    ) : null}
                    {/* Wide, the Usage section's "As of · Refresh" owns refresh; a phone's Usage drops its button, so the bar carries it. */}
                    {props.onRefresh && !signedOut && compact
                        ? <RoundButton testID={`${testID}:refresh`} display="inverted" title={t('common.refresh')} leading={<Icon name="arrow-clockwise" size={14} />} loading={props.refreshing} disabled={props.refreshing} onPress={props.onRefresh} />
                        : null}
                    {/* The ⋯ menu holds rare actions, on a phone too: the provider's raw id is copied from here, never a page row. */}
                    <PageHeaderMenu
                        triggerTestID={`${testID}:more`}
                        accessibilityLabel={t('connectedServicesPool.moreActions')}
                        onOpenChange={onMenuOpenChange}
                        // A key has no Sign-in section, so its connection test lives here.
                        actions={[
                            ...(providerAccount ? [{ id: 'copy-account-id', title: t('connectedServicesSettings.detailCopyAccountId'), onSelect: () => copyProviderAccountId(providerAccount) }] : []),
                            ...(isKey ? [{ id: 'test-connection', title: connectionTestTitle,
                                disabled: !connectionTest || Boolean(connectionTestUnavailable), loading: connectionTest?.pending,
                                subtitle: connectionTestUnavailable ?? connectionTest?.message,
                                onSelect: () => connectionTest?.run() }] : []),
                            ...(share && compact ? [{ id: 'share', testID: `${testID}:share`, title: t('secretsSettings.share'), onSelect: (intent?: PageHeaderMenuIntent) => share(intent?.anchor) }] : []),
                            ...(onDisconnect ? [{
                                id: 'disconnect', testID: `${testID}:menu:disconnect`, title: disconnectTitle,
                                destructive: true, loading: disconnectPending, onSelect: handleDisconnect,
                            }] : []),
                        ]}
                    />
                </View>}
            />
            {signedOut ? (
                // Signed out blocks this account, so the banner lives here (and only here), with the fix.
                <AttentionBanner
                    compactActionPlacement="full-width"
                    testID={`${testID}:signed-out-banner`}
                    title={resolveConnectedAccountCredentialStatusLabel(status, props.statusReason)}
                    // A running sign-in (in the Sign-in section below) is the fix in progress, not one to start again.
                    action={onReconnect && !props.signInFlow ? {
                        label: t('connectedServicesSettings.signInAgain'),
                        display: 'default',
                        testID: `${testID}:signed-out-banner:sign-in-again`,
                        onPress: onReconnect,
                    } : null}
                />
            ) : null}
            {props.keySection ?? null}
            {props.usageSection ?? null}
            {usedBy}

            {/* Lab `s2svc:account`: identity, Usage, Used by and pools, then Sign-in with where it works and the
                machine its operations run on, configuration, sharing, and removal last. */}
            {isKey ? (
                signInFlow || props.machineScopeLine ? <ItemGroup>{signInFlow}{props.machineScopeLine}</ItemGroup> : null
            ) : <ItemGroup title={t('connectedServicesSettings.detailSignInTitle')}>
                    {hasSignInRow ? <Item
                        testID={`${testID}:sign-in`}
                        title={props.authenticationModeTitle ?? t('connectedServices.detail.actions.reconnect')}
                        // Provenance and freshness are said only when they are held (a native import or an older
                        // record knows neither); last use is the quiet fallback, then the credential's own state —
                        // never an invented sign-in, and never a row without a state line.
                        subtitle={[
                            signedOut ? t('connectedServicesSettings.detailSignInNeeded') : null,
                            ...(signInFacts.length > 0 ? signInFacts : [lastUsedFact]),
                        ].filter(Boolean).join(' · ') || (status && !signedOut ? resolveConnectedAccountCredentialStatusLabel(status) : undefined)}
                        mode="info"
                        showChevron={false}
                        // Signed out, the banner above owns Sign in again; a running sign-in owns this section.
                        rightElement={onReconnect && !signedOut && !props.signInFlow ? (
                            <RoundButton
                                testID={`${testID}:action:reconnect`}
                                size="small"
                                display="secondary"
                                title={t('connectedServicesSettings.signInAgain')}
                                onPress={onReconnect}
                            />
                        ) : undefined}
                        rightElementOutsidePressable
                    /> : null}
                    {/* A running or waiting sign-in continues the row above it, drawn on this sheet rather than as a
                        second box inside it. */}
                    {signInFlow}
                    {/* One row, one decision: the row names what it checks and its last result; the button is the verb. */}
                    <Item
                        testID={`${testID}:test-connection`}
                        title={t('connectedServicesSettings.detailConnectionTitle')}
                        subtitle={connectionTestUnavailable ?? connectionTest?.message ?? t('connectedServicesSettings.detailConnectionHint')}
                        mode="info"
                        showChevron={false}
                        rightElement={<RoundButton
                            testID={`${testID}:action:test-connection`}
                            size="small"
                            display="secondary"
                            title={t('connectedServicesSettings.detailConnectionTest')}
                            accessibilityLabel={connectionTestTitle}
                            loading={connectionTest?.pending}
                            disabled={!connectionTest || Boolean(connectionTestUnavailable) || connectionTest.pending}
                            onPress={() => { void connectionTest?.run(); }}
                        />}
                        rightElementOutsidePressable
                    />
                    {/* A fact, not a control: the key exists because the account connected; its value stays sealed. */}
                    {props.includedApiKey ? <Item
                        testID={`${testID}:included-api-key`}
                        title={t('connectedServicesSettings.detailIncludesApiKey')}
                        subtitle={describeConnectedAccountIncludedApiKey(props.includedApiKey)}
                        mode="info"
                        showChevron={false}
                    /> : null}
                    {props.worksOnSection ?? null}
                    {props.machineScopeLine ?? null}
            </ItemGroup>}
            {props.machineSetupSection ?? null}

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

            {props.sharedWithTeamsAdministration}

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
                            title={disconnectTitle}
                            loading={disconnectPending}
                            onPress={handleDisconnect}
                        />
                    </View>
                    <Text style={stylesheet.dangerNote}>
                        {memberships.length > 0
                            ? t('connectedServicesSettings.detailRemovePooledNote', { pool: poolLabel(memberships[0]!) })
                            : isKey ? t('connectedServicesSettings.detailRemoveKeyNote')
                            : t('connectedServicesSettings.detailRemoveNote', { service: serviceLabel })}
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
        columnGap: theme.space.s6,
        rowGap: theme.space.s2,
    },
    fact: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s4,
        minWidth: 0,
    },
    factSeparator: {
        ...Typography.variant('body'),
        color: theme.colors.text.tertiary,
    },
    factText: {
        ...Typography.variant('body'),
        color: theme.colors.text.secondary,
    },
    dangerRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        // Removal closes the page as the pool page's Delete does (lab `s2svc:account`/`s2svc:pool`): from the column's edge.
        justifyContent: 'flex-start',
        gap: theme.space.s8,
    },
    dangerNote: {
        marginTop: theme.space.s8,
        ...Typography.variant('body'),
        color: theme.colors.text.secondary,
    },
}));
