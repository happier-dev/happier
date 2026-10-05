import { entityDragScopesEqualV1, type EntityDragItemV1, type EntityDragScopeV1, type EntityDropAdmissionV1, type EntityDropPreviewV1 } from '@happier-dev/protocol/plugins/ui';
import type { SessionCompanionPresentationItemRefV1 } from '@happier-dev/protocol/sessions';
import type { SessionBoardSnapshot } from '@/sync/domains/session/board';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import { sessionCompanionItemKey } from '../companion/state/sessionCompanionPreference';
import { t } from '@/text';
import { widgetEntitySourceRef } from '@/sync/ops/actions/widgetEntityMovement';
import type { WidgetInstanceRefV1 } from '@happier-dev/protocol/widgets';

type Context = Readonly<{ item: EntityDragItemV1; scope: EntityDragScopeV1; address: SessionAddress; board: SessionBoardSnapshot | null; preview: EntityDropPreviewV1; widgetSourceRef?: WidgetInstanceRefV1 | null }>;
export function sessionSurfaceDropRefused(code: string): Extract<EntityDropAdmissionV1, { status: 'refused' }> {
    const message = code === 'same-position' || code === 'already-kept' || code === 'already-placed' ? t('entityDragDrop.reasons.noChange')
        : code === 'scope-mismatch' ? t('entityDragDrop.surface.scopeMismatch')
        : code === 'widget-placement-unavailable' || code === 'unsupported-kind' ? t('entityDragDrop.surface.widgetMoveUnavailable')
        : code === 'board-read-only' ? t('entityDragDrop.surface.readOnly')
        : t('entityDragDrop.reasons.gone');
    return { status: 'refused', reason: { code, message } };
}
function exactSession(input: Context): boolean {
    return entityDragScopesEqualV1(input.item.scope, input.scope) && 'address' in input.item
        && input.item.address.serverId === input.address.serverId && input.item.address.sessionId === input.address.sessionId;
}
function readableBoardPlacement(input: Context, item: Extract<EntityDragItemV1, { kind: 'session-board-item' }>): boolean {
    return input.board?.reachability === 'reachable' && input.board.itemsById.get(item.itemId)?.state.kind === 'ready'
        && input.board.views.some(view => view.id === item.viewId && view.placements.some(placement => placement.itemId === item.itemId));
}

/** A drag carries identity; the existing layout Action owns placement and revision/CAS. */
export function resolveSessionBoardEntityDrop(input: Context & Readonly<{ viewId: string; anchor?: Readonly<{ side: 'before' | 'after'; itemId: string }> }>): EntityDropAdmissionV1 {
    const configuredRef = widgetEntitySourceRef(input.item);
    if (configuredRef && (input.item.kind !== 'session-board-item' || input.item.address.sessionId !== input.address.sessionId && input.widgetSourceRef)) {
        if (!entityDragScopesEqualV1(input.item.scope, input.scope)) return sessionSurfaceDropRefused('scope-mismatch');
        const target = input.board?.views.find(view => view.id === input.viewId && !view.synthetic);
        if (!target || input.board?.reachability !== 'reachable') return sessionSurfaceDropRefused('target-gone');
        if (!input.board.canEdit) return sessionSurfaceDropRefused('board-read-only');
        const index = input.anchor ? target.placements.findIndex(placement => placement.itemId === input.anchor!.itemId) : target.placements.length;
        if (index < 0) return sessionSurfaceDropRefused('anchor-gone');
        return { status: 'allowed', effect: { actionId: 'widgets.instance.move', preview: input.preview, input: { ref: configuredRef,
            to: { surface: { ...input.scope, owner: { kind: 'sessionBoard', sessionId: input.address.sessionId } }, tabId: target.id,
                index: index + (input.anchor?.side === 'after' ? 1 : 0) } } } };
    }
    if (!exactSession(input)) return sessionSurfaceDropRefused('scope-mismatch');
    const { item, board, anchor } = input;
    if (item.kind !== 'session-board-item' || !readableBoardPlacement(input, item)) return sessionSurfaceDropRefused('board-unavailable');
    if (!board?.canEdit) return sessionSurfaceDropRefused('board-read-only');
    const source = board.views.find(view => view.id === item.viewId);
    const target = board.views.find(view => view.id === input.viewId);
    if (!source || !target || source.synthetic || target.synthetic) return sessionSurfaceDropRefused('target-gone');
    if (source.id !== target.id && target.placements.some(p => p.itemId === item.itemId)) return sessionSurfaceDropRefused('already-placed');
    const ids = target.placements.map(p => p.itemId);
    if (anchor && (anchor.itemId === item.itemId || !ids.includes(anchor.itemId))) return sessionSurfaceDropRefused('anchor-gone');
    const without = ids.filter(id => id !== item.itemId);
    const index = anchor ? without.indexOf(anchor.itemId) + (anchor.side === 'after' ? 1 : 0) : without.length;
    if (source.id === target.id && ids.indexOf(item.itemId) === index) return sessionSurfaceDropRefused('same-position');
    const state = board.itemsById.get(item.itemId)?.state;
    if (state?.kind === 'ready' && state.item.source.kind === 'widget') {
        const surface = { ...input.scope, owner: { kind: 'sessionBoard' as const, sessionId: input.address.sessionId } };
        return { status: 'allowed', effect: { actionId: 'widgets.instance.move', preview: input.preview,
            input: { ref: { surface, instanceId: state.item.source.instance.id }, to: { surface, tabId: target.id, index } } } };
    }
    return { status: 'allowed', effect: { actionId: 'session.board.layout.update', preview: input.preview, input: {
        sessionId: input.address.sessionId, expectedLayoutRevision: board.layoutRevision,
        operation: { op: 'item.move', itemId: item.itemId, fromTabId: source.id, toTabId: target.id, ...(anchor ? { anchor } : {}) },
    } } };
}

