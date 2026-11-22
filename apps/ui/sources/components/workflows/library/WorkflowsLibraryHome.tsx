import * as React from 'react';
import { showDocumentShareSheet } from '@/components/sharing/documents/showDocumentShareSheet';
import type { ShareSheetAnchor } from '@/components/sharing/presentShareSheet';
import { resolvePressTriggerAnchor } from '@/components/ui/popover/resolvePointerMenuAnchor';
import { View } from 'react-native';
import { WorkspaceDestinationRow } from '@/components/appShell/workspace/WorkspaceDestinationRow';
import { useEntityComposerMention } from '@/components/ui/treeDragDrop/useEntityComposerMention';
import { useEntityDragDropRuntime } from '@/components/ui/treeDragDrop/entityDragDropHooks';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
    HostCollection as Collection,
    useHappierCollection,
    type CollectionAnatomy,
    type CollectionField,
    type CollectionRowActions,
} from '@happier-dev/plugin-ui';
import { HAPPIER_PAGE_METRICS, type HappierCollectionWindow } from '@happier-dev/plugin-ui/presentation';
import { isActionApprovalDeclinedErrorCode } from '@happier-dev/protocol/actions/actionExecutionResult';

import { useGlobalSearchParams, useIsFocused, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { Icon } from '@/components/ui/icons/Icon';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { useViewportClass } from '@/utils/platform/useViewportClass';
import { PageContentColumn } from '@/components/ui/lists/PageContentColumn';
import { ItemList } from '@/components/ui/lists/ItemList';
import { CompactSearchField } from '@/components/ui/forms/CompactSearchField';
import { CollectionViewSwitch } from '@/components/ui/lists/collection/CollectionViewSwitch';
import { CollectionColumnsMenuButton, CollectionColumnsMenuTrigger, collectionColumnsMenuColumns } from '@/components/ui/lists/collection/CollectionColumnsMenu';
import { useCollectionDisplayOptions } from '@/components/ui/lists/collection/useCollectionDisplayOptions';
import { CoreCollectionScope } from '@/components/ui/lists/collection/CoreCollectionScope';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { ItemLoadStateRows, type ItemLoadState } from '@/components/ui/lists/ItemLoadStateRows';
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
import { t } from '@/text';

import { confirmWorkflowDocumentExport } from '../actions/confirmWorkflowDocumentExport';
import { WORKFLOWS_IMPORT_ROUTE, WORKFLOWS_NEW_ROUTE } from '../workflowsRoutes';
import { WorkflowsColumnCreationRefContext, useWorkflowsColumnHeadsPage, useWorkflowsColumnLentLibrary, useWorkflowsColumnOwnsCreation } from '../column/workflowsColumnCreation';
import {
    dismissWorkflowLibraryDeletionReceipt,
    useWorkflowRunWindow,
    type WorkflowLibraryDefinition,
} from './workflowLibraryReads';
import { WorkflowRunStripView } from './WorkflowRunStripView';
import { readCollectionPluginDetails, useCollectionListExtensions } from '@/components/ui/lists/collection/useCollectionListExtensions';
import { buildWorkflowLibraryCard, buildWorkflowLibraryFields, readWorkflowLibraryRowFacts, readWorkflowLibraryRowMarks, readWorkflowLineThree, readWorkflowRowStrip, resolveWorkflowRowDetails, workflowLibraryExtensionFacts, workflowRowDetailChoices,
    WorkflowLibraryStateWord, type WorkflowLibraryRowFacts } from './workflowLibraryCells';
import { WorkflowMarks } from '../presentation/WorkflowMarks';
import { WorkflowsViewGroupBy, WorkflowsViewNewSection, WorkflowsViewRowDetails } from './WorkflowsViewMenu';
import { WorkflowsLibraryHeaderActions } from './WorkflowsLibraryHeaderActions';
import { workflowLibraryProjectAxis } from './workflowLibraryProjectGroups';
import { WorkflowExamplesSection } from './WorkflowExamplesSection';
import { WorkflowBuiltinsSection } from './WorkflowBuiltinsSection';
import { useAppShellColumn } from '@/components/navigation/shell/appRail/appShellColumnContext';
import { useWorkflowAgentAuthoring } from '../authoring/useWorkflowAgentAuthoring';
import { buildWorkflowAgentAuthoringSeed } from '@/sync/domains/workflows/workflowAgentAuthoringSeed';
import { formatNextScheduledRun } from '../triggers/formatTriggerSummary';
import { isWorkflowTriggerSourceGone } from '../triggers/sessionTriggerGroups';
import { formatWorkflowDefinitionContentUnavailableReason, formatWorkflowDefinitionLibraryTitle } from '../presentation/workflowProblemPresentation';
import { AccountTriggersSection, useAccountWorkflowEditor } from '../triggers/AccountTriggersSection';
import { readSessionRouteServerId } from '@/hooks/session/sessionRouteServerScope';
import { AccountWorkflowRowAnchor, isAccountWorkflowOff, isAccountWorkflowReviewRequired,
    type AccountWorkflowLibraryRow } from './AccountWorkflowRowAnchor';
import { useWorkflowLibraryView, workflowLibraryRowTitle as rowTitle, type WorkflowLibraryRow } from './useWorkflowLibraryView';
import { resolveSessionSectionDisplayTitle } from '@/sync/domains/session/organization/sections';
import { useWorkflowLibrarySpaceHeader } from './useWorkflowLibrarySpaceHeader';
import { WorkflowLibraryFreshness } from './WorkflowLibraryFreshness';

/**
 * The Collection's rows: saved and Account Workflows (one Library, Q7), shared and plugin workflows.
 * Built-ins narrow with them but keep their own section.
 */
type LibraryRow = Exclude<WorkflowLibraryRow, Readonly<{ group: 'builtin' }>>;
const isAccountRow = (row: LibraryRow): row is AccountWorkflowLibraryRow => 'accountTrigger' in row;

/** An Account Workflow's settings editor and the openers its rows register, for the Collection's own press. */
type AccountWorkflowRows = Readonly<{
    editor: ReturnType<typeof useAccountWorkflowEditor>;
    register: (key: string, open: () => void) => () => void;
    deepLinkAutomationId: string | null;
}>;
const AccountWorkflowRowsContext = React.createContext<AccountWorkflowRows | null>(null);

/** The narrowest readable row at normal text size. */
const LIBRARY_MIN_WIDTH_PX = 320;
/** A workflow card holds its whole sentence (scene 8 D4): two cards to a row on a wide page, never three cramped ones. */
const WORKFLOW_CARD_MIN_WIDTH_PX = 360;
const WORKFLOWS_COLLECTION_ID = 'workflows.library';

type LibraryRowCommands = Readonly<{
    deleting: ReadonlySet<string>;
    focusRequest: Readonly<{ key: string }> | undefined;
    /** Opens the exact run the summary names as needing you, at its first actionable item. */
    openRun: (runId: string) => void;
    run: (definitionId: string) => void;
    exportJson: (definitionId: string) => void;
    /** Opens the one document share sheet (INT I2) for a workflow the caller owns (07 S7 Share). */
    share: (definition: WorkflowLibraryDefinition, anchor?: ShareSheetAnchor) => void;
    remove: (definition: WorkflowLibraryDefinition) => void;
    workflowSections: ReturnType<typeof useWorkflowLibraryView>['workflowSections'];
}>;

const LibraryRowCommandsContext = React.createContext<LibraryRowCommands | null>(null);

const LIBRARY_GROUPS = {
    get axis() {
        return [
            { key: 'library', title: t('workflows.destination.sections.library') },
            { key: 'account', title: t('settings.account') },
            { key: 'sharedWithYou', title: t('workflows.destination.sections.sharedWithYou') },
            // Read-only is a fact about the whole group, said once above it rather than on every row (F9).
            { key: 'fromPlugins', title: t('workflows.plugins.fromPlugins'), description: t('workflows.plugins.fromPluginsDescription') },
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
    const columnOwnsCreation = useWorkflowsColumnOwnsCreation();
    const columnHeadsPage = useWorkflowsColumnHeadsPage();
    const phone = useViewportClass() === 'compact';
    const focused = useIsFocused();
    // The one Workflow library controller (R8-7): the column beside this page narrows through the same draft. A phone's
    // main-screen head lends its own instance, and then owns the scope line and search (owner 11-11).
    const lent = useWorkflowsColumnLentLibrary();
    // The page's toolbar owns the one scope, filter and search, also beside the column (owner 2026-11-12: the column
    // is navigation and carries no second copy); only a phone's main-screen head lends its own.
    const ownLibraryView = useWorkflowLibraryView(focused && lent === null);
    const libraryView = lent?.libraryView ?? ownLibraryView;
    const { library, filter, needle, searchQuery: query } = libraryView;
    const columnListsBuiltins = useAppShellColumn().columnVisible;
    const spaceHeader = useWorkflowLibrarySpaceHeader(ownLibraryView, 'workflows-home-space', 'section');
    React.useEffect(() => {
        const definitionId = library.deletedDefinitionId;
        if (!focused || definitionId === null) return;
        return () => dismissWorkflowLibraryDeletionReceipt(definitionId);
    }, [focused, library.deletedDefinitionId]);
    const { libraryIsEmpty } = libraryView;
    // Only an empty library needs history to distinguish first visit from returning to it.
    const history = useWorkflowRunWindow('all', { enabled: libraryIsEmpty });
    const allRows = libraryView.rows;
    const rows = React.useMemo(() => allRows.filter((row): row is LibraryRow => row.group !== 'builtin'), [allRows]);
    const accountEditor = useAccountWorkflowEditor({ read: libraryView.accountWorkflows });
    const openers = React.useRef(new Map<string, () => void>());
    const register = React.useCallback((key: string, open: () => void) => {
        openers.current.set(key, open);
        return () => { if (openers.current.get(key) === open) openers.current.delete(key); };
    }, []);
    const params = useGlobalSearchParams<{ trigger?: string }>();
    const accountRows = React.useMemo((): AccountWorkflowRows => ({ editor: accountEditor, register,
        deepLinkAutomationId: typeof params.trigger === 'string' ? params.trigger : null }), [accountEditor, register, params.trigger]);
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
        if (key === null) return;
        // An Account Workflow opens its settings where its row stands; a saved one opens its editor.
        const openAccount = openers.current.get(key);
        if (openAccount) { openAccount(); return; }
        router.push(`/workflows/${encodeURIComponent(key)}` as never);
    }, [router]);
    const display = useCollectionDisplayOptions('workflow', phone);
    const projects = libraryView.projectsByWorkflow;
    const { workflowSections } = libraryView;
    const groups = React.useMemo(() => {
        const source = display.groupBy === 'source' ? LIBRARY_GROUPS : workflowLibraryProjectAxis(projects);
        const sectionGroups = new Map(workflowSections.sections.map(section => [section.address.sectionId, {
            key: `section:${section.address.sectionId}`, title: resolveSessionSectionDisplayTitle(section.display),
        }]));
        const groupOf = (row: LibraryRow) => {
            const folderId = 'definition' in row ? workflowSections.assignmentFor(row.definition.definitionId) : null;
            return (folderId ? sectionGroups.get(folderId)?.key : undefined) ?? source.groupOf(row);
        };
        // The page declares the groups its library holds, filtered or not: a library of its own workflows alone is one
        // section, titled beside its "Built-in" sibling (N38).
        const held = new Set(rows.map(groupOf));
        return {
            get axis() { return [...sectionGroups.values(), ...source.axis].filter((group) => held.has(group.key)); },
            groupOf,
        };
    }, [display.groupBy, projects, rows, workflowSections]);
    const model = useHappierCollection<LibraryRow>({
        items: rows,
        keyOf: readRowKey,
        groups,
        filter,
        window,
        openKey: null,
        onOpenChange: openDefinition,
    });
    const commands = useLibraryRowCommands(library.deletedDefinitionId, workflowSections);
    const { anatomy, pluginDetails } = useLibraryAnatomy(display.presentation, commands.openRun, display.lines, display.details);
    const groupOptions = <WorkflowsViewGroupBy groupBy={display.groupBy} onChange={display.setGroupBy} testIDPrefix="workflows-home:view:group" />;
    const newSectionOption = <WorkflowsViewNewSection onPress={workflowSections.create} testID="workflows-home:view:new-section" />;
    const [fittedColumns, setFittedColumns] = React.useState<readonly string[] | null>(null);
    const columns = React.useMemo(() => ({ collectionId: WORKFLOWS_COLLECTION_ID, onColumnsFit: setFittedColumns }), []);
    const menuColumns = React.useMemo(() => collectionColumnsMenuColumns(
        { id: 'title', title: t('workflows.destination.columns.workflow') }, anatomy.fields ?? [],
    ), [anatomy.fields]);
    const deleted = library.deletedDefinitionId !== null;
    // Built-ins share the filter but live outside this Collection's reachable focus rows.
    const visibleKeys = model.keys;
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
    const localCreationRef = React.useRef<import('@/keyboard/focusReturn').FocusReturnTarget>(null);
    const creationRef = React.useContext(WorkflowsColumnCreationRefContext) ?? localCreationRef;
    const setCreationRef = React.useCallback<NonNullable<React.ComponentProps<typeof RoundButton>['controlRef']>>(
        target => { creationRef.current = target; }, [creationRef]);
    React.useEffect(() => {
        if (deleted && deletionFocusRequest === undefined) restoreFocusToBestTarget(creationRef);
    }, [creationRef, deleted, deletionFocusRequest]);

    const newWorkflow = () => router.push(WORKFLOWS_NEW_ROUTE as never);
    const importWorkflow = () => router.pushRetainingCurrent(WORKFLOWS_IMPORT_ROUTE as never);
    const createWithAgent = () => openAgent(buildWorkflowAgentAuthoringSeed({ kind: 'create' }));

    // A `?trigger=` link opens its row's popover, so that row stays mounted wherever the page is scrolled.
    const deepLinkedRowKey = accountRows.deepLinkAutomationId === null ? null
        : rows.find((row) => isAccountRow(row) && row.accountTrigger.automationId === accountRows.deepLinkAutomationId)?.key ?? null;
    // A carried row's node is its drag source: unmounting it mid-drag would cancel the carry.
    const carriedRowKey = useCarriedWorkflowRowKey(rows);
    const retainedRowKeys = React.useMemo(() => {
        const keys = [deepLinkedRowKey, carriedRowKey].filter((key): key is string => key !== null);
        return keys.length === 0 ? undefined : keys;
    }, [carriedRowKey, deepLinkedRowKey]);

    const firstVisit = libraryIsEmpty && history.status === 'loaded' && history.rows.length === 0;
    if (firstVisit && !deleted) return <WorkflowsFirstVisit onNewWorkflow={newWorkflow} onImport={importWorkflow} onCreateWithAgent={createWithAgent} />;

    const search = <CompactSearchField testID="workflows-home:search" accessibilityLabel={t('workflows.destination.searchPlaceholder')}
        placeholder={t('workflows.destination.searchPlaceholder')} value={query} onChangeText={libraryView.setSearchQuery} style={phone ? styles.searchPhone : styles.search} />;
    // An empty deletion landing lends its real New workflow action to the header so focus never lands on BODY.
    const landingNeedsNew = deleted && deletionFocusRequest === undefined;
    const newWorkflowButton = <RoundButton
        testID="workflows-home:new"
        controlRef={setCreationRef}
        title={t('workflows.newWorkflow')}
        leading={<Icon name="plus" size={14} color={theme.colors.button.primary.tint} />}
        onPress={newWorkflow}
    />;
    const header = (<>
        {/* A wide page form's column heads the page with these same actions; only a phone lends its landing button. */}
        {columnHeadsPage ? (landingNeedsNew && phone ? <View style={styles.headerActions}>{newWorkflowButton}</View> : null) : <PageHeader
            testID="workflows-home:header"
            title={t('workflows.title')}
            description={t('workflows.destination.description')}
            actionsPlacement={landingNeedsNew ? 'page' : undefined}
            // The column normally owns phone creation; a wide page's New workflow ends its one toolbar (scene 8).
            actions={phone && (!columnOwnsCreation || landingNeedsNew) ? (
                <WorkflowsLibraryHeaderActions secondary={!columnOwnsCreation} controlRef={setCreationRef} />
            ) : undefined}
        />}
        {deleted ? <View testID="workflows-home:deleted-focus">
            <SurfaceStateCard testID="workflows-home:deleted" size="line" kind="success" title={t('common.deleted')}
                reason={library.deletedDefinitionTitle ?? t('navigation.automation')} accessibilitySemantics="status" />
        </View> : null}
        {/* The space header (R9, R8-7): the same title chevron, filter, strip and condition tokens as the column, over one draft. */}
        {/* A phone keeps the strip on the line of the title it belongs to; the search takes its own line below. */}
        {lent ? null : <>
        <View testID="workflows-home:scope-line" style={[styles.controlLine, phone ? styles.controlLinePhone : null]}>
            {spaceHeader.titleControl}
            {/* Scene 8's one toolbar: the space and its search lead; filters, view and the one primary action end the line. */}
            {phone ? null : search}
            {phone ? <View style={styles.spaceStripInline}>{spaceHeader.strip}</View> : <View style={styles.controlLineGrow} />}
            {spaceHeader.filterButton}
            {/* Scene 8's one View menu: Group by, then "Columns" in the table or "Row details" for cards (Lines are for lists: the phone's sheet;
                owner 2026-11-19), then New section. */}
            {display.presentation === 'table' ? <CollectionColumnsMenuButton
                testID="workflows-home:view"
                trigger="labelled"
                collectionId={WORKFLOWS_COLLECTION_ID}
                columns={menuColumns}
                fittedIds={fittedColumns}
                label={t('workflows.destination.columns.view')}
                beforeColumns={groupOptions}
                afterColumns={newSectionOption}
            /> : <CollectionColumnsMenuTrigger testID="workflows-home:view" trigger="labelled" label={t('workflows.destination.columns.view')}>
                {groupOptions}
                <WorkflowsViewRowDetails choices={workflowRowDetailChoices(display.details, pluginDetails)} onChange={display.setDetail}
                    testIDPrefix="workflows-home:view:detail" />
                {newSectionOption}
            </CollectionColumnsMenuTrigger>}
            {phone ? null : <CollectionViewSwitch presentation={display.preferredPresentation}
                onChange={display.setPresentation} testIDPrefix="workflows-home:presentation" />}
            {/* Beside the Workflows column its "+" carries Import and Create with an agent; the page keeps the one primary. */}
            {phone || columnHeadsPage ? null : <WorkflowsLibraryHeaderActions secondary={!columnListsBuiltins} controlRef={setCreationRef} />}
        </View>
        {phone ? <View style={styles.controlLine}>{search}</View> : <View style={styles.spaceStrip}>{spaceHeader.strip}</View>}
        {spaceHeader.conditionRow ? <View style={styles.spaceStrip}>{spaceHeader.conditionRow}</View> : null}
        {spaceHeader.overlays}
        </>}
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
    ) : needle.length > 0 && !libraryView.inventoryPending ? (
        <EmptyState
            testID="workflows-home:noMatch"
            layout="inline"
            iconName="magnifying-glass"
            title={t('workflows.destination.noMatch', { query: query.trim() })}
        />
    ) : library.status === 'loaded' && !libraryView.inventoryPending ? (
        // Nothing saved yet, but runs exist (else this is the first visit): say what goes here.
        <EmptyState
            testID="workflows-home:empty"
            layout="line"
            title={t('workflows.destination.libraryEmpty')}
        />
    ) : (
        // First load reserves the Library section's rows in their final shape, as the Workflows column does, so
        // the saved workflows land without a jump (never a lone "Loading…" line).
        // The empty slot already stands on the rows' edge, so the section adds no inset of its own.
        <ListPresentationProvider value="page" pageInsets="contained">
            <ItemGroup title={t('workflows.destination.sections.library')} constrainToContentWidth={false}>
                <ItemLoadStateRows testID="workflows-home:loading" state={LIBRARY_LOADING} rows={3} lines={2}
                    accessibilityLabel={t('common.loading')} />
            </ItemGroup>
        </ListPresentationProvider>
    );

    // Account rows can land before the saved library: only its failure is said beside them. Its first load adds
    // nothing, since the reserved rows bring their own Library title and the rows already stand under one.
    const libraryStateBesideRows = library.status === 'failed' && library.definitions.length === 0 && model.keys.length > 0;

    // The page's scroller stands above the Collection, so the library's rows window in it (`page-virtualized`).
    return (
        <LibraryRowCommandsContext.Provider value={commands}>
            <AccountWorkflowRowsContext.Provider value={accountRows}>
                <ItemList pageColumn="wide">
                    {/* The content column sits inside the Collection scope, so its sections and the rows take one inset. */}
                    <CoreCollectionScope renderPageScroller={passThroughPageScroller}>
                    <PageContentColumn>
                            {header}
                            {libraryStateBesideRows ? empty : null}
                            <Collection<LibraryRow>
                                testID="workflows-home:collection"
                                model={model}
                                anatomy={anatomy}
                                accessibilityLabel={t('workflows.title')}
                                presentation={display.presentation}
                                detail="none"
                                scroll={display.presentation === 'grid' ? 'page' : 'page-virtualized'}
                                // The column binding stays fixed for the mounted Collection (its column hook is chosen once):
                                // toggling it with the presentation crashed the Table ⇄ Cards switch. Cards declare no fields.
                                columns={columns}
                                minCardWidth={WORKFLOW_CARD_MIN_WIDTH_PX}
                                minListWidth={LIBRARY_MIN_WIDTH_PX}
                                minDetailWidth={LIBRARY_MIN_WIDTH_PX}
                                preferredListRatio={1}
                                useRowActions={useLibraryRowActions}
                                {...(focusRequest === undefined ? {} : { selection: { focusRequest } })}
                                {...(retainedRowKeys === undefined ? {} : { retainedRowKeys })}
                                empty={empty}
                            />
                        <WorkflowLibraryFreshness library={library} hasRows={library.definitions.length > 0} />
                        <AddressedAccountTriggersSlot />
                        <WorkflowBuiltinsSection isVisible={libraryView.isVisible} />
                        {/* Secondary on a returning library: one compact row, the whole catalog one press away. */}
                        <WorkflowExamplesSection presentation="strip" />
                    </PageContentColumn>
                    </CoreCollectionScope>
                </ItemList>
                {accountEditor.popover}
            </AccountWorkflowRowsContext.Provider>
        </LibraryRowCommandsContext.Provider>
    );
}

const passThroughPageScroller = (children: React.ReactNode) => children;

const LIBRARY_LOADING: ItemLoadState = { kind: 'loading' };

/** A retained link to another Home's trigger keeps that Home's own list and editor. */
function AddressedAccountTriggersSlot() {
    const params = useGlobalSearchParams<{ serverId?: string | string[] }>();
    return readSessionRouteServerId(params) ? <AccountTriggersSection /> : null;
}

function useLibraryAnatomy(
    presentation: 'table' | 'grid' | 'list',
    openRun: (runId: string) => void,
    lines: 1 | 2 | 3,
    details: Readonly<Record<string, boolean>> | undefined,
) {
    const table = presentation === 'table';
    // One facts reading per row identity, shared by every cell and card slot that draws it (the projection keeps rows' identity).
    const readFacts = React.useMemo(() => {
        const facts = new WeakMap<LibraryRow, WorkflowLibraryRowFacts>();
        return (row: LibraryRow) => {
            let read = facts.get(row);
            if (read === undefined) { read = readWorkflowLibraryRowFacts(row); facts.set(row, read); }
            return read;
        };
    }, []);
    const openRunRef = React.useRef(openRun);
    openRunRef.current = openRun;
    const rowDetails = React.useMemo(() => resolveWorkflowRowDetails(details), [details]);
    const readableFacts = React.useMemo(() => workflowLibraryExtensionFacts(readFacts), [readFacts]);
    const extensions = useCollectionListExtensions('workflow', readableFacts);
    const card = React.useMemo(() => {
        const base = buildWorkflowLibraryCard(readFacts, (runId) => openRunRef.current(runId), rowDetails);
        return {
            ...base,
            facts: (row: LibraryRow) => {
                const context = readCollectionPluginDetails(extensions.details, details, row, 'context');
                const mark = readCollectionPluginDetails(extensions.details, details, row, 'mark');
                return <>{base.facts?.(row)}{context || mark ? <Text variant="meta">{[context, mark].filter(Boolean).join(' · ')}</Text> : null}</>;
            },
        };
    }, [details, extensions.details, readFacts, rowDetails]);
    const nextRun = React.useMemo(() => [{
        key: 'nextRun',
        title: t('automations.detail.overview.nextRunTitle'),
        minWidth: 112,
        priority: 0,
        defaultHidden: true,
        render: row => !isAccountRow(row) && row.group !== 'fromPlugins' && row.definition.nextRunAt !== null
            ? formatNextScheduledRun(row.definition.nextRunAt) : null,
    }] satisfies readonly CollectionField<LibraryRow>[], []);
    // Scene 8 table order: Workflow, Uses, Trigger, Steps, Last run, Next run (opt-in), Last 8 runs, State.
    const fields = React.useMemo(() => {
        const [uses, trigger, steps, lastRun, recentRuns, state] = buildWorkflowLibraryFields(readFacts, (runId) => openRunRef.current(runId));
        return [uses!, trigger!, steps!, lastRun!, ...nextRun, recentRuns!, ...extensions.columns, state!];
    }, [extensions.columns, nextRun, readFacts]);

    const anatomy = React.useMemo((): CollectionAnatomy<LibraryRow> => ({
        wrapItem: (row, children) => isAccountRow(row) ? <AccountWorkflowHomeRow row={row}>{children}</AccountWorkflowHomeRow>
            : <WorkflowDefinitionDragRow row={row}>{children}</WorkflowDefinitionDragRow>,
        // Every saved row would repeat the same workflow glyph, so none draws one and the names start on the
        // sheet's text edge; the Built-in rows below, the same Collection row shape, keep their purpose marks (LIST-ICONS-1108).
        glyph: () => null,
        loadingGlyph: false,
        title: rowTitle,
        card,
        // A list row (a phone, a narrow page) at Lines 2 (scene 8 phone): the state word leads line 2 when it speaks, then
        // the trigger sentence; what it uses ends the title line and its recent runs end the row.
        byline: lines === 1 ? undefined : (row) => {
            const trigger = !rowDetails.trigger ? null
                : readFacts(row).triggerLine ?? (row.group === 'fromPlugins' ? row.plugin.description ?? null : null);
            const extension = readCollectionPluginDetails(extensions.details, details, row, 'context');
            return [trigger, extension].filter(Boolean).join(' · ') || null;
        },
        // Lines 3 (scene 8 "Lines × details"): the row's opt-in details on their own line.
        listDetail: lines === 3 && !table ? (row) => {
            const { start, end } = readWorkflowLineThree(row, readFacts(row), rowDetails, Date.now());
            return [start, end].filter(Boolean).join(' · ') || null;
        } : undefined,
        bylineLead: lines === 1 ? undefined : (row) => {
            const facts = readFacts(row);
            return facts.state === null ? null : <WorkflowLibraryStateWord state={facts.state} needsYouRunId={null}
                testID={`workflows-home:row:${row.key}:state`} />;
        },
        // A list row ends with its recent runs; a narrow table falls back to list rows, so it keeps the same end (the table
        // itself never draws a list fact, and a card draws the strip in its own foot).
        ...(presentation === 'grid' ? {} : {
            listFact: (row: LibraryRow) => {
                const strip = rowDetails.recentRuns ? readWorkflowRowStrip(readFacts(row)) : null;
                return strip === null ? null : <WorkflowRunStripView testID={`workflows-home:row:${row.key}:strip`} strip={strip} />;
            },
        }),
        // The marks end a list row's title line; a card draws them in its own foot.
        ...(table ? { fields } : presentation === 'grid' ? {} : {
            titleMeta: (row: LibraryRow) => {
                const facts = readFacts(row);
                return <>
                    {lines === 1 && facts.state ? <WorkflowLibraryStateWord state={facts.state} needsYouRunId={null} /> : null}
                    {rowDetails.icons ? <WorkflowMarks layout="cluster" marks={readWorkflowLibraryRowMarks(facts, row)} /> : null}
                    {details ? readCollectionPluginDetails(extensions.details, details, row, 'mark') : null}
                </>;
            },
        }),
        // A plugin row's read-only fact is its group's description, not a per-row note (F9). The table draws no Reason
        // column: its rows keep one height, so the reason follows the name on its line, quiet (UI refinements 21:44Z, 6b).
        ...(table ? { titleSuffix: readLibraryRowReason } : { reason: readLibraryRowReason }),
        accessibilityLabel: rowTitle,
        testID: (row) => `workflows-home:row:${row.key}`,
        columnTitles: { title: t('workflows.destination.columns.workflow') },
    }), [card, details, extensions.details, fields, lines, presentation, readFacts, rowDetails, table]);
    return { anatomy, pluginDetails: extensions.details };
}

/** Why a row can't run as it is: a legacy Account trigger to review, or a saved definition that can't be read. */
function readLibraryRowReason(row: LibraryRow): string | null {
    if (isAccountRow(row)) return isAccountWorkflowReviewRequired(row) ? t('workflows.triggers.legacy.reviewRequired') : null;
    if (row.group === 'fromPlugins') return null;
    return row.definition.contentStatus === 'unavailable'
        ? formatWorkflowDefinitionContentUnavailableReason(row.definition.contentUnavailableReason) : null;
}

function useLibraryRowActions(row: LibraryRow): CollectionRowActions {
    const accountRows = React.useContext(AccountWorkflowRowsContext);
    const definitionActions = useDefinitionRowActions(isAccountRow(row) ? null : row);
    if (definitionActions !== null || !isAccountRow(row)) return definitionActions!;
    // An Account Workflow's menu turns it on or off; its other settings are its row's own press.
    const off = isAccountWorkflowOff(row);
    const target = row.openTarget;
    if (isWorkflowTriggerSourceGone(row.accountTrigger)) return {
        busy: accountRows?.editor.pending.has(row.accountTrigger.automationId) === true,
        secondaryActionAccessibilityLabel: t('workflows.destination.rowMenu.accessibility'),
        secondaryActions: [{ id: 'remove', label: t('workflows.triggers.row.removeTrigger'), destructive: true }],
        onSecondaryAction: (id) => {
            if (id === 'remove') void accountRows?.editor.remove(target);
        },
    };
    return {
        busy: accountRows?.editor.pending.has(row.accountTrigger.automationId) === true,
        secondaryActionAccessibilityLabel: t('workflows.destination.rowMenu.accessibility'),
        secondaryActions: [{ id: 'toggle', label: t(off ? 'workflows.triggers.popover.turnOn' : 'workflows.triggers.popover.turnOff'),
            disabled: isAccountWorkflowReviewRequired(row) }],
        onSecondaryAction: (id) => {
            if (id === 'toggle') void accountRows?.editor.toggle(target, off);
        },
    };
}

/** A saved, shared or plugin row's own menu: Run now, Export JSON, and Delete for workflows you own. */
function useDefinitionRowActions(row: Exclude<LibraryRow, AccountWorkflowLibraryRow> | null): CollectionRowActions | null {
    const mention = useEntityComposerMention();
    const scope = useActiveServerAccountScope();
    const commands = React.useContext(LibraryRowCommandsContext);
    if (row === null) return null;
    const owned = row.group === 'library';
    const unavailable = row.group !== 'fromPlugins' && row.definition.contentStatus === 'unavailable';
    return {
        busy: commands?.deleting.has(row.key) === true,
        secondaryActionAccessibilityLabel: t('workflows.destination.rowMenu.accessibility'),
        secondaryActions: [
            ...(row.group !== 'fromPlugins' && scope ? [{ id: 'mentionInComposer', label: t('entityDragDrop.composer.mentionInComposer') }] : []),
            ...(row.group !== 'fromPlugins' && commands?.workflowSections.assignmentFor(row.definition.definitionId) !== undefined
                ? [{ id: 'moveToSection', label: t('sessionsList.moveToFolder') }] : []),
            { id: 'run', label: t('workflows.destination.rowMenu.runNow'), disabled: unavailable },
            ...(owned ? [{ id: 'share', label: t('workflows.destination.rowMenu.share') }] : []),
            ...(row.group === 'fromPlugins' ? [] : [{ id: 'export', label: t('workflows.exportJson') }]),
            ...(owned ? [{ id: 'delete', label: t('common.delete'), destructive: true }] : []),
        ],
        onSecondaryAction: (id, selection) => {
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
            else if (id === 'moveToSection') void commands.workflowSections.move(definitionId, rowTitle(row));
            else if (id === 'share') commands.share(row.definition, resolvePressTriggerAnchor({ currentTarget: selection?.anchorRef?.current }));
            else if (id === 'export') commands.exportJson(definitionId);
            else if (id === 'delete') commands.remove(row.definition);
        },
    };
}

/** An Account Workflow's row hangs its settings from itself; the Collection's press reaches it through its opener. */
function AccountWorkflowHomeRow(props: Readonly<{ row: AccountWorkflowLibraryRow; children: React.ReactNode }>) {
    const accountRows = React.useContext(AccountWorkflowRowsContext);
    if (accountRows === null) return <>{props.children}</>;
    return <AccountWorkflowRowAnchor row={props.row} editor={accountRows.editor} register={accountRows.register}
        deepLink={accountRows.deepLinkAutomationId === props.row.accountTrigger.automationId}>
        {() => props.children}
    </AccountWorkflowRowAnchor>;
}

/** The saved row now being carried. Reads only that row's key, so pointer frames and other drags publish nothing here. */
function useCarriedWorkflowRowKey(rows: readonly LibraryRow[]): string | null {
    const runtime = useEntityDragDropRuntime();
    const workflowId = React.useSyncExternalStore(runtime.subscribe, () => {
        const { phase, item } = runtime.getSnapshot();
        return (phase === 'carrying' || phase === 'pending') && item?.kind === 'workflow' ? item.workflowId : null;
    }, () => null);
    if (workflowId === null) return null;
    return rows.find(row => !isAccountRow(row) && row.group !== 'fromPlugins' && row.definition.definitionId === workflowId)?.key ?? null;
}

function WorkflowDefinitionDragRow(props: Readonly<{ row: Exclude<LibraryRow, AccountWorkflowLibraryRow>; children: React.ReactNode }>) {
    const scope = useActiveServerAccountScope();
    const row = props.row;
    return <WorkspaceDestinationRow href={null} existingMenu entityTitle={rowTitle(row)}
        entityItem={scope && row.group !== 'fromPlugins' ? { kind: 'workflow', scope, workflowId: row.definition.definitionId } : null}>
        {props.children}
    </WorkspaceDestinationRow>;
}

function useLibraryRowCommands(deletedDefinitionId: string | null, workflowSections: LibraryRowCommands['workflowSections']): LibraryRowCommands {
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
        workflowSections,
        openRun: (runId) => router.push(createWorkflowRunRoute(runId, scope?.serverId) as never),
        // A saved row holds an Artifact identity, not a reviewed machine or inputs: Run now opens the
        // exact revision in the editor, whose Run review admits the run.
        run: (definitionId) => router.push({ pathname: '/workflows/[id]', params: { id: definitionId, intent: 'run' } } as never),
        exportJson: (definitionId) => { void exportDefinition(definitionId); },
        share: (definition, anchor) => showDocumentShareSheet({
            ...(anchor ? { anchor } : {}),
            kind: 'workflow-definition.v1', artifactId: definition.definitionId, name: formatWorkflowDefinitionLibraryTitle(definition),
            subtitle: definition.contentStatus === 'available'
                ? t('workflows.examples.stepCount', { count: definition.stepCount }) : t('common.unavailable'),
            linkPath: createWorkflowDefinitionRoute(definition.definitionId),
            // "Send a copy instead" is the existing JSON export (INT I2).
            onSendCopy: () => { void exportDefinition(definition.definitionId); },
        }),
        remove: (definition) => {
            const definitionId = definition.definitionId;
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
                    await deleteWorkflowDefinition({ definitionId,
                        ...(definition.metadata?.title === undefined ? {} : { title: definition.metadata.title }),
                        onTransportIssued: () => {
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
    }), [router, scope?.serverId, deleting, focusRequest, deletedDefinitionId, workflowSections]);
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
function WorkflowsFirstVisit(props: Readonly<{ onNewWorkflow: () => void; onImport: () => void; onCreateWithAgent: () => void }>) {
    return (
        <ItemList pageColumn="wide">
            <PageContentColumn>
                <EmptyState
                    testID="workflows-home:firstVisit"
                    layout="page"
                    namesPage
                    scene="noWorkflows"
                    title={t('workflows.destination.firstVisitTitle')}
                    subtitle={t('workflows.destination.firstVisitBody')}
                    primaryAction={{ label: t('workflows.newWorkflow'), onPress: props.onNewWorkflow, testID: 'workflows-home:firstVisit:new' }}
                    secondaryAction={{ label: t('workflows.authoring.create'), onPress: props.onCreateWithAgent, testID: 'workflows-home:firstVisit:agent' }}
                />
                {/* The examples lead, followed by the standalone Built-in section. */}
                <WorkflowExamplesSection presentation="featured" />
                <WorkflowBuiltinsSection />
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
    // The spaces strip starts under the space title's first letter, on the sheets' edge.
    spaceStrip: {
        paddingHorizontal: HAPPIER_PAGE_METRICS.sheetInsetPx,
        paddingTop: theme.space.s8,
    },
    controlLineGrow: {
        flexGrow: 1,
    },
    controlLinePhone: {
        flexWrap: 'nowrap',
    },
    spaceStripInline: {
        flex: 1,
        minWidth: 0,
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
