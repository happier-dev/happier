import { isPluginError } from '@happier-dev/plugin-sdk';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import type { PluginContributionIdentity } from '@happier-dev/plugin-sdk/manifest';
import type { ScopedSettingsService } from '@happier-dev/plugin-sdk/settings';
import {
    MAX_TRIAGE_COLLISION_SCOPE_UTF8_BYTES_V1,
    MAX_TRIAGE_IDENTIFIER_UTF8_BYTES_V1,
    normalizeTriageSingleLineV1,
} from '@happier-dev/triage-protocol/v1';

import {
    CORPUS_DEFAULT_SMART_POLICY_V1,
    parseCorpusSmartPolicy,
    type CorpusSmartPolicyV1,
} from '../corpus/query/smartPolicy.js';
import type {
    CorpusAttentionFilterValueV1,
    CorpusScopeFilterValueV1,
    CorpusSourceFilterValueV1,
    CorpusStateFilterValueV1,
    CorpusTypeFilterValueV1,
    SurfaceFilterSelectionV1,
    TriageListOrderV1,
} from '../projection/listWindow.js';

import { readExactKeys } from './storedValue.js';

/**
 * The sole `triage.savedViews` owner: one typed Account Settings value, read,
 * validated and written in one place.
 *
 * Saved views are genuine durable user state — one of only four things Triage
 * persists — so they carry the same discipline as a pin. A view is addressed by
 * its own minted opaque id and never by its position or its label, so renaming
 * a view, reordering the set, or saving two views under one name can never
 * silently move the user's selection onto a different lens. Selection is durable
 * account preference: on restart the shell re-reads `selectedViewId` and applies
 * the named view exactly.
 *
 * The lens it stores is **source-neutral**. Every facet value is a canonical
 * private identity — an admitted qualified source, a source-neutral `kindId`, an
 * exact `(source, collisionScope)` pair, the canonical lane/presence fold, and
 * the one displayed-attention result. There is no derived storage tag anywhere
 * in it: a persisted tag would be a mode-dependent locator that an Account rekey
 * silently invalidates, and a view expressible only by naming a provider concept
 * would be source vocabulary leaking into the aggregate.
 *
 * It is neither a generic Settings manager nor a materialization authority.
 * Materialization has no Settings value at all, so a view edit can never contend
 * with or become a refresh command.
 */

/** The one versioned Account Settings key this document owns. */
export const TRIAGE_SAVED_VIEWS_SETTING_ID_V1 = 'triage.savedViews';

/** At most this many views: this is one Settings value, not one Settings field per view. */
export const MAX_TRIAGE_SAVED_VIEWS_V1 = 32;
/** Label bound, measured in UTF-8 bytes after trimming, not in characters. */
export const MAX_TRIAGE_SAVED_VIEW_LABEL_UTF8_BYTES_V1 = 128;
/** Values in each of the five filter facets. */
export const MAX_TRIAGE_SAVED_VIEW_FACET_VALUES_V1 = 16;
/**
 * The whole serialized `triage.savedViews` value.
 *
 * It is measured over the complete value rather than per member, because a set
 * of individually valid views is exactly how a Settings record overflows. The
 * generic Account-document structural ceiling is a host safeguard around every
 * Settings value and is deliberately not restated here: it is not this key's
 * bound, and treating its 256-member limit as "256 views" would be wrong by an
 * order of magnitude.
 */
export const MAX_TRIAGE_SAVED_VIEWS_SERIALIZED_UTF8_BYTES_V1 = 64 * 1024;

export type CorpusSavedViewV1 = Readonly<{
    /** Target-minted opaque id; neither an entry/source identity nor a storage tag. */
    viewId: string;
    label: string;
    filters: SurfaceFilterSelectionV1;
    order: TriageListOrderV1;
    /** Retained across a non-Smart order switch, consumed only when `order === 'smart'`. */
    smartPolicy: CorpusSmartPolicyV1;
}>;

