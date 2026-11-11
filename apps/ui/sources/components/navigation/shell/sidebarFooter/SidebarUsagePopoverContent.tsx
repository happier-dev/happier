import * as React from 'react';
import { parseQualifiedPluginContributionKey, type PluginContributionIdentityV1 } from '@happier-dev/protocol/plugins/contribution-identity';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { SurfaceAsOfLabel } from '@/components/ui/surfaces/SurfaceAsOfLabel';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { groupUsageByProvider, type UsageAccountRow } from '@/components/hub/usage/usageByProvider';
import { useUsageSummary, type UsageSummary } from '@/components/hub/usage/useUsageSummary';
import { ConnectedAccountIdentityText } from '@/components/settings/connectedServices/ConnectedAccountIdentityText';
import { ConnectedServiceMark } from '@/components/settings/connectedServices/ConnectedServiceMark';
import { presentConnectSheet } from '@/components/settings/connectedServices/setup/ConnectedServiceSetupModal';
import {
    AccountSubscriptionLine,
    AccountUsageResetsLine,
    type AccountUsageResetsAction,
} from '@/components/settings/connectedServices/usage/AccountUsageFacts';
import { ConnectedAccountPrivacyToggle } from '@/components/settings/connectedServices/usage/ConnectedAccountPrivacyToggle';
import { UsageMeterRow, UsageMeterStack } from '@/components/settings/connectedServices/usage/UsageMeterRow';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import type { PopoverAnchor } from '@/components/ui/popover/_types';
import { resolvePressTriggerAnchor } from '@/components/ui/popover/resolvePointerMenuAnchor';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { Icon } from '@/components/ui/icons/Icon';
import { ActionListSection } from '@/components/ui/lists/ActionListSection';
import { MENU_ROW_METRICS } from '@/components/ui/lists/itemDensityMetrics';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import {
    useConnectedServiceQuotaSummaries,
    type ConnectedServiceAccountNeedingSignIn,
} from '@/hooks/server/connectedServices/useConnectedServiceQuotaSummaries';
import { useProviderAccountUsageSnapshots } from '@/hooks/server/connectedServices/useProviderAccountUsageSnapshots';
import {
    useConnectedAccountIdentityPrivacy,
    type ConnectedAccountIdentityPresenter,
} from '@/hooks/ui/useConnectedAccountIdentityPrivacy';
import type { MeterTone } from '@/components/ui/lists/MeterBar';
import type { ConnectedServiceId } from '@happier-dev/protocol/connect/connected-service-bindings';
import type { ConnectedServiceQuotaMeterV1, ConnectedServiceQuotaRecoveryCreditsV1 } from '@happier-dev/protocol/connect/connected-service-schemas';
import type { ProviderAccountSubscriptionV1 } from '@happier-dev/protocol/connect/accountSubscription';
import { t } from '@/text';
import {
    presentConnectedAccountNames,
    type ConnectedAccountNamePresentation,
} from '@/sync/domains/connectedServices/qualifiedConnectedAccountTargetPresentation';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { formatConnectedServiceQuotaReportedAmount } from '@/sync/domains/connectedServices/accountUsage/formatProviderUsageAmount';
import type { ConnectedServiceQuotaReportedAmount } from '@/sync/domains/connectedServices/accountUsage/presentProviderConnectionUsage';

import type { SidebarFooterPopoverContentProps } from './SidebarFooterPopoverButton';

/** Text starts where a menu row's text starts, so the heading, accounts and the footer row align. */
const CONTENT_INSET_PX = MENU_ROW_METRICS.paddingHorizontalPx;

/** An account's facts beside its meters: its subscription and its usage resets (this launch's read). */
export type UsagePopoverAccountFacts = Readonly<{
    subscription: ProviderAccountSubscriptionV1 | null;
    recoveryCredits: ConnectedServiceQuotaRecoveryCreditsV1 | null;
}>;

/**
 * What the popover shows beside usage: who needs a new sign-in, the keys without limits, and each read
 * account's subscription and usage resets (by usage summary key).
 */
export type SidebarUsageAccountFacts = Readonly<{
    accountsNeedingSignIn: readonly ConnectedServiceAccountNeedingSignIn[];
    keysWithoutLimits: number;
    accounts?: Readonly<Record<string, UsagePopoverAccountFacts>>;
}>;

