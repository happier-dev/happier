import { isPluginError } from '@happier-dev/plugin-sdk';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import { PLUGIN_ACCOUNT_STORAGE_LIMITS_V1 } from '@happier-dev/plugin-sdk/storage';
import { createProtocolStoredReadSchema } from '@happier-dev/plugin-sdk/protocol';
import {
    normalizeTriageSingleLineV1,
} from '@happier-dev/triage-protocol/v1';

import {
    CORPUS_DEFAULT_SMART_POLICY_V1,
    parseCorpusSmartPolicy,
    type CorpusSmartPolicyV1,
} from '../corpus/query/smartPolicy.js';
import {
    triageSourceFilterKeyV1,
    triageScopeFilterKeyV1,
    TRIAGE_LIST_ORDERS_V1 as ORDERS,
    type CorpusSourceFilterValueV1,
    type CorpusScopeFilterValueV1,
    type CorpusTypeFilterValueV1,
    type CorpusStateFilterValueV1,
    type CorpusAttentionFilterValueV1,
    type SurfaceFilterSelectionV1,
    type TriageListOrderV1,
} from '../projection/listWindow.js';
import {
    TriageSurfaceFilterSelectionV1Schema,
    TriageListSettledQueryV1Schema,
} from '../actions/listEntriesProtocol.js';

import { TriageSavedViewsCatalogValueV1Schema, TRIAGE_SAVED_VIEW_PRESENTATIONS_V1 } from '../actions/savedViewsProtocol.js';
export { TRIAGE_SAVED_VIEW_PRESENTATIONS_V1 } from '../actions/savedViewsProtocol.js';
import type { TriageCatalogStoreV1 } from './accountKvCatalogStore.js';

const storedTriageSavedViews = createProtocolStoredReadSchema(TriageSavedViewsCatalogValueV1Schema);

/**
 * The sole `triage.savedViews` owner: one typed Account KV value, read,
 * validated and written in one place.
 *
 * Saved views are genuine durable user state — one of only four things Triage
 * persists — so they carry the same discipline as a pin. A view is addressed by
 * its own minted opaque id and never by its position or its label, so renaming
 * a view, reordering the set, or saving two views under one name can never
 * silently move the user's selection onto a different lens. Selection belongs
 * to the device's host-restored page location, never to this Account value.
 *
 * The lens it stores is **source-neutral**. Every facet value is a canonical
 * private identity — an admitted qualified source, a source-neutral `kindId`, an
 * exact `(source, collisionScope)` pair, the canonical lane/presence fold, and
 * the one displayed-attention result. There is no derived storage tag anywhere
 * in it: a persisted tag would be a mode-dependent locator that an Account rekey
 * silently invalidates, and a view expressible only by naming a provider concept
 * would be source vocabulary leaking into the aggregate.
 *
 * It is neither a generic Account Data manager nor a materialization authority.
 * Materialization has no KV value at all, so a view edit can never contend
 * with or become a refresh command.
 */

/** The one versioned Account KV key this document owns. */
export const TRIAGE_SAVED_VIEWS_ACCOUNT_KV_KEY_V1 = 'triage.savedViews';

/**
 * The whole serialized `triage.savedViews` value.
 *
 * It is measured over the complete value rather than per member, because a set
 * of individually valid views is exactly how an Account KV value overflows. The
 * generic Account-data row ceiling is a host safeguard around every KV record
 * and is deliberately not restated here: it is not this key's
 * member-count bound, and treating its 256-field limit as "256 views" would be
 * wrong by an order of magnitude. The byte boundary below is Account Data's
 * public value boundary, not a second Triage-specific 64-KiB decision.
 */
export const MAX_TRIAGE_SAVED_VIEWS_SERIALIZED_UTF8_BYTES_V1 =
    PLUGIN_ACCOUNT_STORAGE_LIMITS_V1.maximumValueEncodedBytes;

/**
 * How a saved view presents its rows: the view the reader chose while looking through it (PLAN.md r0.41, "Views:
 * List | Board, persisted per saved view"). It is remembered with the view, never as a layout Setting. A value
 * this build does not know makes the stored set unreadable rather than silently becoming List.
 */
