import * as React from 'react';
import type { UsageAnalyticsBreakdownDimension } from '@happier-dev/protocol';
import type { UsageQueryResultSlice } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import { useAllMachines } from '@/sync/domains/state/storage';
import { getMachineDisplayName } from '@/utils/sessions/machineDisplayNames';
import { t } from '@/text';
import type { UsageWidgetPageContextState } from './useUsageWidgetPageContext';
import { toggleUsageScopeSelection } from './usageWidgetPageContext';
import { usageAgentTitle } from './widgets/usageBodyKit';

export const USAGE_SCOPE_FILTER_ALL = '\u0000all';
type ScopeField = 'sources' | 'agents' | 'machines' | 'projects';
const DIMENSION_OF: Readonly<Record<ScopeField, UsageAnalyticsBreakdownDimension>> = {
    sources: 'source', agents: 'agent', machines: 'machine', projects: 'project',
};
const FIELD_TITLE = { sources: 'usage.board.page.filterSources', agents: 'usage.board.page.filterAgents',
    machines: 'usage.board.page.filterMachines', projects: 'usage.board.page.filterProjects' } as const;

/** Current authorized facts and chosen values are the mounted page's supported filter inventory. */
function readScopeOptions(slices: readonly UsageQueryResultSlice[], field: ScopeField, selected: readonly string[]) {
    const labels = new Map<string, string>();
    for (const slice of slices) {
        for (const entry of slice.accounting?.breakdowns?.[DIMENSION_OF[field]] ?? []) {
            if (!labels.has(entry.key)) labels.set(entry.key, entry.label ?? entry.key);
        }
        if (field === 'sources') for (const source of slice.accounting?.coverage?.sources ?? []) {
            if (!labels.has(source.source)) labels.set(source.source, source.source);
        }
    }
    for (const value of selected) if (!labels.has(value)) labels.set(value, value);
    return labels;
}

export type UsageWidgetPageFilter = Readonly<{
    field: ScopeField;
    title: string;
    selected: readonly string[];
    options: readonly Readonly<{ id: string; label: string }>[];
    select(id: string): boolean;
}>;

/** One choice/toggle owner consumed by both the toolbar and mounted current-context commands. */
export function useUsageWidgetPageFilters(page: UsageWidgetPageContextState, slices: readonly UsageQueryResultSlice[], sessionScoped: boolean) {
    const machines = useAllMachines();
    const { scope, setScope } = page;
    return React.useMemo((): readonly UsageWidgetPageFilter[] => sessionScoped ? [] :
        (['sources', 'agents', 'machines', 'projects'] as const).map(field => {
            const selected = scope[field];
            const labels = readScopeOptions(slices, field, selected);
            const title = t(FIELD_TITLE[field]);
            const listed = [...labels.keys()];
            const options = [{ id: USAGE_SCOPE_FILTER_ALL, label: t('usage.board.page.filterAllOf', { what: title.toLocaleLowerCase() }) },
                ...[...labels].map(([id, fallback]) => {
                    const machine = field === 'machines' ? machines.find(candidate => candidate.id === id) : null;
                    return { id, label: field === 'agents' ? usageAgentTitle(id, fallback)
                        : machine ? getMachineDisplayName(machine) ?? id : fallback };
                })];
            return { field, title, selected, options, select: (id: string) => {
                if (id !== USAGE_SCOPE_FILTER_ALL && !labels.has(id)) return false;
                return setScope({ [field]: id === USAGE_SCOPE_FILTER_ALL ? [] : toggleUsageScopeSelection(selected, id, listed) });
            } };
        }), [machines, scope, setScope, sessionScoped, slices]);
}
