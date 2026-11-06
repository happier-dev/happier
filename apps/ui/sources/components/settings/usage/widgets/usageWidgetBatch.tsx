import * as React from 'react';
import { WidgetFrameDemandContext, WidgetFrameInstanceIdContext, type WidgetFrameDemand } from '@/components/widgets/frame/widgetFrameDemand';
import type { JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { UsageBuiltinWidgetIdV1 } from '@happier-dev/protocol/widgets';
import { readBuiltinWidgetDescriptorV1, proposeWidgetInputDefaultBindingsV1 } from '@happier-dev/protocol/widgets';
import { resolveEffectiveInputFields } from '@happier-dev/protocol/inputs/inputFieldRuntime';
import {
  getUsageQueryKey,
  getUsageQueryBatchKey,
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
  useUsageWidgetResourceSubscription,
  type UsageWidgetBodyModel,
  type UsageWidgetResource,
} from '../useUsageWidgetResource';

type Registration = Readonly<{ query: UsageQuery; key: string }>;
type UsageQueryWidgetId = Exclude<UsageBuiltinWidgetIdV1, 'usage_sources'>;
// Each body declares the facts it renders. Unlisted accounting output sections
// remain undemanded; style-specific consumers refine this at resolveQuery.
const USAGE_WIDGET_DEMAND = {
  usage_daily: { includeSeries: true, includeModelTimeline: true, includeSessionEvidence: false, includeWorkEvidence: false },
  usage_period_summary: { includeInsights: true, includeMessageStats: true, includeComparison: true, includeSessionEvidence: true, includeWorkEvidence: true, workProjection: 'summary' },
  usage_cost_facts: { includeSessionEvidence: false, includeWorkEvidence: false },
  usage_flow: { includeSeries: true, includeModelTimeline: true, includeSessionEvidence: false, includeWorkEvidence: false },
  usage_efficiency: { includeInsights: true, includeComparison: true, includeSessionEvidence: false, includeWorkEvidence: false },
  usage_breakdowns: { includeSessionEvidence: false, includeWorkEvidence: false },
  usage_capacity: { includeAccounting: false, includeSessionEvidence: false, includeWorkEvidence: false },
  usage_projections: { includeAccounting: false, includeQuotaHistory: true, includeSessionEvidence: false, includeWorkEvidence: false },
  usage_resets: { includeAccounting: false, includeQuotaHistory: true, includeSessionEvidence: false, includeWorkEvidence: false },
  // Plan fit also renders the recorded-week projection, whose producer consumes calendar activity.
  usage_plan_fit: { includeActivity: true, includeQuotaHistory: true, includeSessionEvidence: false, includeWorkEvidence: false },
  usage_project_ledger: { includeSessionEvidence: false, includeWorkEvidence: true },
  usage_session_value: { includeSessionEvidence: false, includeWorkEvidence: true },
  usage_outcomes: { includeSessionEvidence: false, includeWorkEvidence: true },
  usage_coach: { includeSessionEvidence: true, includeTranscriptEvidence: true, includeWorkEvidence: false },
  // Rhythm's declared default metric is Busy time, which only witnessed intervals can answer.
  usage_rhythm: { includeActivity: true, includeInsights: true, includeSessionEvidence: true, includeWorkEvidence: false },
  usage_parallel: { includeActivity: true, includeSessionEvidence: true, includeWorkEvidence: false },
  usage_human_loop: { includeSessionEvidence: true, includeTranscriptEvidence: true, includeWorkEvidence: false },
  usage_night_shift: { includeActivity: true, includeSessionEvidence: true, includeWorkEvidence: false },
  // Recap's highlights and story name the leading Agent/engine/model; other bodies do not read leaders.
  usage_recap: { includeActivity: true, includeInsights: true, includeLeaders: true, includeSessionEvidence: false, includeWorkEvidence: false },
  usage_footprint: { includeSessionEvidence: false, includeWorkEvidence: false },
  usage_source_coverage: { includeSessionEvidence: false, includeWorkEvidence: false },
  usage_unpriced: { includeSessionEvidence: false, includeWorkEvidence: false },
  usage_score: { includeActivity: true, includeSessionEvidence: true, includeWorkEvidence: false },
  usage_orbit: { includeActivity: true, includeSessionEvidence: false, includeWorkEvidence: false },
  usage_constellation: { includeActivity: true, includeSessionEvidence: true, includeTranscriptEvidence: true, includeWorkEvidence: false },
  usage_planet: { includeActivity: true, includeSessionEvidence: true, includeWorkEvidence: false },
  usage_run_length: { includeSessionEvidence: true, includeWorkEvidence: false },
  usage_atmosphere: { includeAccounting: false, includeActivity: true, includeSessionEvidence: true, includeWorkEvidence: false },
  // Kind evidence and owner-selected public links are unavailable in a private Usage query.
  // Offering these bodies must not hydrate private Session/SCM data to invent either fact.
  usage_machines: { includeAccounting: false, includeSessionEvidence: false, includeWorkEvidence: false },
  usage_projects: { includeAccounting: false, includeSessionEvidence: false, includeWorkEvidence: false },
} satisfies Record<UsageQueryWidgetId, Readonly<Pick<UsageQuery, 'includeSessionEvidence' | 'includeWorkEvidence'> & Partial<Pick<UsageQuery,
  'includeAccounting' | 'includeQuotaHistory' | 'includeTranscriptEvidence' | 'includeSeries' | 'includeInsights' | 'includeActivity' | 'includeComparison'
  | 'includeLeaders' | 'includeModelTimeline' | 'includeMessageStats' | 'workProjection'>>>>;

export function isUsageQueryWidget(id: string): boolean {
  return Object.hasOwn(USAGE_WIDGET_DEMAND, id);
}
type UsageWidgetBatch = Readonly<{
  clauses: UsageWidgetQueryOverrides;
  register(id: string, registration: Registration): () => void;
  resource: UsageWidgetResource;
  inventoryKey: string | null;
}>;

const UsageWidgetBatchContext = React.createContext<UsageWidgetBatch | null>(
  null,
);

/** A setup preview belongs to its destination, independently of the page beneath it. */
export function UsageWidgetBatchBoundary(props: Readonly<{ children: React.ReactNode }>) {
  return <UsageWidgetBatchContext.Provider value={null}>{props.children}</UsageWidgetBatchContext.Provider>;
}

/**
 * One plan from the bodies' own platform-resolved inputs. The widget binder has already applied each
 * widget's value → group → page precedence; this only keys and batches the resulting queries.
 */
export function buildUsageWidgetQueryPlan(
  scope: ServerAccountScope | null,
  rows: ReadonlyMap<string, Registration>,
  inventoryQuery?: UsageQuery,
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
  if (inventoryQuery) queries.push(inventoryQuery);
  const input = scope && queries.length ? normalizeUsageQueryBatchInput({ queries }) : null;
  return {
    scope: scope ?? { serverId: '', accountId: '' },
    input,
    batchKey: input ? getUsageQueryBatchKey(input) : null,
    widgets,
  };
}

/** Mounted by a page that shows several Usage widgets: their distinct requests travel in one `usage.query`. */
export function UsageWidgetBatchProvider(
  props: Readonly<{
    clauses: UsageWidgetQueryOverrides;
    inventoryQuery?: UsageQuery;
    /** A ready layout with no query bodies still needs its filter inventory. */
    inventoryOnly?: boolean;
    /** The admitted layout names query frames before groups finish mounting their children. */
    queryWidgetIds?: readonly string[];
    children: React.ReactNode;
  }>,
) {
  const auth = useAuth();
  const viewer = useActiveServerAccountScope();
  const [rows, setRows] = React.useState<ReadonlyMap<string, Registration>>(
    () => new Map(),
  );
  const [placements, setPlacements] = React.useState<ReadonlyMap<string, Readonly<{ builtinId?: string; visible: boolean | null }>>>(() => new Map());
  const [refusals, setRefusals] = React.useState<ReadonlySet<string>>(() => new Set());
  const demand = React.useMemo<WidgetFrameDemand>(() => ({
    place(id, builtinId, visible) {
      const placement = { builtinId, visible };
      setPlacements(current => new Map(current).set(id, placement));
      return () => setPlacements(current => {
        if (current.get(id) !== placement) return current;
        const next = new Map(current); next.delete(id); return next;
      });
    },
    refuse(id, refused) {
      setRefusals(current => {
        if (current.has(id) === refused) return current;
        const next = new Set(current); if (refused) next.add(id); else next.delete(id); return next;
      });
      return () => setRefusals(current => {
        if (!current.has(id)) return current;
        const next = new Set(current); next.delete(id); return next;
      });
    },
  }), []);
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
  // Filter choices consume accounting membership, never private work detail.
  const inventoryQuery = React.useMemo(() => props.inventoryQuery
    ? normalizeUsageQuery({ ...props.inventoryQuery,
      includeSeries: false, includeInsights: false, includeActivity: false, includeLeaders: false,
      includeModelTimeline: false, includeMessageStats: false, includeQuotaHistory: false, includeComparison: false,
      includeSessionEvidence: false, includeTranscriptEvidence: false, includeWorkEvidence: false,
    }) : undefined, [props.inventoryQuery]);
  // A visible frame can still be binding its inputs after its neighbours mount.
  // Admit their complete cohort, using the frame and binder owners' facts, once.
  const collecting = props.queryWidgetIds?.some(id => !placements.has(id)) === true
    || [...placements].some(([id, placement]) => placement.builtinId !== undefined && isUsageQueryWidget(placement.builtinId)
    && (placement.visible === null || placement.visible && !rows.has(id) && !refusals.has(id)));
  const plan = React.useMemo(
    () => {
      const next = buildUsageWidgetQueryPlan(scope, rows, rows.size > 0 || props.inventoryOnly || placements.size > 0 ? inventoryQuery : undefined);
      return collecting ? { ...next, input: null, batchKey: null } : next;
    },
    [scope, rows, inventoryQuery, props.inventoryOnly, collecting, placements.size],
  );
  const resource = useUsageWidgetResource({
    credentials: auth.credentials,
    enabled: auth.credentials != null,
    retainPendingDemand: true,
    plan,
  });
  const value = React.useMemo(
    () => ({ clauses: props.clauses, register, resource, inventoryKey: inventoryQuery ? getUsageQueryKey(inventoryQuery) : null }),
    [props.clauses, inventoryQuery, register, resource],
  );
  return (
    <UsageWidgetBatchContext.Provider value={value}>
      <WidgetFrameDemandContext.Provider value={demand}>
        {props.children}
      </WidgetFrameDemandContext.Provider>
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
  widgetId: UsageQueryWidgetId,
): Registration | null {
  try {
    const descriptor = readBuiltinWidgetDescriptorV1({ kind: 'builtin', id: widgetId })!;
    const defaults = proposeWidgetInputDefaultBindingsV1(descriptor);
    // The platform has already bound scope. Only own presentation defaults belong here;
    // never let a descriptor's empty scope defaults replace a page or group pin.
    const ownDefaults: Record<string, JsonValue> = Object.fromEntries(descriptor.inputs!.fields.flatMap(field => {
      const binding = field.contextMode === 'own' ? defaults[field.path] : undefined;
      return binding?.kind === 'value' ? [[field.path, binding.value]] : [];
    }));
    const resolvedInput: Record<string, JsonValue> = { ...ownDefaults, ...input };
    const effective = new Set(resolveEffectiveInputFields({ inputHints: descriptor.inputs }, resolvedInput).map(field => field.path));
    // Defaults may not resurrect an own input the platform has made non-applicable for this Style.
    // Scope pins still belong to the binder and are never pruned or re-defaulted here.
    for (const field of descriptor.inputs!.fields) if (field.contextMode === 'own' && !effective.has(field.path)) delete resolvedInput[field.path];
    const { style, colourBy: _colourBy, day: _day, ...queryInput } = resolvedInput;
    // Activity consumers need both calendar and weekday/hour facts, irrespective of partial route read clauses.
    // Direct usage.query callers retain their explicit includeActivity/activityResolution semantics.
    const singleSession = typeof input.session === 'string' && input.session.length > 0
      || Array.isArray(input.session) && input.session.length === 1;
    // The Work autopsy renders only for one selected Session. The aggregate
    // Session-value plot/rows consume allocation facts, not private transcripts.
    const autopsy = singleSession && (widgetId === 'usage_session_value'
      || widgetId === 'usage_recap' && style !== 'personalRecords');
    const rhythmMetric = queryInput.metric ?? 'tokens';
    const query = normalizeUsageQuery({ ...clauses, ...queryInput, includeAccounting: true,
      includeSeries: false, includeInsights: false, includeActivity: false, activityResolution: 'both',
      includeLeaders: false, includeModelTimeline: false, includeMessageStats: false, includeQuotaHistory: false, includeComparison: false,
      includeTranscriptEvidence: false,
      ...USAGE_WIDGET_DEMAND[widgetId],
      ...(typeof queryInput.includeQuotaHistory === 'boolean' ? { includeQuotaHistory: queryInput.includeQuotaHistory } : {}),
      // Ranked rows consume accounting totals and selected breakdowns. Crew
      // also consumes the Agent calendar; neither style reads quota, series or timelines.
      ...(widgetId === 'usage_breakdowns' ? { includeActivity: style === 'crew' } : {}),
      ...(widgetId === 'usage_flow' && style === 'agentRiver' ? { includeSeries: false, includeModelTimeline: false, includeActivity: true } : {}),
      ...(widgetId === 'usage_rhythm' ? {
        includeInsights: style === 'heatmap' || style === 'weekdayHour',
        includeSessionEvidence: rhythmMetric !== 'tokens' && rhythmMetric !== 'cost',
        includeTranscriptEvidence: rhythmMetric === 'steering',
      } : {}),
      ...(widgetId === 'usage_parallel' && style === 'timeline' ? { includeActivity: false } : {}),
      ...(widgetId === 'usage_recap' && style === 'personalRecords' ? {
        includeInsights: false, includeLeaders: false, includeSessionEvidence: true,
      } : {}),
      ...(widgetId === 'usage_run_length' && style === 'galaxy' ? { includeActivity: true } : {}),
      ...(autopsy ? { includeWorkEvidence: true, includeSessionEvidence: true, includeTranscriptEvidence: true } : {}),
    });
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
  widgetId: UsageQueryWidgetId,
): Readonly<{
  model: UsageWidgetBodyModel;
  query: UsageQuery | null;
}> {
  const batch = React.useContext(UsageWidgetBatchContext);
  const auth = useAuth();
  const viewer = useActiveServerAccountScope();
  const ownId = React.useId();
  const id = React.useContext(WidgetFrameInstanceIdContext) ?? ownId;
  const [standaloneClauses] = React.useState(readStandaloneClauses);
  const clauses = batch?.clauses ?? standaloneClauses;
  const inputKey = JSON.stringify(input);
  const registration = React.useMemo(
    () => resolveQuery(clauses, input, widgetId),
    [clauses, inputKey, widgetId],
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
function useDecodedUsageWidgetBatchSelection<T>(select: (slices: readonly UsageQueryResultSlice[]) => T,
    equal: (left: T, right: T) => boolean, demand = false): T {
    const batch = React.useContext(UsageWidgetBatchContext);
    const entry = batch?.resource.entry ?? null;
    const subscribe = useUsageWidgetResourceSubscription(entry, demand);
    const lifetime = batch?.resource.lifetime;
    const getSnapshot = React.useMemo(() => {
        let previous: { value: T } | undefined;
        return () => {
            const value = entry?.getSnapshot().value;
            let slices = EMPTY_RESULTS;
            if (value && lifetime?.isCurrent() === true) {
                try { slices = decodeUsageQueryResource(value).results; } catch { /* No decoded facts yet. */ }
            }
            const selected = select(slices);
            if (previous && equal(previous.value, selected)) return previous.value;
            previous = { value: selected };
            return selected;
        };
    }, [entry, lifetime, select, equal]);
    return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Only mounted widget results feed page totals and freshness; inventory is not a displayed total. */
export function useUsageWidgetBatchSelection<T>(select: (slices: readonly UsageQueryResultSlice[]) => T,
    equal: (left: T, right: T) => boolean): T {
    const batch = React.useContext(UsageWidgetBatchContext);
    const plan = batch?.resource.plan;
    const selectDisplayed = React.useCallback((slices: readonly UsageQueryResultSlice[]) => select(
        slices.filter(slice => [...(plan?.widgets.values() ?? [])].some(widget => widget.key === slice.key))), [select, plan]);
    return useDecodedUsageWidgetBatchSelection(selectDisplayed, equal);
}

const selectSlices = (slices: readonly UsageQueryResultSlice[]) => slices;
const sameSlices = (left: readonly UsageQueryResultSlice[], right: readonly UsageQueryResultSlice[]) =>
    left.length === right.length && left.every((slice, index) => slice === right[index]);

export function useUsageWidgetBatchSlices(): readonly UsageQueryResultSlice[] {
    return useUsageWidgetBatchSelection(selectSlices, sameSlices);
}

/** Unnarrowed choices share the page's canonical request, lifetime, decode and Resource owner. */
export function useUsageWidgetBatchInventorySlice(): UsageQueryResultSlice | undefined {
    const batch = React.useContext(UsageWidgetBatchContext);
    const inventoryKey = batch?.inventoryKey;
    const select = React.useCallback((slices: readonly UsageQueryResultSlice[]) => slices.find(slice => slice.key === inventoryKey), [inventoryKey]);
    return useDecodedUsageWidgetBatchSelection(select, Object.is, true);
}

/**
 * The page's one Retry for a failed shared read, said beside the header's "Couldn't read …" fact. Every body
 * reads the same batch entry, so re-reading it is what each body's own Retry would do; outside a page, null.
 */
export function useUsageWidgetPageRetry(): (() => void) | null {
    const batch = React.useContext(UsageWidgetBatchContext);
    const entry = batch?.resource.entry ?? null;
    const lifetime = batch?.resource.lifetime ?? null;
    return React.useMemo(() => entry ? () => { if (lifetime?.isCurrent()) void entry.refresh(); } : null, [entry, lifetime]);
}

export function useUsageWidgetPageHasCoverageDetail(): boolean {
    const batch = React.useContext(UsageWidgetBatchContext);
    // Coverage belongs to the page from its first frame, including the time
    // before its inventory responds. Loading does not transfer it to a body.
    return batch !== null;
}
