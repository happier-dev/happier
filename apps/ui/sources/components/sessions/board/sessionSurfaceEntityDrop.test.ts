import { describe, expect, it } from 'vitest';
import { createSessionSurfaceNoteDocumentV1, applySessionBoardLayoutOperationV1, SessionBoardLayoutUpdateInputV1Schema, type SessionSurfaceItemV1 } from '@happier-dev/protocol/sessions/board';
import type { EntityDragItemV1 } from '@happier-dev/protocol/plugins/ui';
import { createEntityDragDropRuntime } from '@/components/ui/treeDragDrop/entityDragDropRuntime';
import { projectSessionBoard } from '@/sync/domains/session/board/sessionBoardProjection';
import { resolveSessionBoardEntityDrop, resolveSessionCompanionEntityDrop } from './sessionSurfaceEntityDrop';

const scope = { serverId: 'home', accountId: 'account' };
const address = { serverId: 'home', sessionId: 'session' };
const layout = { v: 1 as const, tabs: [
    { id: 'a', title: 'A', items: [{ itemId: 'one', width: 'medium' as const }, { itemId: 'two', width: 'medium' as const }] },
    { id: 'b', title: 'B', items: [{ itemId: 'three', width: 'medium' as const }] },
] };
const item: EntityDragItemV1 = { kind: 'session-board-item', scope, address, viewId: 'a', itemId: 'one' };
const preview = { verb: 'Move', target: 'B' };
// Existing SSR1 correspondence vector (record sysrec_1, version 1).
const revision = 'ssr1.AAAACHN5c3JlY18xAAAAAQ';
function board(widget = false) {
    return projectSessionBoard({
        layout: { revision, outcome: { status: 'ready', value: layout } },
        items: new Map(['one', 'two', 'three'].map(id => [id, {
            revision, outcome: { status: 'ready' as const, value: { v: 1 as const, title: id, frame: 'card' as const,
                height: { mode: 'auto' as const, fallback: 'regular' as const },
                source: widget && id === 'one' ? { kind: 'widget' as const, instance: { v: 1 as const, id: 'configured-one', definition: { kind: 'builtin' as const, id: 'changes' }, bindings: {} } }
                    : { kind: 'declarative' as const, document: createSessionSurfaceNoteDocumentV1(id) } } satisfies SessionSurfaceItemV1 },
        }])),
        capabilities: { readTranscript: true, editSessionRecords: true }, freshness: 'fresh', reachability: 'reachable', loading: 'idle', incomplete: false,
    });
}
describe('qualified Session surface entity drops', () => {
    it('routes a qualified Project-area copy to Board and Companion through the existing movement Action', () => {
        const ref = { surface: { ...scope, owner: { kind: 'project' as const, projectId: 'portable-source' } }, instanceId: 'configured-one' };
        const carried: EntityDragItemV1 = { kind: 'widget-area-instance', scope, ref };
        expect(resolveSessionBoardEntityDrop({ item: carried, scope, address, board: board(), viewId: 'b', preview })).toMatchObject({
            status: 'allowed', effect: { actionId: 'widgets.instance.move', input: { ref,
                to: { surface: { ...scope, owner: { kind: 'sessionBoard', sessionId: address.sessionId } }, tabId: 'b', index: 1 } } },
        });
        expect(resolveSessionCompanionEntityDrop({ item: carried, scope, address, board: board(), items: [], ready: true, preview })).toMatchObject({
            status: 'allowed', effect: { actionId: 'widgets.instance.move', input: { ref,
                to: { surface: { ...scope, owner: { kind: 'companion', sessionId: address.sessionId } }, index: 0 } } },
        });
    });
    it('moves a WorkBoard configured copy to Board or Companion through the qualified widget Action', () => {
        const carried: EntityDragItemV1 = { kind: 'work-board-widget', scope, boardId: 'launch', instanceId: 'configured-one' };
        const ref = { surface: { ...scope, owner: { kind: 'workBoard', boardId: 'launch' } }, instanceId: 'configured-one' };
        expect(resolveSessionBoardEntityDrop({ item: carried, scope, address, board: board(), viewId: 'b', preview })).toMatchObject({
            status: 'allowed', effect: { actionId: 'widgets.instance.move', input: { ref,
                to: { surface: { ...scope, owner: { kind: 'sessionBoard', sessionId: address.sessionId } }, tabId: 'b', index: 1 } } },
        });
        expect(resolveSessionCompanionEntityDrop({ item: carried, scope, address, board: board(), items: [], ready: true, preview })).toMatchObject({
            status: 'allowed', effect: { actionId: 'widgets.instance.move', input: { ref,
                to: { surface: { ...scope, owner: { kind: 'companion', sessionId: address.sessionId } }, index: 0 } } },
        });
    });
    it('moves a direct Companion widget to an existing Board view instead of treating it as a Board reference', () => {
        const carried: EntityDragItemV1 = { kind: 'companion-item', scope, address, item: { kind: 'instance', instance: {
            v: 1, id: 'configured-one', definition: { kind: 'builtin', id: 'changes' }, bindings: {},
        } } };
        expect(resolveSessionBoardEntityDrop({ item: carried, scope, address, board: board(), viewId: 'b', preview })).toMatchObject({
            status: 'allowed', effect: { actionId: 'widgets.instance.move', input: {
                ref: { surface: { ...scope, owner: { kind: 'companion', sessionId: address.sessionId } }, instanceId: 'configured-one' },
                to: { surface: { ...scope, owner: { kind: 'sessionBoard', sessionId: address.sessionId } }, tabId: 'b', index: 1 },
            } },
        });
    });
    it('moves a configured Board widget to Companion but keeps ordinary Board references as copies', () => {
        expect(resolveSessionCompanionEntityDrop({ item, scope, address, board: board(true), items: [], ready: true, preview })).toMatchObject({
            status: 'allowed', effect: { actionId: 'widgets.instance.move', input: {
                ref: { surface: { ...scope, owner: { kind: 'sessionBoard', sessionId: address.sessionId } }, instanceId: 'configured-one' },
                to: { surface: { ...scope, owner: { kind: 'companion', sessionId: address.sessionId } }, index: 0 },
            } },
        });
    });
    it('moves a configured Companion instance with the owner-native mixed-content destination', () => {
        const ref = { kind: 'instance' as const, instance: { v: 1 as const, id: 'configured-one', definition: { kind: 'builtin' as const, id: 'changes' }, bindings: {} } };
        const carried: EntityDragItemV1 = { kind: 'companion-item', scope, address, item: ref };
        const items = [ref, { kind: 'builtin' as const, id: 'session_summary' as const }, { kind: 'widget' as const, widgetId: 'two' }];
        expect(resolveSessionCompanionEntityDrop({ item: carried, scope, address, board: board(), items, ready: true,
            anchor: { side: 'after', itemKey: 'widget:two' }, preview })).toMatchObject({ status: 'allowed', effect: { actionId: 'widgets.instance.move', input: {
                ref: { surface: { ...scope, owner: { kind: 'companion', sessionId: address.sessionId } }, instanceId: ref.instance.id },
                to: { surface: { ...scope, owner: { kind: 'companion', sessionId: address.sessionId } }, index: 2 },
            } } });
    });
    it('moves configured Board placements through the widget Action with an explicit destination tab and native index', () => {
        const admission = resolveSessionBoardEntityDrop({ item, scope, address, board: board(true), viewId: 'a', anchor: { side: 'after', itemId: 'two' }, preview });
        const surface = { ...scope, owner: { kind: 'sessionBoard', sessionId: address.sessionId } };
        expect(admission).toMatchObject({ status: 'allowed', effect: { actionId: 'widgets.instance.move', input: {
            ref: { surface, instanceId: 'configured-one' }, to: { surface, tabId: 'a', index: 1 },
        } } });
        expect(resolveSessionBoardEntityDrop({ item, scope, address, board: board(true), viewId: 'b', preview })).toMatchObject({ status: 'allowed', effect: { input: {
            to: { surface, tabId: 'b', index: 1 },
        } } });
    });
    it('moves the placement through the existing layout operation, retaining item content and current anchors', () => {
        const admission = resolveSessionBoardEntityDrop({ item, scope, address, board: board(), viewId: 'b', anchor: { side: 'before', itemId: 'three' }, preview });
        expect(admission.status).toBe('allowed');
        if (admission.status !== 'allowed') return;
        expect(admission.effect.actionId).toBe('session.board.layout.update');
        const input = SessionBoardLayoutUpdateInputV1Schema.parse(admission.effect.input);
        const result = applySessionBoardLayoutOperationV1(layout, input.operation);
        expect(result).toMatchObject({ ok: true, layout: { tabs: [ { items: [{ itemId: 'two' }] }, { items: [{ itemId: 'one' }, { itemId: 'three' }] } ] } });
        expect(layout.tabs[0]?.items.map(p => p.itemId)).toEqual(['one', 'two']);
    });
    it('copies a readable Board reference only and refuses another Account, Session or missing placement', () => {
        const context = { scope, address, board: board(), items: [], ready: true, preview };
        const allowed = resolveSessionCompanionEntityDrop({ ...context, item });
        expect(allowed).toMatchObject({ status: 'allowed', effect: { actionId: 'session.presentation.apply', input: { intent: { kind: 'companion.item.add', item: { kind: 'widget', widgetId: 'one' } } } } });
        for (const foreign of [
            { ...item, scope: { ...scope, serverId: 'other' }, address: { ...address, serverId: 'other' } },
            { ...item, scope: { ...scope, accountId: 'other' } },
            { ...item, address: { ...address, sessionId: 'other' } },
            { ...item, viewId: 'missing' },
        ]) expect(resolveSessionCompanionEntityDrop({ ...context, item: foreign }).status).toBe('refused');
        expect(layout.tabs[0]?.items.map(p => p.itemId)).toEqual(['one', 'two']);
    });
    it('rebases Companion order at release and does not resurrect a removed source', async () => {
        const runtime = createEntityDragDropRuntime();
        const companionItem: EntityDragItemV1 = { kind: 'companion-item', scope, address, item: { kind: 'builtin', id: 'session_summary' } };
        let items = [companionItem.item, { kind: 'widget' as const, widgetId: 'two' }];
        const executed: unknown[] = [];
        runtime.registerSource({ id: 'source', scope, isCurrent: () => true, getItem: () => companionItem });
        runtime.registerTarget({ id: 'rail', scope, acceptedKinds: ['companion-item'], getBounds: () => null,
            resolve: ({ item }) => resolveSessionCompanionEntityDrop({ item, scope, address, board: board(), items, ready: true, anchor: { side: 'after', itemKey: 'widget:two' }, preview }),
            execute: async effect => { executed.push(effect.input); return { status: 'applied' }; },
        });
        const carry = runtime.begin('source', 'keyboard');
        carry?.choose('rail');
        items = [ { kind: 'widget', widgetId: 'three' }, ...items ];
        await carry?.release();
        expect(executed).toEqual([{ intent: { kind: 'companion.item.move', item: companionItem.item, toIndex: 2 } }]);
        const cancelled = runtime.begin('source', 'keyboard');
        cancelled?.choose('rail'); cancelled?.cancel(); await cancelled?.release();
        expect(executed).toHaveLength(1);
        const removed = runtime.begin('source', 'keyboard'); removed?.choose('rail');
        items = [{ kind: 'widget', widgetId: 'two' }]; await removed?.release();
        expect(executed).toHaveLength(1);
    });
});
