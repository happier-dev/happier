import * as React from 'react';
import type { CollectionConditionBindings } from '@happier-dev/plugin-ui/components';
import type { HappierCollectionGrouping, HappierCollectionWindow } from '@happier-dev/plugin-ui/presentation';
import {
    compileWorkflowRunListFilterV1, DEFAULT_WORKFLOW_RUN_LIST_FILTER_V1, workflowRunListFilterFieldsV1,
    type WorkflowRunListFilterFactsV1,
} from '@happier-dev/protocol/workflows/listing/workflowRunListFilterV1';
import type { EntityListFilterResultV1 } from '@happier-dev/protocol/collections/filter/entityListFilterV1';
import { getUnsupportedEntityFilterFieldsV1 } from '@happier-dev/protocol/collections/filter/fieldRegistryV1';

import { createCollectionSpaceDraftStore, useCollectionSpaceFilter } from '@/components/ui/lists/collection/useCollectionSpaceFilter';
import { useSyncedAccountName } from '@/components/account/useSyncedAccountName';
import { formatAutomationRunCauseLabel } from '@/components/automations/list/automationListFormatting';
import { useCollectionSpaceHeader } from '@/components/ui/lists/collection/useCollectionSpaceHeader';
import { useWorkflowRunDisplayOptions } from '@/components/ui/lists/collection/useCollectionDisplayOptions';
import { useMachineDisplayNamesById, useProjectAccountRows, useSessionDisplayNameProjections } from '@/sync/domains/state/storage';
import { formatAccountDisplayName, resolveViewerAccountDisplayName } from '@/sync/domains/account/formatAccountDisplayName';
import { useDiscussionTitleProjections } from '@/sync/ops/discussions/useDiscussionRepositorySnapshot';
import { registerWorkflowViewScopeActionOwner, type WorkflowRunViewActionController } from '@/sync/ops/actions/scopeActionFamily';
import { projectGroupIdentityKey } from '@/sync/domains/workspaces/projectGroupDisplay';
import { createWorkflowRunListRowRoute } from '@/sync/domains/workflows/workflowRunRoute';
import type { WorkflowRunRow } from '@/sync/store/domains/workflowRuns';
import { usePluginSurfaceFocusEligibility } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { readableSessionDisplayTitle } from '@/utils/sessions/sessionDisplayTitle';
import { t, usePreferredLanguage } from '@/text';

import { resolveWorkStatusTone, type WorkStatusPresentation } from '@/components/work/status/resolveWorkStatusTone';
import { readWorkflowRunWorkStatusFacts } from '@/components/work/status/workflowWorkStatusFacts';
import { formatWorkflowRunDisplayName, resolveWorkflowRunDisplayName } from '../presentation/workflowRunDisplayName';
import { useWorkflowReferenceTitles } from '../presentation/workflowReferenceOptions';
import { useWorkflowTriggerSetsById } from '../triggers/useWorkflowTriggerSets';
import { useWorkflowSourcePeople } from '../useWorkflowSourcePeople';
import { resolveEditedByLabel } from '../run/workflowEditedBy';
import { describeAccountWorkflowLibraryRecord } from './workflowLibraryCollection';
import { useWorkflowRunWindow } from './workflowLibraryReads';
import { useWorkflowProjectGroupDisplay } from './workflowLibraryProjectGroups';
import { readCollectionPluginDetails, useCollectionListExtensions } from '@/components/ui/lists/collection/useCollectionListExtensions';

const runDraft = createCollectionSpaceDraftStore<'workflowRun'>();
const RUN_ICON = { kind: 'icon', name: 'list' } as const;
type GroupLabel = Readonly<{ key: string; title: string }>;
const DAY_MS = 86_400_000;
export type WorkflowRunCollectionRow = Readonly<{
    key: string;
    title: string;
    route: ReturnType<typeof createWorkflowRunListRowRoute>;
    run: WorkflowRunRow;
    facts: WorkflowRunListFilterFactsV1 & Readonly<{ startedBy: NonNullable<WorkflowRunRow['summary']>['startedBy'] }>;
    date: GroupLabel;
    project: GroupLabel;
    workflow: GroupLabel;
    result: string | null;
    status: WorkStatusPresentation | null;
    startedBy: string | null;
    /** Whose saved workflow this Run ran ("Set up by Mara"); a Run is not edited. */
    setUpBy: string | null;
    subject: string | null;
    createdAt: number | undefined;
}>;

