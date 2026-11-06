import * as React from 'react';
import type { CollectionConditionBindings } from '@happier-dev/plugin-ui/components';
import {
  compileEntityListFilterV1,
  type EntityListFilterResultV1,
} from '@happier-dev/protocol/collections/filter/entityListFilterV1';
import { getUnsupportedEntityFilterFieldsV1, type EntityFilterRegistryV1 } from '@happier-dev/protocol/collections/filter/fieldRegistryV1';
import type { SettingsColumnFilterColumn } from '@happier-dev/protocol/actions/scopeActionFamily';

import { useCollectionConditionHeader } from '@/components/ui/lists/collection/useCollectionConditionHeader';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { useOptionalScreenIsFocused } from '@/utils/navigation/useOptionalScreenIsFocused';
import { useActiveServerAccountScopeLifetime } from '@/sync/store/hooks';
import { registerSettingsColumnFilterScopeActionOwner, type SettingsColumnFilterScopeActionController } from '@/sync/ops/actions/scopeActionFamily';

import type {
  SettingsCollectionFilter,
  SettingsCollectionRowFacts,
} from './settingsCollectionAdapter';

/** How a column names one of its adapter's fields and that field's held values. */
export type SettingsColumnFilterField = Readonly<{
  label: string;
  /** The value's words from its display owner (status words, service and machine names), never the id. */
  valueLabel: (value: string) => string;
}>;

const EMPTY_FILTER = Object.freeze({}) as SettingsCollectionFilter;

/**
 * A Settings column's filter (P8, R8-6): the shared condition header (filter button with its count, tokens,
 * the shared editor) over the column adapter's registry, without saved spaces. Value choices are the values
 * the column's rows hold, so filtering reads no new data; a row whose field is unknown never matches a
 * condition on it, and the editor's count says the answer is partial.
 */