export type TriageSavedViewPresentationV1 = (typeof TRIAGE_SAVED_VIEW_PRESENTATIONS_V1)[number];

export type CorpusSavedViewV1 = Readonly<{
    /** Target-minted opaque id; neither an entry/source identity nor a storage tag. */
    viewId: string;
    label: string;
    /** The settled list query; an empty string means no search constraint. */
    query: string;
    filters: SurfaceFilterSelectionV1;
    order: TriageListOrderV1;
    /** Retained across a non-Smart order switch, consumed only when `order === 'smart'`. */
    smartPolicy: CorpusSmartPolicyV1;
    view: TriageSavedViewPresentationV1;
}>;

export type CorpusSavedViewsCatalogV1 = Readonly<{
    v: 1;
    views: readonly CorpusSavedViewV1[];
}>;

/** The parsed absence and the effective default lens behind it. */
export const CORPUS_EMPTY_SAVED_VIEWS_V1: CorpusSavedViewsCatalogV1 = Object.freeze({
    v: 1,
    views: Object.freeze([]),
});

/**
 * How a stored value was understood.
 *
 * `unreadable` is a real third answer, not a failure dressed as the default. A
 * value this build cannot parse belongs to a newer writer, and reporting it as
 * `absent` is exactly what would let the next ordinary create destroy durable
 * user state that the other client can still read.
 */
export type CorpusSavedViewsReadV1 = Readonly<{
    kind: 'absent' | 'parsed' | 'unreadable';
    value: CorpusSavedViewsCatalogV1;
}>;

export type CorpusSavedViewsRejectionV1 = NonNullable<
    import('../actions/savedViewsProtocol.js').TriageAdministerSavedViewResultV1['reason']
>;

export type CorpusSavedViewsMutationResultV1 =
    | Readonly<{
        status: 'applied';
        viewId: string;
        value: CorpusSavedViewsCatalogV1;
        revision: string;
    }>
    /** Another writer won; the caller re-reads rather than forcing its value. */
    | Readonly<{ status: 'conflict' }>
    | Readonly<{ status: 'unknownView' }>
    | Readonly<{ status: 'unreadable' }>
    | Readonly<{ status: 'rejected'; reason: CorpusSavedViewsRejectionV1 }>;

type CorpusSavedViewsAppliedPlanV1 =
    | Readonly<{ status: 'applied'; viewId: string; value: CorpusSavedViewsCatalogV1 }>
    | Exclude<CorpusSavedViewsMutationResultV1, Readonly<{ status: 'applied' }>>;

export type CorpusSavedViewDraftV1 = Readonly<{
    label: string;
    query: string;
    filters: SurfaceFilterSelectionV1;
    order: TriageListOrderV1;
    smartPolicy: CorpusSmartPolicyV1;
    /** Absent from a writer that predates views; such a view presents as List. */
    view?: TriageSavedViewPresentationV1;
}>;

type CorpusSavedViewCommandBaseV1 = Readonly<{ expectedRevision: string }>;

export type CorpusSavedViewCommandV1 = CorpusSavedViewCommandBaseV1 & (
    | (CorpusSavedViewDraftV1 & Readonly<{ kind: 'create' }>)
    | (CorpusSavedViewDraftV1 & Readonly<{ kind: 'update'; viewId: string }>)
    | Readonly<{ kind: 'delete'; viewId: string }>
);

export type CorpusSavedViewsDepsV1 = Readonly<{
    catalog: Pick<TriageCatalogStoreV1, 'read' | 'write'>;
    /** The opaque view id is minted only here, and only for a create. */
    mintViewId: () => string;
    signal?: AbortSignal;
}>;

const encoder = new TextEncoder();

function utf8ByteLength(value: string): number {
    return encoder.encode(value).byteLength;
}

function readSingleLineString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const normalized = normalizeTriageSingleLineV1(value);
    return normalized.length === 0 ? null : normalized;
}

