import * as React from 'react';
import { showDocumentShareSheet } from '@/components/sharing/documents/showDocumentShareSheet';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
    Collection,
    useHappierCollection,
    type CollectionAnatomy,
    type CollectionRowActions,
} from '@happier-dev/plugin-ui';
import type { HappierCollectionWindow } from '@happier-dev/plugin-ui/presentation';
import type { WorkflowPluginSourceV1 } from '@happier-dev/protocol/workflows';
import { countWorkflowStepsV1 } from '@happier-dev/protocol/workflows/workflowDefinitionEditV1';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { Icon } from '@/components/ui/icons/Icon';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { useLayoutMaxWidthStyle } from '@/components/ui/layout/layout';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { resolveItemGroupContentHorizontalInsetPx } from '@/components/ui/lists/itemGroupSpacing';
import { CoreCollectionScope } from '@/components/ui/lists/collection/CoreCollectionScope';
import { SelectionListSkeletonRow } from '@/components/ui/selectionList/SelectionListSkeletonRow';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import {
    deleteWorkflowDefinition,
    getWorkflowDefinition,
} from '@/sync/domains/workflows/workflowDefinitionActions';
import { exportWorkflowDefinition } from '@/sync/domains/workflows/workflowInterchange';
import { createWorkflowDefinitionRoute, createWorkflowRunRoute } from '@/sync/domains/workflows/workflowRunRoute';
import { formatRelativeTimeShort } from '@/components/ui/selectionList/formatRelativeTimeShort';
import { t } from '@/text';

import { confirmWorkflowDocumentExport } from '../actions/confirmWorkflowDocumentExport';
import { splitLibraryDefinitions } from '../column/workflowsColumnModel';
import { WORKFLOWS_IMPORT_ROUTE, WORKFLOWS_NEW_ROUTE } from '../column/WorkflowsColumnActions';
import {
    forgetWorkflowLibraryDefinition,
    useWorkflowDefinitionLibrary,
    useWorkflowRunWindow,
    type WorkflowLibraryDefinition,
} from './workflowLibraryReads';
import { useWorkflowLibrarySummaries, type WorkflowLibraryRunSummary } from './useWorkflowLibrarySummaries';
import { projectWorkflowRunStrip } from './workflowRunStrip';
import { WorkflowRunStripView } from './WorkflowRunStripView';
import { WorkflowExamplesSection } from './WorkflowExamplesSection';
import { WorkflowBuiltinsSection } from './WorkflowBuiltinsSection';
import { useWorkflowAgentAuthoring } from '../authoring/useWorkflowAgentAuthoring';
import { buildWorkflowAgentAuthoringSeed } from '@/sync/domains/workflows/workflowAgentAuthoringSeed';
import { formatTriggerSetSummary } from '../triggers/formatTriggerSummary';
import { formatWorkflowDefinitionContentUnavailableReason, formatWorkflowDefinitionLibraryTitle } from '../presentation/workflowProblemPresentation';

/** A library longer than this gets its search field (the collection columns' shared convention). */
const SEARCH_THRESHOLD = 8;
/** The narrowest readable row at normal text size. */
const LIBRARY_MIN_WIDTH_PX = 320;

type LibraryRow = Readonly<{
    key: string;
    group: 'library' | 'sharedWithYou';
    definition: WorkflowLibraryDefinition;
}> | Readonly<{ key: string; group: 'fromPlugins'; plugin: WorkflowPluginSourceV1 }>;

const rowTitle = (row: LibraryRow) => row.group === 'fromPlugins' ? row.plugin.title : formatWorkflowDefinitionLibraryTitle(row.definition);

type LibraryRowCommands = Readonly<{
    /** Opens the exact run the summary names as needing you, at its first actionable item. */
    openRun: (runId: string) => void;
    summaries: ReadonlyMap<string, WorkflowLibraryRunSummary> | null;
    run: (definitionId: string) => void;
    exportJson: (definitionId: string) => void;
    /** Opens the one document share sheet (INT I2) for a workflow the caller owns (07 S7 Share). */
    share: (definition: WorkflowLibraryDefinition) => void;
    remove: (definitionId: string) => void;
}>;

