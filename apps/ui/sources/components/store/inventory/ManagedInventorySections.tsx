import * as React from 'react';
import { useHappierCollection } from '@happier-dev/plugin-ui/components';
import type { SettingsCollectionFilter } from '@/components/settings/shell/settingsCollectionAdapter';
import { useSettingsColumnFilter, type SettingsColumnFilterField } from '@/components/settings/shell/useSettingsColumnFilter';
import type { StoreInstalledInput } from '../catalog/storeKinds';
import type { ManagedInventoryView, ManagedInventoryRow as InstalledRow } from './useManagedInventory';
import { inventoryColumnAdapter, inventoryMachineKey, matchesInventoryQuery, presentInventoryAttention, presentInventoryRows,
    type ManagedInventoryField, type ManagedInventoryRowPresentation } from './inventoryRows';

export type ManagedInventoryGroupBy = 'kind' | 'machine' | 'project';
type AllFamilies = ManagedInventoryView['families'] & ManagedInventoryView['operationalFamilies'];
type FamilySection = { [Kind in keyof AllFamilies]: Readonly<{ kind: Kind; result: AllFamilies[Kind] }> }[keyof AllFamilies];
export type ManagedInventorySectionsState = Readonly<{
    rows: readonly InstalledRow[];
    presentations: ReadonlyMap<string, ManagedInventoryRowPresentation>;
    /** Empty unavailable/loading/partial families remain present, with their original reason and continuation. */
    families: readonly FamilySection[];
    groups: readonly Readonly<{ key: string; rows: readonly InstalledRow[] }>[];
    collection: ReturnType<typeof useHappierCollection<InstalledRow>>;
    attention: ManagedInventoryView['attention'];
    noticeSource: ManagedInventoryView['noticeSource'];
}>;
export type ManagedInventoryDraft = Readonly<{
    query: string; setQuery: (query: string) => void;
    filters: SettingsCollectionFilter; setFilters: React.Dispatch<React.SetStateAction<SettingsCollectionFilter>>;
}>;
type SectionsProps = Readonly<{
    inventory: ManagedInventoryView;
    input: StoreInstalledInput;
    groupBy: ManagedInventoryGroupBy;
    query?: string;
    matches?: (key: string) => boolean;
    matchesAttention?: (entry: ManagedInventoryView['attention'][number]) => boolean;
    presentations?: ReadonlyMap<string, ManagedInventoryRowPresentation>;
    openKey: string | null;
    onOpenChange: (key: string | null) => void;
    children: (state: ManagedInventorySectionsState) => React.ReactNode;
}>;
const keyOf = (row: InstalledRow) => row.key;