/** "Hide account emails and IDs" as the popover uses it: the setting, its eye, and the one presenter. */
export type UsagePopoverPrivacy = Readonly<{
    hidden: boolean;
    setHidden: (hidden: boolean) => void;
    present: ConnectedAccountIdentityPresenter;
}>;

/** Refresh and its state belong to the connected-account quota store, not the popover. */
export type UsagePopoverRefresh = Readonly<{
    keys: readonly string[];
    loadingByKey?: Readonly<Record<string, boolean>>;
    refreshingByKey: Readonly<Record<string, boolean>>;
    errorsByKey: Readonly<Record<string, string | null>>;
    run(keys?: readonly string[]): Promise<void>;
}>;

/** One window of a group that is not a connected account (a session that signs in on its own). */
export type UsagePopoverWindow = Readonly<{
    meterId: string;
    label: string;
    remainingPct: number | null;
    resetsAt: number | null;
    tone: MeterTone;
    reportedAmount?: ConnectedServiceQuotaReportedAmount;
    status?: ConnectedServiceQuotaMeterV1['status'];
}>;

/**
 * The composer ring's scope (lab `csvc` U3): the account this session signs in with, how it signs in
 * (the scope line), and what its pool does when that account runs out. `accountKey` comes only from
 * the session's own binding (`resolveSessionUsageAccount`); without it the popover shows every account.
 */
export type UsagePopoverSession = Readonly<{
    /** "Claude Code signs in through Work": how the session signs in, or null when unknown. */
    scopeLine: string | null;
    /** The usage summary key of the account the session signs in with (known from its binding). */
    accountKey: string | null;
    /**
     * The session signs in on its own: the session gauge's own windows under the service's name, and
     * its usage resets, applied through the session's own reset action.
     */
    ownSignIn: Readonly<{
        title: string;
        legacyServiceId: string | null;
        windows: readonly UsagePopoverWindow[];
        recoveryCredits: ConnectedServiceQuotaRecoveryCreditsV1 | null;
        resetAction: AccountUsageResetsAction | null;
    }> | null;
    /** What the session's pool does when its account runs out; null without a pool. */
    nextMove: string | null;
}>;

const NO_FACTS: SidebarUsageAccountFacts = Object.freeze({ accountsNeedingSignIn: [], keysWithoutLimits: 0 });

/**
 * The rail's Usage popover (lab `csvc` U1): one component whether the pointer rests on the rail icon
 * or a click pins it. Every connected account with what is left in each window and when it comes
 * back, a signed-out account with its fix, and the keys that report no limits. It reads the one usage
 * owner (`useUsageSummary`: retained content with visible-demand revalidation and its "as of") and
 * mounts only while open.
 */
export function SidebarUsagePopoverContent(props: SidebarFooterPopoverContentProps) {
    const router = useRouter();
    const handlers = useUsagePopoverHandlers({ close: props.close, router });
    const data = useUsagePopoverData();
    return (
        <SidebarUsagePopoverView
            usage={data.usage}
            facts={data.facts}
            privacy={data.privacy}
            refresh={data.refresh}
            onOpenConnectedServices={handlers.openConnectedServices}
            onOpenUsage={handlers.openUsage}
            onSignInAgain={handlers.signInAgain}
        />
    );
}

