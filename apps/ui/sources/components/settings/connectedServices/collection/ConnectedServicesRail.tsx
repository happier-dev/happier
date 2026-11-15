import * as React from 'react';
import { resolveConnectedAccountAccessMode } from '../model/resolveConnectedAccountAccessMode';
import { presentConnectedAccountAccessMode } from '../model/presentConnectedAccountAccessMode';
import { useConnectedAccountSubscription } from '../usage/AccountUsageFacts';
import { View, type GestureResponderEvent } from 'react-native';
import { useGlobalSearchParams, usePathname, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { parseDisplayableCredentialHealthStatus } from '@/sync/domains/connectedServices/parseDisplayableCredentialHealthStatus';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { ToolbarButton } from '@/components/ui/buttons/ToolbarButton';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { VirtualizedList } from '@/components/ui/lists/virtualized';
import {
    CollectionDraftRow,
    CollectionList,
    CollectionListGroupLabel,
    CollectionNavigationRow,
    CollectionSkeletonRows,
    collectionListStyles,
} from '@/components/ui/lists/collection/CollectionList';
import { useCollectionDraftTitle } from '@/components/ui/lists/collection/CollectionDraftTitle';
import { CollectionStatusGlyph } from '@/components/ui/lists/collection/CollectionStatusGlyph';
import { CollectionIndexRow } from '@/components/ui/lists/collection/CollectionIndexRow';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useConnectedAccountIdentityPrivacy, type ConnectedAccountIdentityPresenter } from '@/hooks/ui/useConnectedAccountIdentityPrivacy';
import { useQualifiedConnectedAccountQuota } from '@/hooks/server/connectedServices/useQualifiedConnectedAccountQuota';
import { buildConnectedAccountSettingsRoute, buildNewConnectedAccountPoolRoute } from '@/sync/domains/connectedServices/connectedAccountSettingsRoute';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { deriveAccountCapacityPct } from '@/sync/domains/connectedServices/deriveAccountCapacityPct';
import { resolveQuotaTone } from '@/sync/domains/connectedServices/resolveQuotaTone';
import { selectConnectedMetadataLabels, useConnectedMetadataCatalog } from '@/hooks/server/connectedServices/useConnectedMetadataCatalog';
import { t } from '@/text';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { useActiveServerAccountScope } from '@/sync/store/hooks';
import type { PopoverAnchor } from '@/components/ui/popover/_types';
import { resolvePressTriggerAnchor } from '@/components/ui/popover/resolvePointerMenuAnchor';
import { presentConnectSheet } from '../setup/ConnectedServiceSetupModal';
import { ConnectedAccountSettled } from '../setup/ConnectedAccountSettled';
import type { ConnectedAccountSetupCompletion, ConnectedAccountSetupFacts } from '../account/useConnectedAccountSetupCompletion';
import type { QualifiedConnectedAccountRef } from '@happier-dev/protocol/connect/qualifiedConnectedAccountPersistence';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { ConnectedServicesGatewaysUnavailableLine, useConnectedServicesGatewaysUnavailable } from '../index/ConnectedServicesGatewaysGroup';

import { ConnectedServiceMark } from '../ConnectedServiceMark';
import { ConnectedAccountPrivacyToggle } from '../usage/ConnectedAccountPrivacyToggle';
import { ConnectedAccountActionApprovalNotice } from '../ConnectedAccountActionApprovalNotice';
import type {
    ConnectedServicesIndexAccount,
    ConnectedServicesIndexModel,
    ConnectedServicesIndexSheet,
} from '../model/buildConnectedServicesIndexModel';
import { presentConnectedServicesIndexAccount, presentConnectedServicesIndexPool } from '../model/presentConnectedServicesIndexAccount';
import { useConnectedServicesIndex, type ConnectedServicesGatewayRow } from '../model/useConnectedServicesIndex';
import {
    CONNECTED_SERVICES_AGENT_SIGN_IN_ROUTE,
    CONNECTED_SERVICES_COLLECTION_ROUTE,
    buildCredentialsSecretRoute,
    resolveConnectedServicesSelection,
    type ConnectedServicesSelection,
} from './connectedServicesCollectionRoutes';
import { NewPoolMenu, selectNewPoolServices } from './NewPoolMenu';
import { ConnectedServicesAddMenu } from './ConnectedServicesAddMenu';
import { connectedAccountColumnFacts, connectedServicesColumnAdapter } from './connectedServicesColumnAdapter';
import { useSettingsColumnFilter } from '@/components/settings/shell/useSettingsColumnFilter';
import { isConnectedAccountSignedOut, presentConnectedAccountSignedOut, resolveConnectedAccountCredentialStatusLabel } from '../account/connectedAccountCredentialStatusLabel';
import type { ConnectedServiceCredentialHealthStatusV1, ConnectedServiceCredentialRefreshFailureKindV1 } from '@happier-dev/protocol/connect/connected-service-schemas';
import { presentNewConnectedAccountDraftTitle } from '../setup/connectMoreBlocks';
import type { SavedSecretCatalogEntryV1 } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';
import { useCredentialsSecrets } from '../index/CredentialsSecretsGroup';
import { savedSecretOwnedRowSummary, sharedSecretProvenanceSegments, sharedSecretRowStatus, sharedSecretStatusLabel } from '@/components/secrets/savedSecretRowCopy';
import type { CredentialsSecretsState } from '../index/credentialsSecretsState';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import type { ScopedSnapshotError } from '@/sync/domains/scope/scopedSnapshotFacts';
import { resolveActionExecutionErrorMessage } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';

/** The rail offers search once it no longer fits at a glance. */
const SEARCH_THRESHOLD = 6;
/** The add's 16 px glyph reaches the height of its 32 px row, and no further: the first row is directly beneath. */
const GROUP_ADD_VERTICAL_REACH = { top: 8, bottom: 8 } as const;

/** One mounted line of the rail; only the recycler's window renders its element (300 accounts mount a viewport). */
type RailRow = Readonly<{ key: string; render: () => React.ReactElement }>;
const railRowKey = (row: RailRow) => row.key;
const renderRailRow = ({ item }: Readonly<{ item: RailRow }>) => item.render();
const RAIL_LIST_STYLE = { flex: 1, minHeight: 0 } as const;
const RAIL_LIST_CONTENT_STYLE = { paddingBottom: 16 } as const;

