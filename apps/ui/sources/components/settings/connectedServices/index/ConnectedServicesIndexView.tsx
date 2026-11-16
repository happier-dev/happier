import * as React from 'react';
import type { PopoverAnchor } from '@/components/ui/popover/_types';
import { resolvePressTriggerAnchor } from '@/components/ui/popover/resolvePointerMenuAnchor';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { parseDisplayableCredentialHealthStatus } from '@/sync/domains/connectedServices/parseDisplayableCredentialHealthStatus';
import type { QualifiedConnectedAccountPurposeBindingTargetV1 } from '@happier-dev/protocol/connect/connected-account-purpose-bindings';

import { CardGrid } from '@/components/ui/cardGrid/CardGrid';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { CompactSearchField } from '@/components/ui/forms/CompactSearchField';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import type { ConnectedAccountIdentityPresenter } from '@/hooks/ui/useConnectedAccountIdentityPrivacy';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { buildPluginDetailRoute } from '@/components/settings/plugins/model/pluginsSurfaceRoutes';
import { t } from '@/text';
import { getPoolStrategyPresentation } from '@/sync/domains/connectedServices/connectedServicePoolPolicy';

import { ConnectedServiceMark, formatAgentNames } from '../ConnectedServiceMark';
import type {
    ConnectedServicesIndexAccount,
    ConnectedServicesIndexModel,
    ConnectedServicesIndexPool,
    ConnectedServicesIndexSheet,
} from '../model/buildConnectedServicesIndexModel';
import { CONNECTED_SERVICES_SEARCH_THRESHOLD, connectedServicesAccountMatchesSearch, presentConnectedServicesIndexAccount, presentConnectedServicesIndexPool } from '../model/presentConnectedServicesIndexAccount';
import { ConnectedAccountCardView } from './ConnectedAccountCard';
import { isConnectedAccountSignedOut, resolveConnectedAccountCredentialStatusLabel } from '../account/connectedAccountCredentialStatusLabel';
import {
    ConnectedAccountIndexRowView,
    type ConnectedAccountIndexEntry,
    type ConnectedAccountIndexFacts,
    type ConnectedAccountIndexRole,
} from './ConnectedAccountIndexRow';
import { ConnectedServicesSummaryLine } from './ConnectedServicesSummaryLine';
import type { ConnectedServicePoolIndexEntry } from './ConnectedServicePoolIndexItem';


export type ConnectedServicesIndexPresentation = 'list' | 'grid';

/**
 * A service's own state line, once it is known. While its description is still being read (`unknown`) it
 * says nothing, so the sections keep their last-known line ("Used by …") instead of flashing "Loading…".
 */
function presentSheetStateLine(sheet: ConnectedServicesIndexSheet): string | null {
    return sheet.installationState === 'unknown' ? null : sheet.statusLine;
}

