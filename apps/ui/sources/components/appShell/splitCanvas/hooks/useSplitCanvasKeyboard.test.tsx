import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@/dev/testkit';
import { installPanelCommonModuleMocks } from '@/components/ui/panels/panelTestHelpers';
import { useSplitCanvasKeyboard } from './useSplitCanvasKeyboard';
import { createSplitCanvasState } from '../model/splitCanvasReducer';

installPanelCommonModuleMocks();

function createLeaf(id: string) {
    return {
        id,
        kind: 'leaf' as const,
        leafKind: 'test',
        payload: id,
    };
}

describe('useSplitCanvasKeyboard', () => {
    it('keeps the global keyboard listener stable across equivalent rerenders', async () => {
        const dispatch = vi.fn();
        const fakeWindow = {
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
        };
        (globalThis as any).window = fakeWindow;

        const state = createSplitCanvasState({
            root: createLeaf('leaf-a'),
            focusedLeafId: 'leaf-a',
            maxLeaves: 4,
        });

        const hook = await renderHook(({ tick }: { tick: number }) => {
            void tick;
            useSplitCanvasKeyboard({
                enabled: true,
                state,
                dispatch,
            });
        }, {
            initialProps: { tick: 0 },
        });

        expect(fakeWindow.addEventListener).toHaveBeenCalledTimes(1);
        expect(fakeWindow.removeEventListener).toHaveBeenCalledTimes(0);

        await hook.rerender({ tick: 1 });

        expect(fakeWindow.addEventListener).toHaveBeenCalledTimes(1);
        expect(fakeWindow.removeEventListener).toHaveBeenCalledTimes(0);
    });

    it('routes focus movement for the focused leaf', async () => {
        const onFocusAdjacent = vi.fn();
        const dispatch = vi.fn();

        const fakeWindow = new (globalThis as any).EventTarget();
        (globalThis as any).window = fakeWindow;
        (globalThis as any).KeyboardEvent = class KeyboardEvent extends Event {
            key: string;
            altKey: boolean;
            shiftKey: boolean;
            metaKey: boolean;
            ctrlKey: boolean;
            target: any;
            constructor(type: string, init: {
                key: string;
                altKey?: boolean;
                shiftKey?: boolean;
                metaKey?: boolean;
                ctrlKey?: boolean;
                target?: any;
            }) {
                super(type);
                this.key = init.key;
                this.altKey = init.altKey ?? false;
                this.shiftKey = init.shiftKey ?? false;
                this.metaKey = init.metaKey ?? false;
                this.ctrlKey = init.ctrlKey ?? false;
                this.target = init.target;
            }
        };

        const state = createSplitCanvasState({
            root: createLeaf('leaf-a'),
            focusedLeafId: 'leaf-a',
            maxLeaves: 4,
        });

        await renderHook(() => useSplitCanvasKeyboard({
            enabled: true,
            state,
            dispatch,
            onFocusAdjacent,
        }));

        act(() => {
            (globalThis as any).window.dispatchEvent(new (globalThis as any).KeyboardEvent('keydown', {
                key: 'ArrowRight',
                altKey: true,
            }));
        });

        expect(onFocusAdjacent).toHaveBeenCalledWith('leaf-a', 'right');
    });

    it('routes split-right and split-down commands for the focused leaf', async () => {
        const onSplit = vi.fn();
        const dispatch = vi.fn();

        const fakeWindow = new (globalThis as any).EventTarget();
        (globalThis as any).window = fakeWindow;
        (globalThis as any).KeyboardEvent = class KeyboardEvent extends Event {
            key: string;
            altKey: boolean;
            shiftKey: boolean;
            metaKey: boolean;
            ctrlKey: boolean;
            target: any;
            constructor(type: string, init: {
                key: string;
                altKey?: boolean;
                shiftKey?: boolean;
                metaKey?: boolean;
                ctrlKey?: boolean;
                target?: any;
            }) {
                super(type);
                this.key = init.key;
                this.altKey = init.altKey ?? false;
                this.shiftKey = init.shiftKey ?? false;
                this.metaKey = init.metaKey ?? false;
                this.ctrlKey = init.ctrlKey ?? false;
                this.target = init.target;
            }
        };

        const state = createSplitCanvasState({
            root: createLeaf('leaf-a'),
            focusedLeafId: 'leaf-a',
            maxLeaves: 4,
        });

        await renderHook(() => useSplitCanvasKeyboard({
            enabled: true,
            state,
            dispatch,
            onSplit,
        }));

        act(() => {
            (globalThis as any).window.dispatchEvent(new (globalThis as any).KeyboardEvent('keydown', {
                key: 'Enter',
                altKey: true,
                shiftKey: true,
            }));
            (globalThis as any).window.dispatchEvent(new (globalThis as any).KeyboardEvent('keydown', {
                key: 'ArrowDown',
                altKey: true,
                shiftKey: true,
            }));
        });

        expect(onSplit).toHaveBeenNthCalledWith(1, 'leaf-a', 'right');
        expect(onSplit).toHaveBeenNthCalledWith(2, 'leaf-a', 'down');
    });

    it('does not intercept split shortcuts when the consumer cannot split the current leaf', async () => {
        const dispatch = vi.fn();
        const preventDefault = vi.fn();
        const stopPropagation = vi.fn();

        const fakeWindow = new (globalThis as any).EventTarget();
        (globalThis as any).window = fakeWindow;
        (globalThis as any).KeyboardEvent = class KeyboardEvent extends Event {
            key: string;
            altKey: boolean;
            shiftKey: boolean;
            metaKey: boolean;
            ctrlKey: boolean;
            target: any;
            preventDefault = preventDefault;
            stopPropagation = stopPropagation;
            constructor(type: string, init: {
                key: string;
                altKey?: boolean;
                shiftKey?: boolean;
                metaKey?: boolean;
                ctrlKey?: boolean;
                target?: any;
            }) {
                super(type);
                this.key = init.key;
                this.altKey = init.altKey ?? false;
                this.shiftKey = init.shiftKey ?? false;
                this.metaKey = init.metaKey ?? false;
                this.ctrlKey = init.ctrlKey ?? false;
                this.target = init.target;
            }
        };

        const state = createSplitCanvasState({
            root: createLeaf('leaf-a'),
            focusedLeafId: 'leaf-a',
            maxLeaves: 4,
        });

        await renderHook(() => useSplitCanvasKeyboard({
            enabled: true,
            state,
            dispatch,
        }));

        act(() => {
            (globalThis as any).window.dispatchEvent(new (globalThis as any).KeyboardEvent('keydown', {
                key: 'Enter',
                altKey: true,
                shiftKey: true,
            }));
        });

        expect(preventDefault).not.toHaveBeenCalled();
        expect(stopPropagation).not.toHaveBeenCalled();
        expect(dispatch).not.toHaveBeenCalled();
    });

    it('does not intercept canvas shortcuts when ctrl or meta modifiers are also pressed', async () => {
        const onSplit = vi.fn();
        const onFocusAdjacent = vi.fn();
        const dispatch = vi.fn();
        const preventDefault = vi.fn();
        const stopPropagation = vi.fn();

        const fakeWindow = new (globalThis as any).EventTarget();
        (globalThis as any).window = fakeWindow;
        (globalThis as any).KeyboardEvent = class KeyboardEvent extends Event {
            key: string;
            altKey: boolean;
            shiftKey: boolean;
            metaKey: boolean;
            ctrlKey: boolean;
            target: any;
            preventDefault = preventDefault;
            stopPropagation = stopPropagation;
            constructor(type: string, init: {
                key: string;
                altKey?: boolean;
                shiftKey?: boolean;
                metaKey?: boolean;
                ctrlKey?: boolean;
                target?: any;
            }) {
                super(type);
                this.key = init.key;
                this.altKey = init.altKey ?? false;
                this.shiftKey = init.shiftKey ?? false;
                this.metaKey = init.metaKey ?? false;
                this.ctrlKey = init.ctrlKey ?? false;
                this.target = init.target;
            }
        };

        const state = createSplitCanvasState({
            root: createLeaf('leaf-a'),
            focusedLeafId: 'leaf-a',
            maxLeaves: 4,
        });

        await renderHook(() => useSplitCanvasKeyboard({
            enabled: true,
            state,
            dispatch,
            onSplit,
            onFocusAdjacent,
        }));

        act(() => {
            (globalThis as any).window.dispatchEvent(new (globalThis as any).KeyboardEvent('keydown', {
                key: 'ArrowRight',
                altKey: true,
                ctrlKey: true,
            }));
            (globalThis as any).window.dispatchEvent(new (globalThis as any).KeyboardEvent('keydown', {
                key: 'Enter',
                altKey: true,
                shiftKey: true,
                metaKey: true,
            }));
        });

        expect(onFocusAdjacent).not.toHaveBeenCalled();
        expect(onSplit).not.toHaveBeenCalled();
        expect(dispatch).not.toHaveBeenCalled();
        expect(preventDefault).not.toHaveBeenCalled();
        expect(stopPropagation).not.toHaveBeenCalled();
    });

    it('restores maximized state explicitly and still closes the focused leaf', async () => {
        const dispatch = vi.fn();

        const fakeWindow = new (globalThis as any).EventTarget();
        (globalThis as any).window = fakeWindow;
        (globalThis as any).KeyboardEvent = class KeyboardEvent extends Event {
            key: string;
            altKey: boolean;
            shiftKey: boolean;
            metaKey: boolean;
            ctrlKey: boolean;
            target: any;
            constructor(type: string, init: {
                key: string;
                altKey?: boolean;
                shiftKey?: boolean;
                metaKey?: boolean;
                ctrlKey?: boolean;
                target?: any;
            }) {
                super(type);
                this.key = init.key;
                this.altKey = init.altKey ?? false;
                this.shiftKey = init.shiftKey ?? false;
                this.metaKey = init.metaKey ?? false;
                this.ctrlKey = init.ctrlKey ?? false;
                this.target = init.target;
            }
        };

        const state = createSplitCanvasState({
            root: createLeaf('leaf-a'),
            focusedLeafId: 'leaf-a',
            maximizedLeafId: 'leaf-a',
            maxLeaves: 4,
        });

        await renderHook(() => useSplitCanvasKeyboard({
            enabled: true,
            state,
            dispatch,
        }));

        act(() => {
            (globalThis as any).window.dispatchEvent(new (globalThis as any).KeyboardEvent('keydown', {
                key: 'm',
                altKey: true,
            }));
            (globalThis as any).window.dispatchEvent(new (globalThis as any).KeyboardEvent('keydown', {
                key: 'Escape',
            }));
            (globalThis as any).window.dispatchEvent(new (globalThis as any).KeyboardEvent('keydown', {
                key: 'Backspace',
                altKey: true,
            }));
        });

        expect(dispatch).toHaveBeenCalledWith({ type: 'restoreMaximize' });
        expect(dispatch).toHaveBeenCalledWith({ type: 'closeLeaf', leafId: 'leaf-a' });
    });
});