/** One Collection lifetime for both doors and every grouping. S50-UI supplies the shared anatomy slots. */
export function ManagedInventorySections(props: SectionsProps): React.ReactNode {
    const presentations = React.useMemo(() => props.presentations ?? presentInventoryRows(props.inventory.rows, props.input, props.inventory.attention),
        [props.inventory.rows, props.inventory.attention, props.input, props.presentations]);
    const normalized = (props.query ?? '').trim().toLocaleLowerCase();
    const filter = React.useCallback((row: InstalledRow) => {
        const facts = presentations.get(row.key)!.facts;
        return (!props.matches || props.matches(row.key)) && matchesInventoryQuery(facts, props.query ?? '');
    }, [presentations, props.matches, props.query]);
    const collection = useHappierCollection({ items: props.inventory.rows, keyOf, filter,
        selection: 'none', openKey: props.openKey, onOpenChange: props.onOpenChange });
    const rows = React.useMemo(() => collection.sections.flatMap(section => section.items), [collection.sections]);
    const families = React.useMemo<readonly FamilySection[]>(() => {
        const native = props.inventory.families;
        const sections = {
            app: { kind: 'app', result: native.app },
            browserExtension: { kind: 'browserExtension', result: native.browserExtension },
            software: { kind: 'software', result: native.software },
            setup: { kind: 'setup', result: props.inventory.operationalFamilies.setup },
            watchedService: { kind: 'watchedService', result: props.inventory.operationalFamilies.watchedService },
            configuredCheck: { kind: 'configuredCheck', result: props.inventory.operationalFamilies.configuredCheck },
            mcpServer: { kind: 'mcpServer', result: native.mcpServer }, agent: { kind: 'agent', result: native.agent },
            skill: { kind: 'skill', result: native.skill }, provider: { kind: 'provider', result: native.provider },
            plugin: { kind: 'plugin', result: native.plugin },
        } satisfies { [Kind in keyof AllFamilies]: Extract<FamilySection, { kind: Kind }> };
        return Object.values(sections).filter(section => section.result.coverage !== 'available' || section.result.rows.length > 0
            || section.result.continuation !== undefined);
    }, [props.inventory.families, props.inventory.operationalFamilies]);
    const groups = React.useMemo(() => {
        const groups = new Map<string, InstalledRow[]>();
        for (const row of rows) {
            const native = presentations.get(row.key)!;
            const keys = props.groupBy === 'kind' ? [row.kind] : props.groupBy === 'machine'
                ? native.machines?.map(machine => inventoryMachineKey(row.scope, machine)) ?? null : native.projects;
            for (const key of keys === null ? ['unassigned'] : keys.length ? keys : ['account']) {
                const members = groups.get(key);
                if (members) members.push(row); else groups.set(key, [row]);
            }
        }
        return [...groups].map(([key, rows]) => ({ key, rows }));
    }, [presentations, props.groupBy, rows]);
    const keys = new Set(rows.map(keyOf));
    const attention = props.inventory.attention.filter(entry => {
        const row = 'row' in entry ? entry.row : undefined;
        if (row) return keys.has(row.key);
        if (props.matchesAttention && !props.matchesAttention(entry)) return false;
        const title = entry.kind === 'notice' ? entry.native.header.title : entry.kind === 'machine' ? entry.native.title
            : 'unavailable' in entry.native ? entry.native.unavailable.title ?? '' : '';
        return !normalized || title.toLocaleLowerCase().includes(normalized);
    });
    return props.children({ rows, presentations, families, groups, collection, attention, noticeSource: props.inventory.noticeSource });
}

/** Reuses the mounted Store controller and its Actions. The Machine embed does not register a second column. */
export function FilteredManagedInventorySections(props: Omit<SectionsProps, 'query' | 'matches' | 'children'> & Readonly<{
    presented: boolean;
    draft: ManagedInventoryDraft;
    fields: Readonly<Record<ManagedInventoryField, SettingsColumnFilterField>>;
    children: (state: ManagedInventorySectionsState & Readonly<{ filter: ReturnType<typeof useSettingsColumnFilter<ManagedInventoryField>> }>) => React.ReactNode;
}>): React.ReactNode {
    const presentations = React.useMemo(() => presentInventoryRows(props.inventory.rows, props.input, props.inventory.attention),
        [props.inventory.rows, props.inventory.attention, props.input]);
    const facts = React.useMemo(() => [...presentations.values()].map(row => row.facts)
        .filter(facts => matchesInventoryQuery(facts, props.draft.query)), [presentations, props.draft.query]);
    const filter = useSettingsColumnFilter({ column: 'store', presented: props.presented, testIDPrefix: 'installed.filter',
        adapter: inventoryColumnAdapter, fields: props.fields, facts, draft: props.draft,
        search: { value: props.draft.query, set: props.draft.setQuery }, corpusCoverage: props.inventory.coverage });
    const matchesAttention = React.useCallback((entry: ManagedInventoryView['attention'][number]) =>
        filter.matchesFacts(presentInventoryAttention(entry, props.input)), [filter.matchesFacts, props.input]);
    return <ManagedInventorySections {...props} presentations={presentations} query={props.draft.query} matches={filter.matches} matchesAttention={matchesAttention}>
        {state => props.children({ ...state, filter })}
    </ManagedInventorySections>;
}
