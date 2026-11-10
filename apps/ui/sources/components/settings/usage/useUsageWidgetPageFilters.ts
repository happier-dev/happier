import * as React from 'react';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import type { CurrentUiContextCommandInvocation } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { readUsageScopeOptions } from '@happier-dev/protocol/usage/usageFilterOptions';
import type { UsageQueryResultSlice } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import { useAllMachines } from '@/sync/domains/state/storage';
import { getMachineDisplayName, resolveMachineDisplayNames } from '@/utils/sessions/machineDisplayNames';
import { t } from '@/text';
import type { UsageWidgetPageContextState } from './useUsageWidgetPageContext';
import { toggleUsageScopeSelection } from './usageWidgetPageContext';
import { usageSourceAgentId } from '@/sync/domains/usage/usageLabels';
import { readUsageCoverageGaps, useUsageProjectAnchorOf, useUsageProjectNames, usageMachinePlace, usageAgentTitle, usageSourceTitle, usageCoverageDescription } from './widgets/usageBodyKit';
import { useUsageWidgetBatchInventorySelection } from './widgets/usageWidgetBatch';

export const USAGE_SCOPE_FILTER_ALL = '\u0000all';
// UI option only; persisted scope keeps every original Project key in the group.
const UNNAMED_PROJECT_OPTION = '\u0000unnamed-projects';
type ScopeField = 'sources' | 'agents' | 'machines' | 'projects';
const FIELD_TITLE = { sources: 'usage.board.page.filterSources', agents: 'usage.board.page.filterAgents',
    machines: 'usage.board.page.filterMachines', projects: 'usage.board.page.filterProjects' } as const;

/** A choice's name starts a line: source names are composed for mid-sentence use ("usage · Claude"). */
function sentenceCase(text: string): string {
    return text.charAt(0).toLocaleUpperCase() + text.slice(1);
}

export type UsageWidgetPageFilter = Readonly<{
    field: ScopeField;
    title: string;
    selected: readonly string[];
    /** `agentId`: the Agent a source belongs to. `partial`: this source has a coverage gap; its detail is said once, on "All". */
    options: readonly Readonly<{ id: string; label: string; subtitle?: string; agentId?: string; partial?: boolean }>[];
    select(id: string, callerContext?: ActionExecutorContext, invocation?: CurrentUiContextCommandInvocation): boolean | Promise<boolean>;
}>;

function sameFilter(left: UsageWidgetPageFilter, right: UsageWidgetPageFilter): boolean {
    return left.field === right.field && left.title === right.title
        && sameStrictJsonValue(left.selected, right.selected) && sameStrictJsonValue(left.options, right.options);
}

function sameFilters(left: readonly UsageWidgetPageFilter[], right: readonly UsageWidgetPageFilter[]): boolean {
    return left.length === right.length && left.every((filter, index) => sameFilter(filter, right[index]!));
}

const CAPTURE_KIND_KEY = {
    measured: 'usage.board.page.sourceKindMeasured',
    from_logs: 'usage.board.page.sourceKindFromLogs',
    not_added: 'usage.board.page.sourceKindNotAdded',
} as const;

/** One source's second line: the opened machines it was read on and how it is counted; unknown facts are left out. */
function sourceOptionDetail(slices: readonly UsageQueryResultSlice[], source: string, partial: boolean): { subtitle?: string; partial?: true } {
    const records = slices.flatMap(slice => (slice.accounting?.coverage?.sources ?? []).filter(record => record.source === source));
    const locations = [...new Set(records.flatMap(record => record.displayLocation ? [record.displayLocation] : []))];
    const kinds = [...new Set(records.flatMap(record => record.captureKind ? [t(CAPTURE_KIND_KEY[record.captureKind])] : []))];
    // One machine is named; several are counted, so the line never truncates mid-name.
    const where = locations.length === 1 ? locations : locations.length > 1 ? [t('usage.board.page.machinesCount', { count: locations.length })] : [];
    const facts = [...where, ...kinds];
    const subtitle = facts.length > 0 ? facts.join(' · ') : partial ? sentenceCase(t('usage.board.page.factIncomplete')) : undefined;
    return { ...(subtitle ? { subtitle } : {}), ...(partial ? { partial: true as const } : {}) };
}