/** The data every Usage popover reads (rail and session): usage, the facts beside it, the privacy setting. */
export function useUsagePopoverData(): Readonly<{
    usage: UsageSummary;
    facts: SidebarUsageAccountFacts;
    privacy: UsagePopoverPrivacy;
    refresh: UsagePopoverRefresh;
}> {
    const usage = useUsageSummary({ load: 'visible' });
    // The facts beside usage come from the same summaries owner the usage summary reads.
    const quota = useConnectedServiceQuotaSummaries({ fetchPolicy: 'cache_only' });
    // Each read account's subscription lives on its provider usage record (one batched read while open).
    const recordIds = React.useMemo(
        () => Object.values(quota.usageRecordIdsByKey).filter((id): id is NonNullable<typeof id> => id !== null),
        [quota.usageRecordIdsByKey],
    );
    const usageRecords = useProviderAccountUsageSnapshots(recordIds, { loading: true });
    const accounts = React.useMemo(() => {
        const byKey: Record<string, UsagePopoverAccountFacts> = {};
        for (const summary of quota.summaries) {
            const recordId = quota.usageRecordIdsByKey[summary.key] ?? null;
            byKey[summary.key] = {
                subscription: recordId ? usageRecords.snapshotsByRecordId[recordId]?.subscription ?? null : null,
                recoveryCredits: summary.recoveryCredits,
            };
        }
        return byKey;
    }, [quota.summaries, quota.usageRecordIdsByKey, usageRecords.snapshotsByRecordId]);
    const facts = React.useMemo((): SidebarUsageAccountFacts => ({
        accountsNeedingSignIn: quota.accountsNeedingSignIn,
        keysWithoutLimits: quota.keysWithoutLimits,
        accounts,
    }), [accounts, quota.accountsNeedingSignIn, quota.keysWithoutLimits]);
    const privacy = useConnectedAccountIdentityPrivacy({ mutation: true });
    const loadingByKey = React.useMemo(() => {
        const loading = { ...quota.loadingByKey };
        for (const [key, recordId] of Object.entries(quota.usageRecordIdsByKey)) {
            if (recordId && usageRecords.loadingByRecordId[recordId]) loading[key] = true;
        }
        return loading;
    }, [quota.loadingByKey, quota.usageRecordIdsByKey, usageRecords.loadingByRecordId]);
    const refresh = React.useMemo((): UsagePopoverRefresh => ({
        keys: quota.refreshableKeys,
        loadingByKey,
        refreshingByKey: quota.refreshingByKey,
        errorsByKey: quota.errorsByKey,
        run: quota.refresh,
    }), [loadingByKey, quota.refreshableKeys, quota.refreshingByKey, quota.errorsByKey, quota.refresh]);
    return { usage, facts, privacy, refresh };
}

/** Opening the Usage page or Credentials, and signing an account in again, close the popover first. */
export function useUsagePopoverHandlers(params: Readonly<{ close: () => void; router: ReturnType<typeof useRouter> }>) {
    const { close, router } = params;
    const scope = useActiveServerAccountScope();
    const openConnectedServices = React.useCallback(() => {
        close();
        const result = runGuardedNavigation(() => router.push(SETTINGS_ROUTES.connectedServices as never));
        if (result !== true) fireAndForget(result, { tag: 'UsagePopover.openConnectedServices' });
    }, [close, router]);
    const openUsage = React.useCallback(() => {
        close();
        const result = runGuardedNavigation(() => router.push(SETTINGS_ROUTES.usage as never));
        if (result !== true) fireAndForget(result, { tag: 'UsagePopover.openUsage' });
    }, [close, router]);
    const signInAgain = React.useCallback((account: ConnectedServiceAccountNeedingSignIn, anchor?: PopoverAnchor) => {
        close();
        fireAndForget(presentConnectSheet({ scope, intent: 'reconnect', service: account.ref.service, account: account.ref, ...(anchor ? { anchor } : {}) }),
            { tag: 'UsagePopover.signInAgain' });
    }, [close, scope]);
    return { openConnectedServices, openUsage, signInAgain };
}

/**
 * The Usage popover's body, rail (U1) and session (U3): the same account groups either way. With a
 * `session`, it first shows the session's own account, how it signs in and its pool's next move;
 * "All accounts" widens it in place to the rail's list. The dev fixtures render it with fixture data.
 */
