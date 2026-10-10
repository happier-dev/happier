import type {
    SessionBoardItemWidth,
    SessionBoardItemFrameStyle,
    SessionBoardLayoutV1,
    SessionSurfaceItemV1,
} from '@happier-dev/protocol/sessions/board';

import {
    deriveSessionBoardItemState,
    type SessionBoardItemState,
} from './sessionBoardItemState';
import type {
    SessionBoardOpenedRecord,
    SessionBoardRecordFreshness,
    SessionBoardRecordLoading,
    SessionBoardRecordReachability,
} from './sessionBoardRecordOutcome';

/**
 * The viewer-facing Board model.
 *
 * It joins the two independently typed record families the Lane 08.02 repository
 * returns — one `surface/layout.v1` row and N `surface/item.v1` rows — into the one
 * snapshot every Board host renders. It owns no transport, cache, freshness
 * lifecycle or encryption: those facts arrive already decided and are passed
 * through so a host can explain them truthfully.
 *
 * Shared Board state is the layout and the items. The active view, scroll, pane
 * geometry and current executable mount are viewer-local and never enter here.
 */

/** Lane 04's projected Session capabilities. Board derives no level, role or share rule. */
export type SessionBoardCapabilities = Readonly<{
    readTranscript: boolean;
    editSessionRecords: boolean;
}>;

export type SessionBoardItemProjection = Readonly<{
    itemId: string;
    /** Opaque System Record revision to echo as expected CAS, when the row was read. */
    revision: string | null;
    state: SessionBoardItemState;
}>;

export type SessionBoardPlacementProjection = Readonly<{
    itemId: string;
    width: SessionBoardItemWidth;
    frameStyle?: SessionBoardItemFrameStyle;
    item: SessionBoardItemProjection;
}>;

export type SessionBoardViewProjection = Readonly<{
    id: string;
    /**
     * The author's own view title. `null` is the synthetic Overview, whose name is
     * localized at render rather than persisted into shared Board state.
     */
    title: string | null;
    synthetic: boolean;
    placements: readonly SessionBoardPlacementProjection[];
}>;

/** Board-level state derived from the single shared layout row. */
export type SessionBoardLayoutState =
    | Readonly<{ kind: 'loading' }>
    | Readonly<{ kind: 'ready' }>
    | Readonly<{ kind: 'locked' }>
    | Readonly<{ kind: 'unopenable'; reason: 'corrupt_or_unopenable' | 'malformed' | 'mode_mismatch' }>
    | Readonly<{ kind: 'unsupported'; version: unknown }>;

export type SessionBoardSnapshot = Readonly<{
    layoutState: SessionBoardLayoutState;
    /** Opaque layout revision to echo as expected CAS; `null` before the row exists. */
    layoutRevision: string | null;
    views: readonly SessionBoardViewProjection[];
    itemsById: ReadonlyMap<string, SessionBoardItemProjection>;
    /** Readable item records the shared layout does not place anywhere. */
    unplacedItemIds: readonly string[];
    capabilities: SessionBoardCapabilities;
    canEdit: boolean;
    freshness: SessionBoardRecordFreshness;
    reachability: SessionBoardRecordReachability;
    loading: SessionBoardRecordLoading;
    /** The record inventory is a page sequence, not a snapshot (Plan 04 §3.1). */
    incomplete: boolean;
}>;

export type SessionBoardProjectionInput = Readonly<{
    layout: SessionBoardOpenedRecord<SessionBoardLayoutV1> | undefined;
    items: ReadonlyMap<string, SessionBoardOpenedRecord<SessionSurfaceItemV1>>;
    /**
     * Lane 04's projection. `null` means the evaluator has not answered yet and
     * every authority decision fails closed; Board never guesses from membership.
     */
    capabilities: SessionBoardCapabilities | null;
    freshness: SessionBoardRecordFreshness;
    reachability: SessionBoardRecordReachability;
    loading: SessionBoardRecordLoading;
    incomplete: boolean;
}>;

export const SESSION_BOARD_OVERVIEW_VIEW_ID = 'overview';

const NO_CAPABILITIES: SessionBoardCapabilities = Object.freeze({
    readTranscript: false,
    editSessionRecords: false,
});

const EMPTY_PLACEMENTS: readonly SessionBoardPlacementProjection[] = Object.freeze([]);

const SYNTHETIC_OVERVIEW: SessionBoardViewProjection = Object.freeze({
    id: SESSION_BOARD_OVERVIEW_VIEW_ID,
    title: null,
    synthetic: true,
    placements: EMPTY_PLACEMENTS,
});

