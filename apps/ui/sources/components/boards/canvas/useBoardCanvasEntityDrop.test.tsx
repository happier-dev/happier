// @vitest-environment jsdom
import type { View } from 'react-native';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { buildWorkBoardItemKeyV1, createWorkBoardV1, WorkBoardActionInputSchemasV1 } from '@happier-dev/protocol';
import { renderHook } from '@/dev/testkit';
import { installPanelCommonModuleMocks } from '@/components/ui/panels/panelTestHelpers';
import { createEntityDragDropRuntime } from '@/components/ui/treeDragDrop/entityDragDropRuntime';
import { installEntityDragCancellation } from '@/components/ui/treeDragDrop/entityDragCancellation';
import { useEntityDragDomBinding } from '@/components/ui/treeDragDrop/useEntityDragDomBinding';
import { createWorkBoardArtifactBoundary } from '@/dev/testkit/harness/workBoardArtifactBoundary';
import { projectBoardMembership } from '../model/boardMembership';
import { createWorkBoardAccountStore } from '../model/workBoardAccountStore';
import { createWorkBoardUiActionPort, workBoardDragItem } from '../model/workBoardEntityDrop';
import type { WorkBoardEntityBinding } from '../model/workBoardEntityBinding';
import { useBoardCanvasEntityDrop } from './useBoardCanvasEntityDrop';

installPanelCommonModuleMocks();

// jsdom has no native DataTransfer; this platform fixture preserves the browser delivery bag.
function delivery() {
    const data = new Map<string, string>();
    return { effectAllowed: 'none', setData: (type: string, value: string) => { data.set(type, value); },
        getData: (type: string) => data.get(type) ?? '', get types() { return [...data.keys()]; } };
}
function drag(type: string, x: number, y: number, dataTransfer: ReturnType<typeof delivery>) {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y });
    Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
    return event;
}

describe('Canvas browser drop at the shared entity owner', () => {
    it.each(['saved', 'flow'] as const)('drops a %s card on blank viewport space through the Board queue, and does not accept a no-op or an invalid kind', async placement => {
        const scope = { serverId: 'home', accountId: 'account' };
        const ref = { kind: 'machine', qualifiedId: { serverId: scope.serverId, id: 'machine' } } as const;
        const key = buildWorkBoardItemKeyV1(ref);
        const board = { ...createWorkBoardV1({ id: 'board', name: 'Board' }), mode: 'canvas' as const,
            source: { picked: [ref] }, positionsByItemRef: placement === 'saved' ? { [key]: { x: 72, y: 0 } } : {} };
        const persistence = createWorkBoardArtifactBoundary({ v: 1, boards: [board] });
        const store = createWorkBoardAccountStore(persistence.transport, () => true);
        await store.refresh();
        const runtime = createEntityDragDropRuntime();
        const context = () => {
            const current = store.getBoards().boards[0]!;
            return { scope, board: current, membership: projectBoardMembership(current, {
                isHomeMounted: () => true, sections: {}, filtered: null }), isHomeMounted: () => true };
        };
        const port = createWorkBoardUiActionPort(context, store.queue);
        const binding: WorkBoardEntityBinding = { runtime, scope, isCurrent: () => true, getContext: context,
            execute: async effect => {
                const input = WorkBoardActionInputSchemasV1['boards.apply'].parse(effect.input);
                await port.apply(input.intent);
                return { status: 'applied' };
            } };
        runtime.registerSource({ id: 'card', scope, isCurrent: () => true,
            getItem: () => workBoardDragItem(scope, board.id, ref) });
        runtime.registerSource({ id: 'invalid', scope, isCurrent: () => true,
            getItem: () => ({ kind: 'destination', scope, href: '/inbox' }) });
        // Flow layout and persisted XY use the same padded Canvas coordinate space.
        const measured = { current: new Map([[key, { x: 72, y: 0 }]]) };
        const canvas = await renderHook(() => useBoardCanvasEntityDrop(binding, measured, true));
        const sourceHook = await renderHook(() => useEntityDragDomBinding({ runtime, sourceId: 'card', enabled: true,
            canStart: event => { canvas.getCurrent().setGrab(key, { x: event.clientX, y: event.clientY }); return true; } }));
        const viewport = document.createElement('div');
        const content = document.createElement('div');
        const source = document.createElement('div');
        content.appendChild(source); viewport.appendChild(content); document.body.appendChild(viewport);
        // Actual window geometry, with content shorter than the visible scroll viewport.
        viewport.getBoundingClientRect = () => new DOMRect(100, 100, 1000, 800);
        content.getBoundingClientRect = () => new DOMRect(100, 100, 1000, 100);
        act(() => {
            // RN Web delivers a DOM host through the native View ref contract.
            canvas.getCurrent().contentRef(content as unknown as View);
            canvas.getCurrent().viewportRef(viewport);
            sourceHook.getCurrent()(source);
        });
        const data = delivery();
        const stopCancellation = installEntityDragCancellation(runtime, window);
        try {
            act(() => { source.dispatchEvent(drag('dragstart', 210, 135, data)); });
            const noChange = drag('dragover', 210, 135, data);
            act(() => { viewport.dispatchEvent(noChange); });
            expect(noChange.defaultPrevented).toBe(false);
            expect(runtime.getSnapshot().admission).toMatchObject({ status: 'refused', reason: { code: 'board-no-change' } });
            act(() => { sourceHook.getCurrent()(null); sourceHook.getCurrent()(source); });
            await act(async () => { await Promise.resolve(); });
            expect(runtime.getSnapshot().phase).toBe('carrying');
            // Native HTML dragging terminates pointer input before dragover delivery.
            source.dispatchEvent(new Event('pointercancel', { bubbles: true }));
            const over = drag('dragover', 721, 460, data);
            act(() => { viewport.dispatchEvent(over); });
            expect(runtime.getSnapshot().admission?.status).toBe('allowed');
            expect(over.defaultPrevented).toBe(true);
            const drop = drag('drop', 721, 460, data);
            await act(async () => { viewport.dispatchEvent(drop); await vi.waitFor(() => expect(runtime.getSnapshot().outcome?.status).toBe('applied')); });
            expect(drop.defaultPrevented).toBe(true);
            expect(persistence.acknowledged().boards[0]!.positionsByItemRef[key]).toEqual({ x: 576, y: 336 });
            expect(runtime.getSnapshot().outcome?.status).toBe('applied');
            source.dispatchEvent(drag('dragend', 721, 460, data));
            runtime.begin('invalid');
            const invalid = drag('dragover', 721, 460, data);
            viewport.dispatchEvent(invalid);
            expect(invalid.defaultPrevented).toBe(false);
            await act(async () => { viewport.dispatchEvent(drag('drop', 721, 460, data)); });
            expect(persistence.acknowledged().boards[0]!.positionsByItemRef[key]).toEqual({ x: 576, y: 336 });
        } finally {
            stopCancellation(); runtime.cancel();
            await sourceHook.unmount(); await canvas.unmount(); viewport.remove();
        }
    });
});
