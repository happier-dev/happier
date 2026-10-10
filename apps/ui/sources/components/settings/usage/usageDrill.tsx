import * as React from 'react';
import type { UsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { buildUsageSettingsRouteTarget } from './usageRouteParams';
import {
  readUsageWidgetPageScope,
  readUsageWidgetQueryOverrides,
} from './usageWidgetPageContext';
import type { UsageWidgetPageFilter } from './useUsageWidgetPageFilters';

/** The scope fields a chart segment, legend entry or ledger row can narrow (lab `kitstates` drill). */
export type UsageDrillField = UsageWidgetPageFilter['field'];

export type UsageDrill = Readonly<{
  /** Whether choosing a value of this field narrows what is shown from here. */
  available(field: UsageDrillField): boolean;
  /** Whether the one filter row already holds this value. */
  selected(field: UsageDrillField, id: string): boolean;
  /** Adds the value to the one filter row, or takes it back out. False when it is not offered. */
  toggle(field: UsageDrillField, id: string): boolean;
}>;

/**
 * The mounted Usage page lends its one filter owner (`useUsageWidgetPageFilters`) to its bodies: a
 * drill is the same choice the toolbar and the current-context commands make, never a second writer.
 */
export function usageDrillFromPageFilters(
  filters: readonly UsageWidgetPageFilter[],
): UsageDrill {
  const byField = new Map(filters.map((filter) => [filter.field, filter]));
  return {
    available: (field) => byField.has(field),
    selected: (field, id) => byField.get(field)?.selected.includes(id) ?? false,
    toggle: (field, id) => byField.get(field)?.select(id) ?? false,
  };
}

const UsageDrillContext = React.createContext<UsageDrill | null>(null);
export const UsageDrillProvider = UsageDrillContext.Provider;

/**
 * A body's drill. On the Usage page it edits the page's filter row. Anywhere else (Home, a Project, a
 * Board) there is no filter row to edit, so it opens the Usage page already narrowed to that value
 * and this widget's own period and cost basis. A Session-scoped query has nothing wider to narrow.
 */
export function useUsageDrill(query: UsageQuery): UsageDrill {
  const page = React.useContext(UsageDrillContext);
  const router = useRouter();
  return React.useMemo((): UsageDrill => {
    if (page) return page;
    const sessionScoped =
      query.session !== undefined &&
      query.session !== null &&
      (typeof query.session === 'string' || query.session.length > 0);
    return {
      available: () => !sessionScoped,
      selected: (field, id) =>
        (query[field] as readonly string[]).includes(id),
      toggle: (field, id) => {
        if (sessionScoped) return false;
        router.push(
          buildUsageSettingsRouteTarget({
            scope: { ...readUsageWidgetPageScope(query), [field]: [id] },
            metric: query.metric,
            queryOverrides: readUsageWidgetQueryOverrides(query),
          }) as Parameters<typeof router.push>[0],
        );
        return true;
      },
    };
  }, [page, query, router]);
}