/** What an account row shows at its end: the tightest limit, a stale clock, or that it needs you. */
export type ConnectedServicesRailAccountMeta =
    | Readonly<{ kind: 'usage'; tightestPct: number; stale: boolean }>
    | Readonly<{ kind: 'signedOut'; statusReason?: ConnectedServiceCredentialRefreshFailureKindV1 }>
    | Readonly<{ kind: 'key' }>
    | Readonly<{ kind: 'none' }>;

export type ConnectedServicesRailViewProps = Readonly<{
    model: ConnectedServicesIndexModel;
    labelsByKey: Readonly<Record<string, string | undefined>>;
    selection: ConnectedServicesSelection;
    present: ConnectedAccountIdentityPresenter;
    identitiesHidden: boolean;
    onSetIdentitiesHidden: (hidden: boolean) => void;
    /** "+" in the head when no menu is supplied: connect a service. */
    onConnect: (anchor?: PopoverAnchor) => void;
    settled?: Readonly<{ serviceKey: string; content: React.ReactNode }> | null;
    /** "+" in the head as the grouped, searchable menu of what can be added (P8-R3); it renders its trigger. */
    renderConnect?: ((renderTrigger: (onPress: () => void) => React.ReactElement) => React.ReactNode) | null;
    onOpenIndex: () => void;
    onOpenService: (sheet: ConnectedServicesIndexSheet) => void;
    onOpenNpmProfiles?: () => void;
    onOpenAccount: (sheet: ConnectedServicesIndexSheet, accountId: string) => void;
    /** A service row's "+": add another account of that service (its draft beside the rail). */
    onAddAccount?: (sheet: ConnectedServicesIndexSheet, anchor?: PopoverAnchor) => void;
    /** Owned and granted Saved Secrets (Q2: a service's key appears only under its service). */
    secrets?: Readonly<{ entries: readonly SavedSecretCatalogEntryV1[]; state: CredentialsSecretsState; onRetry: () => void;
        errorCause?: ScopedSnapshotError | null }>;
    onOpenSecret?: (ref: string) => void;
    /** "+" on Secrets: the create form in a popover under it (owner 10-31); it renders its trigger. */
    renderNewSecret?: ((renderTrigger: (onPress: () => void) => React.ReactElement) => React.ReactNode) | null;
    onOpenPool: (sheet: ConnectedServicesIndexSheet, groupId: string) => void;
    /** "+" on Pools (a menu of services when there are several); absent when no service can hold one. */
    renderNewPool?: ((renderTrigger: (onPress: () => void) => React.ReactElement) => React.ReactNode) | null;
    onOpenAgentSignIn: () => void;
    /** Gateways that draw on these subscriptions; each opens its one page (shared with Providers). */
    gateways?: readonly ConnectedServicesGatewayRow[];
    /** The Account catalog is still loading: the group holds one quiet row in its place. */
    gatewaysLoading?: boolean;
    onOpenGateway?: (gateway: ConnectedServicesGatewayRow) => void;
    /** "+" on Gateways: opens a gateway draft beside the list; only its explicit Create writes the Account. */
    onAddGateway?: () => void;
    /** "+" on Gateways when several contributions qualify: the add menu of gateways; it renders its trigger. */
    renderAddGateway?: ((renderTrigger: (onPress: () => void) => React.ReactElement) => React.ReactNode) | null;
    /** The gateways cannot be read: the group keeps its place and says so, with Retry (D19). */
    gatewaysUnavailable?: Readonly<{ diagnosticCode: string; onRetry: () => void }> | null;
    /** Live rows read their own usage; a fixture preview passes it. */
    renderAccountMeta?: (sheet: ConnectedServicesIndexSheet, account: ConnectedServicesIndexAccount) => React.ReactNode;
}>;

function isSignedOut(account: ConnectedServicesIndexAccount): boolean {
    return isConnectedAccountSignedOut(parseDisplayableCredentialHealthStatus(account.status));
}

/**
 * The Connected services rail (lab `csvc` C1): services that expand to their accounts (each with its
 * tightest limit, a stale clock or ⚠), Pools with "+", Code and tools, and "How agents sign in" at the
 * foot. The head carries the privacy eye and "+" to connect a service.
 */
