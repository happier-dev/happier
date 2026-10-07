import * as React from 'react';
import { View } from 'react-native';
import { useGlobalSearchParams, usePathname, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { normalizeConnectedServiceCredentialHealthStatus } from '@happier-dev/protocol';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { CollectionList, CollectionListGroupLabel, collectionListStyles } from '@/components/ui/lists/collection/CollectionList';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useConnectedAccountIdentityPrivacy, type ConnectedAccountIdentityPresenter } from '@/hooks/ui/useConnectedAccountIdentityPrivacy';
import { useQualifiedConnectedAccountQuota } from '@/hooks/server/connectedServices/useQualifiedConnectedAccountQuota';
import { buildConnectedAccountSettingsRoute, buildNewConnectedAccountPoolRoute } from '@/sync/domains/connectedServices/connectedAccountSettingsRoute';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { deriveAccountCapacityPct } from '@/sync/domains/connectedServices/deriveAccountCapacityPct';
import { resolveQuotaTone } from '@/sync/domains/connectedServices/resolveQuotaTone';
import { useSetting } from '@/sync/store/hooks';
import { t } from '@/text';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { ConnectedServiceMark } from '../ConnectedServiceMark';
import { ConnectedAccountPrivacyToggle } from '../usage/ConnectedAccountPrivacyToggle';
import type {
    ConnectedServicesIndexAccount,
    ConnectedServicesIndexModel,
    ConnectedServicesIndexSheet,
} from '../model/buildConnectedServicesIndexModel';
import { presentConnectedServicesIndexAccount, presentConnectedServicesIndexPool } from '../model/presentConnectedServicesIndexAccount';
import { useConnectedServicesIndex } from '../model/useConnectedServicesIndex';
import {
    CONNECTED_SERVICES_AGENT_SIGN_IN_ROUTE,
    CONNECTED_SERVICES_COLLECTION_ROUTE,
    resolveConnectedServicesSelection,
    type ConnectedServicesSelection,
} from './connectedServicesCollectionRoutes';
import { NewPoolMenu, selectNewPoolServices } from './NewPoolMenu';

/** The rail offers search once it no longer fits at a glance. */
const SEARCH_THRESHOLD = 6;
/** A disclosed account sits one step in from its service. */
const ACCOUNT_INDENT_PX = 26;
const EMPTY_LABELS: Readonly<Record<string, string | undefined>> = {};

/** What an account row shows at its end: the tightest limit, a stale clock, or that it needs you. */
export type ConnectedServicesRailAccountMeta =
    | Readonly<{ kind: 'usage'; tightestPct: number; stale: boolean }>
    | Readonly<{ kind: 'signedOut' }>
    | Readonly<{ kind: 'key' }>
    | Readonly<{ kind: 'none' }>;

export type ConnectedServicesRailViewProps = Readonly<{
    model: ConnectedServicesIndexModel;
    labelsByKey: Readonly<Record<string, string | undefined>>;
    selection: ConnectedServicesSelection;
    present: ConnectedAccountIdentityPresenter;
    identitiesHidden: boolean;
    onSetIdentitiesHidden: (hidden: boolean) => void;
    /** "+" in the head: connect a service (the index's set-up blocks open on the catalog). */
    onConnect: () => void;
    onOpenIndex: () => void;
    onOpenService: (sheet: ConnectedServicesIndexSheet) => void;
    onOpenAccount: (sheet: ConnectedServicesIndexSheet, accountId: string) => void;
    onOpenPool: (sheet: ConnectedServicesIndexSheet, groupId: string) => void;
    /** "+" on Pools (a menu of services when there are several); absent when no service can hold one. */
    renderNewPool?: ((renderTrigger: (onPress: () => void) => React.ReactElement) => React.ReactNode) | null;
    onOpenAgentSignIn: () => void;
    /** Live rows read their own usage; a fixture preview passes it. */
    renderAccountMeta?: (sheet: ConnectedServicesIndexSheet, account: ConnectedServicesIndexAccount) => React.ReactNode;
}>;

