import { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import { renderHook } from '@/dev/testkit';
import { installPanelCommonModuleMocks } from '@/components/ui/panels/panelTestHelpers';
import { createEntityDragDropRuntime } from '@/components/ui/treeDragDrop/entityDragDropRuntime';
import { useSplitCanvasDnD, type SplitCanvasEntityDrop } from './useSplitCanvasDnD';

installPanelCommonModuleMocks();
const scope = { serverId: 'home', accountId: 'account' };

describe('useSplitCanvasDnD shared entity admission', () => {
    it('uses live nested geometry and revalidates visibility before releasing', async () => {
        const runtime = createEntityDragDropRuntime();
        runtime.registerSource({ id: 'session', scope, isCurrent: () => true,
            getItem: () => ({ kind: 'session', scope, address: { serverId: 'home', sessionId: 'session' } }) });
        const writes: unknown[] = [];
        let visible = true;
        let left = 400;
        const entityDrop: SplitCanvasEntityDrop = {
            runtime, id: 'canvas', scope, acceptedKinds: ['session'],
            resolve: ({ target, availableSizePx }) => ({ status: 'allowed', effect: {
                actionId: 'session.canvas.apply', input: { ...target, availableSizePx: availableSizePx ?? null },
                preview: { verb: 'Open', target: target.leafId },
            } }),
            execute: async effect => { writes.push(effect.input); return { status: 'applied' }; },
        };
        const hook = await renderHook(() => useSplitCanvasDnD({ entityDrop,
            isLeafCurrent: id => visible && id === 'nested',
            readSplitMeasurement: () => ({ availableSizePx: 700, minimumExistingSizePx: 200 }),
            isSplitOffered: () => true,
        }));
        act(() => hook.getCurrent().registerLeafHost('nested', {
            getBoundingClientRect: () => ({ left, top: 300, width: 400, height: 300 }),
        }));
        const carry = runtime.begin('session');
        act(() => carry?.move({ x: 412, y: 420 }));
        expect(runtime.getSnapshot().admission).toMatchObject({ status: 'allowed', effect: {
            input: { leafId: 'nested', placement: 'left', availableSizePx: 700 },
        } });
        left = 0;
        act(() => carry?.move({ x: 200, y: 420 }));
        expect(runtime.getSnapshot().admission).toMatchObject({ status: 'allowed', effect: {
            input: { leafId: 'nested', placement: 'center' },
        } });
        visible = false;
        await act(async () => { await carry?.release(); });
        expect(writes).toEqual([]);
        await hook.unmount();
    });

    it('retires removed leaves and admits chooser input through the same resolver', async () => {
        const runtime = createEntityDragDropRuntime();
        runtime.registerSource({ id: 'session', scope, isCurrent: () => true,
            getItem: () => ({ kind: 'session', scope, address: { serverId: 'home', sessionId: 'session' } }) });
        const writes: unknown[] = [];
        const entityDrop: SplitCanvasEntityDrop = { runtime, id: 'canvas', scope, acceptedKinds: ['session'],
            resolve: ({ target }) => ({ status: 'allowed', effect: { actionId: 'session.canvas.apply', input: target,
                preview: { verb: 'Open', target: target.leafId } } }),
            execute: async effect => { writes.push(effect.input); return { status: 'applied' }; },
        };
        const hook = await renderHook(() => useSplitCanvasDnD({ entityDrop, isLeafCurrent: () => true,
            readSplitMeasurement: () => null, isSplitOffered: () => true }));
        act(() => hook.getCurrent().registerLeafHost('leaf', { getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }) }));
        await act(async () => { await runtime.perform('session', hook.getCurrent().targetId('leaf', 'center'), undefined, 'chooser'); });
        expect(writes).toEqual([{ leafId: 'leaf', placement: 'center' }]);
        act(() => hook.getCurrent().registerLeafHost('leaf', null));
        const carry = runtime.begin('session');
        act(() => carry?.move({ x: 400, y: 300 }));
        await act(async () => { await carry?.release(); });
        expect(writes).toHaveLength(1);
        await hook.unmount();
    });

    it('folds the edge bands of a pane too narrow to split into its centre, naming the declined split', async () => {
        const runtime = createEntityDragDropRuntime();
        runtime.registerSource({ id: 'session', scope, isCurrent: () => true,
            getItem: () => ({ kind: 'session', scope, address: { serverId: 'home', sessionId: 'session' } }) });
        const resolved: unknown[] = [];
        const entityDrop: SplitCanvasEntityDrop = { runtime, id: 'canvas', scope, acceptedKinds: ['session'],
            resolve: ({ target, declinedSplit }) => {
                resolved.push({ placement: target.placement, declinedSplit });
                return { status: 'allowed', effect: { actionId: 'session.canvas.apply', input: target,
                    preview: { verb: 'Open', target: target.leafId } } };
            },
            execute: async () => ({ status: 'applied' }),
        };
        let wide = false;
        const hook = await renderHook(() => useSplitCanvasDnD({ entityDrop, isLeafCurrent: () => true,
            readSplitMeasurement: () => ({ availableSizePx: 300, minimumExistingSizePx: 200 }),
            isSplitOffered: () => wide }));
        act(() => hook.getCurrent().registerLeafHost('leaf', { getBoundingClientRect: () => ({ left: 0, top: 0, width: 300, height: 600 }) }));
        const carry = runtime.begin('session');
        act(() => carry?.move({ x: 290, y: 300 }));
        expect(runtime.getSnapshot()).toMatchObject({ targetId: hook.getCurrent().targetId('leaf', 'center'),
            admission: { status: 'allowed', effect: { input: { placement: 'center' } } } });
        expect(resolved.at(-1)).toEqual({ placement: 'center', declinedSplit: 'right' });
        wide = true;
        act(() => carry?.move({ x: 291, y: 300 }));
        expect(runtime.getSnapshot().targetId).toBe(hook.getCurrent().targetId('leaf', 'right'));
        act(() => carry?.cancel());
        await hook.unmount();
    });
});