const LibraryRowCommandsContext = React.createContext<LibraryRowCommands | null>(null);

const LIBRARY_GROUPS = {
    get axis() {
        return [
            { key: 'library', title: t('workflows.destination.sections.library') },
            { key: 'sharedWithYou', title: t('workflows.destination.sections.sharedWithYou') },
            { key: 'fromPlugins', title: t('workflows.plugins.fromPlugins') },
        ];
    },
    groupOf: (row: LibraryRow) => row.group,
};

const readRowKey = (row: LibraryRow) => row.key;

/**
 * The Workflows library home (FIN 04 §3.3, 07 S2, lab `nav-N1` as corrected): what the column lacks,
 * never a copy of it. A header with one primary **New workflow**, then your saved workflows and the
 * ones shared with you through the canonical Collection. Needs you, Running and History stay in the
 * column. A saved row's authored count and attached triggers come from the definition list;
 * "last run {age}", the run strip and **Needs you** come from `workflow.run.summaries`.
 */
export function WorkflowsLibraryHome(): React.ReactElement {
    const { theme } = useUnistyles();
    const router = useRouter();
    const openAgent = useWorkflowAgentAuthoring();
    const library = useWorkflowDefinitionLibrary();
    const libraryIsEmpty = library.definitions.length === 0 && library.pluginWorkflows.length === 0;
    // Only an empty library needs history to distinguish first visit from returning to it.
    const history = useWorkflowRunWindow('all', { enabled: library.status === 'loaded' && libraryIsEmpty });
    const [query, setQuery] = React.useState('');
    const [view, setView] = React.useState<'all' | 'triggered'>('all');
    const split = React.useMemo(() => splitLibraryDefinitions(library.definitions, library.pluginWorkflows), [library.definitions, library.pluginWorkflows]);
    const rows = React.useMemo((): readonly LibraryRow[] => [
        ...split.library.map((definition) => ({ key: definition.definitionId, group: 'library' as const, definition })),
        ...split.sharedWithYou.map((definition) => ({ key: definition.definitionId, group: 'sharedWithYou' as const, definition })),
        ...split.fromPlugins.map((plugin) => ({ key: plugin.workflow, group: 'fromPlugins' as const, plugin })),
    ], [split.library, split.sharedWithYou, split.fromPlugins]);
    const hasTriggers = rows.some((row) => row.group !== 'fromPlugins' && row.definition.triggers.length > 0);
    const activeView = hasTriggers ? view : 'all';
    React.useEffect(() => { if (!hasTriggers) setView('all'); }, [hasTriggers]);
    const needle = query.trim().toLocaleLowerCase();
    const filter = React.useCallback(
        (row: LibraryRow) => (activeView === 'all' || (row.group !== 'fromPlugins' && row.definition.triggers.length > 0))
            && (needle.length === 0 || rowTitle(row).toLocaleLowerCase().includes(needle)),
        [needle, activeView],
    );
    const window = React.useMemo((): HappierCollectionWindow => (library.hasMore ? {
        kind: 'partial',
        continuations: [{
            key: 'more',
            label: library.loadMoreFailed ? t('workflows.retry') : t('workflows.destination.loadMoreWorkflows'),
            load: library.loadMore,
            busy: library.loadingMore,
        }],
    } : { kind: 'complete' }), [library.hasMore, library.loadMore, library.loadMoreFailed, library.loadingMore]);
    const openDefinition = React.useCallback((key: string | null) => {
        if (key !== null) router.push(`/workflows/${encodeURIComponent(key)}` as never);
    }, [router]);
    const model = useHappierCollection<LibraryRow>({
        items: rows,
        keyOf: readRowKey,
        groups: LIBRARY_GROUPS,
        filter,
        window,
        openKey: null,
        onOpenChange: openDefinition,
    });
    const summaryIds = React.useMemo(() => rows.flatMap((row) => row.group === 'fromPlugins' ? [] : [row.definition.definitionId]), [rows]);
    const summaries = useWorkflowLibrarySummaries(summaryIds);
    const anatomy = useLibraryAnatomy(summaries);
    const commands = useLibraryRowCommands(summaries);

    const newWorkflow = () => router.push(WORKFLOWS_NEW_ROUTE as never);
    const importWorkflow = () => router.push(WORKFLOWS_IMPORT_ROUTE as never);
    const createWithAgent = () => openAgent(buildWorkflowAgentAuthoringSeed({ kind: 'create' }));

    const firstVisit = library.status === 'loaded' && libraryIsEmpty
        && history.status === 'loaded' && history.rows.length === 0;
    if (firstVisit) return <WorkflowsFirstVisit onNewWorkflow={newWorkflow} onImport={importWorkflow} onCreateWithAgent={createWithAgent} />;

    const header = (<>
        <PageHeader
            testID="workflows-home:header"
            title={t('workflows.title')}
            description={t('workflows.destination.description')}
            actions={(
                <View style={styles.headerActions}>
                    <RoundButton
                        testID="workflows-home:import"
                        size="small"
                        display="inverted"
                        title={t('workflows.destination.import')}
                        leading={<Icon name="download" size={14} color={theme.colors.text.secondary} />}
                        textStyle={{ color: theme.colors.text.secondary }}
                        onPress={importWorkflow}
                    />
                    <RoundButton testID="workflows-home:agent" size="small" display="secondary"
                        title={t('workflows.authoring.create')}
                        leading={<Icon name="sparkle" size={14} color={theme.colors.text.primary} />}
                        onPress={createWithAgent} />
                    <RoundButton
                        testID="workflows-home:new"
                        size="small"
                        title={t('workflows.newWorkflow')}
                        leading={<Icon name="plus" size={14} color={theme.colors.button.primary.tint} />}
                        onPress={newWorkflow}
                    />
                </View>
            )}
        />
        {hasTriggers ? <SegmentedTabBar
            testIDPrefix="workflows-home:filter"
            accessibilityLabel={t('workflows.destination.views.libraryAccessibility')}
            tabs={[{ id: 'all', label: t('workflows.destination.views.all') }, { id: 'triggered', label: t('workflows.destination.views.triggered') }]}
            activeTabId={activeView} onSelectTab={setView} segmentSizing="content" presentation="pills"
        /> : null}
    </>);

    const empty = library.status === 'failed' && library.definitions.length === 0 ? (
        <SurfaceStateCard
            testID="workflows-home:failed"
            kind="error"
            title={t('workflows.loadFailedTitle')}
            reason={t('workflows.loadFailedBody')}
            action={{ label: t('workflows.retry'), onPress: library.retry }}
            accessibilitySemantics="alert"
        />
    ) : needle.length > 0 ? (
        <EmptyState
            testID="workflows-home:noMatch"
            layout="inline"
            iconName="magnifying-glass"
            title={t('workflows.destination.noMatch', { query: query.trim() })}
        />
    ) : library.status === 'loaded' && history.status !== 'loading' ? (
        // Nothing saved yet, but runs exist (else this is the first visit): say what goes here.
        <EmptyState
            testID="workflows-home:empty"
            layout="line"
            title={t('workflows.destination.libraryEmpty')}
        />
    ) : (
        // First load: list-shaped placeholders where the rows will be, so nothing moves on arrival.
        <View testID="workflows-home:loading">
            {[0, 1, 2].map((index) => <SelectionListSkeletonRow key={index} index={index} />)}
        </View>
    );

    return (
        <LibraryRowCommandsContext.Provider value={commands}>
            <LibraryPageHeaderContext.Provider value={header}>
            <CoreCollectionScope renderPageScroller={renderLibraryPageScroller}>
                <Collection<LibraryRow>
                    testID="workflows-home:collection"
                    model={model}
                    anatomy={anatomy}
                    accessibilityLabel={t('workflows.title')}
                    presentation="list"
                    detail="none"
                    scroll="page"
                    minListWidth={LIBRARY_MIN_WIDTH_PX}
                    minDetailWidth={LIBRARY_MIN_WIDTH_PX}
                    preferredListRatio={1}
                    loading={library.status === 'loading' && library.definitions.length === 0}
                    useRowActions={useLibraryRowActions}
                    {...(rows.length > SEARCH_THRESHOLD ? {
                        search: {
                            label: t('workflows.destination.searchPlaceholder'),
                            placeholder: t('workflows.destination.searchPlaceholder'),
                            value: query,
                            onValueChange: setQuery,
                            testID: 'workflows-home:search',
                        },
                    } : {})}
                    empty={empty}
                />
            </CoreCollectionScope>
            </LibraryPageHeaderContext.Provider>
        </LibraryRowCommandsContext.Provider>
    );
}

