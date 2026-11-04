import * as React from 'react';
import { showDocumentShareSheet } from '@/components/sharing/documents/showDocumentShareSheet';
import { View } from 'react-native';
import { WorkspaceDestinationRow } from '@/components/appShell/workspace/WorkspaceDestinationRow';
import { useEntityComposerMention } from '@/components/ui/treeDragDrop/useEntityComposerMention';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
    Collection,
    useHappierCollection,
    type CollectionAnatomy,
    type CollectionRowActions,
} from '@happier-dev/plugin-ui';
import { HAPPIER_PAGE_METRICS, type HappierCollectionWindow } from '@happier-dev/plugin-ui/presentation';
import { countWorkflowStepsV1 } from '@happier-dev/protocol/workflows/workflowDefinitionEditV1';
import { isActionApprovalDeclinedErrorCode } from '@happier-dev/protocol/actions/actionExecutionResult';

import { useIsFocused, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { Icon } from '@/components/ui/icons/Icon';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { useViewportClass } from '@/utils/platform/useViewportClass';
import { PageContentColumn } from '@/components/ui/lists/PageContentColumn';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { CompactSearchField } from '@/components/ui/forms/CompactSearchField';
import { CoreCollectionScope } from '@/components/ui/lists/collection/CoreCollectionScope';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { restoreFocusToBestTarget } from '@/keyboard/focusReturn';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { WorkflowActionError } from '@/sync/domains/workflows/workflowActionError';
import {
    deleteWorkflowDefinition,
    exportSavedWorkflowDocument,
} from '@/sync/domains/workflows/workflowDefinitionActions';
import { createWorkflowDefinitionRoute, createWorkflowRunRoute } from '@/sync/domains/workflows/workflowRunRoute';
import { formatRelativeTimeShort } from '@/utils/time/formatShortRelativeTime';
import { t } from '@/text';

import { confirmWorkflowDocumentExport } from '../actions/confirmWorkflowDocumentExport';
import { splitLibraryDefinitions } from '../column/workflowsColumnModel';
import { WORKFLOWS_IMPORT_ROUTE, WORKFLOWS_NEW_ROUTE } from '../column/WorkflowsColumnActions';
import { useWorkflowsColumnOwnsCreation } from '../column/workflowsColumnCreation';
import {
    dismissWorkflowLibraryDeletionReceipt,
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
import { AccountTriggersSection } from '../triggers/AccountTriggersSection';
import { useWorkflowLibraryView, workflowLibraryRowTitle as rowTitle, type WorkflowLibraryRow as LibraryRow,
    type WorkflowLibraryView as LibraryView } from './useWorkflowLibraryView';

/** The narrowest readable row at normal text size. */
const LIBRARY_MIN_WIDTH_PX = 320;

const LIBRARY_VIEW_LABEL: Readonly<Record<LibraryView, () => string>> = {
    all: () => t('workflows.destination.views.all'),
    triggered: () => t('workflows.destination.views.triggered'),
    running: () => t('workflows.destination.sections.running'),
};

type LibraryRowCommands = Readonly<{
    deleting: ReadonlySet<string>;
    focusRequest: Readonly<{ key: string }> | undefined;
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
export function WorkflowsLibraryHome(props: Readonly<{ includeAccountTriggers?: boolean }> = {}): React.ReactElement {
    const { theme } = useUnistyles();
    const router = useRouter();
    const openAgent = useWorkflowAgentAuthoring();
    const columnOwnsCreation = useWorkflowsColumnOwnsCreation();
    const phone = useViewportClass() === 'compact';
    const library = useWorkflowDefinitionLibrary();
    const focused = useIsFocused();
    React.useEffect(() => {
        const definitionId = library.deletedDefinitionId;
        if (!focused || definitionId === null) return;
        return () => dismissWorkflowLibraryDeletionReceipt(definitionId);
    }, [focused, library.deletedDefinitionId]);
    const libraryIsEmpty = library.definitions.length === 0 && library.pluginWorkflows.length === 0;
    // Only an empty library needs history to distinguish first visit from returning to it.
    const history = useWorkflowRunWindow('all', { enabled: library.status === 'loaded' && libraryIsEmpty });
    const split = React.useMemo(() => splitLibraryDefinitions(library.definitions, library.pluginWorkflows), [library.definitions, library.pluginWorkflows]);
    const rows = React.useMemo((): readonly LibraryRow[] => [
        ...split.library.map((definition) => ({ key: definition.definitionId, group: 'library' as const, definition })),
        ...split.sharedWithYou.map((definition) => ({ key: definition.definitionId, group: 'sharedWithYou' as const, definition })),
        ...split.fromPlugins.map((plugin) => ({ key: plugin.workflow, group: 'fromPlugins' as const, plugin })),
    ], [split.library, split.sharedWithYou, split.fromPlugins]);
    const summaryIds = React.useMemo(() => rows.flatMap((row) => row.group === 'fromPlugins' ? [] : [row.definition.definitionId]), [rows]);
    const { summaries } = useWorkflowLibrarySummaries(summaryIds);
    const libraryView = useWorkflowLibraryView(rows, summaries, focused);
    const { filter, visibleKeys, needle, searchQuery: query, view: activeView } = libraryView;
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
    const anatomy = useLibraryAnatomy(summaries);
    const commands = useLibraryRowCommands(summaries, library.deletedDefinitionId);
    const deleted = library.deletedDefinitionId !== null;
    const visibleKeysRef = React.useRef(visibleKeys);
    visibleKeysRef.current = visibleKeys;
    const previousVisibleKeys = React.useRef(visibleKeys);
    const deletionFocusRequest = React.useMemo(() => {
        if (library.deletedDefinitionId === null) return undefined;
        const before = previousVisibleKeys.current;
        const index = before.indexOf(library.deletedDefinitionId);
        const neighbor = index < 0 ? undefined : before[index + 1] ?? before[index - 1];
        const key = neighbor !== undefined && visibleKeysRef.current.includes(neighbor) ? neighbor : visibleKeysRef.current[0];
        return key === undefined ? undefined : { key };
    }, [library.deletedDefinitionId, library.status]);
    React.useEffect(() => { previousVisibleKeys.current = visibleKeys; }, [visibleKeys]);
    const focusRequest = commands.focusRequest ?? deletionFocusRequest;
    const creationRef = React.useRef<import('@/keyboard/focusReturn').FocusReturnTarget>(null);
    const setCreationRef = React.useCallback<NonNullable<React.ComponentProps<typeof RoundButton>['controlRef']>>(
        target => { creationRef.current = target; }, []);
    React.useEffect(() => {
        if (deleted && deletionFocusRequest === undefined) restoreFocusToBestTarget(creationRef);
    }, [deleted, deletionFocusRequest]);

    const newWorkflow = () => router.push(WORKFLOWS_NEW_ROUTE as never);
    const importWorkflow = () => router.pushRetainingCurrent(WORKFLOWS_IMPORT_ROUTE as never);
    const createWithAgent = () => openAgent(buildWorkflowAgentAuthoringSeed({ kind: 'create' }));

    const firstVisit = library.status === 'loaded' && libraryIsEmpty
        && history.status === 'loaded' && history.rows.length === 0;
    if (firstVisit && !deleted) return <WorkflowsFirstVisit onNewWorkflow={newWorkflow} onImport={importWorkflow} onCreateWithAgent={createWithAgent}
        includeAccountTriggers={props.includeAccountTriggers} />;

    const header = (<>
        <PageHeader
            testID="workflows-home:header"
            title={t('workflows.title')}
            description={t('workflows.destination.description')}
            actionsPlacement={deleted && deletionFocusRequest === undefined ? 'page' : undefined}
            // The column normally owns phone creation. An empty deletion landing lends
            // its real New workflow action to the header so focus never lands on BODY.
            actions={columnOwnsCreation && !(deleted && deletionFocusRequest === undefined) ? undefined : (
                <View style={styles.headerActions}>
                    {!columnOwnsCreation ? <><RoundButton
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
                        onPress={createWithAgent} /></> : null}
                    <RoundButton
                        testID="workflows-home:new"
                        controlRef={setCreationRef}
                        size="small"
                        title={t('workflows.newWorkflow')}
                        leading={<Icon name="plus" size={14} color={theme.colors.button.primary.tint} />}
                        onPress={newWorkflow}
                    />
                </View>
            )}
        />
        {deleted ? <View testID="workflows-home:deleted-focus">
            <SurfaceStateCard testID="workflows-home:deleted" size="line" kind="success" title={t('common.deleted')} accessibilitySemantics="status" />
        </View> : null}
        {/* The control line under the header (lab `nav-N1`): the view switch, then the search, on the sheets' edge. */}
        {rows.length > 0 ? <View style={styles.controlLine}>
            {libraryView.offeredViews.length > 1 ? <SegmentedTabBar
                testIDPrefix="workflows-home:filter"
                accessibilityLabel={t('workflows.destination.views.libraryAccessibility')}
                tabs={libraryView.offeredViews.map((id) => ({ id, label: LIBRARY_VIEW_LABEL[id]() }))}
                activeTabId={activeView} onSelectTab={libraryView.setView} segmentSizing="content" presentation="pills"
            /> : null}
            <View style={styles.controlLineGrow} />
            <CompactSearchField testID="workflows-home:search" accessibilityLabel={t('workflows.destination.searchPlaceholder')}
                placeholder={t('workflows.destination.searchPlaceholder')} value={query} onChangeText={libraryView.setSearchQuery} style={phone ? styles.searchPhone : styles.search} />
        </View> : null}
    </>);

    const empty = library.status === 'failed' && library.definitions.length === 0 ? (
        // Only the saved library failed; Built-in and the examples below still work, so the failure is one
        // line where the Library rows would be (lab `nav-N5` "Couldn't load"), not a page-sized state. It sits
        // in the Collection's empty slot on the rows' edge, as the search's no-match line does.
        <SurfaceStateCard
            testID="workflows-home:failed"
            size="line"
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
        <SurfaceStateCard testID="workflows-home:loading" size="line" kind="loading" title={t('common.loading')}
            accessibilitySemantics="status" />
    );

    return (
        <LibraryRowCommandsContext.Provider value={commands}>
            <LibraryPageHeaderContext.Provider value={header}>
            <LibraryAccountTriggersContext.Provider value={props.includeAccountTriggers === true}>
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
                    useRowActions={useLibraryRowActions}
                    {...(focusRequest === undefined ? {} : { selection: { focusRequest } })}
                    empty={empty}
                />
            </CoreCollectionScope>
            </LibraryAccountTriggersContext.Provider>
            </LibraryPageHeaderContext.Provider>
        </LibraryRowCommandsContext.Provider>
    );
}

/** The page's content column, so the header and the rows share one edge. */
/**
 * The page header is drawn by the page scroller; Collection owns its page-list inset, sharing
 * the content edge with the sections below it (07 S2: one edge for every section).
 */
const LibraryPageHeaderContext = React.createContext<React.ReactNode>(null);
const LibraryAccountTriggersContext = React.createContext(false);

function LibraryPageHeaderSlot() {
    return <>{React.useContext(LibraryPageHeaderContext)}</>;
}

/** A library with run strips and example maps is a collection page: the wide column (lab `nav-N1`). */
function renderLibraryPageScroller(children: React.ReactNode): React.ReactNode {
    return (
        <ItemList pageColumn="wide">
            <PageContentColumn>
                <LibraryPageHeaderSlot />
                {children}
                <LibraryAccountTriggersSlot />
                <WorkflowBuiltinsSection />
                {/* Secondary on a returning library: one compact row, the whole catalog one press away. */}
                <WorkflowExamplesSection presentation="strip" />
            </PageContentColumn>
        </ItemList>
    );
}

function LibraryAccountTriggersSlot() {
    return React.useContext(LibraryAccountTriggersContext) ? <AccountTriggersSection /> : null;
}

function useLibraryAnatomy(summaries: ReadonlyMap<string, WorkflowLibraryRunSummary> | null): CollectionAnatomy<LibraryRow> {
    const { theme } = useUnistyles();
    return React.useMemo(() => ({
        wrapItem: (row, children) => <WorkflowDefinitionDragRow row={row}>{children}</WorkflowDefinitionDragRow>,
        // The page row's one icon size, as on the Built-in and every other sheet below it.
        glyph: () => <Icon name="tree-structure" size={HAPPIER_PAGE_METRICS.rowIconGlyphPx} color={theme.colors.text.secondary} />,
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
    const mention = useEntityComposerMention();
    const scope = useActiveServerAccountScope();
    const commands = React.useContext(LibraryRowCommandsContext);
    const { theme } = useUnistyles();
    const owned = row.group === 'library';
    const unavailable = row.group !== 'fromPlugins' && row.definition.contentStatus === 'unavailable';
    const summary = row.group === 'fromPlugins' ? undefined : commands?.summaries?.get(row.definition.definitionId);
    const needsYouRunId = summary?.needsYouRunId ?? null;
    // A phone recomposes the row like the Sessions list's (lab `convo-N6b`): the state word stays on the
    // title line and the history strip, a wide-screen enrichment, is left out rather than wrapped beneath.
    const phone = useViewportClass() === 'compact';
    const showStrip = !phone && summary !== undefined && summary.recent.length > 0;
    return {
        busy: commands?.deleting.has(row.key) === true,
        accessoryWraps: !phone && (needsYouRunId !== null || showStrip),
        // The row's end (07 S2, lab `nav-N1`): the neutral run strip, **Needs you** when a run waits
        // (navigation only: the run's own page answers, M3). The row itself is the navigation target;
        // the shared Collection supplies its one trailing overflow control.
        accessory: (
            <View style={styles.rowAccessory}>
                {!showStrip || summary === undefined ? null : (
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
            </View>
        ),
        secondaryActionAccessibilityLabel: t('workflows.destination.rowMenu.accessibility'),
        secondaryActions: [
            ...(row.group !== 'fromPlugins' && scope ? [{ id: 'mentionInComposer', label: t('entityDragDrop.composer.mentionInComposer') }] : []),
            { id: 'run', label: t('workflows.destination.rowMenu.runNow'), disabled: unavailable },
            ...(owned ? [{ id: 'share', label: t('workflows.destination.rowMenu.share') }] : []),
            ...(row.group === 'fromPlugins' ? [] : [{ id: 'export', label: t('workflows.exportJson') }]),
            ...(owned ? [{ id: 'delete', label: t('common.delete'), destructive: true }] : []),
        ],
        onSecondaryAction: (id) => {
            if (id === 'mentionInComposer' && row.group !== 'fromPlugins' && scope) {
                void mention({ kind: 'workflow', scope, workflowId: row.definition.definitionId }, rowTitle(row));
                return;
            }
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

function WorkflowDefinitionDragRow(props: Readonly<{ row: LibraryRow; children: React.ReactNode }>) {
    const scope = useActiveServerAccountScope();
    const row = props.row;
    return <WorkspaceDestinationRow href={null} existingMenu entityTitle={rowTitle(row)}
        entityItem={scope && row.group !== 'fromPlugins' ? { kind: 'workflow', scope, workflowId: row.definition.definitionId } : null}>
        {props.children}
    </WorkspaceDestinationRow>;
}

function useLibraryRowCommands(summaries: ReadonlyMap<string, WorkflowLibraryRunSummary> | null, deletedDefinitionId: string | null): LibraryRowCommands {
    const router = useRouter();
    const scope = useActiveServerAccountScope();
    const admitted = React.useRef(new Set<string>());
    const retirement = React.useRef<Readonly<{ dispose(): void }> | null>(null);
    const [deleting, setDeleting] = React.useState<ReadonlySet<string>>(() => new Set());
    const [focusRequest, setFocusRequest] = React.useState<Readonly<{ key: string }>>();
    React.useEffect(() => { setFocusRequest(undefined); }, [deletedDefinitionId]);
    React.useEffect(() => () => retirement.current?.dispose(), []);
    return React.useMemo(() => ({
        deleting,
        focusRequest,
        summaries,
        openRun: (runId) => router.push(createWorkflowRunRoute(runId, scope?.serverId) as never),
        // A saved row holds an Artifact identity, not a reviewed machine or inputs: Run now opens the
        // exact revision in the editor, whose Run review admits the run.
        run: (definitionId) => router.push({ pathname: '/workflows/[id]', params: { id: definitionId, intent: 'run' } } as never),
        exportJson: (definitionId) => { void exportDefinition(definitionId); },
        share: (definition) => showDocumentShareSheet({
            kind: 'workflow-definition.v1', artifactId: definition.definitionId, name: formatWorkflowDefinitionLibraryTitle(definition),
            subtitle: definition.contentStatus === 'available'
                ? t('workflows.examples.stepCount', { count: definition.stepCount }) : t('common.unavailable'),
            linkPath: createWorkflowDefinitionRoute(definition.definitionId),
            // "Send a copy instead" is the existing JSON export (INT I2).
            onSendCopy: () => { void exportDefinition(definition.definitionId); },
        }),
        remove: (definitionId) => {
            const admissions = admitted.current;
            if (admissions.has(definitionId)) return;
            admissions.add(definitionId);
            void (async () => {
                const lifetime = captureActiveServerAccountScopeLifetime();
                try {
                    if (lifetime === null) return;
                    // Runtime reactivation may replace the Account lifetime without a render.
                    // Bind local operation/focus cleanup to the lifetime actually admitted.
                    retirement.current?.dispose();
                    retirement.current = lifetime.onRetire(() => {
                        if (admitted.current === admissions) admitted.current = new Set();
                        setDeleting(previous => previous.size === 0 ? previous : new Set());
                        setFocusRequest(undefined);
                    });
                    await deleteWorkflowDefinition({ definitionId, onTransportIssued: () => {
                        if (!lifetime.isCurrent()) return;
                        if (deletedDefinitionId !== null) dismissWorkflowLibraryDeletionReceipt(deletedDefinitionId);
                        setDeleting(previous => new Set([...previous, definitionId]));
                    } });
                } catch (error) {
                    // Deletion never retries by itself; the row stays and the person decides.
                    if (lifetime?.isCurrent()) {
                        if (error instanceof WorkflowActionError && isActionApprovalDeclinedErrorCode(error.rawCode)) {
                            setFocusRequest({ key: definitionId });
                            return;
                        }
                        await Modal.alertAsync(t('workflows.destination.deleteFailedTitle'), t('workflows.loadFailedBody'));
                        if (lifetime.isCurrent()) setFocusRequest({ key: definitionId });
                    }
                } finally {
                    admissions.delete(definitionId);
                    if (lifetime?.isCurrent()) setDeleting(previous => {
                        if (!previous.has(definitionId)) return previous;
                        const next = new Set(previous);
                        next.delete(definitionId);
                        return next;
                    });
                }
            })();
        },
    }), [router, scope?.serverId, summaries, deleting, focusRequest, deletedDefinitionId]);
}

async function exportDefinition(definitionId: string): Promise<void> {
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (lifetime === null) return;
    try {
        const exported = await exportSavedWorkflowDocument({ definitionId });
        if (!lifetime.isCurrent()) return;
        await confirmWorkflowDocumentExport({ name: exported.metadata.title, json: exported.json, isCurrent: lifetime.isCurrent });
    } catch {
        if (lifetime.isCurrent()) await Modal.alert(t('workflows.destination.exportFailedTitle'), t('workflows.loadFailedBody'));
    }
}

/**
 * First visit (lab `nav-N3`): show, guide, confirm. One primary, and a quiet way in for a file. The
 * examples use the same catalog as the returning home and column picker (08 §6).
 */
function WorkflowsFirstVisit(props: Readonly<{ onNewWorkflow: () => void; onImport: () => void; onCreateWithAgent: () => void; includeAccountTriggers?: boolean }>) {
    return (
        <ItemList pageColumn="wide">
            <PageContentColumn>
                <EmptyState
                    testID="workflows-home:firstVisit"
                    layout="page"
                    scene="noWorkflows"
                    title={t('workflows.destination.firstVisitTitle')}
                    subtitle={t('workflows.destination.firstVisitBody')}
                    primaryAction={{ label: t('workflows.newWorkflow'), onPress: props.onNewWorkflow, testID: 'workflows-home:firstVisit:new' }}
                    secondaryAction={{ label: t('workflows.authoring.create'), onPress: props.onCreateWithAgent, testID: 'workflows-home:firstVisit:agent' }}
                />
                {props.includeAccountTriggers ? <AccountTriggersSection /> : null}
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
            </PageContentColumn>
        </ItemList>
    );
}

const styles = StyleSheet.create((theme) => ({
    controlLine: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: theme.space.s8,
        paddingTop: HAPPIER_PAGE_METRICS.sectionHeaderGapPx,
        paddingHorizontal: HAPPIER_PAGE_METRICS.sheetInsetPx,
    },
    controlLineGrow: {
        flexGrow: 1,
    },
    // As on the Artifacts toolbar: the search gives up width first and takes its own line on a phone.
    search: {
        flexGrow: 1,
        flexShrink: 1,
        flexBasis: 160,
        maxWidth: 280,
    },
    // A phone gives the search its own full line under the views, on the sheets' edge (lab `phone-P*` search rows).
    searchPhone: {
        flexBasis: '100%',
    },
    rowAccessory: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s12,
    },
    headerActions: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        flexShrink: 1,
        minWidth: 0,
        maxWidth: '100%',
        alignItems: 'center',
        gap: theme.space.s8,
    },
    importLine: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: theme.space.s4,
        paddingBottom: theme.space.s20,
    },
    importPrompt: {
        ...Typography.variant('body'),
        color: theme.colors.text.secondary,
    },
}));