function isSignedOut(account: ConnectedServicesIndexAccount): boolean {
    return normalizeConnectedServiceCredentialHealthStatus(account.status) === 'needs_reauth';
}

/**
 * The Connected services rail (lab `csvc` C1): services that expand to their accounts (each with its
 * tightest limit, a stale clock or ⚠), Pools with "+", Code and tools, and "How agents sign in" at the
 * foot. The head carries the privacy eye and "+" to connect a service.
 */
export const ConnectedServicesRailView = React.memo(function ConnectedServicesRailView(props: ConnectedServicesRailViewProps) {
    const { theme } = useUnistyles();
    const { model, selection, present, labelsByKey } = props;
    const agentSheets = model.sheets.filter((sheet) => sheet.section === 'agents');
    const toolSheets = model.sheets.filter((sheet) => sheet.section === 'tools');
    const pooled = agentSheets.flatMap((sheet) => sheet.pools.map((pool) => ({ sheet, pool })));
    const accountCount = model.sheets.reduce((total, sheet) => total + sheet.accounts.length, 0);

    const [query, setQuery] = React.useState('');
    const searchable = accountCount > SEARCH_THRESHOLD;
    const needle = searchable ? query.trim().toLowerCase() : '';
    // Services open by default when they hold several accounts; the open account's service always does.
    const [toggled, setToggled] = React.useState<ReadonlySet<string>>(() => new Set());
    const selectedServiceKey = selection.kind === 'account' || selection.kind === 'pool' || selection.kind === 'service'
        ? selection.serviceKey
        : null;
    const isExpanded = (sheet: ConnectedServicesIndexSheet) => {
        if (needle) return true;
        const byDefault = sheet.accounts.length > 1 || sheet.serviceKey === selectedServiceKey;
        return toggled.has(sheet.serviceKey) ? !byDefault : byDefault;
    };
    const toggle = (serviceKey: string) => setToggled((current) => {
        const next = new Set(current);
        if (next.has(serviceKey)) next.delete(serviceKey); else next.add(serviceKey);
        return next;
    });

    const renderService = (sheet: ConnectedServicesIndexSheet, expandable: boolean) => {
        const rows = sheet.accounts
            .map((account) => ({ account, presentation: presentConnectedServicesIndexAccount(sheet, account, labelsByKey, present) }))
            .filter(({ presentation }) => !needle
                || presentation.title.toLowerCase().includes(needle)
                || (presentation.identityLabel ?? '').toLowerCase().includes(needle)
                || sheet.label.toLowerCase().includes(needle));
        if (needle && rows.length === 0) return null;
        const open = expandable && isExpanded(sheet);
        const trouble = !open && sheet.accounts.some(isSignedOut);
        const serviceSelected = selection.kind === 'service' && selection.serviceKey === sheet.serviceKey;
        const caret = expandable ? (
            <Icon name={open ? 'caret-down' : 'caret-right'} size={12} color={theme.colors.text.tertiary} />
        ) : <View style={styles.caretSpace} />;
        return (
            <React.Fragment key={sheet.serviceKey}>
                <Item
                    testID={`connected-services-rail:service:${sheet.serviceKey}`}
                    title={sheet.label}
                    leftElement={(
                        <View style={styles.serviceLead}>
                            {caret}
                            <ConnectedServiceMark legacyServiceId={sheet.legacyServiceId} size="inline" />
                        </View>
                    )}
                    rightElement={(
                        <View style={styles.meta}>
                            {trouble ? <View style={[styles.dot, { backgroundColor: theme.colors.state.warning.foreground }]} /> : null}
                            <Text style={styles.count}>{String(sheet.accounts.length)}</Text>
                        </View>
                    )}
                    accessibilityExpanded={expandable ? open : undefined}
                    selected={serviceSelected}
                    density="compact"
                    showChevron={false}
                    pressableStyle={collectionListStyles.row}
                    onPress={() => (expandable ? toggle(sheet.serviceKey) : props.onOpenService(sheet))}
                />
                {open ? rows.map(({ account, presentation }) => {
                    const selected = selection.kind === 'account'
                        && selection.serviceKey === sheet.serviceKey
                        && selection.accountId === account.accountId;
                    const inUse = sheet.rolesByAccountId[account.accountId]?.pools.some((pool) => pool.inUse) === true;
                    return (
                        <Item
                            key={account.accountId}
                            testID={`connected-services-rail:account:${sheet.serviceKey}:${account.accountId}`}
                            title={presentation.title}
                            accessibilityLabel={t('connectedServicesCollection.railAccountLabel', { service: sheet.label, account: presentation.title })}
                            rightElement={(
                                <View style={styles.meta}>
                                    {inUse ? (
                                        <View accessibilityLabel={t('connectedServicesCollection.inUse')}>
                                            <Icon name="stack" size={12} color={theme.colors.text.tertiary} />
                                        </View>
                                    ) : null}
                                    {props.renderAccountMeta
                                        ? props.renderAccountMeta(sheet, account)
                                        : <LiveAccountMeta sheet={sheet} account={account} />}
                                </View>
                            )}
                            selected={selected}
                            density="compact"
                            showChevron={false}
                            pressableStyle={collectionListStyles.row}
                            style={{ paddingLeft: ACCOUNT_INDENT_PX }}
                            onPress={() => props.onOpenAccount(sheet, account.accountId)}
                        />
                    );
                }) : null}
            </React.Fragment>
        );
    };

    const header = (
        <View style={styles.headerActions}>
            <ConnectedAccountPrivacyToggle
                testID="connected-services-rail:privacy"
                hidden={props.identitiesHidden}
                onChange={props.onSetIdentitiesHidden}
            />
            <IconButton
                testID="connected-services-rail:connect"
                iconName="plus"
                accessibilityLabel={t('connectedServicesCollection.connectService')}
                tooltip={t('connectedServicesCollection.connectService')}
                variant="plain"
                onPress={props.onConnect}
            />
        </View>
    );

    return (
        <CollectionList
            testID="connected-services-rail"
            title={t('settings.connectedServices')}
            headerAction={header}
            search={searchable ? {
                value: query,
                onChangeText: setQuery,
                placeholder: t('connectedServicesCollection.searchAccounts'),
            } : null}
            footer={(
                <Item
                    testID="connected-services-rail:agent-sign-in"
                    title={t('connectedServicesCollection.agentSignInTitle')}
                    icon={<Icon name="sparkle" size={18} color={theme.colors.text.secondary} />}
                    selected={selection.kind === 'agentSignIn'}
                    density="compact"
                    showChevron
                    pressableStyle={collectionListStyles.row}
                    onPress={props.onOpenAgentSignIn}
                />
            )}
        >
            {agentSheets.length > 0 ? (
                <>
                    <CollectionListGroupLabel title={t('connectedServicesCollection.servicesGroup')} first />
                    {agentSheets.map((sheet) => renderService(sheet, sheet.accounts.length > 0))}
                </>
            ) : (
                <Text style={styles.quiet}>{t('connectedServicesCollection.railEmpty')}</Text>
            )}
            {pooled.length > 0 || props.renderNewPool ? (
                <>
                    <CollectionListGroupLabel
                        title={t('connectedServicesCollection.poolsGroup')}
                        trailing={props.renderNewPool ? props.renderNewPool((onPress) => (
                            <IconButton
                                testID="connected-services-rail:new-pool"
                                iconName="plus"
                                size={24}
                                accessibilityLabel={t('connectedServicesCollection.newPool')}
                                tooltip={t('connectedServicesCollection.newPool')}
                                variant="plain"
                                onPress={onPress}
                            />
                        )) : undefined}
                    />
                    {pooled.map(({ sheet, pool }) => {
                        const active = pool.activeConnectedAccountId
                            ? sheet.accounts.find((account) => account.accountId === pool.activeConnectedAccountId) ?? null
                            : null;
                        const activeTitle = active ? presentConnectedServicesIndexAccount(sheet, active, labelsByKey, present).title : null;
                        return (
                            <Item
                                key={`${sheet.serviceKey}:${pool.ref.groupId}`}
                                testID={`connected-services-rail:pool:${sheet.serviceKey}:${pool.ref.groupId}`}
                                title={presentConnectedServicesIndexPool(sheet, pool, labelsByKey)}
                                icon={<Icon name="stack" size={16} color={theme.colors.text.secondary} />}
                                detail={activeTitle ?? undefined}
                                selected={selection.kind === 'pool' && selection.serviceKey === sheet.serviceKey && selection.groupId === pool.ref.groupId}
                                density="compact"
                                showChevron={false}
                                pressableStyle={collectionListStyles.row}
                                onPress={() => props.onOpenPool(sheet, pool.ref.groupId)}
                            />
                        );
                    })}
                </>
            ) : null}
            {toolSheets.length > 0 ? (
                <>
                    <CollectionListGroupLabel title={t('connectedServicesSettings.codeAndToolsTitle')} />
                    {toolSheets.map((sheet) => renderService(sheet, sheet.accounts.length > 0))}
                </>
            ) : null}
        </CollectionList>
    );
});