/**
 * The canonical identity of one facet value, used only to reject duplicates.
 *
 * Components are framed as an array rather than joined, because `U+001F` is
 * representable inside `collisionScope`: a delimiter join would make two
 * contract-valid distinct scopes compare equal and silently drop one of them.
 */
function hasDuplicateFacetValue<T>(values: readonly T[], key: (value: T) => string): boolean {
    const seen = new Set<string>();
    for (const value of values) {
        const identity = key(value);
        if (seen.has(identity)) return true;
        seen.add(identity);
    }
    return false;
}

function readClosedValue<TValue extends string>(
    admitted: readonly TValue[],
): (value: unknown) => TValue | null {
    return (value) => (typeof value === 'string' && (admitted as readonly string[]).includes(value)
        ? value as TValue
        : null);
}

type FiltersOutcome =
    | Readonly<{ ok: true; filters: SurfaceFilterSelectionV1 }>
    | Readonly<{ ok: false; reason: CorpusSavedViewsRejectionV1 }>;

function readFilters(raw: unknown): FiltersOutcome {
    const parsed = TriageSurfaceFilterSelectionV1Schema.safeParse(raw);
    if (!parsed.success) return { ok: false, reason: 'filterValue' };
    const filters = parsed.data;
    if (hasDuplicateFacetValue<CorpusSourceFilterValueV1>(filters.sources, triageSourceFilterKeyV1)
        || hasDuplicateFacetValue<CorpusTypeFilterValueV1>(filters.types, (value) => JSON.stringify([value.source.pluginId, value.source.localId, value.kindId]))
        || hasDuplicateFacetValue<CorpusScopeFilterValueV1>(filters.scopes, triageScopeFilterKeyV1)
        || hasDuplicateFacetValue<CorpusStateFilterValueV1>(filters.states, (value) => value)
        || hasDuplicateFacetValue<CorpusAttentionFilterValueV1>(filters.attention, (value) => value)) {
        return { ok: false, reason: 'duplicateFacetValue' };
    }
    return { ok: true, filters };
}

type ViewOutcome =
    | Readonly<{ ok: true; view: CorpusSavedViewV1 }>
    | Readonly<{ ok: false; reason: CorpusSavedViewsRejectionV1 }>;

/**
 * Validate one view. The same rules run for a stored value and for an incoming
 * draft, so a value that could not be written cannot be read back either.
 */
function readView(viewId: string, draft: Readonly<{
    label: unknown;
    query: unknown;
    filters: unknown;
    order: unknown;
    smartPolicy: unknown;
    view?: unknown;
}>): ViewOutcome {
    // The complete Account KV value has the canonical storage boundary.
    // Labels have no independent provider, transport, or product ceiling.
    const label = readSingleLineString(draft.label);
    if (label === null) return { ok: false, reason: 'label' };
    const query = TriageListSettledQueryV1Schema.safeParse(draft.query);
    if (!query.success) return { ok: false, reason: 'query' };
    const order = readClosedValue(ORDERS)(draft.order);
    if (order === null) return { ok: false, reason: 'order' };
    const smartPolicy = parseCorpusSmartPolicy(draft.smartPolicy);
    if (smartPolicy === null) return { ok: false, reason: 'smartPolicy' };
    const filters = readFilters(draft.filters);
    if (!filters.ok) return filters;
    const view = draft.view === undefined ? 'list' : readClosedValue(TRIAGE_SAVED_VIEW_PRESENTATIONS_V1)(draft.view);
    if (view === null) return { ok: false, reason: 'view' };
    return {
        ok: true,
        view: { viewId, label, query: query.data, filters: filters.filters, order, smartPolicy, view },
    };
}

/** A minted view id must look like one: it is opaque, but it is not free-form. */
const VIEW_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/**
 * Parse one stored value.
 *
 * Any member this build cannot understand makes the whole value `unreadable`
 * rather than dropping that member: silently discarding one view would lose
 * durable user state with no upstream owner to recover it from. A retired
 * `selectedViewId` field is ignored by the stored-read projection.
 */
