import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { normalizeConnectedServiceCredentialHealthStatus } from '@happier-dev/protocol/connect/connected-service-schemas';
import type { QualifiedConnectedAccountPurposeBindingTargetV1 } from '@happier-dev/protocol/connect/connected-account-purpose-bindings';

import { CardGrid } from '@/components/ui/cardGrid/CardGrid';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ExpandableItem, type ExpandableItemHeaderState } from '@/components/ui/lists/ExpandableItem';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { PAGE_LIST_METRICS } from '@/components/ui/lists/pageListMetrics';
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
import { presentConnectedServicesIndexAccount, presentConnectedServicesIndexPool } from '../model/presentConnectedServicesIndexAccount';
import { ConnectedAccountCardView } from './ConnectedAccountCard';
import {
    ConnectedAccountIndexRowView,
    type ConnectedAccountIndexEntry,
    type ConnectedAccountIndexFacts,
    type ConnectedAccountIndexRole,
} from './ConnectedAccountIndexRow';
import { ConnectedServicesSummaryLine } from './ConnectedServicesSummaryLine';
import type { ConnectedServicePoolIndexEntry } from './ConnectedServicePoolIndexItem';


/**
 * Leading box that puts a section row's title on the account rows' edge: the accounts start on the heading's optical
 * inset with their mark column and gap, a page row on its own padding and gap.
 */
const SUPPORT_DETAILS_LEADING_BOX_PX = PAGE_LIST_METRICS.headingOpticalInsetPx
    + PAGE_LIST_METRICS.rowLeadingColumnPx
    - PAGE_LIST_METRICS.rowPaddingHorizontalPx;

export type ConnectedServicesIndexPresentation = 'list' | 'grid';

export type ConnectedServicesIndexViewProps = Readonly<{
    model: ConnectedServicesIndexModel;
    labelsByKey: Readonly<Record<string, string | undefined>>;
    present: ConnectedAccountIdentityPresenter;
    now: number;
    presentation: ConnectedServicesIndexPresentation;
    onPresentationChange: (next: ConnectedServicesIndexPresentation) => void;
    /** Phones (and a stacked collection): services expand in place; limits stack under identities. */
    compact: boolean;
    /** Phone header actions (the eye and "+", which the rail carries on wide screens). */
    headerActions?: React.ReactNode;
    summary: Readonly<{ needsYouCount: number; asOf: number | null; onRefreshAll?: () => void }>;
    /** Above the services: a notice about the whole collection (services could not be read). */
    banner?: React.ReactNode;
    /** The set-up blocks ("Connect more", catalog and flows), mounted after the services. */
    connectMore: React.ReactNode;
    /** Gateways that draw on these subscriptions, after the pools they compose. */
    gateways?: React.ReactNode;
    /** Team-shared accounts, after the pools. */
    sharedWithYou?: React.ReactNode;
    /** The last section, "In the composer": where the usage gauges beside the prompt are set. */
    composer?: React.ReactNode;
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
    onAddAccount: (sheet: ConnectedServicesIndexSheet) => void;
    onSignInAgain: (sheet: ConnectedServicesIndexSheet, accountId: string) => void;
    onOpenAccount: (sheet: ConnectedServicesIndexSheet, accountId: string) => void;
    onOpenPool: (sheet: ConnectedServicesIndexSheet, groupId: string) => void;
    /** "New pool" (a menu of services when there are several); absent when no service can hold one. */
    renderNewPool?: ((renderTrigger: (onPress: () => void) => React.ReactElement) => React.ReactNode) | null;
}>;

/**
 * All services (lab `csvc` C1 list, C2 grid): the collection's unselected detail. A summary line, then
 * every service with its accounts — identity on the left, every limit on the right (or as cards) — the
 * set-up blocks for what your agents could also use, the pools with what is left across each, and the
 * Team-shared accounts. Accounts, pools and usage are Account-level; nothing here waits on a machine.
 */