export function SidebarUsagePopoverView(props: Readonly<{
    usage: UsageSummary;
    facts?: SidebarUsageAccountFacts;
    privacy: UsagePopoverPrivacy;
    session?: UsagePopoverSession | null;
    refresh?: UsagePopoverRefresh;
    /** The header's gear: Credentials, where every account here is managed. */
    onOpenConnectedServices: () => void;
    /** The header's chart: the Usage page, the whole picture behind this preview. */
    onOpenUsage: () => void;
    onSignInAgain?: (account: ConnectedServiceAccountNeedingSignIn, anchor?: PopoverAnchor) => void;
}>) {
    const { theme } = useUnistyles();
    const { usage, privacy, session } = props;
    const facts = props.facts ?? NO_FACTS;
    const [widened, setWidened] = React.useState(false);
    const accounts = React.useMemo(
        () => groupUsageByProvider(usage.accounts).flatMap((provider) => provider.accounts.map((account) => ({ provider, account }))),
        [usage.accounts],
    );
    const now = Date.now();

    // Known identity owns the scope even before a usage reading exists. Only an unknown identity
    // or the explicit All accounts action shows the rail's complete list.
    const sessionAccount = session?.accountKey
        ? accounts.find((entry) => entry.account.key === session.accountKey) ?? null
        : null;
    const sessionSignedOut = session?.accountKey && !sessionAccount
        ? facts.accountsNeedingSignIn.find((account) => account.key === session.accountKey) ?? null
        : null;
    const scoped = session != null && !widened
        && (session.accountKey !== null || session.ownSignIn !== null);
    const total = accounts.length + facts.accountsNeedingSignIn.length;
    const nothing = total === 0 && !scoped;
    const refresh = props.refresh;
    const refreshKeys = scoped
        ? refresh?.keys.filter((key) => key === session?.accountKey) ?? []
        : refresh?.keys ?? [];
    const refreshing = refreshKeys.some((key) => refresh?.refreshingByKey[key] === true || refresh?.loadingByKey?.[key] === true);
    const refreshError = refreshKeys.map((key) => refresh?.errorsByKey[key]).find((error) => error != null);
    const shownAsOf = scoped ? sessionAccount?.account.fetchedAt ?? null : usage.asOf;

    // Every account shown together is named at once, so two that read as their service's account are
    // told apart by the one naming owner instead of each row naming itself.
    const names = React.useMemo(() => presentConnectedAccountNames([
        ...accounts.map(({ provider, account }) => ({
            key: account.key, serviceTitle: provider.serviceLabel, displayName: account.label,
            email: account.email, accountId: account.accountId, presentIdentity: privacy.present,
        })),
        ...facts.accountsNeedingSignIn.map((account) => ({
            key: account.key, serviceTitle: account.serviceLabel, displayName: account.accountLabel,
            email: account.accountEmail, accountId: account.accountId, presentIdentity: privacy.present,
        })),
    ]), [accounts, facts.accountsNeedingSignIn, privacy.present]);

    const renderAccount = (entry: (typeof accounts)[number]) => (
        <UsageAccountGroup
            key={entry.account.key}
            serviceLabel={entry.provider.serviceLabel}
            service={parseQualifiedPluginContributionKey(entry.provider.key)}
            legacyServiceId={entry.provider.legacyServiceId}
            account={entry.account}
            facts={facts.accounts?.[entry.account.key] ?? null}
            name={names.get(entry.account.key)!}
            now={now}
        />
    );
    const renderSignedOut = (account: ConnectedServiceAccountNeedingSignIn) => (
        <SignedOutAccount
            key={account.key}
            account={account}
            name={names.get(account.key)!}
            onSignInAgain={props.onSignInAgain}
        />
    );

    let body: React.ReactNode;
    if (nothing) {
        body = (
            <Text testID="sidebar-usage-status" style={styles.status}>
                {t('sidebarFooter.usageNoAccounts')}
            </Text>
        );
    } else if (scoped) {
        body = sessionAccount
            ? renderAccount(sessionAccount)
            : sessionSignedOut
                ? renderSignedOut(sessionSignedOut)
                : session?.ownSignIn ? <OwnSignInGroup group={session.ownSignIn} now={now} /> : (
                    <Text testID="usage-popover-session-unavailable" style={styles.status}>
                        {t('common.unavailable')}
                    </Text>
                );
    } else {
        // Several accounts with nothing to show are one quiet line after the ones that answer; a lone one keeps its row.
        const silent = accounts.filter(({ account }) => account.windows.length === 0 && account.state !== 'loading');
        const collapsed = silent.length > 1 ? new Set(silent) : null;
        body = withDividers([
            ...accounts.filter(entry => !collapsed?.has(entry)).map(renderAccount),
            ...facts.accountsNeedingSignIn.map(renderSignedOut),
            ...(collapsed ? [<Text key="silent" testID="usage-popover-unavailable-accounts" style={styles.scopeLine}>
                {t('sidebarFooter.usageUnavailableAccounts', { count: collapsed.size })}
            </Text>] : []),
        ]);
    }

    // Scoped to a session, the one row widens to every account. Otherwise the header's gear opens Credentials, so no
    // row repeats it; keys that report no limits are said on a quiet line instead.
    const moreAccounts = scoped ? Math.max(0, total - (sessionAccount || sessionSignedOut ? 1 : 0)) : 0;
    const footNote = scoped
        ? (moreAccounts > 0 ? t('sidebarFooter.usageMoreAccounts', { count: moreAccounts }) : null)
        : null;
    const keysNote = !scoped && facts.keysWithoutLimits > 0
        ? t('sidebarFooter.usageKeysWithoutLimits', { count: facts.keysWithoutLimits }) : null;

    return (
        <View testID="sidebar-usage-popover-content">
            <View style={styles.header}>
                <Text style={styles.title}>{t('settings.usage')}</Text>
                {scoped ? <Text style={styles.headerScope} numberOfLines={1}>{t('sidebarFooter.usageThisSession')}</Text> : null}
                <View style={styles.headerEnd}>
                    {shownAsOf !== null ? <SurfaceAsOfLabel at={shownAsOf} testID="sidebar-usage-as-of" /> : null}
                    {refresh && refreshKeys.length > 0 ? (
                        <IconButton
                            testID="sidebar-usage-refresh"
                            iconName="arrow-clockwise"
                            variant="plain"
                            accessibilityLabel={t('common.refresh')}
                            tooltip={t('common.refresh')}
                            disabled={refreshing}
                            busy={refreshing}
                            onPress={() => refresh.run(scoped ? refreshKeys : undefined)}
                        />
                    ) : null}
                    <ConnectedAccountPrivacyToggle
                        testID="usage-popover-privacy"
                        hidden={privacy.hidden}
                        onChange={privacy.setHidden}
                    />
                    {/* Where this preview leads: the Usage page, then Credentials (lab `spfield` usage). */}
                    <View style={styles.headerRule} />
                    <IconButton
                        testID="sidebar-usage-open-usage"
                        iconName="chart-bar"
                        variant="plain"
                        accessibilityLabel={t('settings.usage')}
                        tooltip={t('settings.usage')}
                        onPress={props.onOpenUsage}
                    />
                    <IconButton
                        testID="sidebar-usage-open-connected-services"
                        iconName="gear"
                        variant="plain"
                        accessibilityLabel={t('settings.connectedServices')}
                        tooltip={t('settings.connectedServices')}
                        onPress={props.onOpenConnectedServices}
                    />
                </View>
            </View>
            {refreshError ? (
                <SurfaceFreshnessLine testID="sidebar-usage-refresh-error" reason={refreshError} tone="warning" />
            ) : null}
            {scoped && session?.scopeLine ? (
                <Text testID="usage-popover-session-scope" style={styles.scopeLine} numberOfLines={2}>{session.scopeLine}</Text>
            ) : null}
            <View style={styles.groups}>{body}</View>
            {scoped && session?.nextMove ? (
                <View testID="usage-popover-next-move" style={styles.nextMove}>
                    <Icon name="stack" size={13} color={theme.colors.text.secondary} />
                    <Text style={styles.nextMoveText}>{session.nextMove}</Text>
                </View>
            ) : null}
            {keysNote ? <Text testID="sidebar-usage-footnote" style={styles.scopeLine}>{keysNote}</Text> : null}
            {scoped ? <ActionListSection
                separatorAbove
                actions={[{
                    id: 'all-accounts',
                    testID: 'usage-popover-all-accounts',
                    label: t('sidebarFooter.usageAllAccounts'),
                    icon: <Icon name="stack" size={16} color={theme.colors.text.secondary} />,
                    right: (
                        <View style={styles.footRight}>
                            {footNote ? (
                                <Text testID="sidebar-usage-footnote" style={styles.footNote} numberOfLines={1}>{footNote}</Text>
                            ) : null}
                            <Icon name="caret-right" size={14} color={theme.colors.text.tertiary} />
                        </View>
                    ),
                    onPress: () => setWidened(true),
                }]}
            /> : null}
        </View>
    );
}