const RUN_EXTENSION_FACTS = new Map<string, (row: WorkflowRunCollectionRow) => unknown>([
    ['result', row => row.facts.results],
    ['startedBy', row => row.facts.startedBy],
    ['createdAt', row => row.createdAt],
]);

/** Both Runs surfaces project the same Account window and admitted display facts. */
export function useWorkflowRunCollection(focused: boolean) {
    const runs = useWorkflowRunWindow('all', { demanded: focused });
    const binding = useCollectionSpaceFilter('workflowRun', { lifetime: runs.accountLifetime, draft: runDraft,
        defaultName: t('workflows.destination.allRuns'), defaultFilter: DEFAULT_WORKFLOW_RUN_LIST_FILTER_V1 });
    const display = useWorkflowRunDisplayOptions();
    const extensions = useCollectionListExtensions('workflowRun', RUN_EXTENSION_FACTS);
    const census = useProjectAccountRows();
    const language = usePreferredLanguage();
    const savedDefinitionIds = React.useMemo(() => runs.rows.flatMap(({ summary }) =>
        summary?.sourceArtifactId ? [summary.sourceArtifactId] : []), [runs.rows]);
    const savedWorkflowTitle = useWorkflowReferenceTitles(savedDefinitionIds, focused, runs.accountLifetime);
    // An inline Workflow's name comes from its own exact read, not the Account's whole inline inventory (HUNT3-1125).
    const inlineWorkflowIds = React.useMemo(() => runs.rows.flatMap(({ summary, automation }) => {
        if (summary?.sourceArtifactId) return [];
        const automationId = summary?.origin.kind === 'automation' ? summary.origin.automationId : automation?.automationId;
        return automationId ? [automationId] : [];
    }), [runs.rows]);
    const inlineSets = useWorkflowTriggerSetsById(inlineWorkflowIds, { demanded: focused });
    const inlineWorkflowTitles = React.useMemo(() => new Map([...inlineSets].map(([automationId, set]) => {
        const record = set === null ? null : describeAccountWorkflowLibraryRecord(set);
        return [automationId, record === null || record.sourceGone ? null : record.name] as const;
    })), [language, inlineSets]);
    const sources = React.useMemo(() => focused ? runs.rows.flatMap(({ summary }) => [
        summary?.sourceSavedBy,
        summary?.startedBy === 'user' ? { kind: 'person' as const, accountId: summary.ownerAccountId } : null,
    ]) : [], [focused, runs.rows]);
    const { profiles, viewerAccountId } = useWorkflowSourcePeople(sources, runs.accountLifetime);
    const viewerName = useSyncedAccountName(runs.accountLifetime?.scope ?? null)?.label;
    const subjectAddresses = React.useMemo(() => runs.rows.flatMap(({ id, summary }) => {
        const sessionId = summary?.origin.originSessionId;
        return sessionId ? [{ key: id, sessionId, serverId: runs.serverId }] : [];
    }), [runs.rows, runs.serverId]);
    const subjectTitles = useSessionDisplayNameProjections(subjectAddresses, readableSessionDisplayTitle);
    const subjects = React.useMemo(() => new Map(subjectAddresses.map(({ key }, index) => [key, subjectTitles[index] ?? null])),
        [subjectAddresses, subjectTitles]);
    const discussionAddresses = React.useMemo(() => runs.rows.flatMap(({ id, summary }) => {
        const discussion = summary?.origin.kind === 'direct' ? summary.origin.discussion?.discussion : undefined;
        return discussion ? [{ key: id, ...discussion }] : [];
    }), [runs.rows]);
    const discussionTitles = useDiscussionTitleProjections(discussionAddresses);
    const discussions = React.useMemo(() => new Map(discussionAddresses.map(({ key }, index) => [key, discussionTitles[index] ?? null])),
        [discussionAddresses, discussionTitles]);
    const projectDisplay = useWorkflowProjectGroupDisplay(census, focused);
    const rows = React.useMemo(() => {
        const dateFormat = new Intl.DateTimeFormat(language, { dateStyle: 'medium' });
        const dates = new Map<string, GroupLabel>();
        const todayStart = new Date().setHours(0, 0, 0, 0);
        return runs.rows.map((run): WorkflowRunCollectionRow => {
            const { summary } = run;
            const savedSourceTitle = summary?.sourceArtifactId ? savedWorkflowTitle(summary.sourceArtifactId) : null;
            const title = formatWorkflowRunDisplayName(
                resolveWorkflowRunDisplayName(run.metadata, undefined, savedSourceTitle), summary?.state,
            );
            const workflowId = summary?.sourceArtifactId
                ?? (summary?.origin.kind === 'automation' ? summary.origin.automationId : run.automation?.automationId);
            const project = summary?.where && runs.serverId ? census?.sessionProjectKeyResolver?.({
                machineId: summary.where.machineId, path: summary.where.directory, workspaceId: summary.where.workspaceRefId,
            }, runs.serverId) : null;
            const projectKey = project?.kind === 'resolved' ? projectGroupIdentityKey(project.projectKey) : null;
            const projectTitle = projectKey === null ? null : projectDisplay?.get(projectKey)?.title;
            const startedBy = summary?.startedBy;
            const cause = (summary?.origin.kind === 'automation' ? summary.origin.cause : undefined) ?? run.automation?.cause;
            const starterProfile = summary && profiles.get(summary.ownerAccountId)?.profile;
            const startedByLabel = startedBy === 'user' && summary
                ? summary.ownerAccountId === viewerAccountId ? resolveViewerAccountDisplayName(viewerName)
                    : (starterProfile && formatAccountDisplayName(starterProfile)) || t('accountDisplay.unnamed')
                : cause ? formatAutomationRunCauseLabel(cause)
                    : startedBy == null ? null : t(`workflows.destination.display.starter.${startedBy}`);
            const createdAtSource = summary?.createdAt ?? run.automation?.createdAt;
            const timestamp = createdAtSource === undefined ? NaN : new Date(createdAtSource).getTime();
            const createdAt = Number.isFinite(timestamp) ? timestamp : undefined;
            const day = createdAt === undefined ? null : new Date(createdAt);
            const dateKey = day ? String(day.setHours(0, 0, 0, 0)) : 'unknownDate';
            let date = dates.get(dateKey);
            if (!date) {
                // Today and Yesterday read as words (scene 8 Runs); older days keep their date.
                const dayStart = day ? day.getTime() : null;
                const title = dayStart === null ? t('workflows.destination.display.unknownDate')
                    : dayStart === todayStart ? t('sessionHistory.today')
                        : dayStart === todayStart - DAY_MS ? t('sessionHistory.yesterday') : dateFormat.format(day!);
                date = { key: dateKey, title };
                dates.set(dateKey, date);
            }
            const result = summary?.state ?? run.automation?.workflowRunState;
            const workflowTitle = summary?.sourceArtifactId
                ? savedSourceTitle
                : workflowId ? inlineWorkflowTitles.get(workflowId) : undefined;
            return {
                key: run.id, title, route: createWorkflowRunListRowRoute(run, runs.serverId), run, date,
                project: { key: projectKey ?? 'noProject', title: projectTitle ?? t('workflows.destination.sections.noProject') },
                workflow: { key: workflowId ?? 'noWorkflow', title: workflowTitle ?? (workflowId
                    ? `${t('workflows.destination.display.workflow')} · ${workflowId.slice(-8)}`
                    : t('workflows.destination.display.noWorkflow')) },
                result: result === undefined ? null : readWorkflowRunWorkStatusFacts({ state: result }).word,
                status: summary ? resolveWorkStatusTone({ kind: 'workflow_run', facts: readWorkflowRunWorkStatusFacts(summary) }) : null,
                startedBy: startedByLabel,
                setUpBy: resolveEditedByLabel({ savedBy: summary?.sourceSavedBy, viewerAccountId, viewerOwnSave: 'omit', wording: 'setUp',
                    profile: summary?.sourceSavedBy?.kind === 'person' ? profiles.get(summary.sourceSavedBy.accountId)?.profile : null }),
                subject: discussions.get(run.id) ?? subjects.get(run.id) ?? null,
                createdAt,
                facts: {
                    workflows: workflowId,
                    results: result,
                    startedBy: startedBy ?? undefined,
                    projects: projectKey ?? (project?.kind === 'none' ? null : undefined),
                    machineId: summary?.machineId,
                },
            };
        });
    }, [census?.sessionProjectKeyResolver, discussions, inlineWorkflowTitles, language, profiles, projectDisplay, runs.rows,
        runs.serverId, savedWorkflowTitle, subjects, viewerAccountId, viewerName]);
    const match = React.useMemo(() => compileWorkflowRunListFilterV1(binding.filters), [binding.filters]);
    const needle = binding.searchQuery.trim().toLocaleLowerCase();
    const { visible, filterResult } = React.useMemo(() => {
        const visible = new Set<string>();
        let unavailable = false;
        if (binding.bound) {
            for (const row of rows) {
                if (needle && !row.title.toLocaleLowerCase().includes(needle)) continue;
                const matches = match(row.facts);
                if (matches === 'match') visible.add(row.key);
                else if (matches === 'unavailable') unavailable = true;
            }
        }
        const coverage: EntityListFilterResultV1['coverage'] = !binding.bound || (rows.length === 0 && runs.status !== 'loaded') ? 'unavailable'
            : runs.hasMore || runs.status !== 'loaded' || unavailable ? 'partial' : 'complete';
        return { visible, filterResult: { matchedCount: visible.size, coverage } };
    }, [binding.bound, match, needle, rows, runs.hasMore, runs.status]);
    const filter = React.useCallback((row: WorkflowRunCollectionRow) => visible.has(row.key), [visible]);
    const groups = React.useMemo((): HappierCollectionGrouping<WorkflowRunCollectionRow> => {
        const groupBy = display.groupBy;
        const axis = [...new Map(rows.map(row => [row[groupBy].key, row[groupBy]])).values()];
        if (groupBy === 'date') axis.sort((a, b) => (Number(b.key) || 0) - (Number(a.key) || 0));
        else axis.sort((a, b) => a.title.localeCompare(b.title));
        return { axis, groupOf: row => row[groupBy].key };
    }, [display.groupBy, rows]);
    const window = React.useMemo((): HappierCollectionWindow => runs.hasMore
        ? { kind: 'partial', continuations: [{ key: 'more', label: runs.loadMoreFailed ? t('workflows.retry') : t('automations.detail.loadMoreRuns'),
            load: runs.loadMore, busy: runs.loadingMore }] }
        : { kind: 'complete' }, [runs.hasMore, runs.loadMore, runs.loadMoreFailed, runs.loadingMore]);
    const update = React.useCallback<WorkflowRunViewActionController['update']>((patch) => {
        if (patch.filters && getUnsupportedEntityFilterFieldsV1(workflowRunListFilterFieldsV1, patch.filters, 'list').length > 0) {
            return false;
        }
        return binding.update(patch);
    }, [binding.update]);
    const setSearchQuery = React.useCallback((searchQuery: string) => { update({ searchQuery }); }, [update]);
    // The Runs sidebar narrows the one run binding to one Workflow or one Machine (lab `queue:A` navigation column:
    // Workflows, Hosts & sandboxes), or back to all runs; one sidebar row is selected at a time. The whole next filter
    // replaces the draft (the binding's `setFilters`), so the other sidebar facet's key is removed, while the toolbar's
    // other filters stay.
    const { filters, setFilters } = binding;
    const selectNavigation = React.useCallback((target: Readonly<{ facet: WorkflowRunNavigationFacet; key: string }> | null) => {
        const { workflows: _workflows, machineId: _machineId, ...others } = filters;
        setFilters(target === null ? others : { ...others, [target.facet]: { include: [target.key], exclude: [] } });
    }, [filters, setFilters]);
    const lifetime = runs.accountLifetime;
    const actionController = {
        kind: 'run', focused, lifetime, searchQuery: binding.searchQuery, filters: binding.filters,
        selectedSpaceId: binding.selectedSpaceId, visibleKeys: visible, filterResult, update, reset: binding.reset,
    } satisfies WorkflowRunViewActionController;
    const latest = React.useRef<WorkflowRunViewActionController>(actionController);
    React.useLayoutEffect(() => { latest.current = actionController; });
    React.useEffect(() => focused && lifetime?.isCurrent()
        ? registerWorkflowViewScopeActionOwner(() => latest.current) : undefined, [focused, lifetime]);
    const readPluginDetail = React.useCallback((row: WorkflowRunCollectionRow, slot: 'context' | 'mark') =>
        readCollectionPluginDetails(extensions.details, display.details, row, slot), [display.details, extensions.details]);
    return { rows, groups, filter, filterResult, window, runs, display, binding, focused, setSearchQuery, selectNavigation, extensions, readPluginDetail };
}