export function useSettingsColumnFilter<Field extends string>(
  input: Readonly<{
    column: SettingsColumnFilterColumn;
    /** An owner with its own active-page switch can withdraw its Action reach. */
    presented?: boolean;
    testIDPrefix: string;
    adapter: Readonly<{
      fields: readonly Field[];
      registry: EntityFilterRegistryV1<
        SettingsCollectionFilter,
        SettingsCollectionRowFacts<Field>
      >;
    }>;
    fields: Readonly<Record<Field, SettingsColumnFilterField>>;
    facts: readonly SettingsCollectionRowFacts<Field>[];
    /** A remote list must narrow demand before acquisition; it supplies the same draft back here. */
    draft?: Readonly<{ filters: SettingsCollectionFilter; setFilters: React.Dispatch<React.SetStateAction<SettingsCollectionFilter>> }>;
    /** Loaded rows alone cannot establish completeness of a paged or unavailable corpus. */
    corpusCoverage?: EntityListFilterResultV1['coverage'];
    /** The existing query owner; inputs and Actions write this same transient draft. */
    search?: Readonly<{ value: string; set: (query: string) => void }>;
    /**
     * A condition the route hands the column (Skills' `?machine=`). The column starts with it and takes the
     * new one whenever its key changes; the person removes it like any other token.
     */
    seed?: Readonly<{ key: string | null; filter: SettingsCollectionFilter }>;
    /** Fields another control on the page already states; they get no token (one indicator per condition). */
    statedFields?: readonly Field[];
  }>,
) {
  const { adapter, facts } = input;
  const lifetime = useActiveServerAccountScopeLifetime();
  const layoutPresented = useLayoutPresentationActive();
  const screenFocused = useOptionalScreenIsFocused();
  const scopeKey = lifetime ? JSON.stringify([lifetime.scope.serverId, lifetime.scope.accountId]) : null;
  const seedKey = input.seed?.key ?? null;
  const [ownedFilters, setOwnedFilters] = React.useState<SettingsCollectionFilter>(
    () => (seedKey !== null && input.seed ? input.seed.filter : EMPTY_FILTER),
  );
  const filters = input.draft?.filters ?? ownedFilters;
  const setFilters = input.draft?.setFilters ?? setOwnedFilters;
  const [appliedSeedKey, setAppliedSeedKey] = React.useState(seedKey);
  const [retainedScopeKey, setRetainedScopeKey] = React.useState(scopeKey);
  if (scopeKey !== null && scopeKey !== retainedScopeKey) {
    setRetainedScopeKey(scopeKey);
    setFilters(seedKey !== null && input.seed ? input.seed.filter : EMPTY_FILTER);
  }
  if (seedKey !== appliedSeedKey) {
    setAppliedSeedKey(seedKey);
    if (seedKey !== null && input.seed) setFilters(input.seed.filter);
  }
  const fieldWords = input.fields;

  const bindings = React.useMemo(() => {
    const result: Record<
      string,
      { label: string; valueOptions: { value: string; label: string }[] }
    > = {};
    for (const field of adapter.fields) {
      const words = fieldWords[field];
      const values = new Set<string>();
      for (const row of facts)
        for (const value of row.fields[field] ?? []) values.add(value);
      result[field] = {
        label: words.label,
        valueOptions: [...values]
          .map((value) => ({ value, label: words.valueLabel(value) }))
          .sort((a, b) => a.label.localeCompare(b.label)),
      };
    }
    return { fields: result } satisfies CollectionConditionBindings;
  }, [adapter.fields, facts, fieldWords]);

  const active =
    filters !== EMPTY_FILTER &&
    Object.values(filters).some((value) => value !== undefined);
  // The editor's count always says how many rows the conditions keep, so the footer never sits empty.
  const projection = React.useMemo(() => {
    const match = compileEntityListFilterV1(adapter.registry, filters);
    const keys = new Set<string>();
    let unknown = false;
    for (const row of facts) {
      const verdict = match(row);
      if (verdict === 'match') keys.add(row.key);
      else if (verdict === 'unavailable') unknown = true;
    }
    const result: EntityListFilterResultV1 = {
      matchedCount: keys.size,
      coverage: input.corpusCoverage === 'unavailable' ? 'unavailable'
        : unknown || input.corpusCoverage === 'partial' ? 'partial' : 'complete',
    };
    return { keys, result, match };
  }, [active, adapter.registry, facts, filters, input.corpusCoverage]);
  const actionOwner = React.useRef<SettingsColumnFilterScopeActionController | null>(null);
  const clearFilters = React.useCallback(() => setFilters(EMPTY_FILTER), [setFilters]);
  React.useLayoutEffect(() => {
    actionOwner.current = lifetime ? {
      column: input.column,
      lifetime,
      presented: input.presented !== false && layoutPresented && screenFocused,
      filters,
      searchQuery: input.search?.value,
      setSearchQuery: input.search?.set,
      result: projection.result,
      set: (next) => {
        if (getUnsupportedEntityFilterFieldsV1(adapter.registry, next, 'list').length > 0) return false;
        setFilters(next);
        return true;
      },
      clear: clearFilters,
    } : null;
  });
  React.useEffect(() => registerSettingsColumnFilterScopeActionOwner(() => actionOwner.current), []);
  const readHeldFacts = React.useCallback(() => facts, [facts]);

  // Status is the one facet every Settings column shares. Each status the column holds is a one-press chip, unless a
  // control on the page already states it or every row shares one, where a chip could narrow nothing.
  const statedFieldsKey = input.statedFields?.join('|');
  const quickFilters = React.useMemo(() => {
    const status = bindings.fields?.status;
    if (!status || status.valueOptions.length < 2 || statedFieldsKey?.split('|').includes('status')) return undefined;
    return status.valueOptions.map((option) => ({ fieldId: 'status', value: option.value, label: option.label ?? String(option.value) }));
  }, [bindings, statedFieldsKey]);
  const header = useCollectionConditionHeader({
    testIDPrefix: input.testIDPrefix,
    registry: adapter.registry,
    bindings,
    filters,
    setFilters,
    baseFilter: EMPTY_FILTER,
    result: projection.result,
    readHeldFacts,
    ...(input.statedFields ? { statedFields: input.statedFields } : {}),
    ...(quickFilters ? { quickFilters } : {}),
  });

  const keys = active ? projection.keys : null;
  const matches = React.useCallback(
    (key: string) => keys === null || keys.has(key),
    [keys],
  );
  // Auxiliary conditions (for example Needs you) use the same compiled draft,
  // without becoming duplicate members of the collection's count.
  const matchesFacts = React.useCallback(
    (row: SettingsCollectionRowFacts<Field>) => projection.match(row) === 'match',
    [projection.match],
  );
  return {
    filters,
    setFilters,
    clearFilters,
    active,
    matches,
    matchesFacts,
    result: projection.result,
    filterButton: header.filterButton,
    /** Goes on the column's search field, so the editor opens under that field. */
    searchAnchorRef: header.searchAnchorRef,
    tokenRow: header.tokenRow,
    quickFilterChips: header.quickFilterChips,
    /** What the conditions say, in the words of their values ("nl2, Built in"), for a "nothing matches" line. */
    conditionWords: header.tokens.map((token) => token.valueLabel).join(', '),
    editorOverlay: header.editorOverlay,
  };
}
