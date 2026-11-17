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
import { readUsageAppCallsEnvironmentIds, usageAppCallsSourceId } from '@/sync/domains/usage/usageAppCallsSource';
import type { UsageAppEnvironment } from '@/sync/api/account/usageAppCallsAccounting';

export const USAGE_SCOPE_FILTER_ALL = '\u0000all';
// UI option only; persisted scope keeps every original Project key in the group.
const UNNAMED_PROJECT_OPTION = '\u0000unnamed-projects';
type ScopeField = 'sources' | 'agents' | 'machines' | 'projects' | 'environments';
const FIELD_TITLE = { sources: 'usage.board.page.filterSources', agents: 'usage.board.page.filterAgents',
    machines: 'usage.board.page.filterMachines', projects: 'usage.board.page.filterProjects',
    environments: 'usage.board.page.filterEnvironments' } as const;
/** The Sources chooser's exclusive "Show" choice (D33): Agents or Your apps, never both. */
export const USAGE_SOURCES_SHOW_AGENTS = '\u0000show:agents';
export const USAGE_SOURCES_SHOW_APPS = '\u0000show:apps';

/** A choice's name starts a line: source names are composed for mid-sentence use ("usage · Claude"). */
function sentenceCase(text: string): string {
    return text.charAt(0).toLocaleUpperCase() + text.slice(1);
}

export type UsageWidgetPageFilter = Readonly<{
    field: ScopeField;
    title: string;
    selected: readonly string[];
    /** `agentId`: the Agent a source belongs to. `partial`: this source has a coverage gap; its detail is said once, on "All".
     * `section: 'show'`: one of the exclusive Agents / Your apps choices that head the Sources chooser. */
    options: readonly Readonly<{ id: string; label: string; subtitle?: string; agentId?: string; partial?: boolean; section?: 'show' }>[];
    /** Sources only, when the viewer has apps: which side the page shows. */
    shown?: 'agents' | 'apps';
    /** The chip's value when the All / names / count rule cannot say it ("Your apps · billing-api"). */
    valueLabel?: string;
    select(id: string, callerContext?: ActionExecutorContext, invocation?: CurrentUiContextCommandInvocation): boolean | Promise<boolean>;
}>;

function sameFilter(left: UsageWidgetPageFilter, right: UsageWidgetPageFilter): boolean {
    return left.field === right.field && left.title === right.title && left.shown === right.shown && left.valueLabel === right.valueLabel
        && sameStrictJsonValue(left.selected, right.selected) && sameStrictJsonValue(left.options, right.options);
}

function sameFilters(left: readonly UsageWidgetPageFilter[], right: readonly UsageWidgetPageFilter[]): boolean {
    return left.length === right.length && left.every((filter, index) => sameFilter(filter, right[index]!));
}

// Rendered choices can survive later inventory reads. Create their callbacks outside
// the selector/render frame so they cannot retain its accounting slices or previous filters.
function createScopeSelection(field: Exclude<ScopeField, 'projects'>, selected: readonly string[], listed: readonly string[],
    setScope: UsageWidgetPageContextState['setScope']): UsageWidgetPageFilter['select'] {
    return (id, callerContext) => {
        if (id !== USAGE_SCOPE_FILTER_ALL && !listed.includes(id)) return false;
        return setScope({ [field]: id === USAGE_SCOPE_FILTER_ALL ? [] : toggleUsageScopeSelection(selected, id, listed) }, callerContext);
    };
}

function createProjectSelection(selectedKeys: readonly (readonly [string, string])[], selected: readonly string[],
    groups: ReadonlyMap<string, ReadonlySet<string>>, setScope: UsageWidgetPageContextState['setScope']): UsageWidgetPageFilter['select'] {
    const listed = [...groups.keys()];
    return (id, callerContext) => {
        if (id !== USAGE_SCOPE_FILTER_ALL && !groups.has(id)) return false;
        const next = id === USAGE_SCOPE_FILTER_ALL ? [] : toggleUsageScopeSelection(selected, id, listed);
        // Expand only a newly selected group; retain exact keys in existing selections,
        // including a route that selected only part of the unnamed group.
        const projects = next.length === 0 ? [] : [...new Set([
            ...selectedKeys.filter(([, group]) => next.includes(group)).map(([key]) => key),
            ...(!selected.includes(id) && next.includes(id) ? groups.get(id) ?? [] : []),
        ])].sort();
        return setScope({ projects }, callerContext);
    };
}