/** The page's content column, so the header and the rows share one edge. */
function LibraryPageColumn(props: Readonly<{ children?: React.ReactNode }>) {
    const maxWidthStyle = useLayoutMaxWidthStyle();
    return <View style={[styles.pageColumn, maxWidthStyle]}>{props.children}</View>;
}

/**
 * The page header, drawn by the page scroller rather than the Collection so the Collection's rows can sit
 * on the same content inset as the sections below them (07 S2: one edge for every section).
 */
const LibraryPageHeaderContext = React.createContext<React.ReactNode>(null);

function LibraryPageHeaderSlot() {
    return <>{React.useContext(LibraryPageHeaderContext)}</>;
}

/** A library with run strips and example maps is a collection page: the wide column (lab `nav-N1`). */
function renderLibraryPageScroller(children: React.ReactNode): React.ReactNode {
    return (
        <ItemList pageColumn="wide">
            <LibraryPageColumn>
                <LibraryPageHeaderSlot />
                <View style={styles.collectionInset}>{children}</View>
                <WorkflowBuiltinsSection />
                <WorkflowExamplesSection />
            </LibraryPageColumn>
        </ItemList>
    );
}

function useLibraryAnatomy(summaries: ReadonlyMap<string, WorkflowLibraryRunSummary> | null): CollectionAnatomy<LibraryRow> {
    const { theme } = useUnistyles();
    return React.useMemo(() => ({
        glyph: () => <Icon name="tree-structure" size={18} color={theme.colors.text.secondary} />,
        title: rowTitle,
        where: (row) => {
            if (row.group === 'fromPlugins') return [
                t('workflows.examples.stepCount', { count: countWorkflowStepsV1(row.plugin.definition.blocks) }),
                row.plugin.description ?? `${row.plugin.pluginId} · ${row.plugin.version}`,
            ].join(' · ');
            const lastRun = summaries?.get(row.definition.definitionId)?.lastRun ?? null;
            const createdAt = lastRun === null ? Number.NaN : Date.parse(lastRun.createdAt);
            return [row.definition.contentStatus === 'available'
                ? t('workflows.examples.stepCount', { count: row.definition.stepCount }) : t('common.unavailable'),
                formatTriggerSetSummary(row.definition.triggers),
                ...(Number.isFinite(createdAt) ? [t('workflows.destination.lastRun', { age: formatRelativeTimeShort(createdAt, Date.now()) })] : []),
            ].join(' · ');
        },
        reason: (row) => row.group === 'fromPlugins' ? t('workflows.plugins.readOnly')
            : row.definition.contentStatus === 'unavailable'
                ? formatWorkflowDefinitionContentUnavailableReason(row.definition.contentUnavailableReason) : null,
        accessibilityLabel: rowTitle,
        testID: (row) => `workflows-home:row:${row.key}`,
        columnTitles: { title: t('workflows.title') },
    }), [summaries, theme.colors.text.secondary]);
}