export const ConnectedServicesRailView = React.memo(function ConnectedServicesRailView(props: ConnectedServicesRailViewProps) {
    const { theme } = useUnistyles();
    const { model, selection, present, labelsByKey } = props;
    // Only declared Agent usage places a service under Agent sign-in; unknown accounts stay visible with tools.
    const agentSheets = model.sheets.filter((sheet) => sheet.section === 'agents');
    const pooled = agentSheets.flatMap((sheet) => sheet.pools.map((pool) => ({ sheet, pool })));
    const accountCount = model.sheets.reduce((total, sheet) => total + sheet.accounts.length, 0);

    const draftTitles = useCollectionDraftTitle();
    const [query, setQuery] = React.useState('');
    const searchable = accountCount > SEARCH_THRESHOLD;
    const needle = searchable ? query.trim().toLowerCase() : '';
    // Filters count accounts; service headings group those accounts without adding another result.
    const columnFacts = React.useMemo(() => model.sheets.flatMap((sheet) =>
        sheet.accounts.map((account) => connectedAccountColumnFacts({ sheet, account, labelsByKey, present })),
    ), [labelsByKey, model.sheets, present]);
    const serviceLabels = React.useMemo(() => new Map(model.sheets.map((sheet) => [sheet.serviceKey, sheet.label])), [model.sheets]);
    const filterFields = React.useMemo(() => ({
        service: { label: t('sessionsList.filtersService'), valueLabel: (serviceKey: string) => serviceLabels.get(serviceKey) ?? serviceKey },
        // A filter value is a short noun (a chip in a narrow column): the row's sentence keeps its "will retry".
        status: { label: t('sessionsList.filtersStatus'),
            valueLabel: (status: string) => status === 'refresh_failed_retryable' ? t('connectedServices.pools.behavior.switchOn.refreshFailure')
                : resolveConnectedAccountCredentialStatusLabel(status as ConnectedServiceCredentialHealthStatusV1) },
    }), [serviceLabels]);
    const columnFilter = useSettingsColumnFilter({
        column: 'connected-services',
        testIDPrefix: 'connected-services-rail',
        adapter: connectedServicesColumnAdapter,
        fields: filterFields,
        facts: columnFacts,
    });
    const matchesFilter = columnFilter.matches;
    const narrowed = needle !== '' || columnFilter.active;
    const npmProfilesVisible = Boolean(props.onOpenNpmProfiles) && !columnFilter.active
        && (!needle || t('settingsPlugins.registriesTitle').toLowerCase().includes(needle));
    // Services are open by default (owner 10-31); a person folds one in place. The open account's service and
    // a service being drafted into stay open.
    const [toggled, setToggled] = React.useState<ReadonlySet<string>>(() => new Set());
    const selectedServiceKey = 'serviceKey' in selection ? selection.serviceKey : null;
    const draftServiceKey = selection.kind === 'accountDraft' || selection.kind === 'poolDraft' ? selection.serviceKey : null;
    const isExpanded = (sheet: ConnectedServicesIndexSheet) => {
        if (sheet.serviceKey === draftServiceKey) return true;
        if (narrowed) return true;
        if (sheet.serviceKey === selectedServiceKey && selection.kind === 'account') return true;
        return !toggled.has(sheet.serviceKey);
    };
    const toggle = (serviceKey: string) => setToggled((current) => {
        if (serviceKey === draftServiceKey) return current;
        const next = new Set(current);
        if (next.has(serviceKey)) next.delete(serviceKey); else next.add(serviceKey);
        return next;
    });

    // A draft for a service with nothing added yet (its first API key): the service is not a sheet, so it is
    // listed here only while drafting, open on its draft row, in the group it belongs to (lab `s2svc:key`).
    const draftOnlyService = selection.kind === 'accountDraft' && !model.sheets.some((sheet) => sheet.serviceKey === draftServiceKey)
        ? model.connectable.find((service) => service.serviceKey === draftServiceKey) ?? null
        : null;
    // Same grouping as the sheets: only a service known to be an agent's sits under Agent sign-in.
    const draftOnlySection = draftOnlyService ? (draftOnlyService.section === 'agents' ? 'agents' : 'tools') : null;
    // Every line of the rail is one recycled row, so a long account list mounts only what the column shows.
    const rows: RailRow[] = [];
    const add = (key: string, render: () => React.ReactElement) => rows.push({ key, render });
    const addDraftOnlyService = (section: 'agents' | 'tools') => {
        if (!draftOnlyService || draftOnlySection !== section) return;
        add(`service:${draftOnlyService.serviceKey}`, () => (
            <CollectionNavigationRow
                rowRole="item"
                testID={`connected-services-rail:service:${draftOnlyService.serviceKey}`}
                surface="page"
                title={draftOnlyService.label}
                icon={<ConnectedServiceMark legacyServiceId={draftOnlyService.entry?.legacyServiceId ?? null} service={draftOnlyService.service} size="column" />}
                disclosure={{ expanded: true }}
                count={null}
                selected={false}
                onPress={() => toggle(draftOnlyService.serviceKey)}
            />
        ));
        add(`account-draft:${draftOnlyService.serviceKey}`, () => (
            <CollectionDraftRow
                rowRole="item"
                testID={`connected-services-rail:account-draft:${draftOnlyService.serviceKey}`}
                titles={draftTitles}
                placeholder={presentNewConnectedAccountDraftTitle(draftOnlyService)}
                child
            />
        ));
    };

    // Every "+" (a group's, a service row's) draws just its glyph, so all of them end on the rows' one trailing
    // edge with the percentages, key marks and counts beneath (owner 10-31); the hit area still reaches the target.
    const groupAdd = (testID: string, label: string, onPress: React.ComponentProps<typeof IconButton>['onPress']) => (
        <IconButton
            testID={testID}
            iconName="plus"
            size={16}
            iconSize={16}
            // A group's add sits in its label row with the first row directly beneath: its hit area stays in the row.
            interactiveTargetEdgesPx={GROUP_ADD_VERTICAL_REACH}
            accessibilityLabel={label}
            tooltip={label}
            variant="plain"
            onPress={onPress}
        />
    );

    // Headings and rows consume the same filtered projection; a hidden service cannot
    // leave an empty group behind or require a second identity/search pass.
    const visibleServices = model.sheets.map((sheet) => ({
        sheet,
        rows: sheet.accounts
            .map((account) => ({ account, presentation: presentConnectedServicesIndexAccount(sheet, account, labelsByKey, present) }))
            .filter(({ presentation }) => !needle
                || presentation.title.toLowerCase().includes(needle)
                || (presentation.identityLabel ?? '').toLowerCase().includes(needle)
                || sheet.label.toLowerCase().includes(needle))
            .filter(({ account }) => matchesFilter(`${sheet.serviceKey}:${account.accountId}`)),
    })).filter(({ sheet, rows }) => !narrowed || rows.length > 0
        || (sheet.serviceKey === draftServiceKey && selection.kind === 'accountDraft'));
    const visibleAgentServices = visibleServices.filter(({ sheet }) => sheet.section === 'agents');
    const visibleToolServices = visibleServices.filter(({ sheet }) => sheet.section !== 'agents');

    const addService = ({ sheet, rows: accountRows }: typeof visibleServices[number], expandable: boolean, withContext: boolean) => {
        const drafting = sheet.serviceKey === draftServiceKey && selection.kind === 'accountDraft';
        const open = (expandable || drafting) && isExpanded(sheet);
        // A folded service speaks for its accounts once: the strongest state they hold (P8 rollup).
        const signedOut = sheet.accounts.filter(isSignedOut).length;
        const rollup = !open && signedOut > 0 ? (
            <CollectionStatusGlyph
                status="signIn"
                label={signedOut === 1
                    ? presentConnectedAccountSignedOut().phrase
                    : `${presentConnectedAccountSignedOut().phrase} (${signedOut})`}
                testID={`connected-services-rail:service-rollup:${sheet.serviceKey}`}
            />
        ) : null;
        const serviceSelected = selection.kind === 'service' && selection.serviceKey === sheet.serviceKey;
        add(`service:${sheet.serviceKey}`, () => (
            <CollectionNavigationRow
                rowRole="item"
                testID={`connected-services-rail:service:${sheet.serviceKey}`}
                surface="page"
                title={sheet.label}
                icon={<ConnectedServiceMark legacyServiceId={sheet.legacyServiceId} service={sheet.service} size="column" />}
                disclosure={expandable || drafting ? { expanded: open } : null}
                status={rollup}
                count={sheet.accounts.length > 0 ? sheet.accounts.length : null}
                selected={serviceSelected}
                // Another account of this service, from where its accounts are listed (owner 10-30: always shown;
                // its draft says what it needs when no machine can run the sign-in yet).
                rightElement={props.onAddAccount ? groupAdd(
                    `connected-services-rail:service:${sheet.serviceKey}:add`,
                    t('connectedServicesCollection.addServiceAccount', { service: sheet.label }),
                    (event) => props.onAddAccount?.(sheet, resolvePressTriggerAnchor(event)),
                ) : undefined}
                onPress={() => (expandable || drafting ? toggle(sheet.serviceKey) : props.onOpenService(sheet))}
            />
        ));
        if (open && drafting) {
            add(`account-draft:${sheet.serviceKey}`, () => (
                <CollectionDraftRow
                    rowRole="item"
                    testID={`connected-services-rail:account-draft:${sheet.serviceKey}`}
                    titles={draftTitles}
                    placeholder={presentNewConnectedAccountDraftTitle(sheet)}
                    child
                />
            ));
        }
        if (open) {
            for (const { account, presentation } of accountRows) {
                const selected = selection.kind === 'account'
                    && selection.serviceKey === sheet.serviceKey
                    && selection.accountId === account.accountId;
                // Every account reads the same way (owner 10-31): its email, then its name and plan. A tool
                // with no email keeps its own identity beside its name.
                const context = presentation.listName
                    ?? (withContext && presentation.identityLabel && presentation.identityLabel !== presentation.title
                        ? presentation.identityLabel
                        : null);
                add(`account:${sheet.serviceKey}:${account.accountId}`, () => (
                    <RailAccountRow
                        testID={`connected-services-rail:account:${sheet.serviceKey}:${account.accountId}`}
                        sheet={sheet}
                        account={account}
                        title={presentation.listTitle}
                        context={context}
                        accessibilityLabel={t('connectedServicesCollection.railAccountLabel', { service: sheet.label, account: presentation.listTitle })}
                        meta={props.renderAccountMeta ? props.renderAccountMeta(sheet, account) : undefined}
                        selected={selected}
                        onPress={() => props.onOpenAccount(sheet, account.accountId)}
                    />
                ));
            }
        }
        const settled = props.settled?.serviceKey === sheet.serviceKey ? props.settled.content : null;
        if (settled) add(`settled:${sheet.serviceKey}`, () => <>{settled}</>);
    };

    // "+" opens the add menu (or connects a service when no menu is supplied).
    const { renderConnect, onConnect, identitiesHidden, onSetIdentitiesHidden } = props;
    const connect = React.useMemo(() => {
        const trigger = (onPress: () => void) => (
            <IconButton
                testID="connected-services-rail:connect"
                iconName="plus"
                accessibilityLabel={t('connectedServicesCollection.connectService')}
                tooltip={t('connectedServicesCollection.connectService')}
                variant="plain"
                onPress={onPress}
            />
        );
        return renderConnect ? renderConnect(trigger) : trigger((event?: GestureResponderEvent) => onConnect(resolvePressTriggerAnchor(event)));
    }, [onConnect, renderConnect]);
    const filterInHead = accountCount > 0 && !searchable;
    const header = (
        <View style={styles.headerActions}>
            {filterInHead ? columnFilter.filterButton : null}
            <ConnectedAccountPrivacyToggle
                testID="connected-services-rail:privacy"
                hidden={identitiesHidden}
                onChange={onSetIdentitiesHidden}
            />
            {connect}
        </View>
    );

    const visibleSecrets = (props.secrets?.entries ?? []).filter((entry) => !needle || (entry.name ?? '').toLowerCase().includes(needle));
    // A condition on services and accounts leaves gateways out; a pool stays with its service's matching accounts.
    const visibleGateways = columnFilter.active ? [] : (props.gateways ?? []).filter((gateway) => !needle || gateway.title.toLowerCase().includes(needle));
    const visiblePooled = pooled.filter(({ sheet, pool }) => (!needle
        || presentConnectedServicesIndexPool(sheet, pool, labelsByKey).toLowerCase().includes(needle)
        || sheet.label.toLowerCase().includes(needle))
        && (!columnFilter.active || sheet.accounts.some((account) => matchesFilter(`${sheet.serviceKey}:${account.accountId}`))));
    const poolDraftSheet = selection.kind === 'poolDraft'
        ? agentSheets.find((sheet) => sheet.serviceKey === selection.serviceKey) ?? null
        : null;

    // The way out to the settings of what the column lists, pinned under the column.
    const wayOut = (
        <>
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
        </>
    );

    // Beside a detail, the way back to the overview leads the column (lab `cr` aRail), as on Providers.
    add('overview', () => (
        <CollectionIndexRow
            testID="connected-services-rail:overview-row"
            selected={selection.kind === 'index'}
            onPress={props.onOpenIndex}
        />
    ));
    if (visibleAgentServices.length > 0 || draftOnlySection === 'agents') {
        // Open lists show their rows, so the label adds no count (owner 11-01); it is the first group under the
        // header block (the index row closes that block), so it takes the first group's air.
        add('group:agents', () => <CollectionListGroupLabel title={t('connectedServicesCollection.agentSignInGroup')} first />);
        for (const service of visibleAgentServices) addService(service, service.sheet.accounts.length > 0, false);
        addDraftOnlyService('agents');
    } else if (!narrowed) {
        add('empty', () => <Text style={styles.quiet}>{t('connectedServicesCollection.railEmpty')}</Text>);
    }
    if (visiblePooled.length > 0 || poolDraftSheet || (!narrowed && props.renderNewPool)) {
        add('group:pools', () => (
            <CollectionListGroupLabel
                title={t('connectedServicesCollection.poolsGroup')}
                trailing={props.renderNewPool ? props.renderNewPool((onPress) => (
                    groupAdd('connected-services-rail:new-pool', t('connectedServicesCollection.newPool'), onPress)
                )) : undefined}
            />
        ));
        if (poolDraftSheet) {
            add(`pool-draft:${poolDraftSheet.serviceKey}`, () => (
                <CollectionDraftRow
                    rowRole="item"
                    testID={`connected-services-rail:pool-draft:${poolDraftSheet.serviceKey}`}
                    titles={draftTitles}
                    placeholder={t('connectedServicesCollection.newPoolDraft', { service: poolDraftSheet.label })}
                    mark={<Icon name="stack" size={16} color={theme.colors.text.secondary} />}
                />
            ));
        }
        for (const { sheet, pool } of visiblePooled) {
            const active = pool.activeConnectedAccountId
                ? sheet.accounts.find((account) => account.accountId === pool.activeConnectedAccountId) ?? null
                : null;
            const activeTitle = active ? presentConnectedServicesIndexAccount(sheet, active, labelsByKey, present).title : null;
            add(`pool:${sheet.serviceKey}:${pool.ref.groupId}`, () => (
                <CollectionNavigationRow
                    testID={`connected-services-rail:pool:${sheet.serviceKey}:${pool.ref.groupId}`}
                    surface="page"
                    title={presentConnectedServicesIndexPool(sheet, pool, labelsByKey)}
                    subtitle={activeTitle
                        ? t('connectedServicesCollection.railPoolUsing', { service: sheet.label, account: activeTitle })
                        : sheet.label}
                    icon={<Icon name="stack" size={16} color={theme.colors.text.secondary} />}
                    count={pool.members.length > 0 ? pool.members.length : null}
                    selected={selection.kind === 'pool' && selection.serviceKey === sheet.serviceKey && selection.groupId === pool.ref.groupId}
                    onPress={() => props.onOpenPool(sheet, pool.ref.groupId)}
                />
            ));
        }
    }
    if (!columnFilter.active && (visibleGateways.length > 0 || selection.kind === 'gatewayDraft'
        || (!needle && (props.onAddGateway || props.renderAddGateway || props.gatewaysLoading || props.gatewaysUnavailable)))) {
        add('group:gateways', () => (
            <CollectionListGroupLabel
                title={t('settingsProvidersCollection.gateway.railGroup')}
                trailing={props.renderAddGateway
                    ? props.renderAddGateway((onPress) => groupAdd('connected-services-rail:add-gateway', t('settingsProvidersCollection.gateway.addGateway'), onPress))
                    : props.onAddGateway
                        ? groupAdd('connected-services-rail:add-gateway', t('settingsProvidersCollection.gateway.addGateway'), props.onAddGateway)
                        : undefined}
            />
        ));
        if (selection.kind === 'gatewayDraft') {
            add('gateway-draft', () => (
                <CollectionDraftRow
                    rowRole="item"
                    testID="connected-services-rail:gateway-draft"
                    titles={draftTitles}
                    placeholder={t('connectedServicesCollection.newGatewayDraft')}
                    mark={<Icon name="path" size={16} color={theme.colors.text.secondary} />}
                />
            ));
        }
        if (props.gatewaysLoading && !props.gateways?.length) {
            add('gateways-loading', () => <View testID="connected-services-rail:gateways-loading"><CollectionSkeletonRows count={1} /></View>);
        }
        const gatewaysUnavailable = props.gatewaysUnavailable;
        if (gatewaysUnavailable && !props.gateways?.length) {
            add('gateways-unavailable', () => (
                <ConnectedServicesGatewaysUnavailableLine testID="connected-services-rail:gateways-unavailable"
                    unavailable={gatewaysUnavailable} />
            ));
        }
        for (const gateway of visibleGateways) {
            add(`gateway:${gateway.connectionId}`, () => (
                <CollectionNavigationRow
                    testID={`connected-services-rail:gateway:${gateway.connectionId}`}
                    surface="page"
                    title={gateway.title}
                    subtitle={gateway.summary}
                    icon={<Icon name="path" size={16} color={theme.colors.text.secondary} />}
                    selected={selection.kind === 'gateway' && selection.connectionId === gateway.connectionId}
                    onPress={() => props.onOpenGateway?.(gateway)}
                />
            ));
        }
    }
    if (visibleToolServices.length > 0 || draftOnlySection === 'tools' || npmProfilesVisible) {
        add('group:tools', () => <CollectionListGroupLabel title={t('connectedServicesSettings.codeAndToolsTitle')} />);
        for (const service of visibleToolServices) addService(service, service.sheet.accounts.length > 0, true);
        addDraftOnlyService('tools');
        if (npmProfilesVisible) {
            add('npm-registry-profiles', () => (
                <CollectionNavigationRow
                    rowRole="item"
                    testID="connected-services-rail:npm-registry-profiles"
                    surface="page"
                    title={t('settingsPlugins.registriesTitle')}
                    icon={<Icon name="package" size={16} color={theme.colors.text.secondary} />}
                    selected={false}
                    onPress={() => props.onOpenNpmProfiles?.()}
                />
            ));
        }
    }
    const secrets = props.secrets;
    if (secrets && !columnFilter.active && (!needle || visibleSecrets.length > 0 || selection.kind === 'secretDraft')) {
        add('group:secrets', () => (
            <CollectionListGroupLabel
                title={t('connectedServicesCollection.secretsGroup')}
                trailing={props.renderNewSecret ? props.renderNewSecret((onPress) => groupAdd('connected-services-rail:new-secret', t('connectedServicesCollection.newSecret'), onPress)) : undefined}
            />
        ));
        if (selection.kind === 'secretDraft') {
            add('secret-draft', () => (
                <CollectionDraftRow
                    rowRole="item"
                    testID="connected-services-rail:secret-draft"
                    titles={draftTitles}
                    placeholder={t('connectedServicesCollection.newSecret')}
                    mark={<Icon name="key" size={16} color={theme.colors.text.secondary} />}
                />
            ));
        }
        if (secrets.state === 'loading') {
            add('secrets-loading', () => <View testID="connected-services-rail:secrets-loading"><CollectionSkeletonRows count={2} /></View>);
        } else if (secrets.state === 'failed') {
            add('secrets-failed', () => (
                <View style={collectionListStyles.stateLine}>
                    <SurfaceStateCard
                        testID="connected-services-rail:secrets-failed"
                        kind="warning"
                        size="line"
                        title={resolveActionExecutionErrorMessage(secrets.errorCause, t('secretsSettings.staleTitle'), { safeToRetry: true })}
                        action={{ label: t('common.retry'), onPress: secrets.onRetry }}
                    />
                </View>
            ));
        }
        for (const entry of visibleSecrets) {
            add(`secret:${entry.ref}`, () => (
                <CollectionNavigationRow
                    testID={`connected-services-rail:secret:${entry.ref}`}
                    surface="page"
                    title={entry.name ?? t('secrets.catalog.unavailableName')}
                    subtitle={entry.relationship === 'recipient' ? sharedSecretProvenanceSegments(entry).join(' · ') : savedSecretOwnedRowSummary(entry)}
                    status={secretRowStatus(entry)}
                    icon={<Icon name="key" size={16} color={theme.colors.text.secondary} />}
                    selected={selection.kind === 'secret' && selection.ref === entry.ref}
                    onPress={() => props.onOpenSecret?.(entry.ref)}
                />
            ));
        }
    }

    return (
        <>
        <CollectionList
            testID="connected-services-rail"
            title={t('connectedServicesCollection.indexTitle')}
            count={accountCount > 0 ? accountCount : undefined}
            headerAction={header}
            strip={columnFilter.tokenRow}
            search={searchable ? {
                value: query,
                onChangeText: setQuery,
                placeholder: t('connectedServicesCollection.searchCredentials'),
                trailing: columnFilter.filterButton,
                anchorRef: columnFilter.searchAnchorRef,
            } : null}
            footer={wayOut}
            scrollContent={(
                <>
                    <VirtualizedList
                        testID="connected-services-rail:list"
                        data={rows}
                        keyExtractor={railRowKey}
                        renderItem={renderRailRow}
                        extraData={selection}
                        style={RAIL_LIST_STYLE}
                        contentContainerStyle={RAIL_LIST_CONTENT_STYLE}
                    />
                    {columnFilter.editorOverlay}
                </>
            )}
        />
        </>
    );
});

