import * as React from 'react';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { readUsageScopeOptions } from '@happier-dev/protocol/usage/usageFilterOptions';
import type { UsageQueryResultSlice } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import { useAllMachines } from '@/sync/domains/state/storage';
import { getMachineDisplayName, resolveMachineDisplayNames } from '@/utils/sessions/machineDisplayNames';
import { t } from '@/text';
import type { UsageWidgetPageContextState } from './useUsageWidgetPageContext';
import { toggleUsageScopeSelection } from './usageWidgetPageContext';
import { usageSourceAgentId } from '@/sync/domains/usage/usageLabels';
import { readUsageCoverageGaps, usageAgentTitle, usageSourceTitle, usageCoverageDescription } from './widgets/usageBodyKit';

export const USAGE_SCOPE_FILTER_ALL = '\u0000all';
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
    select(id: string): boolean | Promise<boolean>;
}>;

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
export function useUsageWidgetPageFilters(page: UsageWidgetPageContextState, slices: readonly UsageQueryResultSlice[], sessionScoped: boolean) {
    const { scope, setScope } = page;
    const referencedMachineIds = React.useMemo(() => sessionScoped ? [] : [...readUsageScopeOptions(slices, 'machines', scope.machines).keys()], [sessionScoped, slices, scope.machines]);
    // Filters consume names, not Machine runtime/presence. Select the canonical
    // display strings so those publications cannot invalidate every chart's drill.
    const machineNames = useAllMachines(React.useCallback(machines => {
        if (sessionScoped) return {};
        const listed = new Set(machines.map(machine => machine.id));
        return Object.fromEntries(resolveMachineDisplayNames([...machines,
            ...referencedMachineIds.filter(id => !listed.has(id)).map(id => ({ id, absence: 'unlisted' as const }))]));
    }, [referencedMachineIds, sessionScoped]));
    const retained = React.useRef<Readonly<{ setScope: typeof setScope; filters: readonly UsageWidgetPageFilter[] }> | null>(null);
    return React.useMemo((): readonly UsageWidgetPageFilter[] => {
        const filters = sessionScoped ? [] :
        (['sources', 'agents', 'machines', 'projects'] as const).map(field => {
            const selected = scope[field];
            const labels = readUsageScopeOptions(slices, field, selected);
            const title = t(FIELD_TITLE[field]);
            const listed = [...labels.keys()];
            const gaps = field === 'sources' ? slices.flatMap(slice => readUsageCoverageGaps(slice, ['accounting'])) : [];
            const coverageDetail = field === 'sources' ? [...new Set(slices.map(slice => usageCoverageDescription(slice, ['accounting'])).filter(Boolean))].join(' · ') : '';
            const options = [{ id: USAGE_SCOPE_FILTER_ALL, label: t('usage.board.page.filterAllOf', { what: title.toLocaleLowerCase() }),
                ...(coverageDetail ? { subtitle: coverageDetail } : {}) },
                ...[...labels].map(([id, fallback]) => {
                    const sourceGap = gaps.find(gap => gap.source === id);
                    return { id, label: field === 'agents' ? usageAgentTitle(id, fallback)
                        : field === 'machines' ? machineNames[id] ?? getMachineDisplayName({ id, absence: 'unlisted' })
                        : field === 'sources' ? sentenceCase(usageSourceTitle(id, fallback))
                        : fallback,
                        ...(field === 'sources' && usageSourceAgentId(id) ? { agentId: usageSourceAgentId(id)! } : {}),
                        // Where it was read and how it is counted (lab d2filter-SRC); coverage is said once, on
                        // "All sources", so a source with a gap carries the dot and, failing other facts, the short fact.
                        ...(field === 'sources' ? sourceOptionDetail(slices, id, sourceGap !== undefined) : {}) };
                })];
            return { field, title, selected, options, select: (id: string) => {
                if (id !== USAGE_SCOPE_FILTER_ALL && !labels.has(id)) return false;
                return setScope({ [field]: id === USAGE_SCOPE_FILTER_ALL ? [] : toggleUsageScopeSelection(selected, id, listed) });
            } };
        });
        // Batch progress can change evidence without changing any offered
        // choice. Keep that progress out of every chart's shared drill context.
        const previous = retained.current;
        const shared = previous?.setScope === setScope ? filters.map((filter, index) => {
            const prior = previous.filters[index];
            return prior?.field === filter.field && prior.title === filter.title
                && sameStrictJsonValue(prior.selected, filter.selected) && sameStrictJsonValue(prior.options, filter.options)
                ? prior : filter;
        }) : filters;
        if (previous && previous.filters.length === shared.length && shared.every((filter, index) => filter === previous.filters[index])) return previous.filters;
        retained.current = { setScope, filters: shared };
        return shared;
    }, [machineNames, scope, setScope, sessionScoped, slices]);
}