/** Ordinary Keep beside chat copies a reference; configured copies delegate movement to the widget Action. */
export function resolveSessionCompanionEntityDrop(input: Context & Readonly<{ items: readonly SessionCompanionPresentationItemRefV1[]; ready: boolean; anchor?: Readonly<{ side: 'before' | 'after'; itemKey: string }> }>): EntityDropAdmissionV1 {
    const configuredRef = widgetEntitySourceRef(input.item);
    if (configuredRef && (input.item.kind === 'home-section' || input.item.kind === 'work-board-widget' || input.item.kind === 'companion-item' && input.item.address.sessionId !== input.address.sessionId
        || input.item.kind === 'session-board-item' && input.item.address.sessionId !== input.address.sessionId && input.widgetSourceRef)) {
        if (!entityDragScopesEqualV1(input.item.scope, input.scope)) return sessionSurfaceDropRefused('scope-mismatch');
        if (!input.ready) return sessionSurfaceDropRefused('companion-unavailable');
        const index = input.anchor ? input.items.findIndex(ref => sessionCompanionItemKey(ref) === input.anchor!.itemKey) : input.items.length;
        if (index < 0) return sessionSurfaceDropRefused('anchor-gone');
        return { status: 'allowed', effect: { actionId: 'widgets.instance.move', preview: input.preview, input: { ref: configuredRef,
            to: { surface: { ...input.scope, owner: { kind: 'companion', sessionId: input.address.sessionId } }, index: index + (input.anchor?.side === 'after' ? 1 : 0) } } } };
    }
    if (!exactSession(input)) return sessionSurfaceDropRefused('scope-mismatch');
    if (!input.ready) return sessionSurfaceDropRefused('companion-unavailable');
    const { item, items, anchor } = input;
    if (item.kind === 'session-board-item') {
        if (!readableBoardPlacement(input, item)) return sessionSurfaceDropRefused('source-gone');
        const state = input.board?.itemsById.get(item.itemId)?.state;
        if (state?.kind === 'ready' && state.item.source.kind === 'widget') {
            if (!input.board?.canEdit) return sessionSurfaceDropRefused('board-read-only');
            const index = anchor ? items.findIndex(ref => sessionCompanionItemKey(ref) === anchor.itemKey) : items.length;
            if (index < 0) return sessionSurfaceDropRefused('anchor-gone');
            return { status: 'allowed', effect: { actionId: 'widgets.instance.move', preview: input.preview, input: {
                ref: { surface: { ...input.scope, owner: { kind: 'sessionBoard', sessionId: input.address.sessionId } }, instanceId: state.item.source.instance.id },
                to: { surface: { ...input.scope, owner: { kind: 'companion', sessionId: input.address.sessionId } }, index: index + (anchor?.side === 'after' ? 1 : 0) },
            } } };
        }
        if (items.some(ref => ref.kind === 'widget' && ref.widgetId === item.itemId)) return sessionSurfaceDropRefused('already-kept');
        return { status: 'allowed', effect: { actionId: 'session.presentation.apply', preview: input.preview,
            input: { intent: { kind: 'companion.item.add', item: { kind: 'widget', widgetId: item.itemId } } } } };
    }
    if (item.kind !== 'companion-item') return sessionSurfaceDropRefused('unsupported-kind');
    const key = sessionCompanionItemKey(item.item);
    const current = items.findIndex(ref => sessionCompanionItemKey(ref) === key);
    if (current < 0) return sessionSurfaceDropRefused('source-gone');
    const without = items.filter(ref => sessionCompanionItemKey(ref) !== key);
    const anchorIndex = anchor ? without.findIndex(ref => sessionCompanionItemKey(ref) === anchor.itemKey) : without.length;
    if (anchor && anchorIndex < 0) return sessionSurfaceDropRefused('anchor-gone');
    const toIndex = anchorIndex + (anchor?.side === 'after' ? 1 : 0);
    if (toIndex === current) return sessionSurfaceDropRefused('same-position');
    if (item.item.kind === 'instance') {
        const surface = { ...input.scope, owner: { kind: 'companion' as const, sessionId: input.address.sessionId } };
        return { status: 'allowed', effect: { actionId: 'widgets.instance.move', preview: input.preview,
            input: { ref: { surface, instanceId: item.item.instance.id }, to: { surface, index: toIndex } } } };
    }
    return { status: 'allowed', effect: { actionId: 'session.presentation.apply', preview: input.preview,
        input: { intent: { kind: 'companion.item.move', item: items[current]!, toIndex } } } };
}