/** A row's own menu: Run now, Export JSON, and Delete for workflows you own. */
function useLibraryRowActions(row: LibraryRow): CollectionRowActions {
    const commands = React.useContext(LibraryRowCommandsContext);
    const { theme } = useUnistyles();
    const owned = row.group === 'library';
    const unavailable = row.group !== 'fromPlugins' && row.definition.contentStatus === 'unavailable';
    const summary = row.group === 'fromPlugins' ? undefined : commands?.summaries?.get(row.definition.definitionId);
    const needsYouRunId = summary?.needsYouRunId ?? null;
    return {
        // The row's end (07 S2, lab `nav-N1`): the neutral run strip, **Needs you** when a run waits
        // (navigation only: the run's own page answers, M3), then the chevron every row opens with.
        accessory: (
            <View style={styles.rowAccessory}>
                {summary === undefined || summary.recent.length === 0 ? null : (
                    <WorkflowRunStripView testID={`workflows-home:row:${row.key}:strip`} strip={projectWorkflowRunStrip(summary)} />
                )}
                {needsYouRunId === null || commands === null ? null : (
                    <RoundButton
                        testID={`workflows-home:row:${row.key}:needsYou`}
                        size="small"
                        display="inverted"
                        title={t('workflows.destination.sections.needsYou')}
                        textStyle={{ color: theme.colors.state.warning.foreground }}
                        onPress={() => commands.openRun(needsYouRunId)}
                    />
                )}
                <Icon name="caret-right" size={15} color={theme.colors.text.secondary} />
            </View>
        ),
        secondaryActionAccessibilityLabel: t('workflows.destination.rowMenu.accessibility'),
        secondaryActions: [
            { id: 'run', label: t('workflows.destination.rowMenu.runNow'), disabled: unavailable },
            ...(owned ? [{ id: 'share', label: t('workflows.destination.rowMenu.share') }] : []),
            ...(row.group === 'fromPlugins' ? [] : [{ id: 'export', label: t('workflows.exportJson') }]),
            ...(owned ? [{ id: 'delete', label: t('common.delete') }] : []),
        ],
        onSecondaryAction: (id) => {
            if (commands === null) return;
            if (row.group === 'fromPlugins') {
                if (id === 'run') commands.run(row.plugin.workflow);
                return;
            }
            const definitionId = row.definition.definitionId;
            if (id === 'run' && !unavailable) commands.run(definitionId);
            else if (id === 'share') commands.share(row.definition);
            else if (id === 'export') commands.exportJson(definitionId);
            else if (id === 'delete') commands.remove(definitionId);
        },
    };
}

