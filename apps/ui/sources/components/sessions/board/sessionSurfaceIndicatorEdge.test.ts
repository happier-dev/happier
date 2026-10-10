import { describe, expect, it } from 'vitest';
import type { EntityDropEffectV1 } from '@happier-dev/protocol/plugins/ui';
import type { SessionCompanionPresentationItemRefV1 } from '@happier-dev/protocol/sessions';

import { sessionCompanionItemKey } from '../companion/state/sessionCompanionPreference';
import { resolveSessionCompanionEntityDrop } from './sessionSurfaceEntityDrop';
import { resolveSessionSurfaceIndicatorEdge } from './sessionSurfaceIndicatorEdge';

const scope = { serverId: 'home-1', accountId: 'account-1' };
const address = { serverId: scope.serverId, sessionId: 'session-1' };
const summary = { kind: 'builtin' as const, id: 'session_summary' as const };
const boardRef = { kind: 'widget' as const, widgetId: 'board-ref' };
const plan = { kind: 'builtin' as const, id: 'agent_plan' as const };
const items: readonly SessionCompanionPresentationItemRefV1[] = [
    summary,
    { kind: 'instance', instance: { v: 1, id: 'configured', bindings: {}, definition: { kind: 'builtin', id: 'checks' } } },
    boardRef,
    plan,
];
const bounds = { x: 0, y: 100, width: 300, height: 100 };
// Deliberately unrelated wording: semantic placement, rather than translated
// preview text, decides the indicator.
const preview = { verb: 'Keep working', target: 'Current item' };

function companionEffect(moved: SessionCompanionPresentationItemRefV1, target: SessionCompanionPresentationItemRefV1, side: 'before' | 'after') {
    const admission = resolveSessionCompanionEntityDrop({
        item: { kind: 'companion-item', scope, address, item: moved },
        scope, address, board: null, items, ready: true,
        anchor: { side, itemKey: sessionCompanionItemKey(target) }, preview,
    });
    if (admission.status !== 'allowed') throw new Error('Expected admitted Companion fixture');
    return admission.effect;
}