export type CorpusSavedViewsSettingV1 = Readonly<{
    v: 1;
    views: readonly CorpusSavedViewV1[];
    /** `null` selects the deterministic unsaved default; otherwise it names exactly one member. */
    selectedViewId: string | null;
}>;

/** The parsed absence and the effective default lens behind it. */
export const CORPUS_EMPTY_SAVED_VIEWS_V1: CorpusSavedViewsSettingV1 = Object.freeze({
    v: 1,
    views: Object.freeze([]),
    selectedViewId: null,
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
    value: CorpusSavedViewsSettingV1;
}>;

export type CorpusSavedViewsRejectionV1 =
    | 'label'
    | 'viewLimit'
    | 'facetLimit'
    | 'duplicateFacetValue'
    | 'filterValue'
    | 'order'
    | 'smartPolicy'
    | 'valueTooLarge';

export type CorpusSavedViewsMutationResultV1 =
    | Readonly<{ status: 'applied'; viewId: string | null; value: CorpusSavedViewsSettingV1 }>
    /** Another writer won; the caller re-reads rather than forcing its value. */
    | Readonly<{ status: 'conflict' }>
    | Readonly<{ status: 'unknownView' }>
    | Readonly<{ status: 'unreadable' }>
    | Readonly<{ status: 'rejected'; reason: CorpusSavedViewsRejectionV1 }>;

export type CorpusSavedViewDraftV1 = Readonly<{
    label: string;
    filters: SurfaceFilterSelectionV1;
    order: TriageListOrderV1;
    smartPolicy: CorpusSmartPolicyV1;
}>;

export type CorpusSavedViewCommandV1 =
    | (CorpusSavedViewDraftV1 & Readonly<{ kind: 'create'; select?: boolean }>)
    | (CorpusSavedViewDraftV1 & Readonly<{ kind: 'update'; viewId: string }>)
    | Readonly<{ kind: 'delete'; viewId: string }>
    | Readonly<{ kind: 'select'; viewId: string | null }>;

export type CorpusSavedViewsDepsV1 = Readonly<{
    settings: Pick<ScopedSettingsService, 'snapshot' | 'set'>;
    /** The opaque view id is minted only here, and only for a create. */
    mintViewId: () => string;
    signal?: AbortSignal;
}>;

const encoder = new TextEncoder();

function utf8ByteLength(value: string): number {
    return encoder.encode(value).byteLength;
}

const ORDERS: readonly TriageListOrderV1[] = Object.freeze(['newest', 'oldest', 'smart']);
const STATES: readonly CorpusStateFilterValueV1[] = Object.freeze(['open', 'done', 'absent', 'unresolved']);
const ATTENTION: readonly CorpusAttentionFilterValueV1[] = Object.freeze(['required', 'suggested', 'none']);

function readBoundedString(value: unknown, maxUtf8Bytes: number): string | null {
    if (typeof value !== 'string') return null;
    // The canonical single-line rule, so a saved label cannot carry a control
    // character that costs one byte here and six once JSON escapes it.
    const normalized = normalizeTriageSingleLineV1(value);
    if (normalized.length === 0) return null;
    return utf8ByteLength(normalized) > maxUtf8Bytes ? null : normalized;
}

function readSource(value: unknown): PluginContributionIdentity | null {
    const candidate = readExactKeys(value, ['pluginId', 'localId']);
    if (!candidate) return null;
    const pluginId = readBoundedString(candidate.pluginId, MAX_TRIAGE_IDENTIFIER_UTF8_BYTES_V1);
    const localId = readBoundedString(candidate.localId, MAX_TRIAGE_IDENTIFIER_UTF8_BYTES_V1);
    return pluginId === null || localId === null ? null : { pluginId, localId };
}

function readSourceValue(value: unknown): CorpusSourceFilterValueV1 | null {
    const candidate = readExactKeys(value, ['source']);
    if (!candidate) return null;
    const source = readSource(candidate.source);
    return source === null ? null : { source };
}

function readTypeValue(value: unknown): CorpusTypeFilterValueV1 | null {
    const candidate = readExactKeys(value, ['source', 'kindId']);
    if (!candidate) return null;
    const source = readSource(candidate.source);
    const kindId = readBoundedString(candidate.kindId, MAX_TRIAGE_IDENTIFIER_UTF8_BYTES_V1);
    return source === null || kindId === null ? null : { source, kindId };
}

function readScopeValue(value: unknown): CorpusScopeFilterValueV1 | null {
    const candidate = readExactKeys(value, ['source', 'collisionScope']);
    if (!candidate) return null;
    const source = readSource(candidate.source);
    const collisionScope = typeof candidate.collisionScope === 'string'
        && candidate.collisionScope.length > 0
        && utf8ByteLength(candidate.collisionScope) <= MAX_TRIAGE_COLLISION_SCOPE_UTF8_BYTES_V1
        ? candidate.collisionScope
        : null;
    return source === null || collisionScope === null ? null : { source, collisionScope };
}

/**
 * The canonical identity of one facet value, used only to reject duplicates.
 *
 * Components are framed as an array rather than joined, because `U+001F` is
 * representable inside `collisionScope`: a delimiter join would make two
 * contract-valid distinct scopes compare equal and silently drop one of them.
 */
function facetIdentity(value: unknown): string {
    if (typeof value === 'string') return JSON.stringify([value]);
    const candidate = value as Readonly<Record<string, unknown>>;
    const source = candidate.source as PluginContributionIdentity | undefined;
    return JSON.stringify([
        source?.pluginId ?? null,
        source?.localId ?? null,
        candidate.kindId ?? null,
        candidate.collisionScope ?? null,
    ]);
}

type FacetOutcome<TValue> =
    | Readonly<{ ok: true; values: readonly TValue[] }>
    | Readonly<{ ok: false; reason: CorpusSavedViewsRejectionV1 }>;

function readFacet<TValue>(
    raw: unknown,
    read: (value: unknown) => TValue | null,
): FacetOutcome<TValue> {
    if (!Array.isArray(raw)) return { ok: false, reason: 'filterValue' };
    if (raw.length > MAX_TRIAGE_SAVED_VIEW_FACET_VALUES_V1) return { ok: false, reason: 'facetLimit' };
    const values: TValue[] = [];
    const seen = new Set<string>();
    for (const member of raw) {
        const parsed = read(member);
        if (parsed === null) return { ok: false, reason: 'filterValue' };
        const identity = facetIdentity(parsed);
        if (seen.has(identity)) return { ok: false, reason: 'duplicateFacetValue' };
        seen.add(identity);
        values.push(parsed);
    }
    return { ok: true, values };
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
    const candidate = readExactKeys(raw, ['sources', 'types', 'scopes', 'states', 'attention']);
    if (!candidate) return { ok: false, reason: 'filterValue' };
    const sources = readFacet(candidate.sources, readSourceValue);
    if (!sources.ok) return sources;
    const types = readFacet(candidate.types, readTypeValue);
    if (!types.ok) return types;
    const scopes = readFacet(candidate.scopes, readScopeValue);
    if (!scopes.ok) return scopes;
    const states = readFacet(candidate.states, readClosedValue(STATES));
    if (!states.ok) return states;
    const attention = readFacet(candidate.attention, readClosedValue(ATTENTION));
    if (!attention.ok) return attention;
    return {
        ok: true,
        filters: {
            sources: sources.values,
            types: types.values,
            scopes: scopes.values,
            states: states.values,
            attention: attention.values,
        },
    };
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
    filters: unknown;
    order: unknown;
    smartPolicy: unknown;
}>): ViewOutcome {
    const label = readBoundedString(draft.label, MAX_TRIAGE_SAVED_VIEW_LABEL_UTF8_BYTES_V1);
    if (label === null) return { ok: false, reason: 'label' };
    const order = readClosedValue(ORDERS)(draft.order);
    if (order === null) return { ok: false, reason: 'order' };
    const smartPolicy = parseCorpusSmartPolicy(draft.smartPolicy);
    if (smartPolicy === null) return { ok: false, reason: 'smartPolicy' };
    const filters = readFilters(draft.filters);
    if (!filters.ok) return filters;
    return { ok: true, view: { viewId, label, filters: filters.filters, order, smartPolicy } };
}