/** One choice/toggle owner consumed by both the toolbar and mounted current-context commands. */
export function useUsageWidgetPageFilters(page: UsageWidgetPageContextState, fallbackSlices: readonly UsageQueryResultSlice[], sessionScoped: boolean,
    serverId: string) {
    // Usage stamped by a checkout before it joined a Project is offered under that Project (owner 11-08).
    const projectAnchorOf = useUsageProjectAnchorOf(serverId);
    const { scope, setScope } = page;
    const selectProjectFacts = React.useCallback((inventory: UsageQueryResultSlice | null) => {
        const slices = sessionScoped ? [] : inventory ? [inventory] : fallbackSlices;
        const locations = new Map<string, Set<string>>();
        for (const slice of slices) for (const row of slice.accounting?.contributions ?? []) {
            if (!row.projectKey || !row.machineId) continue;
            const key = projectAnchorOf.resolve(row.projectKey);
            const ids = locations.get(key) ?? new Set<string>();
            ids.add(row.machineId);
            locations.set(key, ids);
        }
        return [...readUsageScopeOptions(slices, 'projects', scope.projects, projectAnchorOf.resolve)]
            .map(([key, label]) => ({ key, label, machineIds: [...locations.get(key) ?? []] }));
    }, [sessionScoped, fallbackSlices, scope.projects, projectAnchorOf]);
    const projectFacts = useUsageWidgetBatchInventorySelection(selectProjectFacts, sameStrictJsonValue);
    const projectNames = useUsageProjectNames(serverId, projectFacts);
    const selectMachineIds = React.useCallback((inventory: UsageQueryResultSlice | null) => sessionScoped ? []
        : [...new Set([...readUsageScopeOptions(inventory ? [inventory] : fallbackSlices, 'machines', scope.machines).keys(),
            ...[...projectNames.machineIds.values()].flat()])], [sessionScoped, fallbackSlices, scope.machines, projectNames.machineIds]);
    const referencedMachineIds = useUsageWidgetBatchInventorySelection(selectMachineIds, sameStrictJsonValue);
    // Filters consume names, not Machine runtime/presence. Select the canonical
    // display strings so those publications cannot invalidate every chart's drill.
    const machineNames = useAllMachines(React.useCallback(machines => {
        if (sessionScoped) return {};
        const listed = new Set(machines.map(machine => machine.id));
        return Object.fromEntries(resolveMachineDisplayNames([...machines,
            ...referencedMachineIds.filter(id => !listed.has(id)).map(id => ({ id, absence: 'unlisted' as const }))]));
    }, [referencedMachineIds, sessionScoped]));
    const retained = React.useRef<Readonly<{ setScope: typeof setScope; filters: readonly UsageWidgetPageFilter[] }> | null>(null);
    const selectFilters = React.useCallback((inventory: UsageQueryResultSlice | null): readonly UsageWidgetPageFilter[] => {
        const slices = inventory ? [inventory] : fallbackSlices;
        return sessionScoped ? [] :
        (['sources', 'agents', 'machines', 'projects'] as const).map(field => {
            const scopeSelected = scope[field];
            const labels = readUsageScopeOptions(slices, field, scopeSelected, field === 'projects' ? projectAnchorOf.resolve : undefined);
            const title = t(FIELD_TITLE[field]);
            if (field === 'projects') {
                const groupId = (key: string) => projectNames.displayKey(projectAnchorOf.resolve(key)) ?? UNNAMED_PROJECT_OPTION;
                const groups = new Map<string, Set<string>>();
                for (const key of labels.keys()) {
                    const id = groupId(key);
                    // The ledger's null display group includes usage with no Project recorded.
                    // Select its existing HTTP operand even when the ranked inventory omits it.
                    const members = groups.get(id) ?? new Set<string>(id === UNNAMED_PROJECT_OPTION ? ['unknown'] : []);
                    members.add(projectAnchorOf.resolve(key));
                    groups.set(id, members);
                }
                const selected = [...new Set(scopeSelected.map(groupId))];
                const listed = [...groups.keys()];
                return { field, title, selected, options: [
                    { id: USAGE_SCOPE_FILTER_ALL, label: t('usage.board.page.filterAllOf', { what: title.toLocaleLowerCase() }) },
                    ...listed.map(id => ({ id, label: projectNames.label(id === UNNAMED_PROJECT_OPTION ? null : id),
                        subtitle: id === UNNAMED_PROJECT_OPTION ? undefined
                            : usageMachinePlace(projectNames.machineIds.get(id) ?? [], machineNames) || undefined })),
                ], select: (id: string, callerContext?: ActionExecutorContext) => {
                    if (id !== USAGE_SCOPE_FILTER_ALL && !groups.has(id)) return false;
                    const next = id === USAGE_SCOPE_FILTER_ALL ? [] : toggleUsageScopeSelection(selected, id, listed);
                    // Expand only a newly selected group; retain exact keys in existing selections,
                    // including a route that selected only part of the unnamed group.
                    const projects = next.length === 0 ? [] : [...new Set([
                        ...scopeSelected.filter(key => next.includes(groupId(key))),
                        ...(!selected.includes(id) && next.includes(id) ? groups.get(id) ?? [] : []),
                    ])].sort();
                    return setScope({ projects }, callerContext);
                } };
            }
            const selected = scopeSelected;
            const listed = [...labels.keys()];
            const gaps = field === 'sources' ? slices.flatMap(slice => readUsageCoverageGaps(slice, ['accounting'])) : [];
            const coverageDetail = field === 'sources' ? [...new Set(slices.map(slice => usageCoverageDescription(slice, ['accounting'])).filter(Boolean))].join(' · ') : '';
            const options = [{ id: USAGE_SCOPE_FILTER_ALL, label: t('usage.board.page.filterAllOf', { what: title.toLocaleLowerCase() }),
                ...(coverageDetail ? { subtitle: coverageDetail } : {}) },
                ...[...labels].map(([id, fallback]) => {
                    const sourceGap = gaps.find(gap => gap.source === id);
                    const sourceAgentId = field === 'sources' ? usageSourceAgentId(id) : null;
                    return { id, label: field === 'agents' ? usageAgentTitle(id, fallback)
                        : field === 'machines' ? machineNames[id] ?? getMachineDisplayName({ id, absence: 'unlisted' })
                        : sentenceCase(usageSourceTitle(id, fallback)),
                        ...(sourceAgentId ? { agentId: sourceAgentId } : {}),
                        // Where it was read and how it is counted (lab d2filter-SRC); coverage is said once, on
                        // "All sources", so a source with a gap carries the dot and, failing other facts, the short fact.
                        ...(field === 'sources' ? sourceOptionDetail(slices, id, sourceGap !== undefined) : {}) };
                })];
            return { field, title, selected, options, select: (id: string, callerContext?: ActionExecutorContext) => {
                if (id !== USAGE_SCOPE_FILTER_ALL && !labels.has(id)) return false;
                return setScope({ [field]: id === USAGE_SCOPE_FILTER_ALL ? [] : toggleUsageScopeSelection(selected, id, listed) }, callerContext);
            } };
        });
    }, [machineNames, projectAnchorOf, projectNames, scope, setScope, sessionScoped, fallbackSlices]);
    const filters = useUsageWidgetBatchInventorySelection(selectFilters, sameFilters);
    // Retain the rendered choices, rather than intermediate selector reads
    // that React can coalesce during one Resource publication.
    const previous = retained.current;
    const shared = previous?.setScope === setScope ? filters.map((filter, index) => {
        const prior = previous.filters[index];
        return prior && sameFilter(prior, filter) ? prior : filter;
    }) : filters;
    if (previous && previous.filters.length === shared.length && shared.every((filter, index) => filter === previous.filters[index])) return previous.filters;
    retained.current = { setScope, filters: shared };
    return shared;
}