function useLibraryRowCommands(summaries: ReadonlyMap<string, WorkflowLibraryRunSummary> | null): LibraryRowCommands {
    const router = useRouter();
    const deleting = React.useRef(new Set<string>());
    return React.useMemo(() => ({
        summaries,
        openRun: (runId) => router.push(createWorkflowRunRoute(runId) as never),
        // A saved row holds an Artifact identity, not a reviewed machine or inputs: Run now opens the
        // exact revision in the editor, whose Run review admits the run.
        run: (definitionId) => router.push({ pathname: '/workflows/[id]', params: { id: definitionId, intent: 'run' } } as never),
        exportJson: (definitionId) => { void exportDefinition(definitionId); },
        share: (definition) => showDocumentShareSheet({
            kind: 'workflow-definition.v1', artifactId: definition.definitionId, name: formatWorkflowDefinitionLibraryTitle(definition),
            subtitle: `${t('workflows.page.chromeTitle')} · ${definition.contentStatus === 'available'
                ? t('workflows.examples.stepCount', { count: definition.stepCount }) : t('common.unavailable')}`,
            linkPath: createWorkflowDefinitionRoute(definition.definitionId),
            // "Send a copy instead" is the existing JSON export (INT I2).
            onSendCopy: () => { void exportDefinition(definition.definitionId); },
        }),
        remove: (definitionId) => {
            if (deleting.current.has(definitionId)) return;
            void (async () => {
                const lifetime = captureActiveServerAccountScopeLifetime();
                if (lifetime === null) return;
                const confirmed = await Modal.confirm(
                    t('workflows.destination.deleteTitle'),
                    t('workflows.destination.deleteBody'),
                    { cancelText: t('common.cancel'), confirmText: t('common.delete'), destructive: true },
                );
                if (!confirmed || !lifetime.isCurrent()) return;
                deleting.current.add(definitionId);
                try {
                    await deleteWorkflowDefinition({ definitionId });
                    if (lifetime.isCurrent()) forgetWorkflowLibraryDefinition(definitionId);
                } catch {
                    // Deletion never retries by itself; the row stays and the person decides.
                    if (lifetime.isCurrent()) await Modal.alert(t('workflows.destination.deleteFailedTitle'), t('workflows.loadFailedBody'));
                } finally {
                    deleting.current.delete(definitionId);
                }
            })();
        },
    }), [router, summaries]);
}