/** Account groups are separated by a hairline aligned with their text. */
function withDividers(items: readonly React.ReactElement[]): React.ReactNode {
    return items.flatMap((item, index) => (index === 0
        ? [item]
        : [<View key={`divider:${String(item.key)}`} style={styles.divider} />, item]));
}

/** An account's head line: "Service · Name" with its email (or a short provider id hint) on the right. */
function accountHeaderLine(serviceLabel: string, name: ConnectedAccountNamePresentation): Readonly<{ title: string; email: string | null }> {
    return {
        title: name.serviceFallback ? name.primaryLabel : `${serviceLabel} · ${name.primaryLabel}`,
        email: name.identityLabel,
    };
}

/** An account's head: the bare service mark, "Service · Name", the plan, and the email on the right. */
function AccountHeader(props: Readonly<{
    service?: PluginContributionIdentityV1 | null;
    legacyServiceId: string | null;
    title: string;
    planLabel: string | null;
    email: string | null;
}>) {
    return (
        <View style={styles.accountHeader}>
            <ConnectedServiceMark service={props.service} legacyServiceId={props.legacyServiceId as ConnectedServiceId | null} size="inline" />
            <ConnectedAccountIdentityText value={props.title} style={styles.accountLabel} numberOfLines={1} />
            {props.planLabel ? <Text style={styles.plan} numberOfLines={1}>{props.planLabel}</Text> : null}
            {props.email ? <ConnectedAccountIdentityText value={props.email} style={styles.email} numberOfLines={1} /> : null}
        </View>
    );
}

