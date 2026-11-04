/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CaptureSelectionLayerProps } from './CaptureSelectionLayer';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The composed hint is drawn elsewhere; here it only counts commits of the layer's own subtree.
const hintRenders = vi.hoisted(() => ({ count: 0 }));
vi.mock('./CaptureSelectionHint', () => ({
    CaptureSelectionHint: () => {
        hintRenders.count += 1;
        return null;
    },
}));
vi.mock('react-native-unistyles', () => ({
    ScopedTheme: (props: { children: React.ReactNode }) => props.children,
    useUnistyles: () => ({
        theme: {
            borderRadius: { md: 8 },
            space: { s8: 8, s10: 10 },
            colors: { overlay: { foreground: '#fff', scrimWizard: 'rgba(19,17,17,.78)', scrimStrong: 'rgba(19,17,17,.86)' }, shadow: { color: '#000' } },
        },
    }),
}));
vi.mock('@/hooks/ui/useReducedMotionPreference', () => ({ useReducedMotionPreference: () => true }));
vi.mock('@/constants/Typography', () => ({
    Typography: { variant: () => ({}), default: () => ({ fontFamily: 'Inter' }), mono: () => ({ fontFamily: 'Mono' }) },
}));

const { CaptureSelectionLayer } = await import('./CaptureSelectionLayer.web');

const terminal = { windowId: 2, frame: { x: 700, y: 70, width: 700, height: 600 }, appName: 'Terminal', title: 'vitest' };

function pointer(type: string, x: number, y: number, button = 0): PointerEvent {
    const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button }) as unknown as PointerEvent;
    Object.defineProperty(event, 'pointerId', { value: 1 });
    return event;
}