/**
 * An account in the rail: its service's mark (owner 10-31), its email, and its name and plan beneath. A
 * subscription reads its plan and tightest limit from its one shared usage store; others show what they hold.
 */
const RailAccountRow = React.memo(function RailAccountRow(props: Readonly<{
    testID: string;
    sheet: ConnectedServicesIndexSheet;
    account: ConnectedServicesIndexAccount;
    title: string;
    context: string | null;
    accessibilityLabel: string;
    /** A fixture's end slot; live rows read their own. */
    meta?: React.ReactNode;
    selected: boolean;
    onPress: () => void;
}>) {
    const recordedMode = props.account.kind === 'qualified' ? resolveConnectedAccountAccessMode(props.account.profile) : null;
    const live = props.meta === undefined && !isSignedOut(props.account) && props.account.kind === 'qualified' && recordedMode?.kind !== 'apiKey';
    // A key says its mode on line 2 through the one mode presenter (lab `muse-accounts` A1), never as an end tag.
    return live && props.account.kind === 'qualified'
        ? <QualifiedRailAccountRow {...props} account={props.account} />
        : <RailAccountRowView {...props} plan={recordedMode?.kind === 'apiKey' ? presentConnectedAccountAccessMode(recordedMode, null) : null}
            status={props.meta !== undefined ? props.meta : <LiveAccountMeta sheet={props.sheet} account={props.account} />} />;
});