/** An account's tightest limit, read by the row that shows it (one shared snapshot store per account). */
const LiveAccountMeta = React.memo(function LiveAccountMeta(props: Readonly<{
    sheet: ConnectedServicesIndexSheet;
    account: ConnectedServicesIndexAccount;
}>) {
    if (isSignedOut(props.account)) return <RailAccountMeta meta={{ kind: 'signedOut' }} />;
    if (props.account.kind !== 'qualified') return null;
    if (props.account.profile.kind === 'token') return <RailAccountMeta meta={{ kind: 'key' }} />;
    return <QualifiedAccountMeta account={props.account} />;
});

const QualifiedAccountMeta = React.memo(function QualifiedAccountMeta(props: Readonly<{
    account: Extract<ConnectedServicesIndexAccount, { kind: 'qualified' }>;
}>) {
    const quota = useQualifiedConnectedAccountQuota(props.account.profile.ref);
    const snapshot = quota.snapshot;
    const tightest = snapshot ? deriveAccountCapacityPct(snapshot.meters.flatMap((meter) => (
        meter.status === 'unavailable' || meter.remainingPct === null || meter.remainingPct === undefined
            ? []
            : [{ remainingPct: meter.remainingPct }]
    ))) : null;
    if (tightest === null || !snapshot) return null;
    const stale = Date.now() - snapshot.fetchedAt > snapshot.staleAfterMs;
    return <RailAccountMeta meta={{ kind: 'usage', tightestPct: tightest, stale }} />;
});