/** A minted view id must look like one: it is opaque, but it is not free-form. */
const VIEW_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/**
 * Parse one stored value.
 *
 * Any member this build cannot understand makes the whole value `unreadable`
 * rather than dropping that member: silently discarding one view would lose
 * durable user state with no upstream owner to recover it from. A
 * `selectedViewId` naming no stored view is the one honest exception — the view
 * was deleted elsewhere, so the selection is cleared rather than restored.
 */
export function parseTriageSavedViews(raw: unknown): CorpusSavedViewsReadV1 {
    if (raw === undefined || raw === null) return { kind: 'absent', value: CORPUS_EMPTY_SAVED_VIEWS_V1 };
    const unreadable: CorpusSavedViewsReadV1 = { kind: 'unreadable', value: CORPUS_EMPTY_SAVED_VIEWS_V1 };
    // The whole-value byte bound is read back as well as written. A reader that
    // accepted what its own writer refuses is what would let a stored value this
    // build never produced return an Action result past the host's 1 MiB gate —
    // and that gate rejects the result whole, so the user would lose the saved
    // views entirely instead of seeing the honest `unreadable` answer.
    if (typeof raw !== 'object') return unreadable;
    if (utf8ByteLength(JSON.stringify(raw)) > MAX_TRIAGE_SAVED_VIEWS_SERIALIZED_UTF8_BYTES_V1) {
        return unreadable;
    }
    const candidate = readExactKeys(raw, ['v', 'views', 'selectedViewId']);
    if (!candidate || candidate.v !== 1 || !Array.isArray(candidate.views)) return unreadable;
    if (candidate.views.length > MAX_TRIAGE_SAVED_VIEWS_V1) return unreadable;
    if (candidate.selectedViewId !== null && typeof candidate.selectedViewId !== 'string') return unreadable;

    const views: CorpusSavedViewV1[] = [];
    const ids = new Set<string>();
    for (const member of candidate.views) {
        const view = readExactKeys(member, ['viewId', 'label', 'filters', 'order', 'smartPolicy']);
        if (!view || typeof view.viewId !== 'string' || !VIEW_ID_PATTERN.test(view.viewId)) return unreadable;
        if (ids.has(view.viewId)) return unreadable;
        ids.add(view.viewId);
        const parsed = readView(view.viewId, {
            label: view.label,
            filters: view.filters,
            order: view.order,
            smartPolicy: view.smartPolicy,
        });
        if (!parsed.ok) return unreadable;
        views.push(parsed.view);
    }

    const selectedViewId = typeof candidate.selectedViewId === 'string' && ids.has(candidate.selectedViewId)
        ? candidate.selectedViewId
        : null;
    return { kind: 'parsed', value: { v: 1, views, selectedViewId } };
}