const QualifiedRailAccountRow = React.memo(function QualifiedRailAccountRow(props: React.ComponentProps<typeof RailAccountRow> & Readonly<{
    account: Extract<ConnectedServicesIndexAccount, { kind: 'qualified' }>;
}>) {
    const quota = useQualifiedConnectedAccountQuota(props.account.profile.ref, { fetchPolicy: 'cache_only' });
    const subscription = useConnectedAccountSubscription(quota.usageRecordId);
    const accessMode = resolveConnectedAccountAccessMode(props.account.profile, subscription);
    const snapshot = quota.snapshot;
    const tightest = snapshot ? deriveAccountCapacityPct(snapshot.meters.flatMap((meter) => (
        meter.status === 'unavailable' || meter.remainingPct === null || meter.remainingPct === undefined
            ? []
            : [{ remainingPct: meter.remainingPct }]
    ))) : null;
    const status = tightest !== null && snapshot
        ? <RailAccountMeta meta={{ kind: 'usage', tightestPct: tightest, stale: Date.now() - snapshot.fetchedAt > snapshot.staleAfterMs }} />
        : null;
    return <RailAccountRowView {...props} plan={accessMode ? presentConnectedAccountAccessMode(accessMode, snapshot?.planLabel) : snapshot?.planLabel ?? null} status={status} />;
});