function deriveLayoutState(
    layout: SessionBoardOpenedRecord<SessionBoardLayoutV1> | undefined,
    incomplete: boolean,
): SessionBoardLayoutState {
    if (layout === undefined) {
        // No layout row is a valid empty Board once the inventory is complete.
        return incomplete ? Object.freeze({ kind: 'loading' as const }) : Object.freeze({ kind: 'ready' as const });
    }
    const outcome = layout.outcome;
    switch (outcome.status) {
        case 'ready':
            return Object.freeze({ kind: 'ready' as const });
        case 'locked':
            return Object.freeze({ kind: 'locked' as const });
        case 'unsupported_version':
            return Object.freeze({ kind: 'unsupported' as const, version: outcome.version });
        case 'corrupt_or_unopenable':
        case 'malformed':
        case 'mode_mismatch':
            return Object.freeze({ kind: 'unopenable' as const, reason: outcome.status });
    }
}

/**
 * Two states describe the same row when they agree on kind and their own
 * distinguishing fact. Ready content needs no deep comparison: the caller has
 * already checked that the opaque System Record revision is unchanged, and that
 * revision is the authoritative fence for the bytes behind it.
 */
function itemStatesEquivalent(previous: SessionBoardItemState, next: SessionBoardItemState): boolean {
    if (previous.kind !== next.kind) return false;
    if (previous.kind === 'unopenable' && next.kind === 'unopenable') return previous.reason === next.reason;
    if (previous.kind === 'unsupported' && next.kind === 'unsupported') return previous.version === next.version;
    return true;
}

function reuseItemProjection(
    previous: SessionBoardItemProjection | undefined,
    next: SessionBoardItemProjection,
): SessionBoardItemProjection {
    if (
        previous
        && previous.itemId === next.itemId
        && previous.revision === next.revision
        && itemStatesEquivalent(previous.state, next.state)
    ) {
        return previous;
    }
    return next;
}

function reusePlacements(
    previous: readonly SessionBoardPlacementProjection[] | undefined,
    next: readonly SessionBoardPlacementProjection[],
): readonly SessionBoardPlacementProjection[] {
    if (!previous || previous.length !== next.length) return next;
    const reused = next.map((placement, index) => {
        const candidate = previous[index];
        return candidate
            && candidate.itemId === placement.itemId
            && candidate.width === placement.width
            && candidate.frameStyle === placement.frameStyle
            && candidate.item === placement.item
            ? candidate
            : placement;
    });
    return reused.every((placement, index) => placement === previous[index]) ? previous : Object.freeze(reused);
}

function reuseViews(
    previous: readonly SessionBoardViewProjection[] | undefined,
    next: readonly SessionBoardViewProjection[],
): readonly SessionBoardViewProjection[] {
    if (!previous || previous.length !== next.length) return next;
    const reused = next.map((view, index) => {
        const candidate = previous[index];
        if (!candidate || candidate.id !== view.id || candidate.title !== view.title || candidate.synthetic !== view.synthetic) {
            return view;
        }
        const placements = reusePlacements(candidate.placements, view.placements);
        return placements === candidate.placements ? candidate : Object.freeze({ ...view, placements });
    });
    return reused.every((view, index) => view === previous[index]) ? previous : Object.freeze(reused);
}

/**
 * Build the Board snapshot.
 *
 * `previous` is the caller's last snapshot for the same qualified Session. Passing
 * it preserves object identity for rows whose revision and state did not change, so
 * a refresh re-renders only what actually moved.
 */