export const ConnectedServicesIndexView = React.memo(function ConnectedServicesIndexView(props: ConnectedServicesIndexViewProps) {
    const { theme } = useUnistyles();
    const router = useRouter();
    // A service's diagnostics are its plugin's: Details opens that plugin's page, where they are read in full.
    const openDiagnostics = (sheet: ConnectedServicesIndexSheet) => router.push(buildPluginDetailRoute('settings', sheet.service.pluginId));
    const { model, labelsByKey, present } = props;
    const grid = !props.compact && props.presentation === 'grid';
    const [expandedServiceKey, setExpandedServiceKey] = React.useState<string | null>(null);
    React.useEffect(() => {
        if (props.settled) setExpandedServiceKey(props.settled.serviceKey);
    }, [props.settled?.serviceKey, props.settled?.accountId]);
    const agentSheets = model.sheets.filter((sheet) => sheet.section === 'agents');
    const toolSheets = model.sheets.filter((sheet) => sheet.section === 'tools');
    const accountCount = model.sheets.reduce((total, sheet) => total + sheet.accounts.length, 0);
    const pooled = model.sheets.flatMap((sheet) => sheet.pools.map((pool) => ({ sheet, pool })));

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
        const needsSignIn = normalizeConnectedServiceCredentialHealthStatus(account.status) === 'needs_reauth';
        const target: QualifiedConnectedAccountPurposeBindingTargetV1 | null = account.kind === 'qualified'
            ? { kind: 'account', account: account.profile.ref }
            : null;
        const testID = `connected-services-account:${sheet.serviceKey}:${account.accountId}`;
        return {
            testID,
            title: presentation.title,
            identityLabel: presentation.identityLabel,
            roles: props.compact && !grid ? indexRoles.filter((role) => role.active) : indexRoles,
            signedOut: needsSignIn ? {
                reason: t('connectedServicesSettings.signedOutBy', { service: sheet.label }),
                onSignInAgain: sheet.canAdd ? () => props.onSignInAgain(sheet, account.accountId) : null,
            } : null,
            fixProminence: props.settled ? 'secondary' : props.fixProminence,
            legacyServiceId: sheet.legacyServiceId,
            accountId: account.accountId,
            star: target ? props.renderStar(target, `${testID}:star`) : null,
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
            }] : [];
        });
        const active = members.find((member) => member.accountId === pool.activeConnectedAccountId) ?? null;
        // "since T" only when the pool owner ties the time to this very member (identity-bound).
        const since = active && pool.state?.activeSince?.accountId === active.accountId ? pool.state.activeSince.atMs : null;
        const testID = `connected-services-pool:${sheet.serviceKey}:${pool.ref.groupId}`;
        return {
            testID,
            title: presentConnectedServicesIndexPool(sheet, pool, labelsByKey),
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

    const serviceHeader = (sheet: ConnectedServicesIndexSheet) => {
        const summary = sheet.statusLine
            ?? (sheet.usedBy.length > 0
                ? t('connectedServicesSettings.usedBy', { names: formatAgentNames(sheet.usedBy) })
                : undefined);
        return {
            summary,
            addAccount: sheet.canAdd ? (
                <SectionActionButton
                    testID={`connected-services-service:${sheet.serviceKey}:add-account`}
                    icon="plus"
                    title={t('connectedServicesSettings.addAccount')}
                    onPress={() => props.onAddAccount(sheet)}
                />
            ) : undefined,
        };
    };

    // Signed-out accounts lead the page in Needs you (lab `s2svc:home`), each once; their services list the rest.
    const isSignedOut = (account: ConnectedServicesIndexAccount) => normalizeConnectedServiceCredentialHealthStatus(account.status) === 'needs_reauth';
    const flatList = !props.compact && !grid;
    const listedAccounts = (sheet: ConnectedServicesIndexSheet) => flatList
        ? sheet.accounts.filter((account) => !isSignedOut(account))
        : sheet.accounts;
    const renderAccounts = (sheet: ConnectedServicesIndexSheet, accounts: readonly ConnectedServicesIndexAccount[] = listedAccounts(sheet)) => (
        <>
            {accounts.map((account, index) => {
                const entry = entryFor(sheet, account);
                const settled = props.settled?.serviceKey === sheet.serviceKey && props.settled.accountId === account.accountId;
                return (
                    <View key={account.accountId} style={settled ? styles.settledRow : undefined}>
                        {props.renderAccount({
                            sheet,
                            account,
                            render: (facts) => (
                                <ConnectedAccountIndexRowView {...entry} facts={facts} now={props.now} compact={props.compact} showDivider={!settled && (index < accounts.length - 1 || Boolean(sheet.supportDetails))} />
                            ),
                        })}
                        {settled ? props.settled!.node : null}
                    </View>
                );
            })}
            {/* Rare detail last: the service's identity leads straight into its accounts. */}
            {sheet.supportDetails ? (
                <Item
                    testID={`connected-services-index:${sheet.serviceKey}:support-details`}
                    title={t('common.details')}
                    // The service header already states its one fact; the row names what it opens.
                    subtitle={t('settingsPlugins.diagnosticsTitle')}
                    // A leading box that puts this title on the account names' edge (their mark column + gap).
                    iconBoxSize={props.compact ? undefined : SUPPORT_DETAILS_LEADING_BOX_PX}
                    // The sheet's leading column, widened so this title starts on the account names' edge
                    // (measured live: 48 vs 58 px), not on the generic row's.
                    onPress={() => openDiagnostics(sheet)}
                />
            ) : null}
        </>
    );

    const renderListSheetContent = (sheet: ConnectedServicesIndexSheet) => {
        const header = serviceHeader(sheet);
        const needsSignIn = sheet.accounts.some((account) => normalizeConnectedServiceCredentialHealthStatus(account.status) === 'needs_reauth');
        const subtitle = props.compact ? [
            t('connectedServicesSettings.accountCount', { count: sheet.accounts.length }),
            needsSignIn ? t('connectedServicesSettings.signedOutBy', { service: sheet.label }) : null,
            header.summary,
        ].filter(Boolean).join(' · ') : header.summary;
        const serviceRow = (disclosure?: ExpandableItemHeaderState) => (
            <Item
                {...disclosure?.headerProps}
                testID={`connected-services-service:${sheet.serviceKey}`}
                title={sheet.label}
                subtitle={subtitle}
                leftElement={<ConnectedServiceMark legacyServiceId={sheet.legacyServiceId} size="row" />}
                rightElement={props.compact ? (
                    <Icon name={disclosure?.expanded ? 'caret-down' : 'caret-right'} size={theme.iconSize.medium} color={theme.colors.text.secondary} />
                ) : header.addAccount}
                rightElementOutsidePressable={!props.compact}
                accessoryLayout={props.compact ? 'inline' : 'adaptive'}
                showChevron={false}
                mode={props.compact ? undefined : 'info'}
            />
        );
        return props.compact ? (
            <ExpandableItem
                key={sheet.serviceKey}
                testID={`connected-services-service:${sheet.serviceKey}:disclosure`}
                expanded={expandedServiceKey === sheet.serviceKey}
                onExpandedChange={(expanded) => setExpandedServiceKey(expanded ? sheet.serviceKey : null)}
                header={serviceRow}
            >
                {renderAccounts(sheet)}
                {header.addAccount ? <View>{header.addAccount}</View> : null}
            </ExpandableItem>
        ) : <React.Fragment key={sheet.serviceKey}>{serviceRow()}{renderAccounts(sheet)}</React.Fragment>;
    };

    // All services is a flat index (P7 W3 "browse flat", P8 §8): each service is a section headed by its mark,
    // name, who uses it and Add account; its accounts are rows on the page, each led by the service's mark.
    const renderListSheet = (sheet: ConnectedServicesIndexSheet) => {
        const header = serviceHeader(sheet);
        return (
            <ItemGroup
                key={sheet.serviceKey}
                testID={`connected-services-service:${sheet.serviceKey}`}
                title={sheet.label}
                titleLeading={<ConnectedServiceMark legacyServiceId={sheet.legacyServiceId} size="inline" />}
                description={header.summary}
                action={header.addAccount}
                surface="none"
            >
                {renderAccounts(sheet)}
            </ItemGroup>
        );
    };
    const needsYou = flatList
        ? model.sheets.flatMap((sheet) => sheet.accounts.filter(isSignedOut).map((account) => ({ sheet, account })))
        : [];
    const needsYouGroup = needsYou.length > 0 ? (
        <ItemGroup
            testID="connected-services-index:needs-you"
            title={t('connectedServicesCollection.needsYouGroup')}
            surface="none"
        >
            {needsYou.map(({ sheet, account }, index) => {
                const entry = entryFor(sheet, account);
                // One primary per view: only the first fix in Needs you is filled; the rest stay secondary.
                const fixProminence = index === 0 ? entry.fixProminence : 'secondary';
                return (
                    <React.Fragment key={`${sheet.serviceKey}:${account.accountId}`}>
                        {props.renderAccount({
                            sheet,
                            account,
                            render: (facts) => (
                                <ConnectedAccountIndexRowView
                                    {...entry}
                                    fixProminence={fixProminence}
                                    identityLabel={[sheet.label, entry.identityLabel].filter(Boolean).join(' · ')}
                                    facts={facts}
                                    now={props.now}
                                    compact={false}
                                    showDivider={index < needsYou.length - 1}
                                />
                            ),
                        })}
                    </React.Fragment>
                );
            })}
        </ItemGroup>
    ) : null;

    const renderGridSheet = (sheet: ConnectedServicesIndexSheet, sectionTitle?: string) => {
        const header = serviceHeader(sheet);
        return (
            <React.Fragment key={sheet.serviceKey}>
                {sectionTitle ? <ItemGroup title={sectionTitle} surface="none">{null}</ItemGroup> : null}
                <ItemGroup
                    title={sheet.label}
                    description={header.summary}
                    titleLeading={<ConnectedServiceMark legacyServiceId={sheet.legacyServiceId} size="inline" />}
                    titleAccessory={<Text style={styles.gridLabelCount}>{String(sheet.accounts.length)}</Text>}
                    action={props.compact ? undefined : header.addAccount}
                    surface="none"
                >
                <CardGrid columns={props.compact ? 1 : 2}>
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
                                            facts={facts}
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

    // On a phone each service collapses to one disclosure row, so the services are rows of one sheet
    // rather than a stack of one-row cards; wider panes give each service its own sheet of accounts.
    const renderSheets = (sheets: readonly ConnectedServicesIndexSheet[], sectionTitle?: string) => props.compact && !grid
        ? (sheets.length > 0 ? <ItemGroup title={sectionTitle}>{sheets.map(renderListSheetContent)}</ItemGroup> : null)
        : grid
            ? sheets.map((sheet, index) => renderGridSheet(sheet, index === 0 ? sectionTitle : undefined))
            : sheets.length > 0 ? (
                <>
                    {sectionTitle ? <ItemGroup title={sectionTitle} surface="none">{null}</ItemGroup> : null}
                    {sheets.map((sheet) => renderListSheet(sheet))}
                </>
            ) : null;

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
            action={props.compact ? undefined : newPool}
            surface="none"
        >
            <CardGrid columns={props.compact ? 1 : 2}>
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
        >
            {pooled.map(({ sheet, pool }, index) => (
                <React.Fragment key={`${sheet.serviceKey}:${pool.ref.groupId}`}>
                    {props.renderPool({ sheet, pool, entry: poolEntryFor(sheet, pool), presentation: 'row', showDivider: index > 0 })}
                </React.Fragment>
            ))}
        </ItemGroup>
    );

    return (
        <ItemList pageColumn="wide">
            <SettingsPageHeader
                {...(props.compact ? {} : {
                    title: t('connectedServicesCollection.indexTitle'),
                    description: t('connectedServicesCollection.indexDescription'),
                })}
                detailsPlacement="column"
                actions={props.compact ? props.headerActions : switcher}
                details={(
                    <View style={styles.details}>
                        {accountCount > 0 ? (
                            <ConnectedServicesSummaryLine
                                accountCount={accountCount}
                                poolCount={pooled.length}
                                needsYouCount={props.summary.needsYouCount}
                                asOf={props.summary.asOf}
                                onRefreshAll={props.compact ? undefined : props.summary.onRefreshAll}
                            />
                        ) : null}
                    </View>
                )}
            />
            {props.banner ?? null}
            {needsYouGroup}
            {renderSheets(agentSheets)}
            {props.connectMore}
            {pools}
            {props.gateways ?? null}
            {renderSheets(toolSheets, t('connectedServicesSettings.codeAndToolsTitle'))}
            {props.sharedWithYou ?? null}
            {props.composer ?? null}
        </ItemList>
    );
});

const styles = StyleSheet.create((theme) => ({
    details: {
        gap: 14,
    },
    settledRow: {
        backgroundColor: theme.colors.state.success.background,
        borderLeftWidth: 2,
        borderLeftColor: theme.colors.state.success.foreground,
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