const noop = () => {};

const UsageAccountGroup = React.memo(function UsageAccountGroup(props: Readonly<{
    serviceLabel: string;
    service?: PluginContributionIdentityV1 | null;
    legacyServiceId: string | null;
    account: UsageAccountRow;
    facts: UsagePopoverAccountFacts | null;
    name: ConnectedAccountNamePresentation;
    now: number;
}>) {
    const { account } = props;
    const identity = accountHeaderLine(props.serviceLabel, props.name);
    const stateLabel = account.windows.length > 0
        ? null
        : account.state === 'loading' ? t('common.loading')
            : account.state === 'no_usage_observed' ? t('connectedServicesSettings.usageAppearsAfterSession')
            : t('common.unavailable');
    return (
        <View testID={`sidebar-usage-account-${account.key}`} style={styles.group}>
            <AccountHeader
                service={props.service}
                legacyServiceId={props.legacyServiceId}
                title={identity.title}
                planLabel={account.planLabel}
                email={identity.email}
            />
            <AccountSubscriptionLine subscription={props.facts?.subscription ?? null} now={props.now} />
            {stateLabel ? <Text style={styles.accountState}>{stateLabel}</Text> : (
                <UsageMeterStack>
                    {account.windows.map((window) => (
                        <UsageMeterRow
                            key={window.meterId}
                            label={window.label}
                            remainingPct={window.remainingPct}
                            amount={formatConnectedServiceQuotaReportedAmount(window.reportedAmount)}
                            estimated={window.status === 'estimated'}
                            resetsAt={window.resetsAt}
                            tone={window.tone}
                            now={props.now}
                        />
                    ))}
                </UsageMeterStack>
            )}
            {account.accountId ? (
                <AccountUsageResetsLine
                    testID={`sidebar-usage-resets-${account.key}`}
                    recoveryCredits={props.facts?.recoveryCredits ?? null}
                    legacyServiceId={props.legacyServiceId as ConnectedServiceId | null}
                    accountId={account.accountId}
                    snapshotFetchedAtMs={account.fetchedAt}
                    now={props.now}
                    // The receipt is spoken by the action; the popover's meters refresh on the next read.
                    onApplied={noop}
                />
            ) : null}
        </View>
    );
});

/** A session that signs in on its own: its gauge's windows under the service's name (no account identity). */
function OwnSignInGroup(props: Readonly<{ group: NonNullable<UsagePopoverSession['ownSignIn']>; now: number }>) {
    return (
        <View testID="usage-popover-own-sign-in" style={styles.group}>
            <AccountHeader legacyServiceId={props.group.legacyServiceId} title={props.group.title} planLabel={null} email={null} />
            <UsageMeterStack>
                {props.group.windows.map((window) => (
                    <UsageMeterRow
                        key={window.meterId}
                        label={window.label}
                        remainingPct={window.remainingPct}
                        amount={formatConnectedServiceQuotaReportedAmount(window.reportedAmount)}
                        estimated={window.status === 'estimated'}
                        resetsAt={window.resetsAt}
                        tone={window.tone}
                        now={props.now}
                    />
                ))}
            </UsageMeterStack>
            {props.group.resetAction ? (
                <AccountUsageResetsLine
                    testID="usage-popover-own-sign-in-resets"
                    recoveryCredits={props.group.recoveryCredits}
                    legacyServiceId={null}
                    accountId={null}
                    snapshotFetchedAtMs={null}
                    now={props.now}
                    onApplied={noop}
                    action={props.group.resetAction}
                />
            ) : null}
        </View>
    );
}