export function parseTriageSavedViews(raw: unknown): CorpusSavedViewsReadV1 {
    if (raw === undefined || raw === null) return { kind: 'absent', value: CORPUS_EMPTY_SAVED_VIEWS_V1 };
    const unreadable: CorpusSavedViewsReadV1 = { kind: 'unreadable', value: CORPUS_EMPTY_SAVED_VIEWS_V1 };
    // The local whole-value bound is read back as well as written so the reader
    // and writer agree about which Account KV values this implementation owns.
    if (typeof raw !== 'object') return unreadable;
    if (utf8ByteLength(JSON.stringify(raw)) > MAX_TRIAGE_SAVED_VIEWS_SERIALIZED_UTF8_BYTES_V1) {
        return unreadable;
    }
    // Preserve the catalog owner's label normalization before schema admission.
    const rawCatalog = raw as Readonly<Record<string, unknown>>;
    const normalized = Array.isArray(rawCatalog.views) ? {
        ...rawCatalog,
        views: rawCatalog.views.map((value: unknown) => {
            if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
            const view = value as Readonly<Record<string, unknown>>;
            return { ...view, label: typeof view.label === 'string' ? normalizeTriageSingleLineV1(view.label) : view.label };
        }),
    } : raw;
    const parsedCatalog = storedTriageSavedViews.safeParse(normalized);
    if (!parsedCatalog.success) return unreadable;
    const candidate = parsedCatalog.data;

    const views: CorpusSavedViewV1[] = [];
    const ids = new Set<string>();
    for (const member of candidate.views) {
        // A view saved before views existed has no `view` member; it presents as List.
        const view = member;
        if (!VIEW_ID_PATTERN.test(view.viewId)) return unreadable;
        if (ids.has(view.viewId)) return unreadable;
        ids.add(view.viewId);
        const parsed = readView(view.viewId, {
            label: view.label,
            query: view.query,
            filters: view.filters,
            order: view.order,
            smartPolicy: view.smartPolicy,
            ...(view.view === undefined ? {} : { view: view.view }),
        });
        if (!parsed.ok) return unreadable;
        views.push(parsed.view);
    }

    return { kind: 'parsed', value: { v: 1, views } };
}

/**
 * Project the validated value to the exact JSON that is stored.
 *
 * The value is rebuilt member by member rather than passed through, so nothing
 * the validator did not admit — a derived tag, a stray display value, an
 * unparsed policy — can ride into durable Account state.
 */
function toStoredValue(value: CorpusSavedViewsCatalogV1): JsonValue {
    return {
        v: 1,
        views: value.views.map((view) => ({
            viewId: view.viewId,
            label: view.label,
            query: view.query,
            filters: {
                ...(view.filters.tasks === undefined ? {} : { tasks: view.filters.tasks }),
                sources: view.filters.sources.map((entry) => ({ source: { ...entry.source },
                    ...(entry.sourceInstanceId === undefined ? {} : { sourceInstanceId: entry.sourceInstanceId }),
                })),
                types: view.filters.types.map((entry) => ({
                    source: { ...entry.source },
                    kindId: entry.kindId,
                })),
                scopes: view.filters.scopes.map((entry) => ({
                    source: { ...entry.source },
                    ...(entry.sourceInstanceId === undefined ? {} : { sourceInstanceId: entry.sourceInstanceId }),
                    ...(entry.unitId === undefined ? {} : { unitId: entry.unitId }),
                    ...(entry.collisionScope === undefined ? {} : { collisionScope: entry.collisionScope }),
                })),
                states: [...view.filters.states],
                attention: [...view.filters.attention],
            },
            order: view.order,
            smartPolicy: { v: 1, precedence: [...view.smartPolicy.precedence] },
            view: view.view,
        })),
    };
}

export async function readTriageSavedViews(deps: Readonly<{
    catalog: Pick<TriageCatalogStoreV1, 'read'>;
    signal?: AbortSignal;
}>): Promise<CorpusSavedViewsReadV1 & Readonly<{ revision: string }>> {
    const snapshot = await deps.catalog.read(deps.signal ? { signal: deps.signal } : undefined);
    const read = parseTriageSavedViews(snapshot.value);
    return { ...read, revision: snapshot.revision };
}

