import type { PluginUiHostApi } from '@happier-dev/plugin-sdk/ui';
import { TriageEntryRefV1Schema, type TriageEntryRefV1 } from '@happier-dev/triage-protocol/v1';

import type { TriageSurfaceStateV1 } from '../state/surface.js';

/**
 * The ONE PRs & Issues route owner (`core/SURFACE.md` §3.2).
 *
 * It is the sole place that turns the host's plugin-local location into a
 * reducer seed and the reducer's state back into a location, and the sole
 * caller of the generic same-page replacement the host publishes. There is no
 * second route store, no location mirror, no history stack of its own and no
 * direct history access — a shareable URL and the rendered lens are the same
 * fact, read from and written to one place.
 *
 * **Deliberately absent, and blocked rather than approximated:**
 * `filters: SurfaceFilterSelectionV1`, the Smart policy and `selectedViewId`.
 * Their canonical vocabulary is owned by `src/corpus/**` and
 * `src/settings/savedViews.ts` and does not exist at current bytes. Restating
 * it here would create exactly the second filter-vocabulary owner the contract
 * forbids, so this owner covers the lens fields the reducer owns today and
 * takes those as an additive extension of the same grammar.
 *
 * **Grammar.** One path segment per field, `<key>,<value>[,<value>…]`, in a
 * fixed order so one lens always produces one string. Every value is
 * percent-encoded, which is what makes `,` safe as the component separator:
 * `encodeURIComponent` escapes it, so a comma inside an id can never be read as
 * a component boundary. That matters more than brevity here — the four
 * `TriageEntryRefV1` components are compared componentwise everywhere else
 * precisely because a delimiter join can merge two contract-valid entries
 * (`core/CORPUS.md` §6), and a route that merged them would select a different
 * entry than the one the user copied.
 */

const GROUPINGS = ['lane', 'scope', 'kind'] as const;
const ORDERS = ['newest', 'oldest', 'smart'] as const;

/** The route-carried lens. Pagination and cursor depth are never in it. */
export type TriageRouteLensV1 = Readonly<{
  grouping: TriageSurfaceStateV1['grouping'];
  order: TriageSurfaceStateV1['order'];
  query: string;
  selection: TriageEntryRefV1 | null;
}>;

export const TRIAGE_ROUTE_DEFAULT_LENS_V1: TriageRouteLensV1 = Object.freeze({
  grouping: 'lane',
  order: 'newest',
  query: '',
  selection: null,
});

function encode(value: string): string {
  return encodeURIComponent(value);
}

function decode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function readEntryRef(components: readonly string[]): TriageEntryRefV1 | null {
  if (components.length !== 5) return null;
  const decoded = components.map(decode);
  if (decoded.some((component) => component === null)) return null;
  const [pluginId, localId, kindId, collisionScope, entryId] = decoded as readonly string[];
  const parsed = TriageEntryRefV1Schema.safeParse({
    source: { pluginId, localId },
    kindId,
    collisionScope,
    entryId,
  });
  return parsed.success ? parsed.data : null;
}

/**
 * Read a host location into a lens.
 *
 * An unreadable field is DROPPED and every other field survives: a stale or
 * hand-edited selection must not also throw away the query the user typed.
 */
export function parseTriageRouteSubPathV1(subPath: string | undefined): TriageRouteLensV1 {
  let grouping = TRIAGE_ROUTE_DEFAULT_LENS_V1.grouping;
  let order = TRIAGE_ROUTE_DEFAULT_LENS_V1.order;
  let query = TRIAGE_ROUTE_DEFAULT_LENS_V1.query;
  let selection: TriageEntryRefV1 | null = null;

  for (const segment of (subPath ?? '').split('/')) {
    if (segment.length === 0) continue;
    const [key, ...components] = segment.split(',');
    if (key === 'g' && components.length === 1) {
      const value = decode(components[0] ?? '');
      if (value !== null && (GROUPINGS as readonly string[]).includes(value)) {
        grouping = value as TriageRouteLensV1['grouping'];
      }
      continue;
    }
    if (key === 'o' && components.length === 1) {
      const value = decode(components[0] ?? '');
      if (value !== null && (ORDERS as readonly string[]).includes(value)) {
        order = value as TriageRouteLensV1['order'];
      }
      continue;
    }
    if (key === 'q' && components.length === 1) {
      const value = decode(components[0] ?? '');
      if (value !== null) query = value;
      continue;
    }
    if (key === 'e') selection = readEntryRef(components);
  }

  return Object.freeze({ grouping, order, query, selection });
}

/** Build the canonical location for one lens. Absent fields stay absent. */
export function buildTriageRouteSubPathV1(lens: TriageRouteLensV1): string {
  const segments: string[] = [];
  if (lens.grouping !== TRIAGE_ROUTE_DEFAULT_LENS_V1.grouping) {
    segments.push(`g,${encode(lens.grouping)}`);
  }
  if (lens.order !== TRIAGE_ROUTE_DEFAULT_LENS_V1.order) {
    segments.push(`o,${encode(lens.order)}`);
  }
  if (lens.query.length > 0) segments.push(`q,${encode(lens.query)}`);
  if (lens.selection) {
    const { source, kindId, collisionScope, entryId } = lens.selection;
    segments.push([
      'e',
      encode(source.pluginId),
      encode(source.localId),
      encode(kindId),
      encode(collisionScope),
      encode(entryId),
    ].join(','));
  }
  return segments.join('/');
}

/** The route-carried view of the reducer's current state. */
export function readTriageRouteLensV1(state: TriageSurfaceStateV1): TriageRouteLensV1 {
  return Object.freeze({
    grouping: state.grouping,
    order: state.order,
    // The settled query only. An IME-intermediate composition reaches neither
    // the bounded walk nor the route.
    query: state.search.query,
    selection: state.selection?.entryRef ?? null,
  });
}

export type TriageRouteWriteResultV1 =
  | Readonly<{ kind: 'settled'; subPath: string }>
  | Readonly<{ kind: 'refused'; reason: 'unavailable' | 'rejected' }>;

/**
 * Write one lens to the host, declaring the page-internal Back step it creates.
 *
 * A lens WITH a selection declares the same lens WITHOUT it as the step, so the
 * first system Back clears the selection and the next one leaves the page. A
 * lens without a selection declares nothing, so Back never becomes a filter
 * undo stack the user cannot see.
 *
 * The host owns history and settlement; the returned `subPath` is the location
 * that is now current and is the reducer's next input. A host that does not
 * publish the capability is a refusal, never a silent push or a local mirror.
 */
export async function writeTriageRouteLensV1(
  hostApi: PluginUiHostApi,
  lens: TriageRouteLensV1,
  options?: Readonly<{ signal?: AbortSignal }>,
): Promise<TriageRouteWriteResultV1> {
  if (!hostApi.version().methods.includes('replacePageLocation')) {
    return { kind: 'refused', reason: 'unavailable' };
  }
  const subPath = buildTriageRouteSubPathV1(lens);
  const backLocation = lens.selection === null
    ? undefined
    : buildTriageRouteSubPathV1({ ...lens, selection: null });
  try {
    const settled = await hostApi.replacePageLocation(subPath, {
      ...(backLocation === undefined ? {} : { backLocation }),
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
    });
    return { kind: 'settled', subPath: settled.subPath };
  } catch {
    return { kind: 'refused', reason: 'rejected' };
  }
}