function RailAccountRowView(props: Readonly<{
    testID: string;
    sheet: ConnectedServicesIndexSheet;
    title: string;
    context: string | null;
    plan: string | null;
    accessibilityLabel: string;
    status: React.ReactNode;
    selected: boolean;
    onPress: () => void;
}>) {
    const subtitle = [props.context, props.plan].filter(Boolean).join(' · ');
    return (
        <CollectionNavigationRow
            testID={props.testID}
            surface="page"
            child
            title={props.title}
            subtitle={subtitle || undefined}
            icon={<ConnectedServiceMark legacyServiceId={props.sheet.legacyServiceId} service={props.sheet.service} size="column" />}
            accessibilityLabel={props.accessibilityLabel}
            status={props.status}
            selected={props.selected}
            onPress={props.onPress}
        />
    );
}

/** A troubled secret's glyph in its row's status slot, the word in its tooltip; a ready secret is quiet. */
function secretRowStatus(entry: SavedSecretCatalogEntryV1): React.ReactNode {
    const status = sharedSecretRowStatus(entry.materialStatus);
    return status ? <CollectionStatusGlyph status={status} label={sharedSecretStatusLabel(entry.materialStatus)} /> : undefined;
}

/** The Secrets group's "+" and the create popover anchored under it. */
function NewSecretPopoverTrigger(props: Readonly<{
    renderTrigger: (onPress: () => void) => React.ReactElement;
    onCreated: (ref: string) => void;
}>) {
    // "New secret" is the one Connect sheet for a key with no purpose, hanging from this "+" (owner 10-31).
    const anchorRef = React.useRef<View>(null);
    const { onCreated } = props;
    const open = React.useCallback(() => {
        fireAndForget(presentConnectSheet({ service: { kind: 'key' }, intent: 'add', anchor: { kind: 'view', ref: anchorRef } }).then((result) => {
            if (result.kind !== 'dismissed') onCreated(result.secretRef);
        }), { tag: 'ConnectedServicesRail.newSecret' });
    }, [onCreated]);
    return <View ref={anchorRef} collapsable={false}>{props.renderTrigger(open)}</View>;
}

