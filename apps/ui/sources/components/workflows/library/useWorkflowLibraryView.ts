import * as React from 'react';
import type { WorkflowPluginSourceV1 } from '@happier-dev/protocol/workflows';
import { getBuiltinWorkflowCatalogV1, type BuiltinWorkflowCatalogEntryV1 } from '@happier-dev/protocol/workflows/builtins/catalog';
import { hasWorkingWorkflowLibraryRun } from './workflowRunStrip';
import { useWorkflowDefinitionLibrary, type WorkflowLibraryDefinition } from './workflowLibraryReads';
import { useWorkflowLibrarySummaries, useWorkflowAutomationSummaries, type WorkflowLibraryRunSummary } from './useWorkflowLibrarySummaries';
import { projectWorkflowLibraryRecords, type WorkflowLibraryRecordRow } from './workflowLibraryCollection';
import { useWorkflowTriggerSets } from '../triggers/useWorkflowTriggerSets';
import { splitLibraryDefinitions } from '../column/workflowsColumnModel';
import type { WorkflowLibraryView } from '@happier-dev/protocol/actions/scopeActionFamily';
import { useActiveServerAccountScopeLifetime } from '@/sync/domains/state/storage';
import { registerWorkflowLibraryScopeActionOwner } from '@/sync/ops/actions/scopeActionFamily';
import { compileWorkflowListFilterV1, DEFAULT_WORKFLOW_LIST_FILTER_V1, WorkflowListFilterPatchV1Schema,
    workflowListFilterFieldsV1, type WorkflowListFilterV1, type WorkflowListFilterFactsV1 } from '@happier-dev/protocol/workflows/listing/workflowListFilterV1';
import { getUnsupportedEntityFilterFieldsV1 } from '@happier-dev/protocol/collections/filter/fieldRegistryV1';
import type { EntityListFilterResultV1 } from '@happier-dev/protocol/collections/filter/entityListFilterV1';
import { createCollectionSpaceDraftStore, useCollectionSpaceFilter } from '@/components/ui/lists/collection/useCollectionSpaceFilter';
import { t, tLoose, usePreferredLanguage } from '@/text';

export type { WorkflowLibraryView } from '@happier-dev/protocol/actions/scopeActionFamily';

export type WorkflowLibraryRow = WorkflowLibraryRecordRow | Readonly<{ key: string; group: 'fromPlugins'; plugin: WorkflowPluginSourceV1 }>
    /** Protocol's built-ins are filter rows like the others (R8-7); their sections render them, not the Collection. */
    | Readonly<{ key: string; group: 'builtin'; entry: BuiltinWorkflowCatalogEntryV1 }>;
export const workflowLibraryRowTitle = (row: WorkflowLibraryRow) => row.group === 'fromPlugins' ? row.plugin.title
    : row.group === 'builtin' ? tLoose(row.entry.titleKey) : row.name;

/** Adapt only facts already admitted by the library and its shared summary owner. */
export function workflowLibraryRowFilterFacts(row: WorkflowLibraryRow | Readonly<{ key: string; group: 'library' | 'sharedWithYou'; definition: WorkflowLibraryDefinition }>, summaries: ReadonlyMap<string, WorkflowLibraryRunSummary> | null): WorkflowListFilterFactsV1 {
    // Plugin and built-in workflows carry no Account triggers or library runs.
    if (row.group === 'fromPlugins' || row.group === 'builtin') return { triggered: false, running: false };
    if ('accountTrigger' in row) {
        const lastRun = row.lastRunSummary?.lastRun;
        return {
            triggered: row.accountTrigger.triggers.length > 0,
            ...(row.lastRunSummary ? { running: hasWorkingWorkflowLibraryRun({ recent: lastRun ? [{ ...lastRun, runId: lastRun.id }] : [] }) } : {}),
        };
    }
    const summary = summaries?.get(row.definition.definitionId);
    return {
        ...(row.definition.contentStatus === 'available' && row.definition.triggerSummaryErrorCode === undefined
            ? { triggered: row.definition.triggers.length > 0 } : {}),
        ...(summary ? { running: hasWorkingWorkflowLibraryRun(summary) } : {}),
    };
}

