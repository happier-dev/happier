import type { SessionSurfaceItemV1 } from '@happier-dev/protocol/sessions/board';

import type { SessionBoardItemProjection, SessionBoardSnapshot } from '@/sync/domains/session/board';
import { resolveSessionBoardItemTitle } from '@/components/sessions/board/sessionBoardItemPresentation';
import type { SessionBoardBinding, SessionBoardBindingUnavailableReason } from '@/components/sessions/board/observeSessionBoard';

import { selectWidgetCandidates, type WidgetCandidate } from '@/components/widgets/widgetCatalog';
import type { SessionPluginRuntimeState } from '@/components/sessions/plugins/useSessionPluginRuntime';
import { RIGHT_SIDEBAR_BUILTIN_TABS } from '@/components/appShell/rightSidebar/rightSidebarBuiltinTabs';
import { resolveRightSidebarPluginTabs } from '@/components/appShell/rightSidebar/rightSidebarPluginTabs';
import { selectPluginRightSidebarTabPlacements } from '@/sync/domains/plugins/ui/surfacePlacementSelectors';

import {
    SESSION_COMPANION_BUILTIN_ITEM_IDS,
    type SessionCompanionBuiltinItemId,
    type SessionCompanionItemRefV1,
} from './state/sessionCompanionPreference';

export type SessionCompanionAddableItem = Readonly<{
    widgetId: string;
    title: string;
    source: SessionSurfaceItemV1['source'];
    /** Already kept in this Companion: shown in place, marked, never re-added. */
    added: boolean;
}>;

function selectedWidgetIds(refs: readonly SessionCompanionItemRefV1[]): ReadonlySet<string> {
    return new Set(refs.flatMap((ref) => (ref.kind === 'widget' ? [ref.widgetId] : [])));
}

/**
 * Projects every currently readable Board item for the local picker, each marked
 * whether this Companion already keeps it, so the list never reflows when one is
 * added. Both rail and full surface consume this one projection, so neither can
 * impose a different arbitrary count limit or title rule.
 */
export function resolveSessionCompanionAddableItems(input: Readonly<{
    snapshot: SessionBoardSnapshot | null;
    refs: readonly SessionCompanionItemRefV1[];
}>): readonly SessionCompanionAddableItem[] {
    if (!input.snapshot) return Object.freeze([]);
    const selected = selectedWidgetIds(input.refs);
    const candidates: SessionCompanionAddableItem[] = [];
    for (const [widgetId, item] of input.snapshot.itemsById) {
        if (item.state.kind !== 'ready') continue;
        candidates.push(Object.freeze({
            widgetId,
            title: resolveSessionBoardItemTitle(item.state),
            source: item.state.item.source,
            added: selected.has(widgetId),
        }));
    }
    return Object.freeze(candidates);
}

export type SessionCompanionPickerPluginRow = Readonly<{
    key: string;
    candidate: WidgetCandidate;
    added: boolean;
}>;

export type SessionCompanionPickerSections = Readonly<{
    builtIn: readonly Readonly<{ id: SessionCompanionBuiltinItemId; added: boolean }>[];
    /** Shared Board items remain independent references, including configured plugin copies. */
    board: readonly SessionCompanionAddableItem[];
    plugins: readonly SessionCompanionPickerPluginRow[];
}>;

/**
 * The Add to Companion picker: one widget system with three sources.
 *
 * Existing Board records remain available as references, while compact plugin
 * surfaces can be kept as independent personal instances without creating a shared Board record.
 * `candidates` comes from the canonical universal widget selector; this projection
 * adds no physical-placement availability policy.
 */