function showOptions(): UsageWidgetPageFilter['options'] {
    return [{ id: USAGE_SOURCES_SHOW_AGENTS, label: t('usage.board.page.sourcesAgents'), subtitle: t('usage.board.page.sourcesAgentsDetail'), section: 'show' },
        { id: USAGE_SOURCES_SHOW_APPS, label: t('usage.board.page.sourcesApps'), subtitle: t('usage.board.page.sourcesAppsDetail'), section: 'show' }];
}

/** Choosing Your apps shows every app Environment and leaves the Agents' scopes, which do not apply to apps. */
function showApps(environments: readonly UsageAppEnvironment[], setScope: UsageWidgetPageContextState['setScope'],
    callerContext?: ActionExecutorContext) {
    return setScope({ sources: environments.map(environment => usageAppCallsSourceId(environment.environmentId)),
        agents: [], machines: [], projects: [] }, callerContext);
}

/** Agents' Sources gain the Show choice; every other option keeps its own selection. */
export function withShowChoice(filter: UsageWidgetPageFilter, environments: readonly UsageAppEnvironment[],
    setScope: UsageWidgetPageContextState['setScope']): UsageWidgetPageFilter {
    return { ...filter, shown: 'agents', options: [...showOptions(), ...filter.options], select: (id, callerContext, invocation) =>
        id === USAGE_SOURCES_SHOW_APPS ? showApps(environments, setScope, callerContext)
            : id === USAGE_SOURCES_SHOW_AGENTS ? true : filter.select(id, callerContext, invocation) };
}

/**
 * Your apps (P7 J4): Sources names the apps (Project sources) and Environments the Environments of the chosen apps.
 * Both write the one `sources` scope: an empty choice means all, and the page never drops back to Agents by narrowing.
 */