/**
 * Project the validated value to the exact JSON that is stored.
 *
 * The value is rebuilt member by member rather than passed through, so nothing
 * the validator did not admit — a derived tag, a stray display value, an
 * unparsed policy — can ride into durable Account state.
 */
function toStoredValue(value: CorpusSavedViewsSettingV1): JsonValue {
    return {
        v: 1,
        views: value.views.map((view) => ({
            viewId: view.viewId,
            label: view.label,
            filters: {
                sources: view.filters.sources.map((entry) => ({ source: { ...entry.source } })),
                types: view.filters.types.map((entry) => ({
                    source: { ...entry.source },
                    kindId: entry.kindId,
                })),
                scopes: view.filters.scopes.map((entry) => ({
                    source: { ...entry.source },
                    collisionScope: entry.collisionScope,
                })),
                states: [...view.filters.states],
                attention: [...view.filters.attention],
            },
            order: view.order,
            smartPolicy: { v: 1, precedence: [...view.smartPolicy.precedence] },
        })),
        selectedViewId: value.selectedViewId,
    };
}

export async function readTriageSavedViews(deps: Readonly<{
    settings: Pick<ScopedSettingsService, 'snapshot'>;
    signal?: AbortSignal;
}>): Promise<CorpusSavedViewsReadV1 & Readonly<{ revision: string }>> {
    const snapshot = await deps.settings.snapshot(deps.signal ? { signal: deps.signal } : undefined);
    const read = parseTriageSavedViews(snapshot.values[TRIAGE_SAVED_VIEWS_SETTING_ID_V1]);
    return { ...read, revision: snapshot.revision };
}

