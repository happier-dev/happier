import { normalizePluginUiSubPathV1, type PluginUiHostApi } from '@happier-dev/plugin-sdk/ui';
import { TriageEntryRefV1Schema, type TriageEntryRefV1 } from '@happier-dev/triage-protocol/v1';

import {
  CORPUS_DEFAULT_SMART_POLICY_V1,
  CORPUS_SMART_PRECEDENCE_TUPLES_V1,
  type CorpusSmartPolicyV1,
} from '../../corpus/query/smartPolicy.js';
import {
  TRIAGE_LIST_NO_FILTERS_V1,
  type CorpusAttentionFilterValueV1,
  type CorpusStateFilterValueV1,
  type SurfaceFilterSelectionV1,
} from '../../projection/listWindow.js';
import { sameTriageFilterValueV1, type TriageSurfaceStateV1 } from '../state/surface.js';

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
 * **`selectedViewId` is carried, in the `sv` segment.** `core/SURFACE.md` §3.2
 * names it as part of the effective lens, and it now has a real producer: the
 * list's own compact **Views** control. Carrying it is what makes a copied link name the view its
 * sender was looking through, and what makes an explicit route lens win on
 * restart without the shell having to guess which of two lenses is current.
 *
 * **A route never mutates Account Data.** The id here is a statement about the lens
 * this location carries, not a selection command: an id naming no stored view —
 * deleted elsewhere, or belonging to another Account — is cleared by the shell
 * while the facets, order and policy in the same location survive
 * (`ui/state/surface.ts#savedViewSelectionCleared`). Only the explicit Views
 * control writes `triage.savedViews`.
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
 *
 * A facet whose value has several components takes **one segment per value**
 * (`fs`/`ft`/`fp`), for the same componentwise reason and with a fixed arity per
 * key, so a truncated value is refused rather than read as a shorter one. The
 * two closed single-token facets (`fst`/`fa`) take one segment carrying their
 * values, because each value is already one component.
 */

const GROUPINGS = ['lane', 'scope', 'kind'] as const;
const ORDERS = ['newest', 'oldest', 'smart'] as const;
const STATES = ['open', 'done', 'absent', 'unresolved'] as const;
const ATTENTION = ['required', 'suggested', 'none'] as const;

/** The route-carried lens. Pagination and cursor depth are never in it. */
export type TriageRouteLensV1 = Readonly<{
  grouping: TriageSurfaceStateV1['grouping'];
  order: TriageSurfaceStateV1['order'];
  /**
   * Carried on every lens, not only a `smart` one, because the reducer retains
   * it across an order switch: a copied link that dropped it would reproduce a
   * different Smart order than the one the sender was looking at.
   */
  smartPolicy: CorpusSmartPolicyV1;
  filters: SurfaceFilterSelectionV1;
  query: string;
  /**
   * The saved view this lens came from, or `null` for an unsaved lens. It names
   * where the lens came from and never replaces it: every facet, the order and
   * the policy are carried in full beside it, so a recipient who does not have
   * that view still sees exactly the list the sender did.
   */
  selectedViewId: string | null;
  selection: TriageEntryRefV1 | null;
}>;