function applyCommand(
    current: CorpusSavedViewsCatalogV1,
    command: CorpusSavedViewCommandV1,
    mintViewId: () => string,
): CorpusSavedViewsAppliedPlanV1 {
    if (command.kind === 'delete') {
        if (!current.views.some((view) => view.viewId === command.viewId)) return { status: 'unknownView' };
        return {
            status: 'applied',
            viewId: command.viewId,
            value: {
                v: 1,
                views: current.views.filter((view) => view.viewId !== command.viewId),
            },
        };
    }

    if (command.kind === 'update') {
        const index = current.views.findIndex((view) => view.viewId === command.viewId);
        if (index < 0) return { status: 'unknownView' };
        const parsed = readView(command.viewId, command);
        if (!parsed.ok) return { status: 'rejected', reason: parsed.reason };
        const views = [...current.views];
        views[index] = parsed.view;
        return { status: 'applied', viewId: command.viewId, value: { ...current, views } };
    }

    const viewId = mintViewId();
    const parsed = readView(viewId, command);
    if (!parsed.ok) return { status: 'rejected', reason: parsed.reason };
    return {
        status: 'applied',
        viewId,
        value: {
            v: 1,
            views: [...current.views, parsed.view],
        },
    };
}

/**
 * The one typed create/update/delete write.
 *
 * It reads the authoritative record, validates the whole resulting value, and
 * writes it against the revision it read. A losing write returns the typed
 * `conflict` and the caller re-reads: there is no last-writer-wins merge, no
 * hidden local copy, and no Collection fallback for an Account KV value.
 *
 * `conflict` means exactly one thing — the host refused this write because
 * another writer moved the revision. Every other refusal the Account KV service
 * raises, and an abort or a store failure, surfaces as itself: folding them all
 * into `conflict` would tell the user their views changed elsewhere and to
 * retry, when the write is in fact refused for a reason retrying cannot
 * resolve. The read half declines to reinterpret its failures the same way.
 */
export async function mutateTriageSavedViews(
    deps: CorpusSavedViewsDepsV1,
    command: CorpusSavedViewCommandV1,
): Promise<CorpusSavedViewsMutationResultV1> {
    const options = deps.signal ? { signal: deps.signal } : undefined;
    const snapshot = await deps.catalog.read(options);
    // The caller names the document it edited. Comparing before applying the
    // full draft closes the window the final Account KV CAS cannot see: a change
    // that landed after the editor read but before this function's own snapshot.
    if (snapshot.revision !== command.expectedRevision) return { status: 'conflict' };
    const read = parseTriageSavedViews(snapshot.value);
    // Refusing here is what keeps a newer client's views alive: this build
    // cannot merge into a value it cannot read, so it declines rather than
    // replacing it with its own idea of the set.
    if (read.kind === 'unreadable') return { status: 'unreadable' };

    const applied = applyCommand(read.value, command, deps.mintViewId);
    if (applied.status !== 'applied') return applied;

    const stored = toStoredValue(applied.value);
    if (utf8ByteLength(JSON.stringify(stored)) > MAX_TRIAGE_SAVED_VIEWS_SERIALIZED_UTF8_BYTES_V1) {
        return { status: 'rejected', reason: 'valueTooLarge' };
    }

    try {
        const mutation = await deps.catalog.write(stored, {
            expectedRevision: snapshot.revision,
            ...(deps.signal ? { signal: deps.signal } : {}),
        });
        return { ...applied, revision: mutation.revision };
    } catch (error) {
        if (isPluginError(error) && error.code === 'plugin_account_kv_conflict') {
            return { status: 'conflict' };
        }
        throw error;
    }
}

/** The retained default policy behind an unsaved lens. */
export const CORPUS_DEFAULT_SAVED_VIEW_POLICY_V1 = CORPUS_DEFAULT_SMART_POLICY_V1;