function resolveLibraryViews(rows: readonly WorkflowLibraryRow[], summaries: ReadonlyMap<string, WorkflowLibraryRunSummary> | null) {
    let triggered = false;
    let running = false;
    for (const row of rows) {
        const facts = workflowLibraryRowFilterFacts(row, summaries);
        triggered ||= facts.triggered === true;
        running ||= facts.running === true;
    }
    return ['all', ...(triggered ? ['triggered' as const] : []), ...(running ? ['running' as const] : [])] satisfies WorkflowLibraryView[];
}

/** The one Workflow draft every mounted library list narrows through (column and library home, R8-7). */
const workflowLibraryDraft = createCollectionSpaceDraftStore<'workflow'>();

/**
 * The Workflow library's rows and their one filter controller: saved, shared, plugin and built-in workflows
 * narrowed by the selected space, its added conditions and the free-text search. The Workflows column and
 * the library home both read it; presented columns and focused homes answer the same Workflow scope Actions.
 */
export function useWorkflowLibraryView(focused: boolean) {
    const language = usePreferredLanguage();
    const library = useWorkflowDefinitionLibrary({ enabled: focused });
    const accountWorkflows = useWorkflowTriggerSets(focused ? { scope: 'account_inline' } : null);
    const split = React.useMemo(() => splitLibraryDefinitions(library.definitions, library.pluginWorkflows), [library.definitions, library.pluginWorkflows]);
    // The same per-definition summary read for every reader (one request owner, shared demand).
    const summaryIds = React.useMemo(() => focused
        ? [...split.library, ...split.sharedWithYou].map((definition) => definition.definitionId) : [],
        [focused, split.library, split.sharedWithYou]);
    const { summaries } = useWorkflowLibrarySummaries(summaryIds);
    const automationIds = React.useMemo(() => focused ? accountWorkflows.sets.map(set => set.automationId) : [], [focused, accountWorkflows.sets]);
    const automationSummaries = useWorkflowAutomationSummaries(automationIds);
    const previousRecords = React.useRef<readonly WorkflowLibraryRecordRow[]>([]);
    const records = React.useMemo(() => {
        const next = projectWorkflowLibraryRecords({ definitions: split, accountTriggers: accountWorkflows.sets,
            summaries, automationSummaries: automationSummaries.summaries, previous: previousRecords.current });
        previousRecords.current = next;
        return next;
    },
        [split, accountWorkflows.sets, summaries, automationSummaries.summaries, language]);
    const libraryRows = React.useMemo(() => records.filter(row => row.group === 'library'), [records]);
    const libraryCount = libraryRows.length;
    const rows = React.useMemo((): readonly WorkflowLibraryRow[] => [
        ...records,
        ...split.fromPlugins.map(plugin => ({ key: plugin.workflow, group: 'fromPlugins' as const, plugin })),
        ...getBuiltinWorkflowCatalogV1().map(entry => ({ key: entry.id, group: 'builtin' as const, entry })),
    ], [records, split.fromPlugins]);
    const libraryRowCount = rows.length - getBuiltinWorkflowCatalogV1().length;
    const sourceCoverage: EntityListFilterResultV1['coverage'] = library.status === 'loading' && libraryRowCount === 0 ? 'unavailable'
        : library.hasMore || library.status !== 'loaded' || accountWorkflows.status !== 'ready' ? 'partial' : 'complete';
    const libraryIsEmpty = libraryRowCount === 0 && sourceCoverage === 'complete';
    const lifetime = useActiveServerAccountScopeLifetime();
    const binding = useCollectionSpaceFilter('workflow', { lifetime,
        defaultName: t('sessionsList.spacesAllWorkflows'), defaultFilter: DEFAULT_WORKFLOW_LIST_FILTER_V1, draft: workflowLibraryDraft });
    const { filters, searchQuery } = binding;
    const selectedSpaceId = binding.selectedSpaceId;
    const offeredViews = React.useMemo(() => resolveLibraryViews(rows, summaries), [rows, summaries]);
    const match = React.useMemo(() => compileWorkflowListFilterV1(filters), [filters]);
    const needle = searchQuery.trim().toLocaleLowerCase();
    const { visibleKeys, visibleKeySet, filterResult } = React.useMemo(() => {
        const visibleKeySet = new Set<string>();
        let unavailable = !binding.spacesReady || !binding.bound;
        for (const row of binding.bound ? rows : []) {
            if (needle.length > 0 && !workflowLibraryRowTitle(row).toLocaleLowerCase().includes(needle)) continue;
            const result = match(workflowLibraryRowFilterFacts(row, summaries));
            if (result === 'match') visibleKeySet.add(row.key);
            else if (result === 'unavailable') unavailable = true;
        }
        const coverage = unavailable ? visibleKeySet.size ? 'partial' : 'unavailable' : sourceCoverage;
        const filterResult: EntityListFilterResultV1 = { matchedCount: visibleKeySet.size, coverage };
        return { visibleKeys: [...visibleKeySet], visibleKeySet, filterResult };
    }, [binding.spacesReady, binding.bound, match, needle, rows, sourceCoverage, summaries]);
    const filter = React.useCallback((row: WorkflowLibraryRow) => visibleKeySet.has(row.key), [visibleKeySet]);
    const isVisible = React.useCallback((key: string) => visibleKeySet.has(key), [visibleKeySet]);
    const visibleLibraryRows = React.useMemo(() => libraryRows.filter(row => visibleKeySet.has(row.key)), [libraryRows, visibleKeySet]);
    const update = React.useCallback((patch: Readonly<{ filters?: Partial<WorkflowListFilterV1>; searchQuery?: string }>): boolean => {
        const nextFilters = patch.filters ? WorkflowListFilterPatchV1Schema.safeParse(patch.filters) : null;
        if (nextFilters && (!nextFilters.success || getUnsupportedEntityFilterFieldsV1(workflowListFilterFieldsV1, { ...DEFAULT_WORKFLOW_LIST_FILTER_V1, ...nextFilters.data }, 'list').length > 0)) return false;
        return binding.update({ ...(nextFilters?.success ? { filters: nextFilters.data } : {}), searchQuery: patch.searchQuery });
    }, [binding.update]);
    const reset = binding.reset;
    const setView = React.useCallback((view: WorkflowLibraryView) => { update({ filters: { view } }); }, [update]);
    const setSearchQuery = React.useCallback((searchQuery: string) => { update({ searchQuery }); }, [update]);
    const controller = { lifetime, focused, filters, selectedSpaceId, spaces: binding.spaces, selectedSpace: binding.selectedSpace,
        activeSpace: binding.activeSpace, spacesEnabled: binding.spacesEnabled,
        spacesReady: binding.spacesReady, spaceSettingsScope: binding.spaceSettingsScope,
        view: filters.view, searchQuery, offeredViews, visibleKeys, filterResult, filter, isVisible, needle, update, reset, setView, setSearchQuery,
        library, split, rows, summaries, accountWorkflows, automationSummaries, libraryRows, libraryCount, visibleLibraryRows,
        libraryCoverage: sourceCoverage, libraryIsEmpty };
    const latest = React.useRef(controller);
    React.useLayoutEffect(() => { latest.current = controller; });
    React.useEffect(() => focused && lifetime?.isCurrent()
        ? registerWorkflowLibraryScopeActionOwner(() => latest.current) : undefined, [focused, lifetime]);
    return controller;
}

export type WorkflowLibraryViewController = ReturnType<typeof useWorkflowLibraryView>;