export function resolveSessionCompanionPickerSections(input: Readonly<{
    refs: readonly SessionCompanionItemRefV1[];
    snapshot: SessionBoardSnapshot | null;
    candidates: readonly WidgetCandidate[];
}>): SessionCompanionPickerSections {
    const builtIn = SESSION_COMPANION_BUILTIN_ITEM_IDS.map((id) => Object.freeze({
        id,
        added: input.refs.some((ref) => ref.kind === 'builtin' && ref.id === id),
    }));
    const board = resolveSessionCompanionAddableItems({ snapshot: input.snapshot, refs: input.refs });
    const plugins = input.candidates.map((candidate) => Object.freeze({ key: candidate.key, candidate, added: false }));
    return Object.freeze({
        builtIn: Object.freeze(builtIn),
        board: Object.freeze(board),
        plugins: Object.freeze(plugins),
    });
}

/**
 * How much the exact Board repository currently knows about this Session's items.
 *
 * Only `authoritative` proves absence. Everything else means "not resolved yet",
 * which is why the Companion has a distinct pending state: a paging, offline or
 * unauthorized inventory must never be relabelled "this widget was removed".
 */
export type SessionCompanionBoardInventory =
    | Readonly<{ kind: 'authoritative' }>
    | Readonly<{ kind: 'loading' }>
    | Readonly<{ kind: 'offline' }>
    | Readonly<{ kind: 'locked' }>
    | Readonly<{
        kind: 'unavailable';
        reason: SessionBoardBindingUnavailableReason | 'unopenable' | 'unsupported';
    }>
    | Readonly<{ kind: 'revoked' }>;

const AUTHORITATIVE_INVENTORY = Object.freeze({ kind: 'authoritative' as const });
const LOADING_INVENTORY = Object.freeze({ kind: 'loading' as const });
const OFFLINE_INVENTORY = Object.freeze({ kind: 'offline' as const });
const LOCKED_INVENTORY = Object.freeze({ kind: 'locked' as const });
const REVOKED_INVENTORY = Object.freeze({ kind: 'revoked' as const });

export type SessionCompanionContentItem =
    | Readonly<{
        kind: 'summary';
        ref: Extract<SessionCompanionItemRefV1, { kind: 'builtin' | 'instance' }>;
    }>
    | Readonly<{
        kind: 'plan';
        ref: Extract<SessionCompanionItemRefV1, { kind: 'builtin' | 'instance' }>;
    }>
    | Readonly<{
        kind: 'changes' | 'local_services';
        ref: Extract<SessionCompanionItemRefV1, { kind: 'builtin' | 'instance' }>;
    }>
    | Readonly<{
        kind: 'pane';
        ref: Extract<SessionCompanionItemRefV1, { kind: 'pane' }>;
    }>
    | Readonly<{
        kind: 'instance';
        ref: Extract<SessionCompanionItemRefV1, { kind: 'instance' }>;
    }>
    | Readonly<{
        kind: 'widget';
        ref: Extract<SessionCompanionItemRefV1, { kind: 'widget' }>;
        item: SessionBoardItemProjection;
    }>
    | Readonly<{
        kind: 'pending_widget';
        ref: Extract<SessionCompanionItemRefV1, { kind: 'widget' }>;
        inventory: Exclude<SessionCompanionBoardInventory, { kind: 'authoritative' }>;
    }>
    | Readonly<{
        kind: 'missing_widget';
        ref: Extract<SessionCompanionItemRefV1, { kind: 'widget' }>;
    }>;

/**
 * Reads the Board binding's own completeness facts. The Companion adds no second
 * freshness model: it only distinguishes "the canonical repository has told us
 * everything" from "it has not".
 */