export type ConnectedServicesIndexViewProps = Readonly<{
    model: ConnectedServicesIndexModel;
    labelsByKey: Readonly<Record<string, string | undefined>>;
    present: ConnectedAccountIdentityPresenter;
    now: number;
    presentation: ConnectedServicesIndexPresentation;
    onPresentationChange: (next: ConnectedServicesIndexPresentation) => void;
    /** Phones (and a stacked collection): the same sections, limits beneath each identity, no switch. */
    compact: boolean;
    /** Phone header actions (the eye and "+", which the rail carries on wide screens). */
    headerActions?: React.ReactNode;
    summary: Readonly<{
        needsYouCount: number;
        asOf: number | null;
        /** When the page's first usage read goes stale (the usage summary owner's `staleAt`). */
        staleAt?: number | null;
        onRefreshAll?: () => void;
    }>;
    /** Above the services: a notice about the whole collection (services could not be read). */
    banner?: React.ReactNode;
    /** The set-up blocks ("Connect more", catalog and flows), mounted after the services. */
    connectMore: React.ReactNode;
    /** Gateways that draw on these subscriptions, after the pools they compose. */
    gateways?: React.ReactNode;
    /** Team-shared accounts, after the pools. */
    sharedWithYou?: React.ReactNode;
    /** Saved Secrets not tied to one service (the credential seam's free-standing records). */
    secrets?: React.ReactNode;
    /** The last section, "In the composer": where the usage gauges beside the prompt are set. */
    composer?: React.ReactNode;
    /** Machine-owned npm credentials use Connect rather than an Account connected-service record. */
    onOpenNpmProfiles?: () => void;
    /** A section's "+" (Agent accounts, Code and tools): the add menu for that section; it renders its trigger. */
    renderAddAccount?: (section: 'agents' | 'tools') => React.ReactNode;
    /** An open set-up panel holds the page's primary: row fixes step down. */
    fixProminence: 'primary' | 'secondary';
    /** A just-connected account settles into its row with the next step under it (A5). */
    settled: Readonly<{ serviceKey: string; accountId: string; node: React.ReactNode }> | null;
    /** Live rows read their own usage; a fixture passes its facts. */
    renderAccount: (input: Readonly<{
        sheet: ConnectedServicesIndexSheet;
        account: ConnectedServicesIndexAccount;
        render: (facts: ConnectedAccountIndexFacts) => React.ReactElement;
    }>) => React.ReactElement;
    renderPool: (input: Readonly<{
        sheet: ConnectedServicesIndexSheet;
        pool: ConnectedServicesIndexPool;
        entry: ConnectedServicePoolIndexEntry;
        presentation: 'row' | 'card';
        showDivider: boolean;
    }>) => React.ReactElement;
    /** ★ for an account or pool (the per-agent default menu). */
    renderStar: (target: QualifiedConnectedAccountPurposeBindingTargetV1, testID: string) => React.ReactNode;
    onAddAccount: (sheet: ConnectedServicesIndexSheet, anchor?: PopoverAnchor) => void;
    /** `anchor`: the row's Sign in again, so the Connect sheet hangs from it. */
    onSignInAgain: (sheet: ConnectedServicesIndexSheet, accountId: string, anchor?: PopoverAnchor) => void;
    onOpenAccount: (sheet: ConnectedServicesIndexSheet, accountId: string) => void;
    onOpenPool: (sheet: ConnectedServicesIndexSheet, groupId: string) => void;
    /** "New pool" (a menu of services when there are several); absent when no service can hold one. */
    renderNewPool?: ((renderTrigger: (onPress: () => void) => React.ReactElement) => React.ReactNode) | null;
}>;

/**
 * Credentials, the collection's overview (lab `cr` crHome A, owner 10-31): one presentation. Every section
 * is a title, a description above and one sheet of the same rows (mark · name · one fact · one trailing
 * thing); services are grouped only in the rail. Needs you, Agent accounts, Pools, Gateways, Code and tools,
 * Secrets, Shared with you, then Connect more with its set-up blocks and In the composer. Cards keeps each service's accounts as
 * cards. Accounts, pools and usage are Account-level; nothing here waits on a machine.
 */
