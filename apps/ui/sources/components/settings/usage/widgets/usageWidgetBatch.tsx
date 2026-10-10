import * as React from 'react';
import type { JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import {
  getUsageQueryKey,
  normalizeUsageQuery,
  normalizeUsageQueryBatchInput,
  type UsageQuery,
} from '@happier-dev/protocol/inputs/usageQuery';
import type { UsageQueryResultSlice } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import { useAuth } from '@/auth/context/AuthContext';
import { decodeUsageQueryResource } from '@/sync/api/account/usageQueryResource';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { UsageWidgetQueryPlan } from '../usageWidgetQueries';
import {
  resolveUsageWidgetPageInitialQuery,
  type UsageWidgetQueryOverrides,
} from '../usageWidgetPageContext';
import {
  useUsageWidgetBodyModel,
  useUsageWidgetResource,
  type UsageWidgetBodyModel,
  type UsageWidgetResource,
} from '../useUsageWidgetResource';

type Registration = Readonly<{ query: UsageQuery; key: string }>;
type UsageWidgetBatch = Readonly<{
  clauses: UsageWidgetQueryOverrides;
  register(id: string, registration: Registration): () => void;
  resource: UsageWidgetResource;
}>;

const UsageWidgetBatchContext = React.createContext<UsageWidgetBatch | null>(
  null,
);

/**
 * One plan from the bodies' own platform-resolved inputs. The widget binder has already applied each
 * widget's value → group → page precedence; this only keys and batches the resulting queries.
 */
export function buildUsageWidgetQueryPlan(
  scope: ServerAccountScope | null,
  rows: ReadonlyMap<string, Registration>,
): UsageWidgetQueryPlan {
  const widgets = new Map(
    [...rows].map(([id, row]) => [
      id,
      {
        resolution: { status: 'ready' as const, input: {} },
        query: row.query,
        key: row.key,
      },
    ]),
  );
  const queries = [...rows.values()].map((row) => row.query);
  return {
    scope: scope ?? { serverId: '', accountId: '' },
    input:
      scope && queries.length
        ? normalizeUsageQueryBatchInput({ queries })
        : null,
    widgets,
  };
}

/** Mounted by a page that shows several Usage widgets: their distinct requests travel in one `usage.query`. */
export function UsageWidgetBatchProvider(
  props: Readonly<{
    clauses: UsageWidgetQueryOverrides;
    children: React.ReactNode;
  }>,
) {
  const auth = useAuth();
  const viewer = useActiveServerAccountScope();
  const [rows, setRows] = React.useState<ReadonlyMap<string, Registration>>(
    () => new Map(),
  );
  const register = React.useCallback(
    (id: string, registration: Registration) => {
      setRows((current) =>
        current.get(id)?.key === registration.key
          ? current
          : new Map(current).set(id, registration),
      );
      return () =>
        setRows((current) => {
          if (current.get(id) !== registration) return current;
          const next = new Map(current);
          next.delete(id);
          return next;
        });
    },
    [],
  );
  const scope = React.useMemo(
    () =>
      viewer
        ? { serverId: viewer.serverId, accountId: viewer.accountId }
        : null,
    [viewer?.serverId, viewer?.accountId],
  );
  const plan = React.useMemo(
    () => buildUsageWidgetQueryPlan(scope, rows),
    [scope, rows],
  );
  const resource = useUsageWidgetResource({
    credentials: auth.credentials,
    enabled: auth.credentials != null,
    plan,
  });
  const value = React.useMemo(
    () => ({ clauses: props.clauses, register, resource }),
    [props.clauses, register, resource],
  );
  return (
    <UsageWidgetBatchContext.Provider value={value}>
      {props.children}
    </UsageWidgetBatchContext.Provider>
  );
}

function readStandaloneClauses(): UsageWidgetQueryOverrides {
  const query = resolveUsageWidgetPageInitialQuery({
    nowMs: Date.now(),
    timeZoneOffsetMinutes: -new Date().getTimezoneOffset(),
  });
  const {
    period: _p,
    agents: _a,
    machines: _m,
    projects: _pr,
    sources: _s,
    session: _se,
    costBasis: _c,
    metric: _me,
    breakdown: _b,
    ...clauses
  } = query;
  return clauses;
}

function resolveQuery(
  clauses: UsageWidgetQueryOverrides,
  input: Readonly<Record<string, JsonValue>>,
): Registration | null {
  try {
    const query = normalizeUsageQuery({ ...clauses, ...input });
    return { query, key: getUsageQueryKey(query) };
  } catch {
    return null;
  }
}

/**
 * The one way a Usage body reads facts. On the Usage page it joins the page batch; elsewhere (Home,
 * a Project) it reads its own single-query batch through the same Resource store and decode path.
 */
export function useUsageWidgetModel(
  input: Readonly<Record<string, JsonValue>>,
): Readonly<{
  model: UsageWidgetBodyModel;
  query: UsageQuery | null;
}> {
  const batch = React.useContext(UsageWidgetBatchContext);
  const auth = useAuth();
  const viewer = useActiveServerAccountScope();
  const id = React.useId();
  const [standaloneClauses] = React.useState(readStandaloneClauses);
  const clauses = batch?.clauses ?? standaloneClauses;
  const inputKey = JSON.stringify(input);
  const registration = React.useMemo(
    () => resolveQuery(clauses, input),
    [clauses, inputKey],
  );
  const register = batch?.register;
  React.useLayoutEffect(
    () => (registration && register ? register(id, registration) : undefined),
    [register, id, registration],
  );
  const scope = React.useMemo(
    () =>
      viewer
        ? { serverId: viewer.serverId, accountId: viewer.accountId }
        : null,
    [viewer?.serverId, viewer?.accountId],
  );
  const ownPlan = React.useMemo(
    () =>
      buildUsageWidgetQueryPlan(
        batch ? null : scope,
        registration ? new Map([[id, registration]]) : new Map(),
      ),
    [batch, scope, registration, id],
  );
  const own = useUsageWidgetResource({
    credentials: auth.credentials,
    enabled: !batch && auth.credentials != null,
    plan: ownPlan,
  });
  const model = useUsageWidgetBodyModel(batch?.resource ?? own, id);
  return { model, query: registration?.query ?? null };
}

const EMPTY_RESULTS: readonly UsageQueryResultSlice[] = Object.freeze([]);

/**
 * The page batch's decoded slices for page chrome (filter options, freshness line). It reads the same
 * Resource entry the widgets read and adds no request of its own; outside a page it is empty.
 */
export function useUsageWidgetBatchSlices(): readonly UsageQueryResultSlice[] {
    const batch = React.useContext(UsageWidgetBatchContext);
    const entry = batch?.resource.entry ?? null;
    const subscribe = React.useCallback((listener: () => void) => entry?.subscribe(listener, false) ?? (() => {}), [entry]);
    const getSnapshot = React.useCallback(() => entry?.getSnapshot().value, [entry]);
    const value = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    return React.useMemo(() => {
        if (!value || batch?.resource.lifetime?.isCurrent() !== true) return EMPTY_RESULTS;
        try { return decodeUsageQueryResource(value).results; } catch { return EMPTY_RESULTS; }
    }, [value, batch?.resource.lifetime]);
}