/** The row end's glyphs: "42%" in its tone (a clock when stale), ⚠ when signed out, "key" for keys. */
export const RailAccountMeta = React.memo(function RailAccountMeta(props: Readonly<{ meta: ConnectedServicesRailAccountMeta }>) {
    const { theme } = useUnistyles();
    const { meta } = props;
    if (meta.kind === 'none') return null;
    if (meta.kind === 'signedOut') {
        return (
            <View accessibilityLabel={t('connectedServicesSettings.needsSignIn')}>
                <Icon name="warning" size={13} color={theme.colors.state.warning.foreground} />
            </View>
        );
    }
    if (meta.kind === 'key') return <Text style={styles.count}>{t('connectedServicesCollection.railKey')}</Text>;
    const tone = resolveQuotaTone(meta.tightestPct);
    const color = tone === 'danger'
        ? theme.colors.state.danger.foreground
        : tone === 'warning' ? theme.colors.state.warning.foreground : theme.colors.text.tertiary;
    return (
        <View style={styles.meta}>
            {meta.stale ? <Icon name="clock" size={12} color={theme.colors.text.tertiary} /> : null}
            <Text style={[styles.count, { color }]}>{`${Math.round(meta.tightestPct)}%`}</Text>
        </View>
    );
});

/** The rail beside the collection's detail; it reads while the Connected services navigator is focused. */
export const ConnectedServicesRail = React.memo(function ConnectedServicesRail() {
    const router = useRouter();
    const pathname = usePathname();
    const params = useGlobalSearchParams();
    const { indexModel } = useConnectedServicesIndex({ agents: 'cached' });
    const labelsByKey = useSetting('connectedServicesProfileLabelByKey') ?? EMPTY_LABELS;
    const privacy = useConnectedAccountIdentityPrivacy();
    const selection = resolveConnectedServicesSelection(pathname, params);
    const onDetail = selection.kind !== 'index';
    const accountGroupsEnabled = useFeatureEnabled('connectedServices.accountGroups');
    const newPoolServices = React.useMemo(() => selectNewPoolServices(indexModel), [indexModel]);

    const open = React.useCallback((href: Parameters<typeof router.push>[0], tag: string) => {
        // Beside a detail, choosing another entity replaces the shown detail instead of stacking history.
        const result = runGuardedNavigation(() => (onDetail ? router.replace(href) : router.push(href)));
        if (result !== true) fireAndForget(result, { tag });
    }, [onDetail, router]);

    return (
        <ConnectedServicesRailView
            model={indexModel}
            labelsByKey={labelsByKey}
            selection={selection}
            present={privacy.present}
            identitiesHidden={privacy.hidden}
            onSetIdentitiesHidden={privacy.setHidden}
            onConnect={() => open({ pathname: CONNECTED_SERVICES_COLLECTION_ROUTE, params: { connect: '1' } }, 'ConnectedServicesRail.connect')}
            onOpenIndex={() => open(CONNECTED_SERVICES_COLLECTION_ROUTE, 'ConnectedServicesRail.index')}
            onOpenService={(sheet) => open(buildConnectedAccountSettingsRoute(sheet.service), 'ConnectedServicesRail.service')}
            onOpenAccount={(sheet, accountId) => open(buildConnectedAccountSettingsRoute(sheet.service, { kind: 'account', accountId }), 'ConnectedServicesRail.account')}
            onOpenPool={(sheet, groupId) => open(buildConnectedAccountSettingsRoute(sheet.service, { kind: 'group', groupId }), 'ConnectedServicesRail.pool')}
            onOpenAgentSignIn={() => open(CONNECTED_SERVICES_AGENT_SIGN_IN_ROUTE, 'ConnectedServicesRail.agentSignIn')}
            renderNewPool={accountGroupsEnabled && newPoolServices.length > 0 ? (renderTrigger) => (
                <NewPoolMenu
                    testID="connected-services-rail:new-pool-menu"
                    services={newPoolServices}
                    onCreate={(sheet) => open(buildNewConnectedAccountPoolRoute(sheet.service), 'ConnectedServicesRail.newPool')}
                    renderTrigger={renderTrigger}
                />
            ) : null}
        />
    );
});

const styles = StyleSheet.create((theme) => ({
    headerActions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 2,
    },
    serviceLead: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    caretSpace: {
        width: 12,
    },
    meta: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    dot: {
        width: 6,
        height: 6,
        borderRadius: 3,
    },
    count: {
        ...Typography.default(),
        fontSize: 12.5,
        lineHeight: 16,
        color: theme.colors.text.tertiary,
        fontVariant: ['tabular-nums'],
    },
    quiet: {
        ...Typography.default(),
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.text.tertiary,
        paddingHorizontal: 22,
        paddingVertical: 6,
    },
}));