export const ConnectedServicesIndexView = React.memo(function ConnectedServicesIndexView(props: ConnectedServicesIndexViewProps) {
    const { theme } = useUnistyles();
    const router = useRouter();
    // A service's diagnostics are its plugin's: Details opens that plugin's page, where they are read in full.
    const openDiagnostics = (sheet: ConnectedServicesIndexSheet) => router.push(buildPluginDetailRoute('settings', sheet.service.pluginId));
    const { labelsByKey, present } = props;
    // Cards on every width, a phone included (R7); the device's view decides.
    const grid = props.presentation === 'grid';
    const accountCount = props.model.sheets.reduce((total, sheet) => total + sheet.accounts.length, 0);
    // The phone's root is this Overview (R6/R7), so the rail's search comes here: the same field, threshold and match.
    const [query, setQuery] = React.useState('');
    const searchable = props.compact && accountCount > CONNECTED_SERVICES_SEARCH_THRESHOLD;
    const needle = searchable ? query.trim().toLowerCase() : '';
    const model = React.useMemo(() => needle ? {
        ...props.model,
        sheets: props.model.sheets.flatMap((sheet) => {
            const accounts = sheet.accounts.filter((account) => connectedServicesAccountMatchesSearch(
                sheet, presentConnectedServicesIndexAccount(sheet, account, labelsByKey, present), needle));
            return accounts.length > 0 ? [{ ...sheet, accounts }] : [];
        }),
    } : props.model, [labelsByKey, needle, present, props.model]);
    const matchCount = model.sheets.reduce((total, sheet) => total + sheet.accounts.length, 0);
    // Only declared Agent usage places a service under Agent sign-in; unknown accounts stay visible with tools.
    const agentSheets = model.sheets.filter((sheet) => sheet.section === 'agents');
    const toolSheets = model.sheets.filter((sheet) => sheet.section !== 'agents');
    const pooled = props.model.sheets.flatMap((sheet) => sheet.pools.map((pool) => ({ sheet, pool })));
    // Old usage is said once, by the page's summary line; a row speaks only when its read differs from the page.
    const pageUsageStale = props.summary.staleAt != null && props.now > props.summary.staleAt;
    const againstPage = (facts: ConnectedAccountIndexFacts): ConnectedAccountIndexFacts =>
        pageUsageStale && facts.staleSince !== null ? { ...facts, staleSince: null } : facts;

    // Words, not glyphs: the segmented owner draws icon tabs without their labels.
    const presentationTabs = React.useMemo(() => [
        { id: 'list' as const, label: t('connectedServicesCollection.viewList') },
        { id: 'grid' as const, label: t('connectedServicesCollection.viewGrid') },
    ], []);
    const switcher = (
        <SegmentedTabBar
            tabs={presentationTabs}
            activeTabId={props.presentation}
            onSelectTab={props.onPresentationChange}
            testIDPrefix="connected-services-index.view"
            accessibilityLabel={t('connectedServicesCollection.viewLabel')}
            segmentSizing={props.compact ? 'equal' : 'content'}
        />
    );

    const entryFor = (sheet: ConnectedServicesIndexSheet, account: ConnectedServicesIndexAccount): ConnectedAccountIndexEntry => {
        const presentation = presentConnectedServicesIndexAccount(sheet, account, labelsByKey, present);
        const roles = sheet.rolesByAccountId[account.accountId];
        const indexRoles: ConnectedAccountIndexRole[] = (roles?.pools ?? []).map((membership) => {
            const pool = sheet.pools.find((candidate) => candidate.ref.groupId === membership.groupId);
            const poolLabel = pool ? presentConnectedServicesIndexPool(sheet, pool, labelsByKey) : membership.groupId;
            return {
                key: `pool:${membership.groupId}`,
                icon: 'stack',
                label: membership.inUse ? t('connectedServicesSettings.poolInUse', { pool: poolLabel }) : poolLabel,
                active: membership.inUse,
            };
        });
        const needsSignIn = isConnectedAccountSignedOut(parseDisplayableCredentialHealthStatus(account.status));
        const target: QualifiedConnectedAccountPurposeBindingTargetV1 | null = account.kind === 'qualified'
            ? { kind: 'account', account: account.profile.ref }
            : null;
        const testID = `connected-services-account:${sheet.serviceKey}:${account.accountId}`;
        return {
            testID,
            // Every subscription reads by its email; a name someone gave it joins the plan (owner 10-31).
            title: presentation.listTitle,
            identityLabel: presentation.listName,
            accessMode: presentation.accessMode,
            roles: indexRoles,
            signedOut: needsSignIn ? {
                reason: resolveConnectedAccountCredentialStatusLabel('needs_reauth', account.kind === 'qualified' ? account.profile.statusReason : undefined),
                onSignInAgain: sheet.canAdd ? (anchor) => props.onSignInAgain(sheet, account.accountId, anchor) : null,
            } : null,
            fixProminence: props.settled ? 'secondary' : props.fixProminence,
            legacyServiceId: sheet.legacyServiceId,
            service: sheet.service,
            pluginId: sheet.service.pluginId,
            accountId: account.accountId,
            // The default menu lives on cards and on the account; a list row keeps one trailing thing (R138).
            star: grid && target ? props.renderStar(target, `${testID}:star`) : null,
            onOpen: () => props.onOpenAccount(sheet, account.accountId),
        };
    };

    const poolEntryFor = (sheet: ConnectedServicesIndexSheet, pool: ConnectedServicesIndexPool): ConnectedServicePoolIndexEntry => {
        const members = pool.members.flatMap((member) => {
            const account = sheet.accounts.find((candidate) => candidate.accountId === member.connectedAccountId);
            return account ? [{
                accountId: account.accountId,
                title: presentConnectedServicesIndexAccount(sheet, account, labelsByKey, present).title,
                enabled: member.enabled !== false,
                credentialStatus: account.status,
            }] : [];
        });
        const active = members.find((member) => member.accountId === pool.activeConnectedAccountId) ?? null;
        // "since T" only when the pool owner ties the time to this very member (identity-bound).
        const since = active && pool.state?.activeSince?.accountId === active.accountId ? pool.state.activeSince.atMs : null;
        const testID = `connected-services-pool:${sheet.serviceKey}:${pool.ref.groupId}`;
        return {
            testID,
            title: presentConnectedServicesIndexPool(sheet, pool, labelsByKey),
            serviceTitle: sheet.label,
            quotaLimitSelection: pool.policy.quotaLimitSelection,
            subtitle: [
                sheet.label,
                t('connectedServicesSettings.accountCount', { count: members.length }),
                getPoolStrategyPresentation(pool.policy.strategy).summary,
            ].join(' · '),
            activeTitle: active?.title ?? null,
            activeSinceMs: since,
            activeAccountId: active?.accountId ?? null,
            members,
            star: props.renderStar({ kind: 'group', service: sheet.service, groupId: pool.ref.groupId }, `${testID}:star`),
            onOpen: () => props.onOpenPool(sheet, pool.ref.groupId),
        };
    };

    const addAccountAction = (sheet: ConnectedServicesIndexSheet) => sheet.canAdd ? (
        <SectionActionButton
            testID={`connected-services-service:${sheet.serviceKey}:add-account`}
            icon="plus"
            title={t('connectedServicesSettings.addAccount')}
            onPress={(event) => props.onAddAccount(sheet, resolvePressTriggerAnchor(event))}
        />
    ) : undefined;

    // Signed-out accounts lead the page in Needs you (lab `s2svc:home`), each once; their sections list the rest.
    const isSignedOut = (account: ConnectedServicesIndexAccount) => isConnectedAccountSignedOut(parseDisplayableCredentialHealthStatus(account.status));
    const listed = (sheets: readonly ConnectedServicesIndexSheet[]) => sheets.flatMap((sheet) => sheet.accounts
        .filter((account) => grid || !isSignedOut(account))
        .map((account) => ({ sheet, account })));
    const needsYou = grid ? [] : model.sheets.flatMap((sheet) => sheet.accounts.filter(isSignedOut).map((account) => ({ sheet, account })));

    // One row per account, on a sheet that mixes services: the fact line names the service when no plan does.
    const renderRows = (rows: ReadonlyArray<Readonly<{ sheet: ConnectedServicesIndexSheet; account: ConnectedServicesIndexAccount }>>, needs: boolean) => rows.map(({ sheet, account }, index) => {
        const entry = entryFor(sheet, account);
        const settled = props.settled?.serviceKey === sheet.serviceKey && props.settled.accountId === account.accountId;
        // One primary per view: only the first fix in Needs you is filled; the rest stay secondary.
        const fixProminence = needs && index > 0 ? 'secondary' : entry.fixProminence;
        return (
            <React.Fragment key={`${sheet.serviceKey}:${account.accountId}`}>
                {props.renderAccount({
                    sheet,
                    account,
                    render: (facts) => (
                        <ConnectedAccountIndexRowView
                            {...entry}
                            fixProminence={fixProminence}
                            serviceFact={sheet.label}
                            facts={againstPage(facts)}
                            now={props.now}
                            compact={props.compact}
                            showDivider={index < rows.length - 1 || settled}
                        />
                    ),
                })}
                {settled ? props.settled!.node : null}
            </React.Fragment>
        );
    });
    // A service's own state (it can't run here yet, its diagnostics): one quiet row in its section, after the
    // accounts (rare detail last). A service still being read says nothing; its accounts already show.
    const renderSupportRows = (sheets: readonly ConnectedServicesIndexSheet[]) => sheets
        .filter((sheet) => sheet.supportDetails || presentSheetStateLine(sheet))
        .map((sheet) => (
            <Item
                key={`${sheet.serviceKey}:support-details`}
                testID={`connected-services-index:${sheet.serviceKey}:${sheet.supportDetails ? 'support-details' : 'state'}`}
                title={sheet.label}
                subtitle={presentSheetStateLine(sheet) ?? t('settingsPlugins.diagnosticsTitle')}
                icon={<ConnectedServiceMark legacyServiceId={sheet.legacyServiceId} service={sheet.service} size="inline" />}
                mode={sheet.supportDetails ? undefined : 'info'}
                onPress={sheet.supportDetails ? () => openDiagnostics(sheet) : undefined}
            />
        ));

    const needsYouGroup = needsYou.length > 0 ? (
        <ItemGroup testID="connected-services-index:needs-you" title={t('connectedServicesCollection.needsYouGroup')} surface="none">
            {renderRows(needsYou, true)}
        </ItemGroup>
    ) : null;

    const renderListSection = (input: Readonly<{
        testID: string;
        sheets: readonly ConnectedServicesIndexSheet[];
        title: string;
        description: string;
        action?: React.ReactNode;
        extraRows?: React.ReactNode;
    }>) => {
        const rows = listed(input.sheets);
        const support = renderSupportRows(input.sheets);
        if (rows.length === 0 && support.length === 0 && !input.extraRows) return null;
        return (
            <ItemGroup testID={input.testID} title={input.title} description={input.description} action={props.compact ? undefined : input.action} surface="none">
                {renderRows(rows, false)}
                {support}
                {input.extraRows}
            </ItemGroup>
        );
    };

    const renderGridSheet = (sheet: ConnectedServicesIndexSheet, sectionTitle?: string) => {
        const summary = presentSheetStateLine(sheet)
            ?? (sheet.usedBy.length > 0
                ? t('connectedServicesSettings.usedBy', { names: formatAgentNames(sheet.usedBy) })
                : undefined);
        return (
            <React.Fragment key={sheet.serviceKey}>
                {sectionTitle ? <ItemGroup title={sectionTitle} surface="none">{null}</ItemGroup> : null}
                <ItemGroup
                    title={sheet.label}
                    description={summary}
                    titleLeading={<ConnectedServiceMark legacyServiceId={sheet.legacyServiceId} service={sheet.service} size="inline" />}
                    titleAccessory={<Text style={styles.gridLabelCount}>{String(sheet.accounts.length)}</Text>}
                    action={addAccountAction(sheet)}
                    surface="none"
                >
                <CardGrid columns={2}>
                    {sheet.accounts.map((account) => {
                        const entry = entryFor(sheet, account);
                        return (
                            <View key={account.accountId} style={styles.cardCell}>
                                {props.renderAccount({
                                    sheet,
                                    account,
                                    render: (facts) => (
                                        <ConnectedAccountCardView
                                            {...entry}
                                            // The grid has no Needs you group: a sign-in to repair stays bordered beside its siblings.
                                            fixProminence="secondary"
                                            facts={againstPage(facts)}
                                            legacyServiceMarkId={sheet.legacyServiceId}
                                            agentIds={sheet.usedByAgentIds}
                                            now={props.now}
                                        />
                                    ),
                                })}
                            </View>
                        );
                    })}
                </CardGrid>
                {sheet.supportDetails ? (
                    <Item testID={`connected-services-index:${sheet.serviceKey}:support-details`}
                        title={t('common.details')} subtitle={t('settingsPlugins.diagnosticsTitle')}
                        onPress={() => openDiagnostics(sheet)} />
                ) : null}
                {props.settled?.serviceKey === sheet.serviceKey ? <View style={styles.gridSettle}>{props.settled.node}</View> : null}
                </ItemGroup>
            </React.Fragment>
        );
    };

    const poolsTitle = t('connectedServicesCollection.poolsGroup');
    const newPool = props.renderNewPool ? props.renderNewPool((onPress) => (
        <SectionActionButton
            testID="connected-services-index:new-pool"
            icon="plus"
            title={t('connectedServicesCollection.newPool')}
            onPress={onPress}
        />
    )) : undefined;
    const pools = pooled.length === 0 ? null : grid ? (
        <ItemGroup
            title={poolsTitle}
            titleLeading={<Icon name="stack" size={15} color={theme.colors.text.secondary} />}
            titleAccessory={<Text style={styles.gridLabelCount}>{String(pooled.length)}</Text>}
            action={newPool}
            surface="none"
        >
            <CardGrid columns={2}>
                {pooled.map(({ sheet, pool }) => (
                    <View key={`${sheet.serviceKey}:${pool.ref.groupId}`} style={styles.cardCell}>
                        {props.renderPool({ sheet, pool, entry: poolEntryFor(sheet, pool), presentation: 'card', showDivider: false })}
                    </View>
                ))}
            </CardGrid>
        </ItemGroup>
    ) : (
        <ItemGroup
            title={poolsTitle}
            description={t('connectedServicesCollection.poolsDescription')}
            action={props.compact ? undefined : newPool}
            surface="none"
        >
            {pooled.map(({ sheet, pool }, index) => (
                <React.Fragment key={`${sheet.serviceKey}:${pool.ref.groupId}`}>
                    {props.renderPool({ sheet, pool, entry: poolEntryFor(sheet, pool), presentation: 'row', showDivider: index > 0 })}
                </React.Fragment>
            ))}
        </ItemGroup>
    );

    const agents = grid
        ? agentSheets.map((sheet) => renderGridSheet(sheet))
        : renderListSection({
            testID: 'connected-services-index:agent-accounts',
            sheets: agentSheets,
            title: t('connectedServicesCollection.agentAccountsGroup'),
            description: t('connectedServicesCollection.agentAccountsDescription'),
            action: props.renderAddAccount?.('agents'),
        });
    const npmProfiles = props.onOpenNpmProfiles && (!needle || t('settingsPlugins.registriesTitle').toLowerCase().includes(needle)) ? <Item
        testID="credentials:npm-registry-profiles"
        title={t('settingsPlugins.registriesTitle')}
        subtitle={t('settingsPlugins.registriesFooter')}
        icon={<Icon name="package" size={18} color={theme.colors.text.secondary} />}
        onPress={props.onOpenNpmProfiles}
    /> : null;
    const tools = grid
        ? <>{toolSheets.map((sheet, index) => renderGridSheet(sheet, index === 0 ? t('connectedServicesSettings.codeAndToolsTitle') : undefined))}
            {npmProfiles ? <ItemGroup title={toolSheets.length === 0 ? t('connectedServicesSettings.codeAndToolsTitle') : undefined} surface="none">{npmProfiles}</ItemGroup> : null}</>
        : renderListSection({
            testID: 'connected-services-index:code-and-tools',
            sheets: toolSheets,
            title: t('connectedServicesSettings.codeAndToolsTitle'),
            description: t('connectedServicesCollection.codeAndToolsDescription'),
            action: props.renderAddAccount?.('tools'),
            extraRows: npmProfiles,
        });

    return (
        <ItemList pageColumn="wide">
            <SettingsPageHeader
                {...(props.compact ? {} : {
                    title: t('connectedServicesCollection.indexTitle'),
                    description: t('connectedServicesCollection.indexDescription'),
                })}
                detailsPlacement="column"
                // The phone's privacy eye and "+" are the list's frequent controls (crPhone): they stay
                // visible at the navigation bar's edge instead of folding into its "…".
                navigationTrailing={props.compact ? props.headerActions : undefined}
                actions={props.compact ? undefined : switcher}
                details={(
                    <View style={styles.details}>
                        {accountCount > 0 ? (
                            <ConnectedServicesSummaryLine
                                accountCount={accountCount}
                                poolCount={pooled.length}
                                needsYouCount={props.summary.needsYouCount}
                                asOf={props.summary.asOf}
                                stale={pageUsageStale}
                                onRefreshAll={props.compact ? undefined : props.summary.onRefreshAll}
                            />
                        ) : null}
                    </View>
                )}
            />
            {searchable ? (
                <CompactSearchField
                    testID="connected-services-index:search"
                    placement="page"
                    value={query}
                    onChangeText={setQuery}
                    placeholder={t('connectedServicesCollection.searchCredentials')}
                />
            ) : null}
            {props.banner ?? null}
            {needle && matchCount === 0 && !npmProfiles ? (
                <EmptyState
                    testID="connected-services-index:no-match"
                    // "No credentials match “x” · Clear search": a quiet line with an inline link, never a button.
                    layout="line"
                    iconName="magnifying-glass"
                    title={t('connectedServicesCollection.noCredentialsMatch', { query: query.trim() })}
                    primaryAction={{ testID: 'connected-services-index:no-match-clear', label: t('common.clearSearch'), onPress: () => setQuery('') }}
                />
            ) : needle ? (
                // A search lists the accounts it found; the page's other sections come back when it is cleared.
                <>{needsYouGroup}{agents}{tools}</>
            ) : (
                <>
                    {needsYouGroup}
                    {agents}
                    {pools}
                    {props.gateways ?? null}
                    {tools}
                    {props.secrets ?? null}
                    {props.sharedWithYou ?? null}
                    {props.connectMore}
                    {props.composer ?? null}
                </>
            )}
        </ItemList>
    );
});

const styles = StyleSheet.create((theme) => ({
    details: {
        gap: 14,
    },
    gridLabelCount: {
        ...Typography.variant('body'),
        color: theme.colors.text.tertiary,
    },
    cardCell: {
        flex: 1,
        alignItems: 'stretch',
        justifyContent: 'flex-start',
    },
    gridSettle: {
        marginTop: theme.space.s10,
    },
}));