describe('resolveSessionSurfaceIndicatorEdge', () => {
    it('keeps Project insertion feedback in the destination area native sibling list', () => {
        const surface = { ...scope, owner: { kind: 'project' as const, projectId: 'anchor' } };
        const effect: EntityDropEffectV1 = { actionId: 'widgets.item.move', preview,
            input: { ref: { surface, instanceId: 'main-a' }, to: { surface, area: 'aside', index: 1 } } };
        expect(resolveSessionSurfaceIndicatorEdge({ effect, bounds: null, pointer: null,
            widgetAreaTarget: { surface, area: 'aside', itemId: 'aside-a', itemIds: ['aside-a', 'aside-b'] } })).toBe('bottom');
        expect(resolveSessionSurfaceIndicatorEdge({ effect, bounds: null, pointer: null,
            widgetAreaTarget: { surface, area: 'main', itemId: 'main-b', itemIds: ['main-a', 'main-b'] } })).toBeNull();
    });
    it.each([
        { moved: summary, target: boardRef },
        { moved: boardRef, target: summary },
    ])('uses the full remaining mixed list for keyboard placement before and after $target.kind', ({ moved, target }) => {
        for (const side of ['before', 'after'] as const) {
            expect(resolveSessionSurfaceIndicatorEdge({
                effect: companionEffect(moved, target, side), bounds: null, pointer: null,
                companionTarget: { itemKey: sessionCompanionItemKey(target), items },
            })).toBe(side === 'before' ? 'top' : 'bottom');
        }
    });

    it('uses semantic placement even when pointer geometry suggests the opposite edge', () => {
        expect(resolveSessionSurfaceIndicatorEdge({
            effect: companionEffect(summary, boardRef, 'before'), bounds, pointer: { x: 100, y: 190 },
            companionTarget: { itemKey: sessionCompanionItemKey(boardRef), items },
        })).toBe('top');
    });

    it('clears the line when either the moved item or target has left the current Companion', () => {
        const effect = companionEffect(summary, boardRef, 'before');
        for (const missingKey of [sessionCompanionItemKey(summary), sessionCompanionItemKey(boardRef)]) {
            expect(resolveSessionSurfaceIndicatorEdge({
                effect, bounds, pointer: { x: 100, y: 110 },
                companionTarget: { itemKey: sessionCompanionItemKey(boardRef),
                    items: items.filter(item => sessionCompanionItemKey(item) !== missingKey) },
            })).toBeNull();
        }
        expect(resolveSessionSurfaceIndicatorEdge({ effect, bounds, pointer: { x: 100, y: 110 } })).toBeNull();
    });

    it('projects Board move anchors without a pointer and omits unanchored destinations', () => {
        for (const side of ['before', 'after'] as const) {
            const effect: EntityDropEffectV1 = {
                actionId: 'session.board.layout.update', preview,
                input: { sessionId: address.sessionId, expectedLayoutRevision: null,
                    operation: { op: 'item.move', itemId: 'one', fromTabId: 'view', toTabId: 'view',
                        anchor: { side, itemId: 'two' } } },
            };
            expect(resolveSessionSurfaceIndicatorEdge({ effect, bounds: null, pointer: null }))
                .toBe(side === 'before' ? 'top' : 'bottom');
        }
        const effect: EntityDropEffectV1 = {
            actionId: 'session.board.layout.update', preview,
            input: { sessionId: address.sessionId, expectedLayoutRevision: null,
                operation: { op: 'item.move', itemId: 'one', fromTabId: 'view', toTabId: 'other' } },
        };
        expect(resolveSessionSurfaceIndicatorEdge({ effect, bounds, pointer: { x: 100, y: 110 } })).toBeNull();
    });

    it('does not reinterpret widget inventory ordinals as mixed Companion positions', () => {
        const effect: EntityDropEffectV1 = {
            actionId: 'widgets.item.move', preview,
            input: { ref: { surface: { ...scope, owner: { kind: 'companion', sessionId: address.sessionId } },
                instanceId: 'configured' }, toIndex: 0 },
        };
        const companionTarget = { itemKey: sessionCompanionItemKey(boardRef), items };
        expect(resolveSessionSurfaceIndicatorEdge({ effect, bounds, pointer: null, companionTarget })).toBeNull();
        expect(resolveSessionSurfaceIndicatorEdge({ effect, bounds, pointer: { x: 100, y: 110 }, companionTarget })).toBe('top');
        expect(resolveSessionSurfaceIndicatorEdge({ effect, bounds, pointer: { x: 100, y: 190 }, companionTarget })).toBe('bottom');
        expect(resolveSessionSurfaceIndicatorEdge({ effect, bounds: null, pointer: { x: 100, y: 110 }, companionTarget })).toBeNull();
    });
    it('projects a configured move destination against the full mixed Companion list for keyboard feedback', () => {
        const instance = { kind: 'instance' as const, instance: { v: 1 as const, id: 'configured', definition: { kind: 'builtin' as const, id: 'changes' }, bindings: {} } };
        const surface = { ...scope, owner: { kind: 'companion' as const, sessionId: address.sessionId } };
        const target = { itemKey: sessionCompanionItemKey(boardRef), items };
        const index = items.filter(item => sessionCompanionItemKey(item) !== sessionCompanionItemKey(instance))
            .findIndex(item => sessionCompanionItemKey(item) === target.itemKey);
        for (const side of ['before', 'after'] as const) {
            const effect: EntityDropEffectV1 = { actionId: 'widgets.item.move', preview,
                input: { ref: { surface, instanceId: 'configured' }, to: { surface, index: index + (side === 'after' ? 1 : 0) } } };
            expect(resolveSessionSurfaceIndicatorEdge({ effect, bounds: null, pointer: null, companionTarget: target })).toBe(side === 'before' ? 'top' : 'bottom');
        }
    });
});
