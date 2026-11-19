import * as React from 'react';
import type { CollectionConditionBindings } from '@happier-dev/plugin-ui/components';
import type { HappierCollectionGrouping, HappierCollectionWindow } from '@happier-dev/plugin-ui/presentation';
import {
    compileWorkflowRunListFilterV1, DEFAULT_WORKFLOW_RUN_LIST_FILTER_V1, workflowRunListFilterFieldsV1,
    type WorkflowRunListFilterFactsV1,
} from '@happier-dev/protocol/workflows/listing/workflowRunListFilterV1';
import type { EntityListFilterResultV1 } from '@happier-dev/protocol/collections/filter/entityListFilterV1';

import { createCollectionSpaceDraftStore, useCollectionSpaceFilter } from '@/components/ui/lists/collection/useCollectionSpaceFilter';
import { useCollectionSpaceHeader } from '@/components/ui/lists/collection/useCollectionSpaceHeader';
import { useWorkflowRunDisplayOptions } from '@/components/ui/lists/collection/useCollectionDisplayOptions';
import { useProjectAccountRows } from '@/sync/domains/state/storage';
import { buildProjectGroupDisplayIndex, projectGroupIdentityKey } from '@/sync/domains/workspaces/projectGroupDisplay';
import { createWorkflowRunListRowRoute } from '@/sync/domains/workflows/workflowRunRoute';
import type { WorkflowRunRow } from '@/sync/store/domains/workflowRuns';
import { usePluginSurfaceFocusEligibility } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { t, usePreferredLanguage } from '@/text';

import { describeWorkflowRunState } from '../presentation/workflowLifecyclePresentation';
import { formatWorkflowRunDisplayName, resolveWorkflowRunDisplayName } from '../presentation/workflowRunDisplayName';
import { useWorkflowRunWindow } from './workflowLibraryReads';
import { readWorkflowPluginDetails, useWorkflowListExtensions } from './useWorkflowListExtensions';

const runDraft = createCollectionSpaceDraftStore<'workflowRun'>();
const RUN_ICON = { kind: 'icon', name: 'list' } as const;
type GroupLabel = Readonly<{ key: string; title: string }>;
const DAY_MS = 86_400_000;
export type WorkflowRunCollectionRow = Readonly<{
    key: string;
    title: string;
    route: ReturnType<typeof createWorkflowRunListRowRoute>;
    run: WorkflowRunRow;
    facts: WorkflowRunListFilterFactsV1;
    date: GroupLabel;
    project: GroupLabel;
    workflow: GroupLabel;
    result: string | null;
    startedBy: string | null;
    createdAt: number | undefined;
}>;

const RUN_EXTENSION_FACTS = new Map<string, (row: WorkflowRunCollectionRow) => unknown>([
    ['result', row => row.facts.results],
    ['startedBy', row => row.facts.startedBy],
    ['createdAt', row => row.createdAt],
]);

/** Runs derives all row and filter facts from the already-held Account window and Project census. */
export function useWorkflowRunCollection(focused: boolean) {
    const runs = useWorkflowRunWindow('all', { demanded: focused });
    const binding = useCollectionSpaceFilter('workflowRun', { lifetime: runs.accountLifetime, draft: runDraft,
        defaultName: t('workflows.destination.allRuns'), defaultFilter: DEFAULT_WORKFLOW_RUN_LIST_FILTER_V1 });
    const display = useWorkflowRunDisplayOptions();
    const extensions = useWorkflowListExtensions('workflowRun', RUN_EXTENSION_FACTS);
    const census = useProjectAccountRows();
    const language = usePreferredLanguage();
    const projectDisplay = React.useMemo(() => census ? buildProjectGroupDisplayIndex(census.workspaceRefs, census.organizations) : null,
        [census?.workspaceRefs, census?.organizations]);
    const rows = React.useMemo(() => {
        const dateFormat = new Intl.DateTimeFormat(language, { dateStyle: 'medium' });
        const dates = new Map<string, GroupLabel>();
        const todayStart = new Date().setHours(0, 0, 0, 0);
        return runs.rows.map((run): WorkflowRunCollectionRow => {
            const { summary } = run;
            const title = formatWorkflowRunDisplayName(resolveWorkflowRunDisplayName(run.metadata));
            const workflowId = summary?.sourceArtifactId
                ?? (summary?.origin.kind === 'automation' ? summary.origin.automationId : run.automation?.automationId);
            const project = summary?.where && runs.serverId ? census?.sessionProjectKeyResolver?.({
                machineId: summary.where.machineId, path: summary.where.directory, workspaceId: summary.where.workspaceRefId,
            }, runs.serverId) : null;
            const projectKey = project?.kind === 'resolved' ? projectGroupIdentityKey(project.projectKey) : null;
            const projectTitle = projectKey === null ? null : projectDisplay?.get(projectKey)?.title;
            const startedBy = summary?.startedBy;
            const startedByLabel = startedBy == null ? null : t(`workflows.destination.display.starter.${startedBy}`);
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
            return {
                key: run.id, title, route: createWorkflowRunListRowRoute(run, runs.serverId), run, date,
                project: { key: projectKey ?? 'noProject', title: projectTitle ?? t('workflows.destination.sections.noProject') },
                workflow: { key: workflowId ?? 'noWorkflow', title: workflowId ? title : t('workflows.destination.display.noWorkflow') },
                result: result === undefined ? null : describeWorkflowRunState(result).label,
                startedBy: startedByLabel,
                createdAt,
                facts: {
                    workflows: workflowId,
                    results: result,
                    startedBy: startedBy ?? undefined,
                    projects: projectKey ?? (project?.kind === 'none' ? null : undefined),
                },
            };
        });
    }, [census?.sessionProjectKeyResolver, language, projectDisplay, runs.rows, runs.serverId]);
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
    const setSearchQuery = React.useCallback((searchQuery: string) => {
        binding.update({ searchQuery });
    }, [binding.update]);
    const readPluginDetail = React.useCallback((row: WorkflowRunCollectionRow, slot: 'context' | 'mark') =>
        readWorkflowPluginDetails(extensions.details, display.details, row, slot), [display.details, extensions.details]);
    return { rows, groups, filter, filterResult, window, runs, display, binding, focused, setSearchQuery, extensions, readPluginDetail };
}

export type WorkflowRunCollection = ReturnType<typeof useWorkflowRunCollection>;

export function useWorkflowRunCollectionHeader(model: WorkflowRunCollection, testIDPrefix: string, titleScale?: 'page' | 'section') {
    const focusEligible = usePluginSurfaceFocusEligibility();
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
            startedBy: { label: t('workflows.destination.display.startedBy'), valueOptions: options('startedBy', row => row.startedBy) },
            projects: { label: t('workflows.destination.display.project'), valueOptions: options('projects', row => row.project.title) },
        } };
    }, [model.rows]);
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