export function createUsageAppFilters(environments: readonly UsageAppEnvironment[], selectedIds: readonly string[],
    setScope: UsageWidgetPageContextState['setScope']): readonly UsageWidgetPageFilter[] {
    const apps = [...new Map(environments.map(environment => [environment.projectSourceId,
        environment.projectName ?? environment.name])).entries()];
    const appIds = apps.map(([id]) => id);
    const selectedApps = [...new Set(environments.filter(environment => selectedIds.includes(environment.environmentId))
        .map(environment => environment.projectSourceId))];
    const shownApps = selectedApps.length === appIds.length ? [] : selectedApps;
    const inApps = (ids: readonly string[]) => environments.filter(environment => ids.length === 0 || ids.includes(environment.projectSourceId));
    const listedEnvironments = inApps(shownApps);
    const listedIds = listedEnvironments.map(environment => environment.environmentId);
    const selectedEnvironments = selectedIds.filter(id => listedIds.includes(id));
    const shownEnvironments = selectedEnvironments.length === listedIds.length ? [] : selectedEnvironments;
    const write = (ids: readonly string[], callerContext?: ActionExecutorContext) =>
        setScope({ sources: ids.map(usageAppCallsSourceId) }, callerContext);
    const appLabel = (id: string) => apps.find(([key]) => key === id)?.[1] ?? id;
    // The chooser checks every shown app; the chip names them through valueLabel, so "all" needs no All row here.
    const sources: UsageWidgetPageFilter = { field: 'sources', title: t(FIELD_TITLE.sources), shown: 'apps', selected: selectedApps,
        valueLabel: t('usage.board.page.sourcesAppsValue', { name: shownApps.length === 0 && apps.length > 1
            ? t('usage.board.page.filterAll') : shownApps.length === 1 || apps.length === 1 ? appLabel(shownApps[0] ?? appIds[0]!)
            : t('usage.board.page.filterCount', { count: shownApps.length }) }),
        options: [...showOptions(), ...apps.map(([id, label]) => ({ id, label,
            subtitle: environments.filter(environment => environment.projectSourceId === id).map(environment => environment.name).join(', ') }))],
        select: (id, callerContext) => {
            if (id === USAGE_SOURCES_SHOW_AGENTS) return setScope({ sources: [] }, callerContext);
            if (id === USAGE_SOURCES_SHOW_APPS) return true;
            if (!appIds.includes(id)) return false;
            return write(inApps(toggleUsageScopeSelection(shownApps, id, appIds)).map(environment => environment.environmentId), callerContext);
        } };
    const environmentsFilter: UsageWidgetPageFilter = { field: 'environments', title: t(FIELD_TITLE.environments), selected: shownEnvironments,
        options: [{ id: USAGE_SCOPE_FILTER_ALL, label: t('usage.board.page.filterAllOf', { what: t(FIELD_TITLE.environments).toLocaleLowerCase() }) },
            ...listedEnvironments.map(environment => ({ id: environment.environmentId, label: environment.name,
                ...(environment.projectName ? { subtitle: environment.projectName } : {}) }))],
        select: (id, callerContext) => {
            if (id !== USAGE_SCOPE_FILTER_ALL && !listedIds.includes(id)) return false;
            const next = id === USAGE_SCOPE_FILTER_ALL ? [] : toggleUsageScopeSelection(shownEnvironments, id, listedIds);
            return write(next.length === 0 ? listedIds : next, callerContext);
        } };
    return [sources, environmentsFilter];
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
    serverId: string, appEnvironments: readonly UsageAppEnvironment[] | null = null) {
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
        if (sessionScoped) return [];
        const apps = appEnvironments?.length ? appEnvironments : null;
        const appIds = readUsageAppCallsEnvironmentIds(scope.sources);
        if (apps && appIds) return createUsageAppFilters(apps, appIds, setScope);
        return (['sources', 'agents', 'machines', 'projects'] as const).map((field): UsageWidgetPageFilter => {
            const scopeSelected = scope[field];
            const labels = readUsageScopeOptions(slices, field, scopeSelected, field === 'projects' ? projectAnchorOf.resolve : undefined);
            const title = t(FIELD_TITLE[field]);
            if (field === 'projects') {
                const groupId = (key: string) => projectNames.displayKey(projectAnchorOf.resolve(key)) ?? UNNAMED_PROJECT_OPTION;
                const groups = new Map<string, Set<string>>();
                for (const key of labels.keys()) {
                    const id = groupId(key);
                    const members = groups.get(id) ?? new Set<string>();
                    members.add(projectAnchorOf.resolve(key));
                    groups.set(id, members);
                }
                const selectedKeys = scopeSelected.map(key => [key, groupId(key)] as const);
                const selected = [...new Set(selectedKeys.map(([, group]) => group))];
                const listed = [...groups.keys()];
                return { field, title, selected, options: [
                    { id: USAGE_SCOPE_FILTER_ALL, label: t('usage.board.page.filterAllOf', { what: title.toLocaleLowerCase() }) },
                    ...listed.map(id => ({ id, label: projectNames.label(id === UNNAMED_PROJECT_OPTION ? null : id),
                        subtitle: id === UNNAMED_PROJECT_OPTION ? undefined
                            : usageMachinePlace(projectNames.machineIds.get(id) ?? [], machineNames) || undefined })),
                ], select: createProjectSelection(selectedKeys, selected, groups, setScope) };
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
            const filter = { field, title, selected, options, select: createScopeSelection(field, selected, listed, setScope) };
            return apps && field === 'sources' ? withShowChoice(filter, apps, setScope) : filter;
        });
    }, [machineNames, projectAnchorOf, projectNames, scope, setScope, sessionScoped, fallbackSlices, appEnvironments]);
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
