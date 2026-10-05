import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { normalizeConnectedServiceCredentialHealthStatus, type QualifiedConnectedAccountPurposeBindingTargetV1 } from '@happier-dev/protocol';

import { CardGrid } from '@/components/ui/cardGrid/CardGrid';
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
import { Modal } from '@/modal';
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

export type ConnectedServicesIndexPresentation = 'list' | 'grid';

export type ConnectedServicesIndexViewProps = Readonly<{
    model: ConnectedServicesIndexModel;
    labelsByKey: Readonly<Record<string, string | undefined>>;
    present: ConnectedAccountIdentityPresenter;
    now: number;
    presentation: ConnectedServicesIndexPresentation;
    onPresentationChange: (next: ConnectedServicesIndexPresentation) => void;
    /** Phones (and a stacked collection): the index is the list; limits stack under identities. */
    compact: boolean;
    /** Phone header actions (the eye and "+", which the rail carries on wide screens). */
    headerActions?: React.ReactNode;
    summary: Readonly<{ needsYouCount: number; asOf: number | null; onRefreshAll?: () => void }>;
    /** Above the services: a notice about the whole collection (services could not be read). */
    banner?: React.ReactNode;
    /** The set-up blocks ("Connect more", catalog and flows), mounted after the services. */
    connectMore: React.ReactNode;
    /** Team-shared accounts, after the pools. */
    sharedWithYou?: React.ReactNode;
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
    const { model, labelsByKey, present } = props;
    const grid = props.presentation === 'grid';
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
            slidingThumb
            targetSize="platform"
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
        const needsSignIn = sheet.canOpen && normalizeConnectedServiceCredentialHealthStatus(account.status) === 'needs_reauth';
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
                consequence: t('connectedServicesCollection.signedOutConsequence'),
                onSignInAgain: () => props.onSignInAgain(sheet, account.accountId),
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
            addAccount: sheet.canOpen ? (
                <SectionActionButton
                    testID={`connected-services-service:${sheet.serviceKey}:add-account`}
                    icon="plus"
                    title={t('connectedServicesSettings.addAccount')}
                    onPress={() => props.onAddAccount(sheet)}
                />
            ) : undefined,
        };
    };

    const renderListSheet = (sheet: ConnectedServicesIndexSheet, sectionTitle?: string) => {
        const header = serviceHeader(sheet);
        return (
            <ItemGroup key={sheet.serviceKey} title={sectionTitle}>
                <Item
                    testID={`connected-services-service:${sheet.serviceKey}`}
                    title={sheet.label}
                    subtitle={header.summary}
                    leftElement={<ConnectedServiceMark legacyServiceId={sheet.legacyServiceId} size="row" />}
                    rightElement={props.compact ? undefined : header.addAccount}
                    rightElementOutsidePressable
                    accessoryLayout="adaptive"
                    showChevron={false}
                    mode="info"
                />
                {sheet.supportDetails ? (
                    <Item
                        testID={`connected-services-index:${sheet.serviceKey}:support-details`}
                        title={t('common.details')}
                        subtitle={t('common.unavailable')}
                        onPress={() => void Modal.alert(t('common.details'), sheet.supportDetails ?? '')}
                    />
                ) : null}
                {sheet.accounts.map((account, index) => {
                    const entry = entryFor(sheet, account);
                    const settled = props.settled?.serviceKey === sheet.serviceKey && props.settled.accountId === account.accountId;
                    return (
                        <View key={account.accountId} style={settled ? styles.settledRow : undefined}>
                            {props.renderAccount({
                                sheet,
                                account,
                                render: (facts) => (
                                    <ConnectedAccountIndexRowView {...entry} facts={facts} now={props.now} compact={props.compact} showDivider={!settled && index < sheet.accounts.length - 1} />
                                ),
                            })}
                            {settled ? props.settled!.node : null}
                        </View>
                    );
                })}
            </ItemGroup>
        );
    };

    const renderGridSheet = (sheet: ConnectedServicesIndexSheet, sectionTitle?: string) => {
        const header = serviceHeader(sheet);
        return (
            <React.Fragment key={sheet.serviceKey}>
                {sectionTitle ? <ItemGroup title={sectionTitle} surface="none">{null}</ItemGroup> : null}
                <ItemGroup
                    title={sheet.label}
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
                {props.settled?.serviceKey === sheet.serviceKey ? <View style={styles.gridSettle}>{props.settled.node}</View> : null}
                </ItemGroup>
            </React.Fragment>
        );
    };

    const renderSheets = (sheets: readonly ConnectedServicesIndexSheet[], sectionTitle?: string) => sheets.map((sheet, index) => (
        grid ? renderGridSheet(sheet, index === 0 ? sectionTitle : undefined) : renderListSheet(sheet, index === 0 ? sectionTitle : undefined)
    ));

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
                alwaysShowTitle
                detailsPlacement="column"
                actions={props.compact ? props.headerActions : switcher}
                details={(
                    <View style={styles.details}>
                        {props.compact ? switcher : null}
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
            {renderSheets(agentSheets)}
            {props.connectMore}
            {pools}
            {renderSheets(toolSheets, t('connectedServicesSettings.codeAndToolsTitle'))}
            {props.sharedWithYou ?? null}
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
        ...Typography.default(),
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.text.tertiary,
    },
    cardCell: {
        flex: 1,
        alignItems: 'stretch',
        justifyContent: 'flex-start',
    },
    gridSettle: {
        marginTop: 10,
    },
}));
