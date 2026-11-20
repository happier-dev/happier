import { RegistrySourcesUnavailable } from '@/components/capabilities/add/RegistrySourcesUnavailable';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import * as React from 'react';
import { formatAgentNameListFolded } from '@/components/capabilities/identity/agentNameList';
import { usePathname, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { buildPluginsHomeRoute, resolvePluginsSurfaceHost } from './model/pluginsSurfaceRoutes';
import { Status, useHappierCollection, type CollectionAnatomy, type CollectionRowActions } from '@happier-dev/plugin-ui';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { PluginProjectionDiagnostic } from '@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters';
import { Item } from '@/components/ui/lists/Item';
import { usePageNoticeActive } from '@/components/ui/lists/listPresentation';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { buildActionRowAccessibilityLabel } from '@/components/ui/lists/actionRowAccessibility';
import { PAGE_LIST_METRICS } from '@/components/ui/lists/pageListMetrics';
import { resolveItemGroupContentHorizontalInsetPx } from '@/components/ui/lists/itemGroupSpacing';
import { Switch } from '@/components/ui/forms/Switch';
import { SelectionTiles } from '@/components/ui/forms/SelectionTiles';
import { Text } from '@/components/ui/text/Text';
import { StatusPill } from '@/components/ui/status/StatusPill';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { SurfaceFreshnessLine, SurfaceFreshnessOnSheetProvider } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { Popover } from '@/components/ui/popover';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { useLayoutMaxWidthStyle } from '@/components/ui/layout/layout';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { formatPathRelativeToHome } from '@/utils/sessions/formatPathRelativeToHome';

import { PluginMark } from './PluginMark';
import { PluginsPageCollection } from './collection/PluginsPageCollection';
import { buildPluginMarketplaceDiscoverIssues } from './model/pluginMarketplaceDiscoverIssues';
import { PLUGIN_KIND_SHELF_ORDER, pluginKindShelfTitle, pluginListingAdds, resolvePluginKindShelf, type PluginKindShelfKey } from './model/pluginContributionKindLabel';
import type { PluginProjectionEntry } from '@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters';

/** The machine's contribution projection facts a plugin row reads: its Agent mark and what it adds. */
type PluginProjectionFactsById = Readonly<Record<string, Pick<PluginProjectionEntry, 'iconAgentId' | 'contributionKinds' | 'installedPackage'> | undefined>>;
import type { PluginsCollectionState } from './model/pluginsCollectionState';
import { PluginDiagnosticsSection } from './diagnostics/PluginDiagnosticsSection';
import type {
    PluginMarketplaceCatalogEntry,
    PluginMarketplaceDiscoverDiagnostic,
    PluginMarketplaceDiscoverSourceStatus,
    PluginMarketplaceNonInstallableListing,
} from './readPluginMarketplaceCatalog';
import { Icon } from '@/components/ui/icons/Icon';
import { buildApprovalHref } from '@/components/approvals/approvalNavigation';
import { readApprovalArtifactTitleInput, useApprovalRequestTitle } from '@/components/approvals/approvalRequestTitle';
import { executeWorkspaceUiAction } from '@/components/appShell/workspace/workspaceActionRuntime';
import { InboxArtifactSourceBoundary, useInboxArtifactBodyDemand, useInboxArtifactItems, useInboxArtifactSource } from '@/hooks/inbox/useInboxArtifactSource';
import { listOpenPluginApprovalArtifactsForMachine } from '@/sync/domains/artifacts/approvalArtifacts';
import { useActiveServerAccountScope } from '@/sync/store/hooks';
import { captureActiveServerAccountScopeLifetime, selectActiveServerAccountScopeForServer } from '@/sync/domains/scope/activeServerAccountScope';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { InstalledPluginActionId, PluginQuickInstallReview, PluginRoutineOperationSettlement, PluginSettingsScreenState } from './model/usePluginSettingsScreenState';
import {
    catalogReviewStatusLabel,
    projectBrowseSections,
    projectDevelopmentPluginPresentation,
    projectInstalledPluginLifecycleCapabilities,
    projectInstalledPluginPresentation,
    installedPluginVersionLabel,
    isPluginIncludedWithHappier,
    partitionInstalledPlugins,
    type DevelopmentPluginEntry,
    type InstalledPluginEntry,
    type PendingPluginChangeListing,
} from './model/pluginMarketplaceModel';
import type { DevelopmentStartUnavailableReason } from './development/developmentStartAvailability';
import { SkeletonRows } from '@/components/ui/lists/SkeletonRows';
import type { RegistryFailureStatus } from '@/registries/describeRegistrySourceStatus';

/** Grid (cards, the default) or List (rows) — the Plugins page's two presentations of one collection. */
export type PluginsCollectionPresentation = 'grid' | 'list';

/**
 * The selected machine's installed plugins, as cards (grid) or rows (list): identity, what each one
 * is for, and its state with the one control beside it — the enable switch, or Review when the
 * plugin needs a decision. The body opens the plugin; everything rarer lives there.
 *
 * It is the page: the page's own `header` above and `footer` below scroll with the plugins in the one
 * Collection. Every state is terminal and says what is true, in the Collection's place for items: a machine to
 * choose, the grid's shape while the machine answers, a failed read with Retry, nothing installed yet, or a search
 * that hid every plugin. A machine that went offline keeps its last-known plugins, with controls off.
 */
export function InstalledPluginsSection(props: Readonly<{
    collectionState: PluginsCollectionState;
    /** The plugins the search and filter leave visible. */
    installedPlugins: readonly InstalledPluginEntry[];
    presentation: PluginsCollectionPresentation;
    /** The plugin whose detail is open beside the collection. */
    selectedPluginId?: string | null;
    /** What the search or filter is narrowed to, named by the "no match" line. */
    searchText: string;
    /** A search or status filter is on. */
    filtering?: boolean;
    /** The machine's contribution projection by plugin id: the Agent mark and what each plugin adds. */
    projectionByPluginId?: PluginProjectionFactsById;
    machineId?: string | null;
    serverId?: string | null;
    /** Where each plugin runs across the Account ("On 3 machines"), from the machine matrix owner. */
    machineCoverageByPluginId?: Readonly<Record<string, string>>;
    /** The chosen machine described its plugins (no registry or snapshot notice). Default: true. */
    machineAnswered?: boolean;
    onClearSearch: () => void;
    onDiscover: () => void;
    onRetry: () => void;
    canRunActions: boolean;
    isPluginActionInFlight: (pluginId: string) => boolean;
    onNavigateToPlugin: (pluginId: string) => void;
    /** The open plugin closes (Escape inside the collection). */
    onClosePlugin?: () => void;
    onRunAction: (action: InstalledPluginActionId, pluginId: string) => void;
    /** The page above and below the plugins, in the page's one scroller. */
    header?: React.ReactNode;
    footer?: React.ReactNode;
}>) {
    const { theme } = useUnistyles();
    const styles = sectionStylesheet;
    const maxWidthStyle = useLayoutMaxWidthStyle();
    const ready = props.collectionState === 'ready' || props.collectionState === 'offline';
    const offline = props.collectionState === 'offline';
    const rows = ready ? projectInstalledPluginRows(props, offline) : NO_INSTALLED_ROWS;
    const { onNavigateToPlugin, onClosePlugin } = props;
    const onOpenChange = React.useCallback((key: string | null) => {
        if (key === null) onClosePlugin?.();
        else onNavigateToPlugin(key);
    }, [onClosePlugin, onNavigateToPlugin]);
    // What ships with Happier waits behind one quiet line; a search or filter opens it, so a match is never hidden.
    const [includedShown, setIncludedShown] = React.useState(false);
    const includedOpen = includedShown || props.filtering === true;
    const groups = React.useMemo(() => buildInstalledPluginShelves(rows, includedOpen), [rows, includedOpen]);
    const filter = React.useMemo(
        () => (includedOpen ? undefined : (row: InstalledPluginRow) => row.group === 'added'),
        [includedOpen],
    );
    const filtering = props.filtering === true;
    const includedCount = rows.filter((row) => row.group === 'included').length;
    // A quiet text action on the line, like Browse's "See all": the line is a disclosure, not a button bar.
    const groupAction = React.useCallback((groupKey: string) => (groupKey !== INCLUDED_SHELF || filtering ? null : {
        label: includedShown
            ? t('settingsPlugins.surfaces.includedHide')
            : t('settingsPlugins.surfaces.includedShow', { count: includedCount }),
        onPress: () => setIncludedShown((shown) => !shown),
        kind: 'link' as const,
    }), [filtering, includedCount, includedShown]);
    // Only a machine that answered can say nothing was added; an offline one shows what it last reported.
    const nothingAdded = props.collectionState === 'ready' && props.machineAnswered !== false && rows.length > 0 && rows.every((row) => row.group !== 'added');
    const model = useHappierCollection<InstalledPluginRow>({
        items: rows,
        keyOf: readInstalledPluginRowKey,
        groups,
        order: orderInstalledPluginRows,
        ...(filter ? { filter } : {}),
        openKey: props.selectedPluginId ?? null,
        onOpenChange,
    });
    const anatomy = useInstalledPluginAnatomy(props.projectionByPluginId, props.machineId, props.serverId, props.presentation);
    const controls = React.useMemo(
        () => new Map(rows.map((row) => [row.entry.pluginId, row.control] as const)),
        [rows],
    );
    const empty = (() => {
        switch (props.collectionState) {
            case 'noTarget':
                return (
                    <ItemGroup>
                        <Item
                            testID="settings.plugins.marketplace.installed.noTarget"
                            title={t('settingsPlugins.surfaces.chooseMachineInstalled')}
                            mode="info"
                            showChevron={false}
                        />
                    </ItemGroup>
                );
            case 'loading':
                // The grid holds its shape with skeleton cards (the Collection's `loading`); the list says so.
                return props.presentation === 'grid' ? (
                    <View testID="settings.plugins.marketplace.installed.loading" />
                ) : (
                    <ItemGroup>
                        <Item
                            testID="settings.plugins.marketplace.installed.loading"
                            title={t('common.loading')}
                            loading
                            mode="info"
                            showChevron={false}
                        />
                    </ItemGroup>
                );
            case 'readFailed':
                return (
                    <View style={[styles.stateFrame, maxWidthStyle]}>
                        <SurfaceStateCard
                            testID="settings.plugins.marketplace.installed.readFailed"
                            kind="error"
                            title={t('settingsPlugins.surfaces.readFailedTitle')}
                            reason={t('settingsPlugins.surfaces.readFailedBody')}
                            action={{ label: t('common.retry'), onPress: props.onRetry }}
                            accessibilitySemantics="alert"
                        />
                    </View>
                );
            case 'empty':
                return installedInvite(props.onDiscover, maxWidthStyle);
            case 'noMatch':
                return (
                    <PluginsNoMatch
                        testID="settings.plugins.marketplace.installed.noMatch"
                        clearTestID="settings.plugins.marketplace.installed.clearSearch"
                        query={props.searchText}
                        onClear={props.onClearSearch}
                    />
                );
            case 'ready':
                return undefined;
            case 'offline':
                return props.installedPlugins.length === 0 ? (
                    <ItemGroup>
                        <Item
                            testID="settings.plugins.marketplace.installed.noSnapshot"
                            title={t('settingsPlugins.surfaces.noSavedDetails')}
                            mode="info"
                            showChevron={false}
                        />
                    </ItemGroup>
                ) : undefined;
        }
    })();
    return (
        <InstalledPluginControlsContext.Provider value={controls}>
            <PluginsPageCollection<InstalledPluginRow>
                testID="settings.plugins.marketplace.installed"
                model={model}
                anatomy={anatomy}
                presentation={props.presentation}
                accessibilityLabel={t('settingsPlugins.surfaces.navigationTitle')}
                // Nothing added yet: the invitation leads, above the line that holds what ships with Happier.
                header={nothingAdded && !filtering ? <>{props.header}{installedInvite(props.onDiscover, maxWidthStyle, true)}</> : props.header}
                footer={props.footer}
                groupAction={groupAction}
                loading={props.collectionState === 'loading'}
                {...(empty === undefined ? {} : { empty })}
                // Cards use the anatomy's footer action; only list rows carry the accessory beside the body.
                useRowActions={props.presentation === 'list' ? useInstalledPluginRowActions : undefined}
            />
        </InstalledPluginControlsContext.Provider>
    );
}

/** The first-plugin invitation: what plugins are for, and the one way to get one. */
function installedInvite(onDiscover: () => void, maxWidthStyle: ReturnType<typeof useLayoutMaxWidthStyle>, nothingAdded = false) {
    return (
        <View style={[sectionStylesheet.stateFrame, maxWidthStyle]}>
            <EmptyState
                testID="settings.plugins.marketplace.installed.empty"
                scene="noPlugins"
                // With included plugins present, the truthful fact is that nothing was added yet.
                title={nothingAdded ? t('settingsPlugins.surfaces.nothingAddedTitle') : t('settingsPlugins.surfaces.emptyTitle')}
                subtitle={t('settingsPlugins.surfaces.emptyBody')}
                action={(
                    // The page header's Add is the page's one primary; the invitation's way in stays secondary.
                    <RoundButton
                        testID="settings.plugins.marketplace.installed.empty.browse"
                        size="normal"
                        display="secondary"
                        title={t('settingsPlugins.surfaces.browsePlugins')}
                        onPress={onDiscover}
                    />
                )}
            />
        </View>
    );
}

type InstalledPluginRow = Readonly<{
    entry: InstalledPluginEntry;
    group: 'added' | 'included';
    /** The shelf it sits on: Added, the kind an included plugin adds, or the included rest. */
    shelf: InstalledPluginShelfKey;
    statusLabel: string | null;
    statusTone: 'quiet' | 'warning' | 'danger';
    control: React.ReactNode;
    /** The source line, unless the section it sits in already names it. */
    byline: string | null;
}>;

const NO_INSTALLED_ROWS: readonly InstalledPluginRow[] = Object.freeze([]);
const NO_ROW_ACTIONS = Object.freeze({});

const readInstalledPluginRowKey = (row: InstalledPluginRow) => row.entry.pluginId;

/**
 * Within a shelf, plugins that say what they are for come first, then compact tiles, each in their given
 * order: grid rows share their tallest card's height, so mixing the two would stretch tiles into hollow cards.
 */
const orderInstalledPluginRows = (left: InstalledPluginRow, right: InstalledPluginRow): number => (
    Number(!left.entry.description) - Number(!right.entry.description)
);

type InstalledPluginShelfKey = 'added' | 'included' | PluginKindShelfKey;

const INCLUDED_SHELF = 'included';
const INCLUDED_REST_SHELF = 'includedRest';
/** Names the closed included line shows before "and N more" when no kinds are known. */
const INCLUDED_NAMES_SHOWN = 3;

/**
 * What the user added, then one quiet line for what ships with Happier, named by the kinds it holds. Opened,
 * that line is followed by a shelf per kind (Agents, Machines, Code hosting…) and the included plugins whose
 * kind is not known; with no kinds known at all, those sit under the line itself.
 */
function buildInstalledPluginShelves(rows: readonly InstalledPluginRow[], includedOpen: boolean) {
    const present = new Set(rows.map((row) => row.shelf));
    const kindShelves = PLUGIN_KIND_SHELF_ORDER.filter((key) => present.has(key));
    const hasIncluded = rows.some((row) => row.group === 'included');
    const axis: { key: string; title: string; description?: string }[] = [];
    if (present.has('added')) axis.push({ key: 'added', title: t('settingsPlugins.surfaces.addedGroup') });
    if (hasIncluded) {
        axis.push({
            key: INCLUDED_SHELF,
            title: t('settingsPlugins.rowSource.bundled'),
            // Closed, the line still says what it holds: its kinds, or (none known yet) the first few by name.
            description: kindShelves.length > 0
                ? kindShelves.map(pluginKindShelfTitle).join(' · ')
                : formatAgentNameListFolded(rows.filter((row) => row.group === 'included')
                    .sort(orderInstalledPluginRows).map((row) => row.entry.title), INCLUDED_NAMES_SHOWN),
        });
    }
    if (includedOpen) {
        for (const key of kindShelves) axis.push({ key, title: pluginKindShelfTitle(key) });
        if (kindShelves.length > 0 && present.has('included')) {
            axis.push({ key: INCLUDED_REST_SHELF, title: t('settingsPlugins.surfaces.kinds.other') });
        }
    }
    const restShelf = kindShelves.length > 0 ? INCLUDED_REST_SHELF : INCLUDED_SHELF;
    return {
        axis,
        groupOf: (row: InstalledPluginRow) => (row.shelf === 'included' ? restShelf : row.shelf),
        // The included line keeps its place while it is closed and holds no cards.
        retainEmpty: true,
    };
}

/** Each row's one control (the switch, or Review), read by the row where the List draws it. */
const InstalledPluginControlsContext = React.createContext<ReadonlyMap<string, React.ReactNode>>(new Map());

/** A list row carries its control beside the row; a card carries it in its footer (the anatomy's `action`). */
function useInstalledPluginRowActions(row: InstalledPluginRow): CollectionRowActions {
    const control = React.useContext(InstalledPluginControlsContext).get(row.entry.pluginId);
    return control === undefined || control === null ? NO_ROW_ACTIONS : { accessory: control };
}

function projectInstalledPluginRows(
    props: Readonly<{
        installedPlugins: readonly InstalledPluginEntry[];
        projectionByPluginId?: PluginProjectionFactsById;
        presentation: PluginsCollectionPresentation;
        machineCoverageByPluginId?: Readonly<Record<string, string>>;
        canRunActions: boolean;
        isPluginActionInFlight: (pluginId: string) => boolean;
        onNavigateToPlugin: (pluginId: string) => void;
        onRunAction: (action: InstalledPluginActionId, pluginId: string) => void;
    }>,
    offline: boolean,
): readonly InstalledPluginRow[] {
    const { added, included } = partitionInstalledPlugins(props.installedPlugins);
    /** `sectionNamesSource`: the group header already says where these plugins come from. */
    const project = (entry: InstalledPluginEntry, group: InstalledPluginRow['group']): InstalledPluginRow => {
        const capabilities = projectInstalledPluginLifecycleCapabilities(entry);
        const machineEnabled = entry.machineEnabled ?? entry.enabled;
        const toggleAction = machineEnabled ? 'disable' as const : 'enable' as const;
        const canToggle = machineEnabled ? capabilities.canDisable : capabilities.canEnable;
        const busy = props.isPluginActionInFlight(entry.pluginId);
        const presentation = projectInstalledPluginPresentation(entry);
        const observedOnly = entry.accountInstallations !== undefined;
        const needsDecision = !observedOnly && (presentation.status.id === 'incompatible'
            || presentation.status.id === 'trustRemoved'
            || presentation.status.id === 'needsAttention');
        // Cards always name their state in the footer; a healthy list row needs no repeated boilerplate.
        // An Account installation has nothing to say yet: "Installed" in the Installed view repeats the view,
        // and its details arrive when its own machine describes it (never a "Loading…" that may not end).
        const statusLabel = observedOnly
            ? null
            : offline
            ? t('settingsPlugins.surfaces.lastKnown', { status: presentation.status.label })
            // The switch is this machine's; when the Account keeps the plugin off, that is the reason to name.
            : !needsDecision && entry.accountEnabled === false
                ? t('settingsPlugins.rowStatus.offInAccount')
            : presentation.status.id === 'enabled' && props.presentation === 'list'
                ? null : presentation.attentionLabel ?? presentation.status.label;
        // A healthy, enabled plugin says where it runs; anything else keeps its own status.
        const coverage = !offline && !needsDecision && entry.enabled
            ? props.machineCoverageByPluginId?.[entry.pluginId] ?? null
            : null;
        const statusTone = offline || !needsDecision
            ? 'quiet' as const
            : presentation.status.id === 'needsAttention' ? 'warning' as const : 'danger' as const;
        // Review replaces the switch only where the plugin can be fixed; an incompatible one keeps
        // its (disabled) switch in the same place.
        const showReview = needsDecision && !offline && presentation.status.id !== 'incompatible';
        const control = showReview ? (
            <RoundButton
                testID={`settings.plugins.marketplace.installed.${entry.pluginId}.fix`}
                size="small"
                display="secondary"
                title={t('settingsPlugins.surfaces.review')}
                accessibilityLabel={buildActionRowAccessibilityLabel([t('settingsPlugins.surfaces.review'), entry.title])}
                accessibilityHint={presentation.status.label}
                onPress={() => props.onNavigateToPlugin(entry.pluginId)}
            />
        ) : (
            <Switch
                testID={`settings.plugins.marketplace.installed.${entry.pluginId}.action.${toggleAction}`}
                value={machineEnabled}
                disabled={offline || !canToggle || !props.canRunActions || busy}
                onValueChange={() => props.onRunAction(toggleAction, entry.pluginId)}
                accessibilityLabel={buildActionRowAccessibilityLabel([
                    entry.machineEnabled === undefined ? t('common.enabled') : t('settingsPlugins.enablement.machine'), entry.title,
                ])}
            />
        );
        const includedWithHappier = isPluginIncludedWithHappier({ installed: entry });
        const kindShelf = group === 'included'
            ? resolvePluginKindShelf(props.projectionByPluginId?.[entry.pluginId]?.contributionKinds)?.key ?? null
            : null;
        return {
            entry,
            group,
            shelf: group === 'added' ? 'added' : kindShelf ?? 'included',
            // Healthy included plugins stay quiet; their switch conveys the Machine setting.
            statusLabel: coverage ?? (includedWithHappier && !observedOnly && entry.enabled && !needsDecision && !offline ? null : statusLabel),
            statusTone,
            control: observedOnly ? null : control,
            byline: group === 'included' ? null : presentation.sourceLabel,
        };
    };
    return [...added.map((entry) => project(entry, 'added')), ...included.map((entry) => project(entry, 'included'))];
}

/** One anatomy for the grid's cards and the list's rows. */
function useInstalledPluginAnatomy(projectionByPluginId: PluginProjectionFactsById | undefined, machineId: string | null | undefined, serverId: string | null | undefined, presentation: PluginsCollectionPresentation): CollectionAnatomy<InstalledPluginRow> {
    const host = resolvePluginsSurfaceHost(usePathname());
    return React.useMemo(() => ({
        destination: (row) => ({ href: buildPluginsHomeRoute(host, {
            view: 'installed', open: { kind: 'installed', pluginId: row.entry.pluginId },
        }) }),
        glyph: (row) => (
            <PluginMark title={row.entry.title} pluginId={row.entry.pluginId} iconAgentId={projectionByPluginId?.[row.entry.pluginId]?.iconAgentId ?? null}
                installedPackage={projectionByPluginId?.[row.entry.pluginId]?.installedPackage} machineId={machineId} serverId={serverId} />
        ),
        title: (row) => row.entry.title,
        // The version, and the source unless the group names it.
        where: (row) => [installedPluginVersionLabel(row.entry), row.byline].filter(Boolean).join(' · ') || null,
        // What it is for (its shelf already names its kind). None declared: no slot, so the shared grid
        // card composes it as a compact tile instead of reserving an empty band (R-APP-14).
        description: (row) => row.entry.description ?? null,
        reason: (row) => (row.statusLabel
            ? <Status label={row.statusLabel} tone={row.statusTone === 'quiet' ? 'secondary' : row.statusTone}
                presentation="inline" indicator={row.statusTone !== 'quiet'} />
            : null),
        // A card's control uses the shared action slot; a list row's is its row action (`useInstalledPluginRowActions`),
        // which the Collection draws in every list geometry, so the list does not draw it a second time.
        ...(presentation === 'grid' ? { action: (row: InstalledPluginRow) => row.control } : {}),
        accessibilityLabel: (row) => buildActionRowAccessibilityLabel([row.entry.title, t('common.details')]) ?? row.entry.title,
        testID: (row) => `settings.plugins.marketplace.installed.${row.entry.pluginId}`,
        columnTitles: { title: t('settingsPlugins.surfaces.navigationTitle') },
    }), [host, projectionByPluginId, machineId, serverId, presentation]);
}

/**
 * A search or filter that hid everything: one line on the collection's text edge naming what was
 * searched, and Clear. It exists only while something is searched or filtered.
 */
function PluginsNoMatch(props: Readonly<{
    testID: string;
    clearTestID: string;
    query: string;
    onClear?: () => void;
}>) {
    return (
        <ItemGroup>
            <SurfaceStateCard
                testID={props.testID}
                size="line"
                kind="empty"
                accessibilitySemantics="status"
                title={t('settingsPlugins.surfaces.noMatch', { query: props.query.trim() })}
                action={props.onClear ? {
                    testID: props.clearTestID,
                    label: t('settingsPlugins.surfaces.clearSearch'),
                    onPress: props.onClear,
                } : undefined}
            />
        </ItemGroup>
    );
}

/** Ordinary Inbox reviews and daemon-owned applying facts for the selected Machine. */
export function PendingPluginChangesSection(props: Readonly<{
    pendingChanges: readonly PendingPluginChangeListing[];
    active: boolean;
    target: Readonly<{ serverId: string; machineId: string }> | null;
}>) {
    const activeScope = useActiveServerAccountScope();
    const currentTarget = React.useRef(props.target);
    currentTarget.current = props.active ? props.target : null;
    React.useEffect(() => {
        currentTarget.current = props.active ? props.target : null;
        return () => { currentTarget.current = null; };
    }, [props.active, props.target?.serverId, props.target?.machineId]);
    if (!props.active || !props.target) return null;
    const target = props.target;
    const scope = selectActiveServerAccountScopeForServer(activeScope, target.serverId);
    // The existing Inbox inventory belongs to the active Account; foreign targets
    // retain daemon applying facts without introducing another approval source.
    if (!scope) return <PendingPluginChangesRows pendingChanges={props.pendingChanges} approvalRows={[]} sourceUnavailable={false} />;
    return <InboxArtifactSourceBoundary>
        <PendingPluginChangesContent pendingChanges={props.pendingChanges} scope={scope} target={target}
            isCurrentTarget={() => currentTarget.current?.serverId === target.serverId
                && currentTarget.current?.machineId === target.machineId} />
    </InboxArtifactSourceBoundary>;
}

function PendingPluginChangesContent(props: Readonly<{
    pendingChanges: readonly PendingPluginChangeListing[];
    scope: ServerAccountScope;
    target: Readonly<{ serverId: string; machineId: string }>;
    isCurrentTarget: () => boolean;
}>) {
    const router = useRouter();
    // Plugin approvals are matched by their request body.
    useInboxArtifactBodyDemand();
    const { openApprovals } = useInboxArtifactItems();
    const source = useInboxArtifactSource();
    const lifetime = captureActiveServerAccountScopeLifetime();
    const approvals = listOpenPluginApprovalArtifactsForMachine(openApprovals, {
        ...props.scope, machineId: props.target.machineId,
    });
    const approvalRows = approvals.map(entry => ({ id: entry.artifact.id, entry,
        onReview: async () => {
            if (!props.isCurrentTarget() || !lifetime?.isCurrent()) return;
            await executeWorkspaceUiAction({ actionId: 'workspace.tabs.open',
                input: { href: buildApprovalHref(entry.artifact.id, props.target.serverId) } }, router.push);
        } }));
    return <PendingPluginChangesRows serverId={props.target.serverId} pendingChanges={props.pendingChanges} approvalRows={approvalRows}
        sourceUnavailable={source.phase === 'failed' || source.phase === 'partial'} onRetry={source.retry} />;
}

type PendingPluginApproval = ReturnType<typeof listOpenPluginApprovalArtifactsForMachine>[number];

function PendingPluginChangesRows(props: Readonly<{
    serverId?: string;
    pendingChanges: readonly PendingPluginChangeListing[];
    approvalRows: readonly Readonly<{ id: string; entry: PendingPluginApproval; onReview: () => Promise<void> }>[];
    sourceUnavailable: boolean;
    onRetry?: () => void;
}>) {
    const applying = props.pendingChanges.flatMap(entry => entry.kind === 'applying' ? [entry.pendingChangeId] : []);
    if (props.approvalRows.length === 0 && applying.length === 0 && !props.sourceUnavailable) return null;
    return (
        <View
            testID="settings.plugins.management.pendingChanges"
            accessibilityLiveRegion="polite"
        >
            <ItemGroup
                title={t('settingsPlugins.pendingChangesTitle')}
                description={t('settingsPlugins.pendingChangesFooter')}
            >
                {/* The Inbox's own words for a partial source: retained rows stay at full strength under the line. */}
                {props.sourceUnavailable ? (props.approvalRows.length > 0 || applying.length > 0 ? <SurfaceFreshnessOnSheetProvider><SurfaceFreshnessLine
                    testID="settings.plugins.management.pendingChanges.approvalsUnavailable"
                    reason={t('inbox.work.stale.sources')}
                    action={props.onRetry ? { label: t('common.retry'), onPress: props.onRetry } : undefined} /></SurfaceFreshnessOnSheetProvider> : <SurfaceStateCard
                    testID="settings.plugins.management.pendingChanges.approvalsUnavailable"
                    size="line" kind="unavailable" title={t('inbox.work.stale.sources')}
                    action={props.onRetry ? { label: t('common.retry'), onPress: props.onRetry } : undefined} />) : null}
                {props.approvalRows.map((row) => (
                    <PendingPluginApprovalRow key={`approval:${row.id}`} id={row.id} entry={row.entry}
                        serverId={props.serverId ?? null} onReview={row.onReview} />
                ))}
                {applying.map((id) => (
                    <PendingPluginChangeRow key={`applying:${id}`} id={id} title={t('settingsPlugins.pendingChangeApplying')} />
                ))}
            </ItemGroup>
        </View>
    );
}

/** Named by the approval's one title owner, the same words as its Inbox row and page. */
function PendingPluginApprovalRow(props: Readonly<{
    id: string;
    entry: PendingPluginApproval;
    serverId: string | null;
    onReview: () => Promise<void>;
    showDivider?: boolean;
}>) {
    const { title } = useApprovalRequestTitle(readApprovalArtifactTitleInput(
        { header: props.entry.artifact.header, title: null },
        { family: 'built_in', request: props.entry.approval },
    ), props.serverId);
    return <PendingPluginChangeRow id={props.id} title={title} onReview={props.onReview} showDivider={props.showDivider} />;
}

/** A waiting change speaks in the attention amber; one being applied is already out of the person's hands. */
function PendingPluginChangeRow(props: Readonly<{
    id: string;
    title: string;
    onReview?: () => Promise<void>;
    showDivider?: boolean;
}>) {
    const { theme } = useUnistyles();
    return (
        <Item
            testID={`settings.plugins.management.pendingChanges.${props.id}`}
            title={props.title}
            icon={<Icon
                name="shield-check"
                size={20}
                color={props.onReview ? theme.colors.state.attention.foreground : theme.colors.text.secondary}
            />}
            showChevron={false}
            showDivider={props.showDivider}
            loading={!props.onReview}
            mode="info"
            // A row's one action stays at its end on a phone; beneath the title it became a full-width bar per row.
            accessoryLayout="inline"
            rightElementOutsidePressable
            rightElement={props.onReview ? (
                <RoundButton
                    testID={`settings.plugins.management.pendingChanges.${props.id}.action.review`}
                    size="small"
                    display="secondary"
                    title={t('settingsPlugins.pendingChangeReviewAction')}
                    accessibilityHint={t('settingsPlugins.pendingChangesReviewHint')}
                    onPress={props.onReview}
                />
            ) : undefined}
        />
    );
}

export function PluginRoutineOperationSettlementRow(props: Readonly<{
    settlement: PluginRoutineOperationSettlement | null;
    scope: PluginRoutineOperationSettlement['scope'];
}>) {
    const { theme } = useUnistyles();
    if (props.settlement?.scope !== props.scope) return null;
    return (
        <View
            testID={`settings.plugins.${props.scope}.operationSettlement`}
            accessibilityLiveRegion="polite"
            aria-live="polite"
        >
            {/* A group, so the outcome sits on the page column with the sections it follows. */}
            <ItemGroup>
                <Item
                    testID={`settings.plugins.${props.scope}.operationSettlement.row`}
                    title={props.settlement.message}
                    subtitle={props.settlement.detail}
                    subtitleLines={0}
                    icon={props.settlement.outcome === 'withdrawn'
                        // Nothing changed: a quiet mark, never the success check.
                        ? <Icon name="info" size={29} color={theme.colors.text.secondary} />
                        : <Icon name="check-circle" size={29} color={theme.colors.state.success.foreground} />}
                    showChevron={false}
                    mode="info"
                />
            </ItemGroup>
        </View>
    );
}

export function RegistryDiagnosticsSection(props: Readonly<{
    diagnostics: readonly PluginProjectionDiagnostic[];
}>) {
    return (
        <PluginDiagnosticsSection
            title={t('settingsPlugins.registryDiagnosticsTitle')}
            diagnostics={props.diagnostics}
            testIDPrefix="settings.plugins.registryDiagnostic"
        />
    );
}

const DEVELOPMENT_START_UNAVAILABLE_COPY = {
    waitingForMachine: 'settingsPlugins.developmentStartWaiting',
    notOffered: 'settingsPlugins.developmentStartNotOffered',
} as const satisfies Record<DevelopmentStartUnavailableReason, string>;

export function DevelopmentPluginsSection(props: Readonly<{
    developmentPlugins: readonly DevelopmentPluginEntry[];
    /** No machine is chosen: nothing was asked, so the empty list must not claim the machine reported nothing. */
    noTarget?: boolean;
    createAvailable: boolean;
    sourceInstallAvailable: boolean;
    canRunActions: boolean;
    /** Why the ways to start can't be used right now, said once above them (`developmentStartAvailability`). */
    startUnavailableReason?: DevelopmentStartUnavailableReason | null;
    /**
     * The selected machine's home directory, so a development root reads
     * `~/projects/...` exactly like an ordinary Session working directory.
     * Absent home simply shows the canonical absolute root.
     */
    machineHomeDir?: string;
    createdPlugin: Readonly<{ pluginId: string; sourceRootPath: string }> | null;
    operationSettlement: PluginRoutineOperationSettlement | null;
    isPluginActionInFlight: (pluginId: string) => boolean;
    onCreate: () => void;
    onCreateWithAgent: () => void;
    onStartCreatedDevelopment: (sourceRootPath: string) => void;
    onCreateWithAgentFromCreated: (created: Readonly<{ pluginId: string; sourceRootPath: string }>) => void;
    onDevelopSourceRoot: () => void;
    onEditWithAgent: (pluginId: string) => void;
    onPublish?: (sourceRootPath: string) => void;
    onRunAction: (action: 'test' | 'pack' | 'unregister', sourceRootPath: string) => void;
}>) {
    const { theme } = useUnistyles();
    const createdPlugin = props.createdPlugin;
    return (
        <>
        {/*
          * Three ways to start, as tiles: each one opens its own flow, and none
          * is a setting. What this machine is already developing follows.
          */}
        <ItemGroup
            surface="none"
            description={props.startUnavailableReason ? t(DEVELOPMENT_START_UNAVAILABLE_COPY[props.startUnavailableReason]) : undefined}
        >
            <SelectionTiles
                variant="action"
                accessibilityLabel={t('settingsPlugins.developmentTitle')}
                options={[
                    {
                        id: 'create',
                        title: t('settingsPlugins.developmentCreate'),
                        subtitle: t('settingsPlugins.developmentCreateSubtitle'),
                        icon: 'plus',
                        disabled: !props.canRunActions || !props.createAvailable,
                        testID: 'settings.plugins.management.development.action.create',
                    },
                    {
                        id: 'createWithAgent',
                        title: t('settingsPlugins.developmentCreateWithAgent'),
                        subtitle: t('settingsPlugins.developmentCreateWithAgentSubtitle'),
                        icon: 'sparkle',
                        disabled: !props.canRunActions || !props.createAvailable,
                        testID: 'settings.plugins.management.development.action.createWithAgent',
                    },
                    {
                        id: 'develop',
                        title: t('settingsPlugins.developmentSourceInstall'),
                        subtitle: t('settingsPlugins.developmentSourceInstallSubtitle'),
                        icon: 'folder-open',
                        disabled: !props.canRunActions || !props.sourceInstallAvailable,
                        testID: 'settings.plugins.management.development.action.develop',
                    },
                ]}
                onPress={(id) => {
                    if (id === 'create') props.onCreate();
                    else if (id === 'createWithAgent') props.onCreateWithAgent();
                    else props.onDevelopSourceRoot();
                }}
            />
        </ItemGroup>
        <ItemGroup title={t('settingsPlugins.surfaces.developmentSourcesTitle')} description={t('settingsPlugins.developmentFooter')}>
            {createdPlugin ? (
                <View
                    testID="settings.plugins.management.development.createSettlement"
                    accessibilityLiveRegion="polite"
                    aria-live="polite"
                >
                    <Item
                        testID="settings.plugins.management.development.createSettlement.row"
                        title={t('settingsPlugins.developmentCreateSucceeded')}
                        subtitle={formatPathRelativeToHome(createdPlugin.sourceRootPath, props.machineHomeDir)}
                        subtitleLines={0}
                        detail={createdPlugin.pluginId}
                        icon={<Icon name="check-circle" size={29} color={theme.colors.state.success.foreground} />}
                        showChevron={false}
                        mode="info"
                        rightElementOutsidePressable
                        rightElement={(
                            <ItemRowActions
                                title={createdPlugin.pluginId}
                                compactActionIds={['startDevelopment', 'createWithAgent']}
                                overflowTriggerTestID="settings.plugins.management.development.createSettlement.actions.overflow"
                                actions={[
                                    {
                                        id: 'startDevelopment',
                                        title: t('settingsPlugins.developmentSourceInstall'),
                                        icon: 'play',
                                        inlineTestID: 'settings.plugins.management.development.createSettlement.action.startDevelopment',
                                        disabled: !props.canRunActions || !props.sourceInstallAvailable,
                                        onPress: () => props.onStartCreatedDevelopment(createdPlugin.sourceRootPath),
                                    },
                                    {
                                        id: 'createWithAgent',
                                        title: t('settingsPlugins.developmentCreateWithAgent'),
                                        icon: 'magic-wand',
                                        inlineTestID: 'settings.plugins.management.development.createSettlement.action.createWithAgent',
                                        disabled: !props.canRunActions,
                                        onPress: () => props.onCreateWithAgentFromCreated(createdPlugin),
                                    },
                                ]}
                            />
                        )}
                    />
                </View>
            ) : null}
            <PluginRoutineOperationSettlementRow
                settlement={props.operationSettlement}
                scope="development"
            />
            {/*
              * One plugin is one row. Edit with Agent, Test and Pack all act on
              * the same development source, so they are that row's actions
              * rather than three more rows a reader — and assistive technology —
              * has to traverse and reassemble per plugin.
              */}
            {props.developmentPlugins.length > 0 ? props.developmentPlugins.map((entry) => {
                // The root is the source's identity: a source the daemon could not load has no
                // installed plugin, and may not even have an id yet.
                const sourceRootPath = entry.sourceRootPath;
                const rowId = entry.installed?.pluginId ?? entry.pluginId ?? sourceRootPath;
                const editPluginId = entry.installed?.pluginId ?? null;
                const presentation = projectDevelopmentPluginPresentation(entry, props.machineHomeDir);
                const busy = props.isPluginActionInFlight(sourceRootPath);
                return (
                    <Item
                        key={sourceRootPath}
                        testID={`settings.plugins.management.development.${rowId}`}
                        title={presentation.title}
                        subtitle={(
                            // Selectable so the folder and diagnostic can be copied; it keeps the row's
                            // secondary subtitle role (as plain Text it rendered as primary body ink).
                            <Text
                                testID={`settings.plugins.management.development.${rowId}.details`}
                                variant="body"
                                style={{ color: theme.colors.text.secondary }}
                                selectable
                            >
                                {presentation.sourcePathLabel}
                                {presentation.attentionLabel === null ? null : `\n${presentation.attentionLabel}`}
                            </Text>
                        )}
                        subtitleLines={0}
                        subtitleAccessory={(
                            <StatusPill
                                testID={`settings.plugins.management.development.${rowId}.status`}
                                chrome="plain"
                                labelVariant="phrase"
                                variant={presentation.status.variant}
                                label={presentation.status.label}
                            />
                        )}
                        detail={entry.installed?.version}
                        icon={<PluginMark title={presentation.title} />}
                        iconBoxSize={36}
                        showChevron={false}
                        mode="info"
                        rightElementOutsidePressable
                        rightElement={(
                            <ItemRowActions
                                title={presentation.title}
                                compactActionIds={['editWithAgent']}
                                overflowTriggerTestID={`settings.plugins.management.development.${rowId}.actions.overflow`}
                                actions={[
                                    // Editing resolves an installed plugin's source; a source that
                                    // never loaded is fixed in its folder, then tested.
                                    ...(editPluginId === null ? [] : [{
                                        id: 'editWithAgent',
                                        title: t('settingsPlugins.developmentEditWithAgent'),
                                        accessibilityLabel: buildActionRowAccessibilityLabel([
                                            t('settingsPlugins.developmentEditWithAgent'),
                                            presentation.title,
                                        ]),
                                        subtitle: t('settingsPlugins.developmentEditWithAgentSubtitle'),
                                        icon: 'sparkle' as const,
                                        inlineTestID: `settings.plugins.management.development.${rowId}.action.editWithAgent`,
                                        disabled: !props.canRunActions,
                                        onPress: () => props.onEditWithAgent(editPluginId),
                                    }]),
                                    {
                                        id: 'test',
                                        title: t('settingsPlugins.developmentTest'),
                                        subtitle: t('settingsPlugins.developmentTestSubtitle'),
                                        icon: 'checks',
                                        inlineTestID: `settings.plugins.management.development.${rowId}.action.test`,
                                        disabled: !props.canRunActions || !entry.actions.test || busy,
                                        onPress: () => props.onRunAction('test', sourceRootPath),
                                    },
                                    ...(props.onPublish ? [{
                                        id: 'publish',
                                        title: t('settingsPlugins.publish.title'),
                                        icon: 'upload' as const,
                                        inlineTestID: `settings.plugins.management.development.${rowId}.action.publish`,
                                        disabled: !props.canRunActions || busy,
                                        onPress: () => props.onPublish?.(sourceRootPath),
                                    }] : []),
                                    {
                                        id: 'pack',
                                        title: t('settingsPlugins.developmentPack'),
                                        subtitle: t('settingsPlugins.developmentPackSubtitle'),
                                        icon: 'cube',
                                        inlineTestID: `settings.plugins.management.development.${rowId}.action.pack`,
                                        disabled: !props.canRunActions || !entry.actions.pack || busy,
                                        onPress: () => props.onRunAction('pack', sourceRootPath),
                                    },
                                    ...(entry.actions.unregister ? [{
                                        id: 'unregister',
                                        title: t('common.remove'),
                                        subtitle: entry.sourceRootPath,
                                        icon: 'trash' as const,
                                        destructive: true,
                                        inlineTestID: `settings.plugins.management.development.${rowId}.action.unregister`,
                                        disabled: !props.canRunActions || busy,
                                        onPress: () => props.onRunAction('unregister', sourceRootPath),
                                    }] : []),
                                ]}
                            />
                        )}
                    />
                );
            }) : props.startUnavailableReason === 'waitingForMachine' ? (
                // Not answered yet: nothing is known, so the rows wait rather than claim none were reported.
                <SkeletonRows rows={3} />
            ) : (
                props.noTarget ? (
                    <Item
                        testID="settings.plugins.management.development.noTarget"
                        title={t('settingsPlugins.surfaces.chooseMachineInstalled')}
                        showChevron={false}
                        mode="info"
                    />
                ) : (
                    <Item
                        testID="settings.plugins.management.development.empty"
                        title={t('settingsPlugins.developmentEmpty')}
                        subtitle={t('settingsPlugins.developmentEmptySubtitle')}
                        showChevron={false}
                        mode="info"
                    />
                )
            )}
        </ItemGroup>
        </>
    );
}

export function PluginDiagnosticsSnapshotSection(props: Readonly<{
    diagnostics: readonly PluginProjectionDiagnostic[];
}>) {
    return (
        <View
            testID="settings.plugins.management.diagnostics.live"
            accessibilityLiveRegion="polite"
        >
            {props.diagnostics.length > 0 ? (
                <RegistryDiagnosticsSection diagnostics={props.diagnostics} />
            ) : (
                <ItemGroup title={t('settingsPlugins.diagnosticsSnapshotTitle')} description={t('settingsPlugins.diagnosticsSnapshotFooter')}>
                    <Item
                        testID="settings.plugins.management.diagnostics.empty"
                        title={t('settingsPlugins.diagnosticsSnapshotEmpty')}
                        subtitle={t('settingsPlugins.diagnosticsSnapshotEmptySubtitle')}
                        showChevron={false}
                        mode="info"
                    />
                </ItemGroup>
            )}
        </View>
    );
}


/**
 * One aggregate status line for the whole Discover pane, plus the detailed
 * rows behind its counts.
 *
 * Discover is a list of independently sourced results, and giving each result
 * its own live region turned one search into a burst of announcements — source
 * disclosure, warning, and loading row all speaking over each other. Assistive
 * technology gets exactly one polite status here, composed from the same facts
 * the pane shows visually, and nothing below it announces on its own.
 *
 * Only the compact summary row is that accessible announcement. The degraded
 * source rows, index diagnostics, and non-installable listings render outside
 * it: an accessible parent aggregates its whole subtree, so nesting the detail
 * rows inside it would hide them from VoiceOver and TalkBack traversal and
 * leave users hearing counts they can never inspect.
 */
export function DiscoverStatusSummary(props: Readonly<{
    loading: boolean;
    error: string | null;
    failureStatus?: RegistryFailureStatus | null;
    sources?: readonly Readonly<{ title: string }>[];
    stale: boolean;
    entryCount: number;
    sourceStatuses: readonly PluginMarketplaceDiscoverSourceStatus[];
    diagnostics: readonly PluginMarketplaceDiscoverDiagnostic[];
    nonInstallable: readonly PluginMarketplaceNonInstallableListing[];
    selectedSourceTitle: string | null;
    /** No machine is chosen yet: nothing was searched, so no result count is claimed. */
    noTarget?: boolean;
    /** The query the results answer; null means no query has returned yet. */
    searchText?: string | null;
    onClearSearch?: () => void;
    /** Asks every source again; offered on each source notice when a refresh can run. */
    onRetry?: () => void;
    /** Opens Sources & registries, where a source that keeps failing is fixed. */
    onOpenSources?: () => void;
}>) {
    const pageNoticeActive = usePageNoticeActive();
    const { theme } = useUnistyles();
    const styles = sectionStylesheet;
    const maxWidthStyle = useLayoutMaxWidthStyle();
    const searched = (props.searchText ?? '').trim().length > 0;
    const waitingForQuery = props.searchText === null && !props.loading && props.error === null && !props.noTarget;
    // One issue per source (and one for the index), however many ways the daemon reported it.
    const issues = React.useMemo(
        () => buildPluginMarketplaceDiscoverIssues({ sourceStatuses: props.sourceStatuses, diagnostics: props.diagnostics,
            ...(props.error !== null && !props.loading ? { readFailure: { status: props.failureStatus ?? null,
                sourceTitle: props.selectedSourceTitle ?? (props.sources?.map(source => source.title).join(', ') || null) } } : {}) }),
        [props.diagnostics, props.sourceStatuses, props.error, props.loading, props.failureStatus, props.selectedSourceTitle, props.sources],
    );
    const sourceIssueCount = issues.filter((issue) => issue.sourceId !== null).length;
    const unreachableIssues = issues.filter((issue) => issue.sourceId !== null && !issue.reachable);
    const attentionIssues = issues.filter((issue) => issue.sourceId === null || issue.reachable);
    // Unanswered sources cannot establish an empty catalog or a no-match search.
    // With no retained rows, the source notices own the cause and recovery.
    const sourceFailureWithoutResults = issues.length > 0 && props.entryCount === 0
        && props.nonInstallable.length === 0 && !props.loading;
    // Browse reads the Account's sources without a Machine, so an answered query that matched nothing is a
    // no-match whether or not a Machine is chosen yet (`searched` is the query the results answer).
    const noMatch = searched && !props.loading && props.error === null
        && props.entryCount === 0 && props.nonInstallable.length === 0 && !sourceFailureWithoutResults;
    const message = props.noTarget && props.entryCount === 0 && !props.loading
        ? t('settingsPlugins.surfaces.chooseMachineBrowse')
        : props.loading
        ? props.selectedSourceTitle === null
            ? t('settingsPlugins.discover.status.loading')
            : t('settingsPlugins.discover.status.loadingSource', { source: props.selectedSourceTitle })
        : props.entryCount === 0 && props.nonInstallable.length > 0
                ? t('settingsPlugins.discover.status.nonInstallable', { count: props.nonInstallable.length })
                : props.entryCount === 0
                    ? searched
                        ? t('settingsPlugins.surfaces.noMatch', { query: (props.searchText ?? '').trim() })
                        : t('settingsPlugins.surfaces.browseEmpty')
                    : t('settingsPlugins.discover.status.results', {
                        count: props.entryCount,
                        sources: props.sourceStatuses.length,
                    });
    // Qualifiers, in the order a reader needs them: what they are looking at is
    // out of date, then what was missing, then what could not be acted on.
    const qualifiers = [
        ...(props.stale && !props.loading ? [t('settingsPlugins.discover.status.stale')] : []),
        ...(sourceIssueCount > 0
            ? [t('settingsPlugins.discover.status.partial', { count: sourceIssueCount })]
            : []),
        ...(props.nonInstallable.length > 0 && props.entryCount > 0
            ? [t('settingsPlugins.discover.status.nonInstallable', { count: props.nonInstallable.length })]
            : []),
    ];

    return (
        <View testID="settings.plugins.marketplace.discover.status">
            {noMatch ? (
                <PluginsNoMatch
                    testID="settings.plugins.marketplace.discover.noMatch"
                    clearTestID="settings.plugins.marketplace.discover.clearSearch"
                    query={props.searchText ?? ''}
                    onClear={props.onClearSearch}
                />
            ) : null}
            {/*
              * One quiet line under the toolbar: what the results are, then any
              * qualifier. It is the pane's only live region; the rows below it
              * stay outside so each one can be traversed on its own.
              */}
            {noMatch || waitingForQuery || sourceFailureWithoutResults || (pageNoticeActive && props.entryCount === 0 && !props.loading) ? null : (<View
                style={[styles.statusLine, maxWidthStyle]}
                accessible
                accessibilityRole={props.error === null ? 'text' : 'alert'}
                accessibilityLiveRegion="polite"
                accessibilityLabel={[message, ...qualifiers].join(' ')}
            >
                {props.loading ? <ActivitySpinner size="small" color={theme.colors.text.secondary} /> : null}
                <View style={styles.statusText}>
                    <Text
                        testID="settings.plugins.marketplace.discover.status.summary"
                        style={[styles.statusMessage, props.error === null ? null : styles.statusMessageError]}
                    >
                        {message}
                    </Text>
                    {qualifiers.length > 0 ? (
                        <Text style={styles.statusQualifier}>{qualifiers.join('\n')}</Text>
                    ) : null}
                </View>
            </View>)}
            {/* A catalog that didn't answer doesn't need the person: the one quiet outage line every Store page uses. */}
            <RegistrySourcesUnavailable
                testID="settings.plugins.marketplace.discover.sources"
                size={sourceFailureWithoutResults ? 'page' : 'line'}
                failures={unreachableIssues.map((issue) => {
                    const source = issue.sourceTitle ?? issue.sourceId!;
                    const reason = t('settingsPlugins.discover.diagnostic.unreachableTitle', { source });
                    return { key: issue.id, message: issue.summary ?? reason,
                        details: issue.details.flatMap((detail) => [
                            detail.message,
                            t('settingsPlugins.diagnosticsTechnicalCode', { code: detail.code }),
                        ]),
                        onRetry: props.onRetry ?? (() => {}) };
                })}
            />
            {attentionIssues.map((issue) => (
                <AttentionBanner
                    key={issue.id}
                    testID={`settings.plugins.marketplace.discover.issue.${issue.sourceId ?? 'index'}`}
                    title={issue.summary ?? (issue.sourceId === null
                        ? t('settingsPlugins.discover.diagnostic.indexTitle')
                        : t('settingsPlugins.discover.diagnostic.behindTitle', { source: issue.sourceTitle ?? issue.sourceId }))}
                    description={issue.sourceId === null || props.entryCount === 0
                        ? undefined : t('settingsPlugins.discover.diagnostic.otherSourcesShown')}
                    action={props.onRetry ? { label: t('common.retry'), onPress: props.onRetry } : null}
                    secondaryAction={props.onOpenSources && issue.sourceId !== null
                        ? { label: t('settingsPlugins.sourceAdministration.title'), onPress: props.onOpenSources }
                        : null}
                    details={issue.details.flatMap((detail) => [
                        detail.message,
                        t('settingsPlugins.diagnosticsTechnicalCode', { code: detail.code }),
                    ])}
                />
            ))}
            {props.nonInstallable.length > 0 ? (
                <ItemGroup title={t('settingsPlugins.surfaces.notShownTitle')}>
                    {props.nonInstallable.map((listing) => (
                        <Item
                            key={`${listing.sourceId}:${listing.pluginId}`}
                            testID={`settings.plugins.marketplace.discover.nonInstallable.${listing.sourceId}.${listing.pluginId}`}
                            title={listing.title}
                            subtitle={`${t('settingsPlugins.discoveredVia', { source: listing.sourceTitle })}\n${
                                t(`settingsPlugins.discover.nonInstallableReason.${listing.reason}` as
                                    'settingsPlugins.discover.nonInstallableReason.sourceStale')
                            }`}
                            subtitleLines={0}
                            icon={<PluginMark title={listing.title} />}
                            iconBoxSize={36}
                            showChevron={false}
                            mode="info"
                        />
                    ))}
                </ItemGroup>
            ) : null}
        </View>
    );
}

/**
 * Browse: the loaded results in category sections (lab ideas-1118-platform scene 1 B), each one row of cards until the
 * reader asks for all of it, as the same page-sized Collection as Installed — one grid, one list. Source stays the
 * toolbar filter and the first word of each card's facts. Each card installs with "+" or says Installed; its body
 * opens the listing.
 */
export function DiscoverListingsSection(props: Readonly<{
    entries: readonly PluginMarketplaceCatalogEntry[];
    presentation?: PluginsCollectionPresentation;
    /** The listing whose detail is open beside the collection. */
    selectedListing?: Readonly<{ sourceId: string; pluginId: string }> | null;
    loading: boolean;
    loadingMore: boolean;
    canLoadMore: boolean;
    installedPluginById: ReadonlyMap<string, InstalledPluginEntry>;
    /** Listings of installed plugins that contribute an Agent show that Agent's logo. */
    projectionByPluginId?: PluginProjectionFactsById;
    machineId?: string | null;
    machineName?: string | null;
    serverId?: string | null;
    canRunActions: boolean;
    installDisabledReason?: string | null;
    isPluginActionInFlight: (pluginId: string) => boolean;
    prepareQuickInstall: PluginSettingsScreenState['prepareQuickInstall'];
    onLoadMore: () => void;
    onNavigateToPlugin: (pluginId: string) => void;
    onOpenListing: (entry: PluginMarketplaceCatalogEntry) => void;
    /** The open listing closes (Escape inside the collection). */
    onCloseListing?: () => void;
    /** The page above the listings (its header, the search's status) and below them, in one scroller. */
    header?: React.ReactNode;
    footer?: React.ReactNode;
}>) {
    const styles = sectionStylesheet;
    const maxWidthStyle = useLayoutMaxWidthStyle();
    const presentation = props.presentation ?? 'grid';
    // Presentation only: which section the page shows whole. The query and its results stay with the Discover owner.
    const [focusedSectionId, setFocusedSectionId] = React.useState<string | null>(null);
    const view = projectBrowseSections(props.entries, { focusedSectionId });
    // A focus the new results dropped is forgotten, so it cannot return unasked later.
    React.useEffect(() => {
        if (focusedSectionId !== view.focusedSectionId) setFocusedSectionId(view.focusedSectionId);
    }, [focusedSectionId, view.focusedSectionId]);
    const sections = view.sections;
    const items = React.useMemo(
        () => sections.flatMap((section) => section.entries.map((entry): DiscoverListingItem => ({ entry, sectionId: section.id }))),
        [sections],
    );
    const groups = React.useMemo(() => ({
        axis: sections.map((section) => ({ key: section.id, title: section.title })),
        groupOf: (item: DiscoverListingItem) => item.sectionId,
    }), [sections]);
    const { onOpenListing, onCloseListing } = props;
    const onOpenChange = React.useCallback((key: string | null) => {
        if (key === null) {
            onCloseListing?.();
            return;
        }
        const item = items.find((candidate) => readDiscoverListingKey(candidate) === key);
        if (item) onOpenListing(item.entry);
    }, [items, onCloseListing, onOpenListing]);
    const model = useHappierCollection<DiscoverListingItem>({
        items,
        keyOf: readDiscoverListingKey,
        groups,
        openKey: props.selectedListing ? `${props.selectedListing.sourceId}:${props.selectedListing.pluginId}` : null,
        onOpenChange,
    });
    const anatomy = useDiscoverListingAnatomy(props, presentation);
    const controls = React.useMemo(() => new Map(items.map((item) => [
        readDiscoverListingKey(item),
        discoverListingControl(item.entry, props),
    ] as const)), [items, props]);
    // "All" on a section the page shortened, "All results" on the one it focused.
    const groupAction = React.useCallback((sectionId: string) => {
        if (view.focusedSectionId === sectionId) {
            return { label: t('settingsPlugins.surfaces.allResults'), onPress: () => setFocusedSectionId(null) };
        }
        const section = sections.find((candidate) => candidate.id === sectionId);
        return section && section.hiddenCount > 0
            ? { label: t('settingsPlugins.surfaces.seeAll'), onPress: () => setFocusedSectionId(section.id) }
            : null;
    }, [sections, view.focusedSectionId]);
    const header = props.header;
    const footer = (
        <>
            {props.canLoadMore ? (
                <View style={[styles.loadMore, maxWidthStyle]}>
                    <RoundButton testID="settings.plugins.marketplace.loadMore" size="normal" display="secondary"
                        title={t('settingsPlugins.discoverLoadMore')} onPress={props.onLoadMore}
                        disabled={props.loadingMore || props.loading} loading={props.loadingMore} />
                </View>
            ) : null}
            {props.footer}
        </>
    );
    return (
        <DiscoverListingControlsContext.Provider value={controls}>
            <PluginsPageCollection<DiscoverListingItem>
                testID="settings.plugins.marketplace.discover"
                model={model}
                anatomy={anatomy}
                presentation={presentation}
                accessibilityLabel={t('settingsPlugins.surfaces.navigationTitle')}
                header={header}
                footer={footer}
                groupAction={groupAction}
                useRowActions={presentation === 'list' ? useDiscoverListingRowActions : undefined}
            />
        </DiscoverListingControlsContext.Provider>
    );
}


type DiscoverListingItem = Readonly<{ entry: PluginMarketplaceCatalogEntry; sectionId: string }>;

const readDiscoverListingKey = (item: DiscoverListingItem) => `${item.entry.sourceId}:${item.entry.id}`;

const DiscoverListingControlsContext = React.createContext<ReadonlyMap<string, React.ReactNode>>(new Map());

function useDiscoverListingRowActions(item: DiscoverListingItem): CollectionRowActions {
    const control = React.useContext(DiscoverListingControlsContext).get(readDiscoverListingKey(item));
    return control === undefined || control === null ? NO_ROW_ACTIONS : { accessory: control };
}

type DiscoverListingActionInputs = Readonly<{
    machineId?: string | null;
    machineName?: string | null;
    serverId?: string | null;
    installedPluginById: ReadonlyMap<string, InstalledPluginEntry>;
    canRunActions: boolean;
    installDisabledReason?: string | null;
    loading: boolean;
    isPluginActionInFlight: (pluginId: string) => boolean;
    prepareQuickInstall: PluginSettingsScreenState['prepareQuickInstall'];
    onNavigateToPlugin: (pluginId: string) => void;
}>;

function discoverListingControl(entry: PluginMarketplaceCatalogEntry, props: DiscoverListingActionInputs): React.ReactNode {
    if (props.installedPluginById.has(entry.id) || !entry.installable) return null;
    return <DiscoverQuickInstall
        key={JSON.stringify([props.serverId, props.machineId, entry.sourceId, entry.id, entry.itemId, entry.version])}
        entry={entry}
        machineName={props.machineName}
        disabled={!props.canRunActions || props.isPluginActionInFlight(entry.id) || props.loading}
        disabledReason={props.installDisabledReason ?? undefined}
        prepareQuickInstall={props.prepareQuickInstall}
    />;
}

/**
 * Browse’s plus opens the compact Quick install confirmation anchored to it (lab ideas-1118-platform round 4, "Quick
 * install"; a sheet on a phone): the plugin, who made it and where it is listed, one line of what it adds and where it
 * goes, then Cancel or Install & Trust. The person has not seen the listing here, so this press is the consent; the
 * listing's own Install & Trust needs no second step.
 */
function DiscoverQuickInstall({ entry, machineName, disabled, disabledReason, prepareQuickInstall }: Readonly<{
    entry: PluginMarketplaceCatalogEntry;
    machineName?: string | null;
    disabled: boolean;
    disabledReason?: string;
    prepareQuickInstall: PluginSettingsScreenState['prepareQuickInstall'];
}>) {
    const [review, setReview] = React.useState<PluginQuickInstallReview | null>(null);
    const open = review !== null;
    const anchorRef = React.useRef<View>(null);
    const testID = `settings.plugins.marketplace.action.install.${entry.sourceId}.${entry.id}`;
    const installLabel = t('settingsPlugins.installAndTrust');
    const close = React.useCallback(() => setReview(null), []);
    const contents = pluginListingAdds(entry.contributions).map((add) => add.title);
    const uses = [
        contents.join(', '),
        machineName ? t('settingsPlugins.surfaces.listingInstallsOn', { machine: machineName }) : null,
    ].filter(Boolean).join('. ');
    return (
        <>
            <View ref={anchorRef} collapsable={false}>
                <IconButton
                    testID={testID}
                    iconName="plus"
                    variant="plain"
                    tooltip={installLabel}
                    disabledReason={disabledReason}
                    accessibilityLabel={buildActionRowAccessibilityLabel([installLabel, entry.title, entry.sourceTitle]) ?? installLabel}
                    accessibilityHint={t('settingsPlugins.discover.installSubtitle', { source: entry.sourceTitle })}
                    disabled={disabled}
                    expanded={open}
                    hasPopup="dialog"
                    onPress={() => setReview(open ? null : prepareQuickInstall({ pluginId: entry.id, sourceId: entry.sourceId }))}
                />
            </View>
            {open ? (
                <Popover
                    open
                    anchorRef={anchorRef}
                    boundaryRef={null}
                    placement="auto-vertical"
                    phonePresentation="sheet"
                    sheetHeader="none"
                    accessibilityLabel={installLabel}
                    edgePadding={{ horizontal: 12, vertical: 12 }}
                    portal={{ web: { target: 'body' }, native: true, matchAnchorWidth: false }}
                    maxWidthCap={360}
                    onRequestClose={close}
                >
                    {({ maxHeight, maxWidth }) => (
                        <FloatingOverlay maxHeight={maxHeight} surfaceChrome="theme" containerStyle={{ width: Math.min(maxWidth, 360) }}>
                            <View testID={`${testID}.quickInstall`} style={sectionStylesheet.quickInstall}>
                                <View style={sectionStylesheet.quickInstallHeader}>
                                    <PluginMark title={entry.title} pluginId={entry.id} size="row" />
                                    <View style={sectionStylesheet.quickInstallTitles}>
                                        <Text variant="body" emphasis="semiBold">
                                            {machineName
                                                ? t('settingsPlugins.surfaces.quickInstallTitle', { name: entry.title, machine: machineName })
                                                : t('settingsPlugins.surfaces.quickInstallTitleNoMachine', { name: entry.title })}
                                        </Text>
                                        <Text variant="meta" style={sectionStylesheet.quickInstallMeta}>
                                            {[entry.publisher.displayName, entry.sourceTitle].filter(Boolean).join(' · ')}
                                        </Text>
                                    </View>
                                </View>
                                {uses ? <Text variant="body" style={sectionStylesheet.quickInstallMeta}>{uses}</Text> : null}
                                <View style={sectionStylesheet.quickInstallFooter}>
                                    <RoundButton testID={`${testID}.cancel`} size="small" display="secondary"
                                        title={t('common.cancel')} onPress={close} />
                                    <RoundButton testID={`${testID}.confirm`} size="small" title={installLabel}
                                        disabled={disabled} onPress={() => {
                                            if (disabled || !review) return;
                                            close();
                                            review.confirm();
                                        }} />
                                </View>
                            </View>
                        </FloatingOverlay>
                    )}
                </Popover>
            ) : null}
        </>
    );
}

/** One anatomy for the grid's cards and the list's rows. A withdrawal outranks "Installed". */
function useDiscoverListingAnatomy(props: DiscoverListingActionInputs & Readonly<{
    projectionByPluginId?: PluginProjectionFactsById;
}>, presentation: PluginsCollectionPresentation): CollectionAnatomy<DiscoverListingItem> {
    const host = resolvePluginsSurfaceHost(usePathname());
    const { installedPluginById, projectionByPluginId } = props;
    return React.useMemo(() => ({
        destination: ({ entry }) => ({ href: buildPluginsHomeRoute(host, {
            view: 'browse', open: { kind: 'listing', sourceId: entry.sourceId, pluginId: entry.id,
                ...(entry.itemId ? { itemId: entry.itemId } : {}), ...(entry.version ? { version: entry.version } : {}) },
        }) }),
        glyph: ({ entry }) => (
            <PluginMark title={entry.title} pluginId={entry.id} iconAgentId={projectionByPluginId?.[entry.id]?.iconAgentId ?? null}
                installedPackage={projectionByPluginId?.[entry.id]?.installedPackage} machineId={props.machineId} serverId={props.serverId} />
        ),
        title: ({ entry }) => entry.title,
        // A registry the install needs is the one fact to read before installing, on cards and rows alike; it
        // takes the byline's place until the listing is installed.
        where: ({ entry }) => (!installedPluginById.has(entry.id) && entry.registrySelectionOrigin !== null
            ? t('settingsPlugins.discover.registrySelectionRequired', { origin: entry.registrySelectionOrigin })
            // Where it comes from first, then what it adds (lab ideas-1118-platform scene 1).
            : [entry.sourceTitle, ...pluginListingAdds(entry.contributions).map((add) => add.title)].filter(Boolean).join(' · ')),
        description: ({ entry }) => entry.description || null,
        // Healthy is quiet: only a withdrawal or "Installed" speaks; a withdrawal outranks "Installed".
        reason: ({ entry }) => entry.warning === 'withdrawn' ? (
            <Status
                testID={`settings.plugins.marketplace.reviewStatus.${entry.sourceId}.${entry.id}`}
                label={catalogReviewStatusLabel(entry)}
                tone="warning" presentation="inline" indicator
            />
        ) : installedPluginById.has(entry.id) ? (
            <Status
                testID={`settings.plugins.marketplace.installedStatus.${entry.sourceId}.${entry.id}`}
                label={t('settingsPlugins.surfaces.installed')}
                tone="secondary" presentation="inline" indicator={false}
            />
        ) : null,
        // A card's control sits in its footer; a list row's is its row action (`useDiscoverListingRowActions`),
        // which the Collection draws in every list geometry, so the list does not draw it a second time.
        ...(presentation === 'grid' ? { action: (item: DiscoverListingItem) => discoverListingControl(item.entry, props) } : {}),
        accessibilityLabel: ({ entry }) => buildActionRowAccessibilityLabel([entry.title, t('common.details'), entry.sourceTitle]) ?? entry.title,
        testID: ({ entry }) => `settings.plugins.marketplace.entry.${entry.sourceId}.${entry.id}`,
        columnTitles: { title: t('settingsPlugins.surfaces.navigationTitle') },
    // `props` carries the action inputs `discoverListingControl` reads; its identity is the render's.
    }), [host, installedPluginById, presentation, projectionByPluginId, props]);
}

const sectionStylesheet = StyleSheet.create((theme) => ({
    version: {
        ...Typography.mono(),
        fontSize: 11,
        lineHeight: 16,
        color: theme.colors.text.tertiary,
        flexShrink: 1,
    },
    rowControls: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s12,
    },
    source: {
        ...Typography.variant('meta'),
        color: theme.colors.text.tertiary,
        maxWidth: 140,
    },
    statusLine: {
        width: '100%',
        alignSelf: 'center',
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: theme.space.s8,
        paddingHorizontal: PAGE_LIST_METRICS.pageTextInsetPx,
        paddingTop: theme.space.s4,
        paddingBottom: theme.space.s4,
    },
    statusText: {
        flex: 1,
        gap: theme.space.s2,
    },
    statusMessage: {
        ...Typography.variant('meta'),
        color: theme.colors.text.secondary,
    },
    statusMessageError: {
        color: theme.colors.state.warning.textForeground,
    },
    statusQualifier: {
        ...Typography.variant('meta'),
        color: theme.colors.text.tertiary,
    },
    quickInstall: { padding: theme.space.s16, gap: theme.space.s12 },
    quickInstallHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: theme.space.s10 },
    quickInstallTitles: { flex: 1, minWidth: 0, gap: theme.space.s2 },
    quickInstallMeta: { color: theme.colors.text.secondary },
    quickInstallFooter: { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: theme.space.s8 },
    loadMore: {
        width: '100%',
        alignSelf: 'center',
        alignItems: 'center',
        paddingTop: theme.space.s4,
        paddingBottom: theme.space.s16,
    },
    stateFrame: {
        width: '100%',
        alignSelf: 'center',
        paddingHorizontal: resolveItemGroupContentHorizontalInsetPx(),
        paddingTop: theme.space.s12,
        paddingBottom: theme.space.s8,
    },
    registryNote: {
        ...Typography.variant('meta'),
        color: theme.colors.text.secondary,
    },
}));