function applyCommand(
    current: CorpusSavedViewsSettingV1,
    command: CorpusSavedViewCommandV1,
    mintViewId: () => string,
): CorpusSavedViewsMutationResultV1 {
    if (command.kind === 'select') {
        if (command.viewId !== null && !current.views.some((view) => view.viewId === command.viewId)) {
            return { status: 'unknownView' };
        }
        return {
            status: 'applied',
            viewId: command.viewId,
            value: { ...current, selectedViewId: command.viewId },
        };
    }

    if (command.kind === 'delete') {
        if (!current.views.some((view) => view.viewId === command.viewId)) return { status: 'unknownView' };
        return {
            status: 'applied',
            viewId: command.viewId,
            value: {
                v: 1,
                views: current.views.filter((view) => view.viewId !== command.viewId),
                // Deleting the selected view clears the selection in the same
                // write: a dangling selection would restore a view that no
                // longer exists on the next start.
                selectedViewId: current.selectedViewId === command.viewId ? null : current.selectedViewId,
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

    if (current.views.length >= MAX_TRIAGE_SAVED_VIEWS_V1) return { status: 'rejected', reason: 'viewLimit' };
    const viewId = mintViewId();
    const parsed = readView(viewId, command);
    if (!parsed.ok) return { status: 'rejected', reason: parsed.reason };
    return {
        status: 'applied',
        viewId,
        value: {
            v: 1,
            views: [...current.views, parsed.view],
            selectedViewId: command.select === true ? viewId : current.selectedViewId,
        },
    };
}

/**
 * The one typed create/update/delete/select write.
 *
 * It reads the authoritative record, validates the whole resulting value, and
 * writes it against the revision it read. A losing write returns the typed
 * `conflict` and the caller re-reads: there is no last-writer-wins merge, no
 * hidden local copy, and no Collection fallback for a Settings value.
 *
 * `conflict` means exactly one thing — the host refused this write because
 * another writer moved the revision. Every other refusal the Settings service
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
    const snapshot = await deps.settings.snapshot(options);
    const read = parseTriageSavedViews(snapshot.values[TRIAGE_SAVED_VIEWS_SETTING_ID_V1]);
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
        await deps.settings.set(TRIAGE_SAVED_VIEWS_SETTING_ID_V1, stored, {
            expectedRevision: snapshot.revision,
            ...(deps.signal ? { signal: deps.signal } : {}),
        });
    } catch (error) {
        if (isPluginError(error) && error.code === 'plugin_settings_revision_conflict') {
            return { status: 'conflict' };
        }
        throw error;
    }
    return applied;
}

/** The retained default policy behind an unsaved lens. */
export const CORPUS_DEFAULT_SAVED_VIEW_POLICY_V1 = CORPUS_DEFAULT_SMART_POLICY_V1;