async function exportDefinition(definitionId: string): Promise<void> {
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (lifetime === null) return;
    try {
        const opened = await getWorkflowDefinition({ definitionId });
        if (!lifetime.isCurrent()) return;
        const exported = exportWorkflowDefinition({ definition: opened.definition });
        if (!exported.ok) {
            await Modal.alert(t('workflows.destination.exportFailedTitle'), t('workflows.loadFailedBody'));
            return;
        }
        await confirmWorkflowDocumentExport({ name: opened.metadata.title, json: exported.json, isCurrent: lifetime.isCurrent });
    } catch {
        if (lifetime.isCurrent()) await Modal.alert(t('workflows.destination.exportFailedTitle'), t('workflows.loadFailedBody'));
    }
}

/**
 * First visit (lab `nav-N3`): show, guide, confirm. One primary, and a quiet way in for a file. The
 * examples use the same catalog as the returning home and column picker (08 §6).
 */
function WorkflowsFirstVisit(props: Readonly<{ onNewWorkflow: () => void; onImport: () => void; onCreateWithAgent: () => void }>) {
    return (
        <ItemList pageColumn="wide">
            <LibraryPageColumn>
                <EmptyState
                    testID="workflows-home:firstVisit"
                    layout="page"
                    scene="noWorkflows"
                    title={t('workflows.destination.firstVisitTitle')}
                    subtitle={t('workflows.destination.firstVisitBody')}
                    primaryAction={{ label: t('workflows.newWorkflow'), onPress: props.onNewWorkflow, testID: 'workflows-home:firstVisit:new' }}
                    secondaryAction={{ label: t('workflows.authoring.create'), onPress: props.onCreateWithAgent, testID: 'workflows-home:firstVisit:agent' }}
                />
                <WorkflowBuiltinsSection />
                <WorkflowExamplesSection />
                <View style={styles.importLine}>
                    <Text style={styles.importPrompt}>{t('workflows.destination.importPrompt')}</Text>
                    <RoundButton
                        testID="workflows-home:firstVisit:import"
                        size="small"
                        display="inverted"
                        title={t('workflows.destination.import')}
                        onPress={props.onImport}
                    />
                </View>
            </LibraryPageColumn>
        </ItemList>
    );
}

const styles = StyleSheet.create((theme) => ({
    pageColumn: {
        width: '100%',
        alignSelf: 'center',
    },
    // The rows' edge is the page sections' sheet edge, not the page column's.
    collectionInset: {
        paddingHorizontal: resolveItemGroupContentHorizontalInsetPx(),
    },
    rowAccessory: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.margins.md,
    },
    headerActions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.margins.sm,
    },
    importLine: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: theme.margins.xs,
        paddingBottom: theme.margins.xl,
    },
    importPrompt: {
        ...Typography.default(),
        color: theme.colors.text.secondary,
    },
}));