export function resolveSessionCompanionBoardInventory(
    binding: SessionBoardBinding | null,
): SessionCompanionBoardInventory {
    if (!binding) return LOADING_INVENTORY;
    if (binding.status === 'unavailable') {
        if (binding.reason === 'forbidden' || binding.reason === 'not_found') {
            return REVOKED_INVENTORY;
        }
        if (binding.reason === 'offline' || binding.reason === 'server_error' || binding.reason === 'invalid_response') {
            return OFFLINE_INVENTORY;
        }
        return Object.freeze({ kind: 'unavailable', reason: binding.reason });
    }
    const snapshot = binding.snapshot;
    if (snapshot.layoutState.kind === 'locked') return LOCKED_INVENTORY;
    if (snapshot.layoutState.kind === 'unopenable') {
        return Object.freeze({ kind: 'unavailable', reason: 'unopenable' });
    }
    if (snapshot.layoutState.kind === 'unsupported') {
        return Object.freeze({ kind: 'unavailable', reason: 'unsupported' });
    }
    if (snapshot.layoutState.kind === 'loading' || snapshot.incomplete || snapshot.loading !== 'idle') {
        return LOADING_INVENTORY;
    }
    // Freshness is not availability: a stale-but-reachable snapshot still carries its
    // item rows, and the `incomplete`/`loading` arms above already cover the genuinely
    // unknown case. Every other Board consumer keys this on reachability alone.
    if (snapshot.reachability !== 'reachable') {
        return OFFLINE_INVENTORY;
    }
    return AUTHORITATIVE_INVENTORY;
}

/**
 * Joins presentation-only references to the canonical Board projection.
 *
 * Missing records remain visible as recoverable local references; this owner
 * never prunes or replaces them and never copies shared item content. An absent
 * record is terminal ONLY when the exact Board repository has an authoritative
 * inventory — otherwise it is pending, so a slow page, an offline Home or a
 * refused read cannot masquerade as a deletion.
 */
export function resolveSessionCompanionContentItems(input: Readonly<{
    refs: readonly SessionCompanionItemRefV1[];
    boardItemsById: ReadonlyMap<string, SessionBoardItemProjection>;
    inventory: SessionCompanionBoardInventory;
}>): readonly SessionCompanionContentItem[] {
    return Object.freeze(input.refs.map((ref): SessionCompanionContentItem => {
        if (ref.kind === 'builtin') {
            const kind = ref.id === 'agent_plan' ? 'plan' : ref.id === 'session_summary' ? 'summary' : ref.id;
            return Object.freeze({ kind, ref });
        }
        if (ref.kind === 'pane') return Object.freeze({ kind: 'pane', ref });
        if (ref.kind === 'instance') {
            return Object.freeze({ kind: 'instance', ref });
        }
        const item = input.boardItemsById.get(ref.widgetId);
        if (item) return Object.freeze({ kind: 'widget', ref, item });
        return input.inventory.kind === 'authoritative'
            ? Object.freeze({ kind: 'missing_widget', ref })
            : Object.freeze({ kind: 'pending_widget', ref, inventory: input.inventory });
    }));
}

/** Add admission consumes the existing pane/widget catalogs. Saved unavailable refs are never pruned here. */
export function canAddSessionCompanionItem(
    item: SessionCompanionItemRefV1,
    runtime: SessionPluginRuntimeState | null,
    canReadBoardItem: (widgetId: string) => boolean = () => false,
): boolean {
    if (item.kind === 'builtin') return true;
    if (item.kind === 'widget') return canReadBoardItem(item.widgetId);
    if (item.kind === 'instance' && item.instance.definition.kind === 'builtin') {
        const definition = item.instance.definition;
        return SESSION_COMPANION_BUILTIN_ITEM_IDS.some((id) => id === definition.id);
    }
    if (item.kind === 'pane' && RIGHT_SIDEBAR_BUILTIN_TABS.some((tab) => tab.id === item.paneId && tab.scopes.includes('session'))) return true;
    if (runtime?.phase !== 'current' || !runtime.pluginUiProjection) return false;
    if (item.kind === 'instance') {
        const definition = item.instance.definition;
        return definition.kind === 'installed' && selectWidgetCandidates(runtime.pluginUiProjection)
            .some((candidate) => candidate.surface?.pluginId === definition.surface.pluginId && candidate.surface.localId === definition.surface.localId);
    }
    return resolveRightSidebarPluginTabs({ scope: 'session', placements: selectPluginRightSidebarTabPlacements(runtime.pluginUiProjection, 'session') })
        .some((tab) => tab.id === item.paneId);
}