describe('CaptureSelectionLayer', () => {
    let root: Root | null = null;
    let host: HTMLDivElement | null = null;

    afterEach(() => {
        act(() => root?.unmount());
        host?.remove();
        root = null;
        hintRenders.count = 0;
    });

    async function mount(hitTest: CaptureSelectionLayerProps['hitTest'] = vi.fn(async () => terminal),
        props: Partial<Pick<CaptureSelectionLayerProps, 'display' | 'initialPointer'>> = {}) {
        const onCommit = vi.fn();
        const onCancel = vi.fn();
        host = document.createElement('div');
        document.body.append(host);
        Object.assign(HTMLElement.prototype, { setPointerCapture: () => {}, releasePointerCapture: () => {}, animate: undefined });
        root = createRoot(host);
        await act(async () => {
            root!.render(
                <CaptureSelectionLayer
                    display={{ width: 1440, height: 900 }}
                    safeAreaTop={0}
                    windows={[terminal]}
                    hitTest={hitTest}
                    mode="still"
                    onModeChange={() => {}}
                    onCommit={onCommit}
                    onCancel={onCancel}
                    {...props}
                />,
            );
        });
        const layer = host.querySelector<HTMLElement>('[data-testid="capture-selection-layer"]')!;
        return { layer, onCommit, onCancel, hitTest };
    }

    it('traces and drags without a React commit per pointer move', async () => {
        const { layer } = await mount();
        const before = hintRenders.count;
        await act(async () => {
            for (let x = 0; x < 200; x += 1) layer.dispatchEvent(pointer('pointermove', 800 + x, 300));
        });
        expect(hintRenders.count).toBe(before);
        await act(async () => { layer.dispatchEvent(pointer('pointerdown', 800, 300)); });
        const atPress = hintRenders.count;
        await act(async () => {
            for (let x = 0; x < 200; x += 1) layer.dispatchEvent(pointer('pointermove', 840 + x, 340 + x));
        });
        // One commit for "Release to capture"; moves after that write styles directly.
        expect(hintRenders.count).toBe(atPress + 1);
    });

    it('keeps one native hit test in flight, latest pointer wins', async () => {
        const pending: Array<(value: typeof terminal) => void> = [];
        const hitTest = vi.fn(() => new Promise<typeof terminal>((resolve) => { pending.push(resolve); }));
        const { layer } = await mount(hitTest as never);
        await act(async () => {
            for (let x = 0; x < 50; x += 1) layer.dispatchEvent(pointer('pointermove', 800 + x, 300));
        });
        expect(hitTest).toHaveBeenCalledTimes(1);
        await act(async () => { pending[0]!(terminal); });
        expect(hitTest).toHaveBeenCalledTimes(2);
        expect(hitTest).toHaveBeenLastCalledWith({ x: 849, y: 300 });
    });

    it('a click commits the window under the pointer; a drag commits its gesture for the native owner to clamp', async () => {
        const { layer, onCommit } = await mount();
        await act(async () => { layer.dispatchEvent(pointer('pointermove', 800, 300)); });
        await act(async () => {
            layer.dispatchEvent(pointer('pointerdown', 800, 300));
            layer.dispatchEvent(pointer('pointerup', 803, 301));
        });
        expect(onCommit).toHaveBeenCalledWith({ kind: 'window', window: terminal });

        act(() => root?.unmount());
        const second = await mount();
        await act(async () => {
            second.layer.dispatchEvent(pointer('pointermove', 1300, 800));
        });
        await act(async () => {
            second.layer.dispatchEvent(pointer('pointerdown', 1300, 800));
            second.layer.dispatchEvent(pointer('pointermove', 1500, 1000));
            second.layer.dispatchEvent(pointer('pointerup', 1500, 1000));
        });
        expect(second.onCommit).toHaveBeenCalledWith({ kind: 'rect', rect: { x: 1300, y: 800, width: 200, height: 200 }, under: terminal });
    });

    it('right-click cancels once and commits nothing', async () => {
        const { layer, onCancel, onCommit } = await mount();
        await act(async () => {
            layer.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
            layer.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
        });
        expect(onCancel).toHaveBeenCalledTimes(1);
        expect(onCommit).not.toHaveBeenCalled();
    });

    it('waits for the press-point hit instead of committing the previous hovered window', async () => {
        const second = { ...terminal, windowId: 3, appName: 'Editor' };
        let resolve!: (window: typeof terminal) => void;
        const delayed = new Promise<typeof terminal>(done => { resolve = done; });
        const { layer, onCommit } = await mount(point => point.x < 1000 ? Promise.resolve(terminal) : delayed);
        await act(async () => { layer.dispatchEvent(pointer('pointermove', 800, 300)); });
        await act(async () => {
            layer.dispatchEvent(pointer('pointermove', 1100, 300));
            layer.dispatchEvent(pointer('pointerdown', 1100, 300));
            layer.dispatchEvent(pointer('pointerup', 1100, 300));
        });
        expect(onCommit).not.toHaveBeenCalled();
        await act(async () => { resolve(second); });
        expect(onCommit).toHaveBeenCalledExactlyOnceWith({ kind: 'window', window: second });
    });

    it('cancels while a released click is awaiting its press-point hit', async () => {
        let resolve!: (window: typeof terminal) => void;
        const delayed = new Promise<typeof terminal>(done => { resolve = done; });
        const { layer, onCommit, onCancel } = await mount(() => delayed);
        await act(async () => {
            layer.dispatchEvent(pointer('pointerdown', 800, 300));
            layer.dispatchEvent(pointer('pointerup', 800, 300));
            layer.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
        });
        await act(async () => { resolve(terminal); });
        expect(onCancel).toHaveBeenCalledTimes(1);
        expect(onCommit).not.toHaveBeenCalled();
    });

    it('defines, adjusts and confirms a display-clamped region with no pointer input', async () => {
        const { layer, onCommit } = await mount(undefined, { display: { width: 12, height: 8 } });
        const key = (key: string) => layer.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
        await act(async () => { key('r'); key('ArrowLeft'); key('Enter'); });
        await act(async () => {
            for (let i = 0; i < 20; i++) { key('ArrowRight'); key('ArrowDown'); }
            key('Enter');
        });
        expect(onCommit).toHaveBeenCalledExactlyOnceWith({ kind: 'rect', rect: { x: 5, y: 4, width: 7, height: 4 }, under: terminal });
    });

    it('Escape cancels a keyboard region without committing media', async () => {
        const { layer, onCommit, onCancel } = await mount();
        await act(async () => {
            for (const key of ['r', 'Enter', 'ArrowRight', 'ArrowDown', 'Escape']) {
                layer.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
            }
        });
        expect(onCancel).toHaveBeenCalledTimes(1);
        expect(onCommit).not.toHaveBeenCalled();
    });

    it('preserves the first corner of a reverse keyboard region for native window-text provenance', async () => {
        const { layer, onCommit } = await mount(undefined, { display: { width: 12, height: 8 } });
        const key = (key: string) => layer.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
        await act(async () => { key('r'); key('Enter'); });
        await act(async () => {
            for (let i = 0; i < 10; i++) { key('ArrowLeft'); key('ArrowUp'); }
            key('Enter');
        });
        expect(onCommit).toHaveBeenCalledExactlyOnceWith({ kind: 'rect', rect: { x: 6, y: 4, width: -6, height: -4 }, under: terminal });
    });
});