export const TRIAGE_ROUTE_DEFAULT_LENS_V1: TriageRouteLensV1 = Object.freeze({
  grouping: 'lane',
  order: 'newest',
  smartPolicy: CORPUS_DEFAULT_SMART_POLICY_V1,
  filters: TRIAGE_LIST_NO_FILTERS_V1,
  query: '',
  selectedViewId: null,
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
 * The mutable facet accumulator one parse fills.
 *
 * Facet segments repeat, so a value is APPENDED rather than overwriting the
 * facet: overwriting would silently reduce a five-source filter to its last
 * source, which is the "drops another still-valid selected facet" §3.2 forbids.
 */
type FacetDraft = {
  sources: SurfaceFilterSelectionV1['sources'][number][];
  types: SurfaceFilterSelectionV1['types'][number][];
  scopes: SurfaceFilterSelectionV1['scopes'][number][];
  states: CorpusStateFilterValueV1[];
  attention: CorpusAttentionFilterValueV1[];
};

/**
 * Admit one value into its facet unless it is already there.
 */
function admitFacetValue(
  draft: FacetDraft,
  facet: keyof FacetDraft,
  value: FacetDraft[keyof FacetDraft][number],
): void {
  const current = draft[facet] as FacetDraft[keyof FacetDraft][number][];
  const selection = { facet, value } as Parameters<typeof sameTriageFilterValueV1>[0];
  if (current.some((candidate) => sameTriageFilterValueV1(
    { facet, value: candidate } as Parameters<typeof sameTriageFilterValueV1>[0],
    selection,
  ))) return;
  current.push(value);
}

/** Decode the leading contribution identity every multi-component facet shares. */
function readSourceIdentity(
  components: readonly string[],
): Readonly<{ pluginId: string; localId: string }> | null {
  const pluginId = decode(components[0] ?? '');
  const localId = decode(components[1] ?? '');
  if (pluginId === null || localId === null) return null;
  if (pluginId.length === 0 || localId.length === 0) return null;
  return { pluginId, localId };
}

function readClosedTokens<TValue extends string>(
  components: readonly string[],
  vocabulary: readonly TValue[],
  admit: (value: TValue) => void,
): void {
  for (const component of components) {
    const value = decode(component);
    // One unknown token is dropped; the valid ones beside it survive.
    if (value !== null && (vocabulary as readonly string[]).includes(value)) admit(value as TValue);
  }
}

/**
 * Read a host location into a lens.
 *
 * An unreadable field is DROPPED and every other field survives: a stale or
 * hand-edited selection must not also throw away the query the user typed, and
 * one invalid facet value must not throw away the four facets beside it.
 */
export function parseTriageRouteSubPathV1(subPath: string | undefined): TriageRouteLensV1 {
  let grouping = TRIAGE_ROUTE_DEFAULT_LENS_V1.grouping;
  let order = TRIAGE_ROUTE_DEFAULT_LENS_V1.order;
  let smartPolicy = TRIAGE_ROUTE_DEFAULT_LENS_V1.smartPolicy;
  let query = TRIAGE_ROUTE_DEFAULT_LENS_V1.query;
  let selectedViewId = TRIAGE_ROUTE_DEFAULT_LENS_V1.selectedViewId;
  let selection: TriageEntryRefV1 | null = null;
  const facets: FacetDraft = { sources: [], types: [], scopes: [], states: [], attention: [] };

  for (const segment of (subPath ?? '').split('/')) {
    if (segment.length === 0) continue;
    const [key, ...components] = segment.split(',');
    if (key === 'sv' && components.length === 1) {
      // Opaque and never parsed for meaning: the id either names a stored view
      // or it does not, and only the Account KV owner can say which. An id no
      // stored view answers to is cleared by the shell rather than refused
      // here, because the lens carried beside it is still the reader's.
      const value = decode(components[0] ?? '');
      if (value !== null && value.length > 0) selectedViewId = value;
      continue;
    }
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
    if (key === 'sp' && components.length === 1) {
      // The ladder is closed to two tuples, so its first predicate names the
      // whole policy. Encoding both would let a route spell a ladder the one
      // canonical owner does not admit.
      const value = decode(components[0] ?? '');
      const tuple = CORPUS_SMART_PRECEDENCE_TUPLES_V1.find((candidate) => candidate[0] === value);
      if (tuple !== undefined) smartPolicy = Object.freeze({ v: 1, precedence: tuple });
      continue;
    }
    if (key === 'fs' && components.length === 2) {
      const source = readSourceIdentity(components);
      if (source !== null) admitFacetValue(facets, 'sources', { source });
      continue;
    }
    if (key === 'ft' && components.length === 3) {
      const source = readSourceIdentity(components);
      const kindId = decode(components[2] ?? '');
      if (source !== null && kindId !== null && kindId.length > 0) {
        admitFacetValue(facets, 'types', { source, kindId });
      }
      continue;
    }
    if (key === 'fp' && components.length === 3) {
      const source = readSourceIdentity(components);
      const collisionScope = decode(components[2] ?? '');
      if (source !== null && collisionScope !== null && collisionScope.length > 0) {
        admitFacetValue(facets, 'scopes', { source, collisionScope });
      }
      continue;
    }
    if (key === 'fst') {
      readClosedTokens(components, STATES, (value) => admitFacetValue(facets, 'states', value));
      continue;
    }
    if (key === 'fa') {
      readClosedTokens(components, ATTENTION, (value) => admitFacetValue(facets, 'attention', value));
      continue;
    }
    if (key === 'q' && components.length === 1) {
      const value = decode(components[0] ?? '');
      if (value !== null) query = value;
      continue;
    }
    if (key === 'e') selection = readEntryRef(components);
  }

  return Object.freeze({
    grouping,
    order,
    smartPolicy,
    filters: Object.freeze({
      sources: Object.freeze(facets.sources),
      types: Object.freeze(facets.types),
      scopes: Object.freeze(facets.scopes),
      states: Object.freeze(facets.states),
      attention: Object.freeze(facets.attention),
    }),
    query,
    selectedViewId,
    selection,
  });
}

/** Build the canonical location for one lens. Absent fields stay absent. */
export function buildTriageRouteSubPathV1(lens: TriageRouteLensV1): string {
  const segments: string[] = [];
  if (lens.selectedViewId !== null) segments.push(`sv,${encode(lens.selectedViewId)}`);
  if (lens.grouping !== TRIAGE_ROUTE_DEFAULT_LENS_V1.grouping) {
    segments.push(`g,${encode(lens.grouping)}`);
  }
  if (lens.order !== TRIAGE_ROUTE_DEFAULT_LENS_V1.order) {
    segments.push(`o,${encode(lens.order)}`);
  }
  // The retained default policy is omitted: naming it would put a value in
  // every reader's URL that says nothing about what they are looking at.
  if (lens.smartPolicy.precedence[0] !== CORPUS_DEFAULT_SMART_POLICY_V1.precedence[0]) {
    segments.push(`sp,${encode(lens.smartPolicy.precedence[0])}`);
  }
  for (const value of lens.filters.sources) {
    segments.push(`fs,${encode(value.source.pluginId)},${encode(value.source.localId)}`);
  }
  for (const value of lens.filters.types) {
    segments.push(`ft,${encode(value.source.pluginId)},${encode(value.source.localId)},${encode(value.kindId)}`);
  }
  for (const value of lens.filters.scopes) {
    segments.push(`fp,${encode(value.source.pluginId)},${encode(value.source.localId)},${encode(value.collisionScope)}`);
  }
  if (lens.filters.states.length > 0) {
    segments.push(['fst', ...lens.filters.states.map(encode)].join(','));
  }
  if (lens.filters.attention.length > 0) {
    segments.push(['fa', ...lens.filters.attention.map(encode)].join(','));
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
    smartPolicy: state.smartPolicy,
    filters: state.filters,
    // The settled query only. An IME-intermediate composition reaches neither
    // the bounded walk nor the route.
    query: state.search.query,
    selectedViewId: state.selectedViewId,
    selection: state.selection?.entryRef ?? null,
  });
}

/**
 * Whether a location names a LENS of its own, as opposed to only a selection.
 *
 * `core/SURFACE.md` §6.5: on restart an explicit valid route lens wins without
 * mutating Account KV, and otherwise the canonical selected saved view restores
 * its exact facets, order and policy. That decision needs exactly this fact, and
 * it is answered by the canonical builder rather than by a second field-by-field
 * comparison — a location is at its default lens precisely when this owner would
 * write no lens segment for it.
 *
 * A bare `e,` selection is deliberately not a lens: it names one entry to open
 * and says nothing about what the page should be listing.
 */
export function hasTriageRouteLensV1(lens: TriageRouteLensV1): boolean {
  return buildTriageRouteSubPathV1({ ...lens, selection: null }).length > 0;
}

export type TriageRoutePreflightV1 =
  | Readonly<{ kind: 'accepted'; subPath: string }>
  | Readonly<{ kind: 'refused' }>;

/**
 * Measure the COMPLETE resulting location before anything moves
 * (`core/SURFACE.md` §3.2).
 *
 * The bound is real either way: `replacePageLocation` already fails closed on
 * an over-long location. But a rejected write is the wrong moment to find out.
 * By then the reducer has already accepted the edit, so the reader is looking
 * at a lens their URL does not carry — the page silently stops being
 * shareable, reloadable and Back-able, and nothing on screen says so. That is
 * the failure this exists to prevent, which is why it runs *before* the
 * reducer rather than on the write's refusal.
 *
 * The decision is the incumbent owner's, not a Triage copy of its number: a
 * second bound would be free to drift from the one the host actually enforces.
 * Only the full location is measured, because the page-internal Back step this
 * owner declares is the same lens WITHOUT its selection — strictly shorter, so
 * it cannot be the half that fails.
 */
export function preflightTriageRouteLensV1(lens: TriageRouteLensV1): TriageRoutePreflightV1 {
  const normalized = normalizePluginUiSubPathV1(buildTriageRouteSubPathV1(lens));
  // Every component is percent-encoded and every segment carries a key prefix,
  // so no route this owner builds can be an escape or a control sequence: the
  // only refusal reachable from here is the byte bound.
  return normalized === null ? { kind: 'refused' } : { kind: 'accepted', subPath: normalized };
}

export type TriageRouteWriteResultV1 =
  | Readonly<{ kind: 'settled'; subPath: string }>
  | Readonly<{ kind: 'refused'; reason: 'unavailable' | 'tooLong' | 'rejected' }>;

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
  // The same preflight the caller runs before its edit, applied again here so
  // this owner never asks the host for a location it already knows is refused.
  const preflight = preflightTriageRouteLensV1(lens);
  if (preflight.kind === 'refused') return { kind: 'refused', reason: 'tooLong' };
  const subPath = preflight.subPath;
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

export type TriageRouteWriteQueueV1 = Readonly<{
  /** Replace any not-yet-started intent with this newest complete lens. */
  write: (lens: TriageRouteLensV1) => void;
  /** Test/coordination seam: resolves once the in-flight write and latest queued intent settle. */
  whenSettled: () => Promise<void>;
  dispose: () => void;
}>;

/**
 * One mounted page's single-flight latest-intent route writer.
 *
 * The host owns the current location, so an in-flight replacement is allowed
 * to settle. While it does, this owner retains exactly one successor and each
 * newer lens overwrites it. That is sufficient to prevent out-of-order host
 * writes and avoidable intermediate calls; no timer, generation, route mirror
 * or second state machine is involved.
 */
export function createTriageRouteWriteQueueV1(
  hostApi: PluginUiHostApi,
): TriageRouteWriteQueueV1 {
  let pending: TriageRouteLensV1 | null = null;
  let running = false;
  let disposed = false;
  let activeController: AbortController | null = null;
  let settlers: Array<() => void> = [];

  const settleWaiters = () => {
    if (running || pending !== null) return;
    const current = settlers;
    settlers = [];
    for (const settle of current) settle();
  };

  const drain = async (): Promise<void> => {
    if (running || disposed) return;
    running = true;
    try {
      while (!disposed && pending !== null) {
        const lens = pending;
        pending = null;
        const controller = new AbortController();
        activeController = controller;
        await writeTriageRouteLensV1(hostApi, lens, { signal: controller.signal });
        if (activeController === controller) activeController = null;
      }
    } finally {
      activeController = null;
      running = false;
      settleWaiters();
    }
  };

  return Object.freeze({
    write(lens) {
      if (disposed) return;
      pending = lens;
      void drain();
    },
    whenSettled() {
      if (!running && pending === null) return Promise.resolve();
      return new Promise<void>((resolve) => { settlers.push(resolve); });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      pending = null;
      activeController?.abort();
      settleWaiters();
    },
  });
}
