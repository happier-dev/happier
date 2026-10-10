import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import * as React from 'react';
import { usePathname } from '@/components/appShell/workspace/destinationRoute';
import { WorkspaceDestinationRow } from '@/components/appShell/workspace/WorkspaceDestinationRow';
import { buildPluginsHomeRoute, resolvePluginsSurfaceHost } from './model/pluginsSurfaceRoutes';
import { useHappierCollection, type CollectionAnatomy, type CollectionRowActions } from '@happier-dev/plugin-ui';
import { ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { PluginProjectionDiagnostic } from '@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters';
import { Item } from '@/components/ui/lists/Item';
import { usePageNoticeActive } from '@/components/ui/lists/listPresentation';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { buildActionRowAccessibilityLabel } from '@/components/ui/lists/actionRowAccessibility';
import { PAGE_LIST_METRICS } from '@/components/ui/lists/pageListMetrics';
import { resolveItemGroupContentHorizontalInsetPx } from '@/components/ui/lists/itemGroupSpacing';
import { Switch } from '@/components/ui/forms/Switch';
import { SelectionTiles } from '@/components/ui/forms/SelectionTiles';
import { Text } from '@/components/ui/text/Text';
import { StatusPill } from '@/components/ui/status/StatusPill';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { useLayoutMaxWidthStyle } from '@/components/ui/layout/layout';
import { Typography } from '@/constants/Typography';
import { t, type TranslationKeyNoParams } from '@/text';
import { formatPathRelativeToHome } from '@/utils/sessions/formatPathRelativeToHome';

import { PluginMark } from './PluginMark';
import { PluginCardStatus } from './collection/PluginCardStatus';
import { PluginsPageCollection } from './collection/PluginsPageCollection';
import { buildPluginMarketplaceDiscoverIssues } from './model/pluginMarketplaceDiscoverIssues';
import { resolvePluginContributionKindLabel } from './model/pluginContributionKindLabel';
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
import type { InstalledPluginActionId, PluginRoutineOperationSettlement } from './model/usePluginSettingsScreenState';
import {
    catalogReviewStatusLabel,
    projectBrowseShelves,
    formatPendingPluginChangeSubtitle,
    formatPendingPluginChangeTitle,
    projectDevelopmentPluginPresentation,
    projectInstalledPluginLifecycleCapabilities,
    projectInstalledPluginPresentation,
    installedPluginVersionLabel,
    isPluginIncludedWithHappier,
    partitionInstalledPlugins,
    readPendingPluginChangeListingId,
    type DevelopmentPluginEntry,
    type DiscoverShelf,
    type InstalledPluginEntry,
    type PendingPluginChangeListing,
    type PluginMarketplaceActionRequest,
} from './model/pluginMarketplaceModel';

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
    const model = useHappierCollection<InstalledPluginRow>({
        items: rows,
        keyOf: readInstalledPluginRowKey,
        groups: INSTALLED_PLUGIN_GROUPS,
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
                return (
                    <View style={[styles.stateFrame, maxWidthStyle]}>
                        <EmptyState
                            testID="settings.plugins.marketplace.installed.empty"
                            scene="noPlugins"
                            title={t('settingsPlugins.surfaces.emptyTitle')}
                            subtitle={t('settingsPlugins.surfaces.emptyBody')}
                            action={(
                                <RoundButton
                                    testID="settings.plugins.marketplace.installed.empty.browse"
                                    size="normal"
                                    title={t('settingsPlugins.surfaces.browsePlugins')}
                                    onPress={props.onDiscover}
                                />
                            )}
                        />
                    </View>
                );
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
                header={props.header}
                footer={props.footer}
                loading={props.collectionState === 'loading'}
                {...(empty === undefined ? {} : { empty })}
                // Cards use the anatomy's footer action; only list rows carry the accessory beside the body.
                useRowActions={props.presentation === 'list' ? useInstalledPluginRowActions : undefined}
            />
        </InstalledPluginControlsContext.Provider>
    );
}

type InstalledPluginRow = Readonly<{
    entry: InstalledPluginEntry;
    group: 'added' | 'included';
    statusLabel: string | null;
    statusTone: 'quiet' | 'warning' | 'danger';
    control: React.ReactNode;
    /** The source line, unless the section it sits in already names it. */
    byline: string | null;
}>;

const NO_INSTALLED_ROWS: readonly InstalledPluginRow[] = Object.freeze([]);
const NO_ROW_ACTIONS = Object.freeze({});

const readInstalledPluginRowKey = (row: InstalledPluginRow) => row.entry.pluginId;

/** What the user added, then what ships with Happier: the column's own two groups. */
const INSTALLED_PLUGIN_GROUPS = {
    get axis() {
        return [
            { key: 'added', title: t('settingsPlugins.surfaces.addedGroup') },
            { key: 'included', title: t('settingsPlugins.rowSource.bundled') },
        ];
    },
    groupOf: (row: InstalledPluginRow) => row.group,
};

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
        const toggleAction = entry.enabled ? 'disable' as const : 'enable' as const;
        const canToggle = entry.enabled ? capabilities.canDisable : capabilities.canEnable;
        const busy = props.isPluginActionInFlight(entry.pluginId);
        const presentation = projectInstalledPluginPresentation(entry);
        const observedOnly = entry.accountInstallations !== undefined;
        const needsDecision = !observedOnly && (presentation.status.id === 'incompatible'
            || presentation.status.id === 'trustRemoved'
            || presentation.status.id === 'needsAttention');
        // Cards always name their state in the footer; a healthy list row needs no repeated boilerplate.
        const statusLabel = observedOnly
            ? entry.accountInstallations!.some((installation) => installation.declarationState === 'preparing')
                ? t('common.loading') : t('common.installed')
            : offline
            ? t('settingsPlugins.surfaces.lastKnown', { status: presentation.status.label })
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
                value={entry.enabled}
                disabled={offline || !canToggle || !props.canRunActions || busy}
                onValueChange={() => props.onRunAction(toggleAction, entry.pluginId)}
                accessibilityLabel={buildActionRowAccessibilityLabel([t('common.enabled'), entry.title])}
            />
        );
        // A plugin that ships with Happier and cannot be switched off says so quietly instead of
        // showing a switch that does nothing.
        const locked = !showReview && !canToggle && isPluginIncludedWithHappier({ installed: entry });
        return {
            entry,
            group,
            statusLabel: coverage ?? statusLabel,
            statusTone,
            control: locked || observedOnly ? null : control,
            byline: group === 'included' || observedOnly ? null : presentation.sourceLabel,
        };
    };
    return [...added.map((entry) => project(entry, 'added')), ...included.map((entry) => project(entry, 'included'))];
}