/** An account's tightest limit, read by the row that shows it (one shared snapshot store per account). */
const LiveAccountMeta = React.memo(function LiveAccountMeta(props: Readonly<{
    sheet: ConnectedServicesIndexSheet;
    account: ConnectedServicesIndexAccount;
}>) {
    if (isSignedOut(props.account)) return <RailAccountMeta meta={{ kind: 'signedOut', statusReason: props.account.kind === 'qualified' ? props.account.profile.statusReason : undefined }} />;
    if (props.account.kind !== 'qualified') return null;
    // A key's mode is its second line; its end stays quiet unless it reports a limit.
    return <QualifiedAccountMeta account={props.account} />;
});

const QualifiedAccountMeta = React.memo(function QualifiedAccountMeta(props: Readonly<{
    account: Extract<ConnectedServicesIndexAccount, { kind: 'qualified' }>;
}>) {
    const quota = useQualifiedConnectedAccountQuota(props.account.profile.ref, { fetchPolicy: 'cache_only' });
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

/** The row end's status slot: "42%" in its tone (the stale glyph when old), the sign-in glyph when signed out, "key" for keys. */
export const RailAccountMeta = React.memo(function RailAccountMeta(props: Readonly<{ meta: ConnectedServicesRailAccountMeta }>) {
    const { theme } = useUnistyles();
    const { meta } = props;
    if (meta.kind === 'none') return null;
    if (meta.kind === 'signedOut') {
        return <CollectionStatusGlyph status="signIn" label={resolveConnectedAccountCredentialStatusLabel('needs_reauth', meta.statusReason)} />;
    }
    if (meta.kind === 'key') return <Text style={styles.count}>{t('connectedServicesCollection.railKey')}</Text>;
    const tone = resolveQuotaTone(meta.tightestPct);
    const color = tone === 'danger'
        ? theme.colors.state.danger.textForeground
        : tone === 'warning' ? theme.colors.state.warning.textForeground : theme.colors.text.tertiary;
    return (
        <View style={styles.meta}>
            {meta.stale ? <CollectionStatusGlyph status="stale" label={t('connectedServicesCollection.railUsageStale')} /> : null}
            <Text style={[styles.count, { color }]}>{`${Math.round(meta.tightestPct)}%`}</Text>
        </View>
    );
});

/** The rail beside the collection's detail; it reads while the Connected services navigator is focused. */
export const ConnectedServicesRail = React.memo(function ConnectedServicesRail() {
    const router = useRouter();
    const scope = useActiveServerAccountScope();
    const pathname = usePathname();
    const params = useGlobalSearchParams();
    const { theme } = useUnistyles();
    const providersEnabled = useFeatureEnabled('providers');
    const { indexModel, agentEntries, appShellProjection, registryReadFailure, gateways, gatewaysLoading, addGateway, gatewayUnavailable, retryGateways, gatewayContributionChoice, gatewayCountsByContributionKey } = useConnectedServicesIndex({ agents: 'load', gateways: providersEnabled });
    const [settled, setSettled] = React.useState<ConnectedAccountSetupCompletion | null>(null);
    const onConnected = React.useCallback((account: QualifiedConnectedAccountRef, facts?: ConnectedAccountSetupFacts) => setSettled({ ...facts, account }), []);
    const gatewayFacts = React.useMemo(() => ({ gateways, addGateway, gatewayContributionChoice, gatewayCountsByContributionKey }),
        [addGateway, gatewayContributionChoice, gatewayCountsByContributionKey, gateways]);
    const gatewaysUnavailable = useConnectedServicesGatewaysUnavailable(gatewayUnavailable, retryGateways);
    const labelsByKey = useConnectedMetadataCatalog(undefined, selectConnectedMetadataLabels);
    const privacy = useConnectedAccountIdentityPrivacy({ mutation: true });
    const selection = resolveConnectedServicesSelection(pathname, params);
    const onDetail = selection.kind !== 'index';
    const accountGroupsEnabled = useFeatureEnabled('connectedServices.accountGroups');
    const newPoolServices = React.useMemo(() => selectNewPoolServices(indexModel), [indexModel]);
    // Saved Secrets, folded into Credentials: the overview's own reading and state (names and access only).
    const { entries: secretEntries, state: secretsState, retry: retrySecrets, errorCause: secretsErrorCause } = useCredentialsSecrets();
    const secrets = React.useMemo(() => ({ entries: secretEntries, state: secretsState, onRetry: retrySecrets, errorCause: secretsErrorCause }),
        [secretEntries, retrySecrets, secretsState, secretsErrorCause]);

    const open = React.useCallback((href: Parameters<typeof router.push>[0] | null, tag: string) => {
        if (!href) return;
        // Beside a detail, choosing another entity replaces the shown detail instead of stacking history.
        const result = runGuardedNavigation(() => (onDetail ? router.replace(href) : router.push(href)));
        if (result !== true) fireAndForget(result, { tag });
    }, [onDetail, router]);

    // Stable while the menu's facts are, so the phone's navigation bar is not re-published per render.
    const onConnect = React.useCallback((anchor?: PopoverAnchor) => {
        fireAndForget(presentConnectSheet({ scope, intent: 'add', ...(anchor ? { anchor } : {}) }).then(result => {
            if (result.kind !== 'dismissed') onConnected(result.account, result);
        }), { tag: 'ConnectedServicesRail.connect' });
    }, [onConnected, scope]);
    const renderConnect = React.useCallback((renderTrigger: (onPress: () => void) => React.ReactElement) => (
        <ConnectedServicesAddMenu
            model={indexModel}
            gatewayFacts={gatewayFacts}
            registryReadFailure={registryReadFailure}
            onOpen={(href) => open(href as never, 'ConnectedServicesRail.add')}
            renderTrigger={renderTrigger}
            onConnected={onConnected}
        />
    ), [gatewayFacts, indexModel, onConnected, open, registryReadFailure]);

    return (
        <>
        <ConnectedAccountActionApprovalNotice execution={privacy.execution} testID="connected-services-rail-privacy-approval-pending" />
        <ConnectedServicesRailView
            model={indexModel}
            labelsByKey={labelsByKey}
            selection={selection}
            present={privacy.present}
            identitiesHidden={privacy.hidden}
            onSetIdentitiesHidden={privacy.setHidden}
            onConnect={onConnect}
            settled={settled ? {
                serviceKey: buildQualifiedPluginContributionKey(settled.account.service),
                content: <ConnectedAccountSettled account={settled.account} completion={settled} model={indexModel} agents={agentEntries}
                    machineId={appShellProjection.machineId ?? undefined} onDismiss={() => setSettled(null)} />,
            } : null}
            renderConnect={renderConnect}
            onOpenIndex={() => open(CONNECTED_SERVICES_COLLECTION_ROUTE, 'ConnectedServicesRail.index')}
            onOpenService={(sheet) => open(buildConnectedAccountSettingsRoute(sheet.service), 'ConnectedServicesRail.service')}
            onOpenNpmProfiles={() => {
                fireAndForget(presentConnectSheet({ scope, service: { kind: 'npm-registry-profile' } }), {
                    tag: 'ConnectedServicesRail.openNpmProfiles',
                });
            }}
            onOpenAccount={(sheet, accountId) => open(buildConnectedAccountSettingsRoute(sheet.service, { kind: 'account', accountId }), 'ConnectedServicesRail.account')}
            onAddAccount={(sheet, anchor?: PopoverAnchor) => {
                fireAndForget(presentConnectSheet({ scope, intent: 'add', service: sheet.service, ...(anchor ? { anchor } : {}) }).then(result => {
                    if (result.kind !== 'dismissed') onConnected(result.account, result);
                }), {
                    tag: 'ConnectedServicesRail.addAccount',
                });
            }}
            secrets={secrets}
            onOpenSecret={(ref) => open(buildCredentialsSecretRoute({ ref }) as never, 'ConnectedServicesRail.secret')}
            renderNewSecret={(renderTrigger) => (
                <NewSecretPopoverTrigger
                    renderTrigger={renderTrigger}
                    onCreated={(ref) => open(buildCredentialsSecretRoute({ ref }) as never, 'ConnectedServicesRail.createdSecret')}
                />
            )}
            onOpenPool={(sheet, groupId) => open(buildConnectedAccountSettingsRoute(sheet.service, { kind: 'group', groupId }), 'ConnectedServicesRail.pool')}
            onOpenAgentSignIn={() => open(CONNECTED_SERVICES_AGENT_SIGN_IN_ROUTE, 'ConnectedServicesRail.agentSignIn')}
            gateways={gateways ?? undefined}
            gatewaysLoading={gatewaysLoading}
            gatewaysUnavailable={gatewaysUnavailable}
            onOpenGateway={(gateway) => {
                open(gateway.detailRoute as never, 'ConnectedServicesRail.gateway');
            }}
            onAddGateway={addGateway ? () => {
                // Open the shared authoring body. Only its explicit Create writes the Account.
                fireAndForget(addGateway().then((route) => {
                    if (!route) return;
                    const result = runGuardedNavigation(() => router.push(route as never));
                    if (result !== true) fireAndForget(result, { tag: 'ConnectedServicesRail.addGateway.open' });
                }), { tag: 'ConnectedServicesRail.addGateway' });
            } : undefined}
            renderAddGateway={gatewayContributionChoice.status === 'choice_required' && addGateway ? (renderTrigger) => (
                <ConnectedServicesAddMenu
                    testID="connected-services-rail:add-gateway-menu"
                    model={indexModel}
                    gatewayFacts={gatewayFacts}
                    only="gateways"
                    onOpen={(href) => open(href as never, 'ConnectedServicesRail.addGateway.choose')}
                    renderTrigger={renderTrigger}
                />
            ) : null}
            renderNewPool={accountGroupsEnabled && newPoolServices.length > 0 ? (renderTrigger) => (
                <NewPoolMenu
                    testID="connected-services-rail:new-pool-menu"
                    services={newPoolServices}
                    onCreate={(sheet) => open(buildNewConnectedAccountPoolRoute(sheet.service), 'ConnectedServicesRail.newPool')}
                    renderTrigger={renderTrigger}
                />
            ) : null}
        />
        </>
    );
});

const styles = StyleSheet.create((theme) => ({
    headerActions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s2,
    },
    meta: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s6,
    },
    count: {
        ...Typography.variant('meta'),
        color: theme.colors.text.tertiary,
        fontVariant: ['tabular-nums'],
    },
    quiet: {
        ...Typography.variant('body'),
        color: theme.colors.text.tertiary,
        paddingHorizontal: 22,
        paddingVertical: theme.space.s6,
    },
}));