export function projectSessionBoard(
    input: SessionBoardProjectionInput,
    previous?: SessionBoardSnapshot | null,
): SessionBoardSnapshot {
    const capabilities = input.capabilities ?? NO_CAPABILITIES;
    const layoutState = deriveLayoutState(input.layout, input.incomplete);
    const inventory = Object.freeze({ complete: !input.incomplete });

    const itemsById = new Map<string, SessionBoardItemProjection>();
    const readItem = (itemId: string): SessionBoardItemProjection => {
        const existing = itemsById.get(itemId);
        if (existing) return existing;
        const record = input.items.get(itemId);
        const projection: SessionBoardItemProjection = Object.freeze({
            itemId,
            revision: record?.revision ?? null,
            state: deriveSessionBoardItemState(record, inventory),
        });
        const reused = reuseItemProjection(previous?.itemsById.get(itemId), projection);
        itemsById.set(itemId, reused);
        return reused;
    };

    const layoutValue = input.layout?.outcome.status === 'ready' ? input.layout.outcome.value : null;
    const placedItemIds = new Set<string>();
    const projectedViews: SessionBoardViewProjection[] = (layoutValue?.tabs ?? []).map((tab) => {
        const placements = tab.items.map((placement) => {
            placedItemIds.add(placement.itemId);
            return Object.freeze({
                itemId: placement.itemId,
                width: placement.width,
                ...(placement.frameStyle === undefined ? {} : { frameStyle: placement.frameStyle }),
                item: readItem(placement.itemId),
            });
        });
        return Object.freeze({
            id: tab.id,
            title: tab.title,
            synthetic: false,
            placements: Object.freeze(placements),
        });
    });

    for (const itemId of input.items.keys()) readItem(itemId);

    // An unreadable or absent layout still has a Board to show: the synthetic
    // Overview keeps the host from inventing a different empty shape per surface.
    const views = projectedViews.length > 0 ? Object.freeze(projectedViews) : Object.freeze([SYNTHETIC_OVERVIEW]);

    const unplacedItemIds = Object.freeze(
        [...input.items.keys()].filter((itemId) => {
            if (placedItemIds.has(itemId)) return false;
            const record = input.items.get(itemId);
            return record?.outcome.status === 'ready'
                && (record.outcome.value.destination ?? 'board') === 'board';
        }),
    );

    return Object.freeze({
        layoutState,
        layoutRevision: input.layout?.revision ?? null,
        views: reuseViews(previous?.views, views),
        itemsById: previous?.itemsById.size === itemsById.size
            && [...itemsById].every(([id, item]) => previous.itemsById.get(id) === item)
            ? previous.itemsById : itemsById,
        unplacedItemIds: previous?.unplacedItemIds.length === unplacedItemIds.length
            && unplacedItemIds.every((id, index) => previous.unplacedItemIds[index] === id)
            ? previous.unplacedItemIds : unplacedItemIds,
        capabilities,
        canEdit: capabilities.editSessionRecords,
        freshness: input.freshness,
        reachability: input.reachability,
        loading: input.loading,
        incomplete: input.incomplete,
    });
}

/** Referentially stable lookup of one Board view. */
export function selectSessionBoardView(
    snapshot: SessionBoardSnapshot,
    viewId: string | null | undefined,
): SessionBoardViewProjection {
    if (viewId) {
        const match = snapshot.views.find((view) => view.id === viewId);
        if (match) return match;
    }
    return snapshot.views[0] ?? SYNTHETIC_OVERVIEW;
}

/**
 * Resolve the viewer's active Board view. A remote view removal falls back to the
 * first view instead of leaving the person on a view that no longer exists; the
 * requested id is never written back to shared Board state.
 */
export function resolveActiveSessionBoardViewId(
    snapshot: SessionBoardSnapshot,
    requestedViewId: string | null | undefined,
): string {
    return selectSessionBoardView(snapshot, requestedViewId).id;
}

/**
 * The state of a viewer-local reference (Companion entry, inline transcript
 * result) to a Board item. A complete Board that does not contain the item proves
 * removal; an incomplete one only proves the page has not arrived.
 */
export function resolveSessionBoardReferenceState(
    snapshot: SessionBoardSnapshot,
    itemId: string,
): SessionBoardItemState {
    const projection = snapshot.itemsById.get(itemId);
    if (projection) return projection.state;
    return snapshot.incomplete
        ? Object.freeze({ kind: 'loading' as const })
        : Object.freeze({ kind: 'removed' as const });
}

/**
 * The same viewer-local reference as one projected row, so a Companion entry or an
 * inline transcript result renders through the SAME item shell and state table as
 * a placed Board card instead of growing its own status ladder. An item the
 * snapshot already carries keeps its exact projection identity, which is what lets
 * an unchanged row skip a rerender.
 */
export function resolveSessionBoardReferenceProjection(
    snapshot: SessionBoardSnapshot,
    itemId: string,
): SessionBoardItemProjection {
    return snapshot.itemsById.get(itemId)
        ?? Object.freeze({
            itemId,
            revision: null,
            state: resolveSessionBoardReferenceState(snapshot, itemId),
        });
}

/** The Board views strip is chrome only when the person has more than Overview. */
export function shouldRenderSessionBoardViewStrip(snapshot: SessionBoardSnapshot): boolean {
    return snapshot.views.length > 1;
}

/** True when a readable Board genuinely has no content to show yet. */
export function isSessionBoardEmpty(snapshot: SessionBoardSnapshot): boolean {
    return snapshot.layoutState.kind === 'ready'
        && !snapshot.incomplete
        && snapshot.itemsById.size === 0;
}