/** One anatomy for the grid's cards and the list's rows. */
function useInstalledPluginAnatomy(projectionByPluginId: PluginProjectionFactsById | undefined, machineId: string | null | undefined, serverId: string | null | undefined, presentation: PluginsCollectionPresentation): CollectionAnatomy<InstalledPluginRow> {
    const host = resolvePluginsSurfaceHost(usePathname());
    return React.useMemo(() => ({
        wrapItem: (row, content) => <WorkspaceDestinationRow href={buildPluginsHomeRoute(host, {
            view: 'installed', open: { kind: 'installed', pluginId: row.entry.pluginId },
        })}>{content}</WorkspaceDestinationRow>,
        glyph: (row) => (
            <PluginMark title={row.entry.title} pluginId={row.entry.pluginId} iconAgentId={projectionByPluginId?.[row.entry.pluginId]?.iconAgentId ?? null}
                installedPackage={projectionByPluginId?.[row.entry.pluginId]?.installedPackage} machineId={machineId} serverId={serverId} />
        ),
        title: (row) => row.entry.title,
        // The version, and the source unless the group names it.
        where: (row) => [installedPluginVersionLabel(row.entry), row.byline].filter(Boolean).join(' · ') || null,
        // What it is for, else the kind of thing it adds. An empty grid value reserves the canonical two-line
        // slot even before purpose facts arrive; it states nothing the machine has not supplied.
        description: (row) => row.entry.description
            ?? resolvePluginContributionKindLabel(projectionByPluginId?.[row.entry.pluginId]?.contributionKinds)
            ?? (presentation === 'grid' ? '' : null),
        reason: (row) => (row.statusLabel
            ? <PluginCardStatus label={row.statusLabel} tone={row.statusTone} />
            : null),
        action: (row) => row.control,
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

/**
 * The decisions this machine's daemon is holding for the present user.
 *
 * This is the app half of the agent-authored plugin loop: an Agent can prepare
 * a plugin change but cannot approve source-root or package trust, so without
 * this section its change is invisible and expires unanswered. The section is
 * rendered only when something is actually waiting, as one tinted notice at
 * the top of the page, so it reads as attention rather than as furniture.
 */
export function PendingPluginChangesSection(props: Readonly<{
    pendingChanges: readonly PendingPluginChangeListing[];
    canRunActions: boolean;
    isPluginActionInFlight: (pendingChangeId: string) => boolean;
    onDecide: (pendingChangeId: string, decision: 'approve' | 'reject') => void;
}>) {
    const { theme } = useUnistyles();
    const styles = sectionStylesheet;
    if (props.pendingChanges.length === 0) return null;
    return (
        <View
            testID="settings.plugins.management.pendingChanges"
            accessibilityLiveRegion="polite"
        >
            <ItemGroup
                title={t('settingsPlugins.pendingChangesTitle')}
                description={t('settingsPlugins.pendingChangesFooter')}
                containerStyle={styles.pendingNotice}
            >
                {props.pendingChanges.map((entry) => {
                    const pendingChangeId = readPendingPluginChangeListingId(entry);
                    const busy = props.isPluginActionInFlight(pendingChangeId);
                    const decidable = entry.kind !== 'applying';
                    return (
                        <Item
                            key={pendingChangeId}
                            testID={`settings.plugins.management.pendingChanges.${pendingChangeId}`}
                            title={formatPendingPluginChangeTitle(entry)}
                            subtitle={formatPendingPluginChangeSubtitle(entry)}
                            subtitleLines={0}
                            icon={<Icon
                                name={decidable ? 'shield-check' : 'arrow-clockwise'}
                                size={20}
                                color={decidable ? theme.colors.state.info.foreground : theme.colors.text.secondary}
                            />}
                            showChevron={false}
                            mode="info"
                            accessoryLayout="adaptive"
                            rightElementOutsidePressable
                            rightElement={decidable ? (
                                // The row action opens the full install-and-trust
                                // review (or, for a source-root change, the folder
                                // trust confirmation) before anything is decided;
                                // nothing has been approved yet, so the label says
                                // Review, and the reject action — which discards
                                // without ever opening the review — does not claim
                                // that it shows one.
                                <ItemRowActions
                                    title={formatPendingPluginChangeTitle(entry)}
                                    compactActionIds={['review', 'reject']}
                                    overflowTriggerTestID={`settings.plugins.management.pendingChanges.${pendingChangeId}.actions.overflow`}
                                    actions={[
                                        {
                                            id: 'review',
                                            title: t('settingsPlugins.pendingChangeReviewAction'),
                                            subtitle: t('settingsPlugins.pendingChangesReviewHint'),
                                            icon: 'eye',
                                            inlineTestID: `settings.plugins.management.pendingChanges.${pendingChangeId}.action.review`,
                                            disabled: !props.canRunActions || busy,
                                            onPress: () => props.onDecide(pendingChangeId, 'approve'),
                                        },
                                        {
                                            id: 'reject',
                                            title: t('approvals.reject'),
                                            subtitle: t('settingsPlugins.pendingChangeRejectHint'),
                                            icon: 'x-circle',
                                            destructive: true,
                                            inlineTestID: `settings.plugins.management.pendingChanges.${pendingChangeId}.action.reject`,
                                            disabled: !props.canRunActions || busy,
                                            onPress: () => props.onDecide(pendingChangeId, 'reject'),
                                        },
                                    ]}
                                />
                            ) : undefined}
                        />
                    );
                })}
            </ItemGroup>
        </View>
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
            <Item
                testID={`settings.plugins.${props.scope}.operationSettlement.row`}
                title={props.settlement.message}
                subtitle={props.settlement.detail}
                subtitleLines={0}
                icon={<Icon name="check-circle" size={29} color={theme.colors.state.success.foreground} />}
                showChevron={false}
                mode="info"
            />
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

export function DevelopmentPluginsSection(props: Readonly<{
    developmentPlugins: readonly DevelopmentPluginEntry[];
    createAvailable: boolean;
    sourceInstallAvailable: boolean;
    canRunActions: boolean;
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
    onRunAction: (action: 'test' | 'pack' | 'unregister', pluginId: string) => void;
}>) {
    const { theme } = useUnistyles();
    const createdPlugin = props.createdPlugin;
    return (
        <>
        {/*
          * Three ways to start, as tiles: each one opens its own flow, and none
          * is a setting. What this machine is already developing follows.
          */}
        <ItemGroup surface="none">
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
                const pluginId = entry.installed.pluginId;
                const presentation = projectDevelopmentPluginPresentation(entry, props.machineHomeDir);
                const busy = props.isPluginActionInFlight(pluginId);
                return (
                    <Item
                        key={pluginId}
                        testID={`settings.plugins.management.development.${pluginId}`}
                        title={entry.installed.title}
                        subtitle={(
                            <Text
                                testID={`settings.plugins.management.development.${pluginId}.details`}
                                selectable
                            >
                                {presentation.sourcePathLabel}
                                {presentation.attentionLabel === null ? null : `\n${presentation.attentionLabel}`}
                            </Text>
                        )}
                        subtitleLines={0}
                        subtitleAccessory={(
                            <StatusPill
                                testID={`settings.plugins.management.development.${pluginId}.status`}
                                chrome="plain"
                                labelVariant="phrase"
                                variant={presentation.status.variant}
                                label={presentation.status.label}
                            />
                        )}
                        detail={entry.installed.version}
                        icon={<PluginMark title={entry.installed.title} />}
                        iconBoxSize={36}
                        showChevron={false}
                        mode="info"
                        rightElementOutsidePressable
                        rightElement={(
                            <ItemRowActions
                                title={entry.installed.title}
                                compactActionIds={['editWithAgent']}
                                overflowTriggerTestID={`settings.plugins.management.development.${pluginId}.actions.overflow`}
                                actions={[
                                    {
                                        id: 'editWithAgent',
                                        title: t('settingsPlugins.developmentEditWithAgent'),
                                        accessibilityLabel: buildActionRowAccessibilityLabel([
                                            t('settingsPlugins.developmentEditWithAgent'),
                                            entry.installed.title,
                                        ]),
                                        subtitle: t('settingsPlugins.developmentEditWithAgentSubtitle'),
                                        icon: 'sparkle',
                                        inlineTestID: `settings.plugins.management.development.${pluginId}.action.editWithAgent`,
                                        disabled: !props.canRunActions,
                                        onPress: () => props.onEditWithAgent(pluginId),
                                    },
                                    {
                                        id: 'test',
                                        title: t('settingsPlugins.developmentTest'),
                                        subtitle: t('settingsPlugins.developmentTestSubtitle'),
                                        icon: 'checks',
                                        inlineTestID: `settings.plugins.management.development.${pluginId}.action.test`,
                                        disabled: !props.canRunActions || !entry.actions.test || busy,
                                        onPress: () => props.onRunAction('test', pluginId),
                                    },
                                    {
                                        id: 'pack',
                                        title: t('settingsPlugins.developmentPack'),
                                        subtitle: t('settingsPlugins.developmentPackSubtitle'),
                                        icon: 'cube',
                                        inlineTestID: `settings.plugins.management.development.${pluginId}.action.pack`,
                                        disabled: !props.canRunActions || !entry.actions.pack || busy,
                                        onPress: () => props.onRunAction('pack', pluginId),
                                    },
                                    ...(entry.actions.unregister ? [{
                                        id: 'unregister',
                                        title: t('common.remove'),
                                        subtitle: entry.sourceRootPath,
                                        icon: 'trash' as const,
                                        destructive: true,
                                        inlineTestID: `settings.plugins.management.development.${pluginId}.action.unregister`,
                                        disabled: !props.canRunActions || busy,
                                        onPress: () => props.onRunAction('unregister', pluginId),
                                    }] : []),
                                ]}
                            />
                        )}
                    />
                );
            }) : (
                <Item
                    testID="settings.plugins.management.development.empty"
                    title={t('settingsPlugins.developmentEmpty')}
                    subtitle={t('settingsPlugins.developmentEmptySubtitle')}
                    showChevron={false}
                    mode="info"
                />
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
        () => buildPluginMarketplaceDiscoverIssues({ sourceStatuses: props.sourceStatuses, diagnostics: props.diagnostics }),
        [props.diagnostics, props.sourceStatuses],
    );
    const sourceIssueCount = issues.filter((issue) => issue.sourceId !== null).length;
    // Unanswered sources cannot establish an empty catalog or a no-match search.
    // With no retained rows, the source notices own the cause and recovery.
    const sourceFailureWithoutResults = issues.length > 0 && props.entryCount === 0
        && props.nonInstallable.length === 0 && !props.loading;
    const noMatch = searched && !props.loading && props.error === null && !props.noTarget
        && props.entryCount === 0 && props.nonInstallable.length === 0 && !sourceFailureWithoutResults;
    const message = props.noTarget && props.entryCount === 0 && !props.loading
        ? t('settingsPlugins.surfaces.chooseMachineBrowse')
        : props.loading
        ? props.selectedSourceTitle === null
            ? t('settingsPlugins.discover.status.loading')
            : t('settingsPlugins.discover.status.loadingSource', { source: props.selectedSourceTitle })
        : props.error !== null
            ? t('settingsPlugins.discover.status.errorTitle')
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
        ...(props.error !== null && !props.loading ? [props.error] : []),
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
            {issues.map((issue) => (
                <AttentionBanner
                    key={issue.id}
                    testID={`settings.plugins.marketplace.discover.issue.${issue.sourceId ?? 'index'}`}
                    title={issue.sourceId === null
                        ? t('settingsPlugins.discover.diagnostic.indexTitle')
                        : issue.reachable
                            ? t('settingsPlugins.discover.diagnostic.behindTitle', { source: issue.sourceTitle ?? issue.sourceId })
                            : t('settingsPlugins.discover.diagnostic.unreachableTitle', { source: issue.sourceTitle ?? issue.sourceId })}
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

const SHELF_COPY = {
    curated: {
        title: 'settingsPlugins.surfaces.shelfCurated',
        description: 'settingsPlugins.surfaces.shelfCuratedDescription',
    },
    user: {
        title: 'settingsPlugins.surfaces.shelfUser',
        description: 'settingsPlugins.surfaces.shelfUserDescription',
    },
    'community-npm': {
        title: 'settingsPlugins.surfaces.shelfCommunity',
        description: 'settingsPlugins.surfaces.shelfCommunityDescription',
    },
} as const satisfies Record<DiscoverShelf['id'], Readonly<{ title: TranslationKeyNoParams; description: TranslationKeyNoParams }>>;

/**
 * Browse: the loaded results as shelves (curated, your sources, community), each compact until the reader asks
 * for all of it, filtered by a category chip, as the same page-sized Collection as Installed — one grid, one list.
 * Each listing says its review state and offers Install (or Open, once installed); its body opens the listing.
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
    serverId?: string | null;
    canRunActions: boolean;
    isPluginActionInFlight: (pluginId: string) => boolean;
    onAction: (request: PluginMarketplaceActionRequest) => void;
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
    // Presentation only: which slice of the loaded results the page shows. The query and its results stay with
    // the Discover owner.
    const [category, setCategory] = React.useState<string | null>(null);
    const [focusedShelfId, setFocusedShelfId] = React.useState<DiscoverShelf['id'] | null>(null);
    const view = projectBrowseShelves(props.entries, { category, focusedShelfId });
    // A chip or focus the new results dropped is forgotten, so it cannot return unasked later.
    React.useEffect(() => {
        if (category !== view.category) setCategory(view.category);
        if (focusedShelfId !== view.focusedShelfId) setFocusedShelfId(view.focusedShelfId);
    }, [category, focusedShelfId, view.category, view.focusedShelfId]);
    const shelves = view.shelves;
    const activeCategory = view.category ?? DISCOVER_ALL_CATEGORIES_ID;
    const items = React.useMemo(
        () => shelves.flatMap((shelf) => shelf.entries.map((entry): DiscoverListingItem => ({ entry, shelfId: shelf.id }))),
        [shelves],
    );
    const groups = React.useMemo(() => ({
        axis: shelves.map((shelf) => ({
            key: shelf.id,
            title: t(SHELF_COPY[shelf.id].title),
            description: t(SHELF_COPY[shelf.id].description),
        })),
        groupOf: (item: DiscoverListingItem) => item.shelfId,
    }), [shelves]);
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
    const anatomy = useDiscoverListingAnatomy(props);
    const controls = React.useMemo(() => new Map(items.map((item) => [
        readDiscoverListingKey(item),
        discoverListingControl(item.entry, props),
    ] as const)), [items, props]);
    // "See all" on a shelf the page shortened, "All results" on the one it focused.
    const groupAction = React.useCallback((shelfId: string) => {
        if (view.focusedShelfId === shelfId) {
            return { label: t('settingsPlugins.surfaces.allResults'), onPress: () => setFocusedShelfId(null) };
        }
        const shelf = shelves.find((candidate) => candidate.id === shelfId);
        return shelf && shelf.hiddenCount > 0
            ? { label: t('settingsPlugins.surfaces.seeAll'), onPress: () => setFocusedShelfId(shelf.id) }
            : null;
    }, [shelves, view.focusedShelfId]);
    const header = (
        <>
            {props.header}
            {view.categories.length > 0 ? (
                <View style={[styles.chips, maxWidthStyle]}>
                    <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                        <SegmentedTabBar
                            tabs={[
                                { id: DISCOVER_ALL_CATEGORIES_ID, label: t('settingsPlugins.discoverSourceAll') },
                                ...view.categories.map((id) => ({ id, label: id })),
                            ]}
                            activeTabId={activeCategory}
                            onSelectTab={(id) => setCategory(id === DISCOVER_ALL_CATEGORIES_ID ? null : id)}
                            testIDPrefix="settings.plugins.marketplace.category"
                            accessibilityLabel={t('settingsPlugins.surfaces.categoriesLabel')}
                            segmentSizing="content"
                            slidingThumb
                            targetSize="platform"
                        />
                    </ScrollView>
                </View>
            ) : null}
        </>
    );
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

/** The "All" category chip: no category filter. Not a category id, so it cannot collide with one. */
const DISCOVER_ALL_CATEGORIES_ID = '__all__';

type DiscoverListingItem = Readonly<{ entry: PluginMarketplaceCatalogEntry; shelfId: DiscoverShelf['id'] }>;

const readDiscoverListingKey = (item: DiscoverListingItem) => `${item.entry.sourceId}:${item.entry.id}`;

const DiscoverListingControlsContext = React.createContext<ReadonlyMap<string, React.ReactNode>>(new Map());

function useDiscoverListingRowActions(item: DiscoverListingItem): CollectionRowActions {
    const control = React.useContext(DiscoverListingControlsContext).get(readDiscoverListingKey(item));
    return control === undefined || control === null ? NO_ROW_ACTIONS : { accessory: control };
}

type DiscoverListingActionInputs = Readonly<{
    machineId?: string | null;
    serverId?: string | null;
    installedPluginById: ReadonlyMap<string, InstalledPluginEntry>;
    canRunActions: boolean;
    loading: boolean;
    isPluginActionInFlight: (pluginId: string) => boolean;
    onAction: (request: PluginMarketplaceActionRequest) => void;
    onNavigateToPlugin: (pluginId: string) => void;
}>;

/**
 * A listing's one action: Install, or Open once installed. "Installed" stays a status and never turns into an
 * uninstall affordance.
 */
function discoverListingControl(entry: PluginMarketplaceCatalogEntry, props: DiscoverListingActionInputs): React.ReactNode {
    const installed = props.installedPluginById.has(entry.id);
    if (!installed && !entry.installable) return null;
    const action = installed ? 'manage' : 'install';
    const installDisabled = !props.canRunActions || props.isPluginActionInFlight(entry.id) || props.loading;
    return (
        <RoundButton
            size="small"
            display="secondary"
            testID={`settings.plugins.marketplace.action.${action}.${entry.sourceId}.${entry.id}`}
            title={installed ? t('settingsPlugins.surfaces.open') : t('common.install')}
            accessibilityLabel={buildActionRowAccessibilityLabel([
                installed ? t('settingsPlugins.managePlugin') : t('settingsPlugins.installAndTrust'),
                entry.title, entry.sourceTitle,
            ])}
            accessibilityHint={installed ? undefined : t('settingsPlugins.discover.installSubtitle', { source: entry.sourceTitle })}
            disabled={!installed && installDisabled}
            onPress={() => installed ? props.onNavigateToPlugin(entry.id) : props.onAction({
                method: 'install', pluginId: entry.id, sourceId: entry.sourceId,
            })}
        />
    );
}

/** One anatomy for the grid's cards and the list's rows. A withdrawal outranks "Installed". */
function useDiscoverListingAnatomy(props: DiscoverListingActionInputs & Readonly<{
    projectionByPluginId?: PluginProjectionFactsById;
}>): CollectionAnatomy<DiscoverListingItem> {
    const host = resolvePluginsSurfaceHost(usePathname());
    const { installedPluginById, projectionByPluginId } = props;
    return React.useMemo(() => ({
        wrapItem: ({ entry }, content) => <WorkspaceDestinationRow href={buildPluginsHomeRoute(host, {
            view: 'browse', open: { kind: 'listing', sourceId: entry.sourceId, pluginId: entry.id },
        })}>{content}</WorkspaceDestinationRow>,
        glyph: ({ entry }) => (
            <PluginMark title={entry.title} pluginId={entry.id} iconAgentId={projectionByPluginId?.[entry.id]?.iconAgentId ?? null}
                installedPackage={projectionByPluginId?.[entry.id]?.installedPackage} machineId={props.machineId} serverId={props.serverId} />
        ),
        title: ({ entry }) => entry.title,
        // A registry the install needs is the one fact to read before installing, on cards and rows alike; it
        // takes the byline's place until the listing is installed.
        where: ({ entry }) => (!installedPluginById.has(entry.id) && entry.registrySelectionOrigin !== null
            ? t('settingsPlugins.discover.registrySelectionRequired', { origin: entry.registrySelectionOrigin })
            : `${entry.publisher.displayName} · ${entry.sourceTitle}`),
        // The grid-only slot keeps its two-line place without inventing unavailable catalog copy.
        description: ({ entry }) => entry.description ?? '',
        reason: ({ entry }) => (installedPluginById.has(entry.id) && entry.warning !== 'withdrawn' ? (
            <PluginCardStatus
                testID={`settings.plugins.marketplace.installedStatus.${entry.sourceId}.${entry.id}`}
                label={t('settingsPlugins.surfaces.installed')}
                tone="quiet"
            />
        ) : (
            <PluginCardStatus
                testID={`settings.plugins.marketplace.reviewStatus.${entry.sourceId}.${entry.id}`}
                label={catalogReviewStatusLabel(entry)}
                tone={entry.warning === 'withdrawn' ? 'warning' : 'quiet'}
            />
        )),
        action: (item) => discoverListingControl(item.entry, props),
        accessibilityLabel: ({ entry }) => buildActionRowAccessibilityLabel([entry.title, t('common.details'), entry.sourceTitle]) ?? entry.title,
        testID: ({ entry }) => `settings.plugins.marketplace.entry.${entry.sourceId}.${entry.id}`,
        columnTitles: { title: t('settingsPlugins.surfaces.navigationTitle') },
    // `props` carries the action inputs `discoverListingControl` reads; its identity is the render's.
    }), [host, installedPluginById, projectionByPluginId, props]);
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
        gap: 12,
    },
    source: {
        ...Typography.default(),
        fontSize: 12,
        lineHeight: 16,
        color: theme.colors.text.tertiary,
        maxWidth: 140,
    },
    pendingNotice: {
        backgroundColor: theme.colors.state.info.background,
        borderColor: theme.colors.state.info.border,
    },
    statusLine: {
        width: '100%',
        alignSelf: 'center',
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 8,
        paddingHorizontal: PAGE_LIST_METRICS.pageTextInsetPx,
        paddingTop: 4,
        paddingBottom: 4,
    },
    statusText: {
        flex: 1,
        gap: 2,
    },
    statusMessage: {
        ...Typography.default(),
        fontSize: 12.5,
        lineHeight: 18,
        color: theme.colors.text.secondary,
    },
    statusMessageError: {
        color: theme.colors.state.warning.foreground,
    },
    statusQualifier: {
        ...Typography.default(),
        fontSize: 12.5,
        lineHeight: 18,
        color: theme.colors.text.tertiary,
    },
    chips: {
        width: '100%',
        alignSelf: 'center',
        paddingHorizontal: resolveItemGroupContentHorizontalInsetPx(),
        paddingTop: 8,
    },
    loadMore: {
        width: '100%',
        alignSelf: 'center',
        alignItems: 'center',
        paddingTop: 4,
        paddingBottom: 16,
    },
    stateFrame: {
        width: '100%',
        alignSelf: 'center',
        paddingHorizontal: resolveItemGroupContentHorizontalInsetPx(),
        paddingTop: 12,
        paddingBottom: 8,
    },
    registryNote: {
        ...Typography.default(),
        fontSize: 12,
        lineHeight: 16,
        color: theme.colors.text.secondary,
    },
}));