const SignedOutAccount = React.memo(function SignedOutAccount(props: Readonly<{
    account: ConnectedServiceAccountNeedingSignIn;
    name: ConnectedAccountNamePresentation;
    onSignInAgain?: (account: ConnectedServiceAccountNeedingSignIn, anchor?: PopoverAnchor) => void;
}>) {
    const { theme } = useUnistyles();
    const { account } = props;
    const identity = accountHeaderLine(account.serviceLabel, props.name);
    return (
        <View testID={`sidebar-usage-signed-out-${account.key}`} style={styles.group}>
            <AccountHeader
                service={account.ref.service}
                legacyServiceId={account.legacyServiceId}
                title={identity.title}
                planLabel={null}
                email={identity.email}
            />
            <View style={styles.signedOutRow}>
                <View style={styles.signedOut}>
                    <Icon name="warning" size={13} color={theme.colors.state.warning.foreground} />
                    <Text style={styles.signedOutText} numberOfLines={1}>{t('sidebarFooter.usageSignedOut')}</Text>
                </View>
                {props.onSignInAgain ? (
                    <RoundButton
                        testID={`sidebar-usage-sign-in-again-${account.key}`}
                        size="small"
                        display="secondary"
                        title={t('connectedServicesSettings.signInAgain')}
                        onPress={(event) => props.onSignInAgain?.(account, resolvePressTriggerAnchor(event))}
                    />
                ) : null}
            </View>
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
        paddingLeft: CONTENT_INSET_PX,
        paddingRight: CONTENT_INSET_PX - 6,
        paddingTop: theme.space.s8,
        paddingBottom: theme.space.s2,
    },
    title: {
        ...Typography.variant('label', 'semiBold'),
        color: theme.colors.text.primary,
    },
    headerScope: {
        flexShrink: 1,
        ...Typography.variant('meta'),
        color: theme.colors.text.tertiary,
    },
    headerEnd: {
        marginLeft: 'auto',
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s6,
    },
    /** Between the popover's own controls and the pages it leads to. */
    headerRule: {
        width: StyleSheet.hairlineWidth,
        height: theme.space.s16,
        backgroundColor: theme.colors.border.default,
    },
    status: {
        ...Typography.variant('body'),
        color: theme.colors.text.secondary,
        paddingHorizontal: CONTENT_INSET_PX,
        paddingVertical: theme.space.s8,
    },
    scopeLine: {
        ...Typography.variant('meta'),
        color: theme.colors.text.secondary,
        paddingHorizontal: CONTENT_INSET_PX,
        paddingBottom: theme.space.s4,
    },
    groups: {
        paddingBottom: theme.space.s4,
    },
    group: {
        paddingHorizontal: CONTENT_INSET_PX,
        paddingVertical: theme.space.s10,
        gap: theme.space.s8,
    },
    divider: {
        height: StyleSheet.hairlineWidth,
        marginHorizontal: CONTENT_INSET_PX,
        backgroundColor: theme.colors.border.default,
    },
    accountHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
    },
    // Identity first: the email gives up its room before the plan, and both before the account's name.
    accountLabel: {
        flexShrink: 1,
        minWidth: 0,
        ...Typography.variant('body', 'semiBold'),
        color: theme.colors.text.primary,
    },
    plan: {
        flexShrink: 10,
        minWidth: 0,
        ...Typography.variant('meta'),
        color: theme.colors.text.secondary,
    },
    email: {
        marginLeft: 'auto',
        flexShrink: 100,
        minWidth: 0,
        ...Typography.variant('meta'),
        color: theme.colors.text.secondary,
        textAlign: 'right',
    },
    accountState: {
        ...Typography.variant('meta'),
        color: theme.colors.text.secondary,
    },
    signedOutRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: theme.space.s8,
    },
    signedOut: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s6,
        flexShrink: 1,
    },
    signedOutText: {
        ...Typography.variant('meta'),
        color: theme.colors.state.warning.foreground,
    },
    nextMove: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
        marginBottom: theme.space.s6,
        paddingHorizontal: MENU_ROW_METRICS.paddingHorizontalPx,
        paddingVertical: theme.space.s8,
        borderRadius: 9,
        backgroundColor: theme.colors.surface.sectionTint,
    },
    nextMoveText: {
        flex: 1,
        ...Typography.variant('meta'),
        color: theme.colors.text.secondary,
    },
    footRight: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
    },
    footNote: {
        ...Typography.variant('meta'),
        color: theme.colors.text.tertiary,
    },
}));