export type WorkflowRunCollection = ReturnType<typeof useWorkflowRunCollection>;
/** The run facets the Runs sidebar narrows to one value. */
export type WorkflowRunNavigationFacet = 'workflows' | 'machineId';

export function useWorkflowRunCollectionHeader(model: WorkflowRunCollection, testIDPrefix: string, titleScale?: 'page' | 'section') {
    const focusEligible = usePluginSurfaceFocusEligibility();
    const machineIds = React.useMemo(() => model.rows.map(row => row.facts.machineId ?? undefined), [model.rows]);
    const machineNames = useMachineDisplayNamesById(machineIds, {
        serverId: model.runs.serverId ?? undefined, presented: model.focused && focusEligible,
    });
    const bindings = React.useMemo((): CollectionConditionBindings => {
        const options = (field: keyof WorkflowRunListFilterFactsV1, label: (row: WorkflowRunCollectionRow) => string | null) => {
            const choices = new Map<string, string>();
            for (const row of model.rows) {
                const value = row.facts[field];
                const title = label(row);
                if (typeof value === 'string' && title !== null && !choices.has(value)) choices.set(value, title);
            }
            return [...choices].map(([value, label]) => ({ value, label }));
        };
        return { fields: {
            workflows: { label: t('workflows.destination.display.workflow'), valueOptions: options('workflows', row => row.workflow.title) },
            results: { label: t('workflows.destination.display.result'), valueOptions: options('results', row => row.result) },
            startedBy: { label: t('workflows.destination.display.startedBy'), valueOptions: options('startedBy', row =>
                row.facts.startedBy ? t(`workflows.destination.display.starter.${row.facts.startedBy}`) : null) },
            projects: { label: t('workflows.destination.display.project'), valueOptions: options('projects', row => row.project.title) },
            machineId: { label: t('common.machine'), valueOptions: options('machineId', row =>
                (row.facts.machineId && machineNames[row.facts.machineId]) || t('machine.unnamedMachine')) },
        } };
    }, [machineNames, model.rows]);
    const readHeldFacts = React.useCallback(function* () {
        for (const row of model.rows) yield row.facts;
    }, [model.rows]);
    return useCollectionSpaceHeader({
        entityKind: 'workflowRun', testIDPrefix, defaultName: t('workflows.destination.allRuns'),
        view: model.binding, registry: workflowRunListFilterFieldsV1, bindings,
        result: model.filterResult, readHeldFacts, defaultIcon: RUN_ICON,
        keyboardEnabled: focusEligible && model.focused, ...(titleScale ? { titleScale } : {}),
    });
}
