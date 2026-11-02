import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { mountThroughReactNativeWeb } from '../../rnwMount.testSupport.js';
import { HappierLiveStreamInputLayer } from './LiveStreamInputLayer.js';
import type { HappierLiveStreamInputGesture } from './inputGesture.js';

describe('live stream keyboard focus', () => {
    it('turns a double tap into exactly one double click and drops delayed taps after control is lost', async () => {
        vi.useFakeTimers();
        const onGesture = vi.fn();
        const render = (inputAccepted: boolean) => <HappierLiveStreamInputLayer inputAccepted={inputAccepted}
            mode="trackpad" localZoom supports={() => true} viewport={{ width: 800, height: 400 }} onGesture={onGesture} testID="viewer" />;
        const mounted = mountThroughReactNativeWeb(render(true));
        const capture = mounted.container.querySelector('[data-testid="viewer-capture"]')!;
        const tap = () => act(() => {
            capture.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 10, clientY: 10 }));
            capture.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, clientX: 10, clientY: 10 }));
        });
        try {
            tap();
            expect(onGesture).not.toHaveBeenCalled();
            act(() => vi.advanceTimersByTime(100));
            tap();
            expect(onGesture).toHaveBeenCalledTimes(1);
            expect(onGesture.mock.calls[0][0].action).toMatchObject({ kind: 'tap', clickCount: 2, point: { x: 0.5, y: 0.5 } });
            act(() => vi.advanceTimersByTime(400));
            tap();
            await mounted.render(render(false));
            act(() => vi.advanceTimersByTime(400));
            expect(onGesture).toHaveBeenCalledTimes(1);
        } finally { mounted.unmount(); vi.useRealTimers(); }
    });
    it('coalesces distinct mouse and pen positions across host rerenders to the latest per frame, excluding touch and pressed pointers', async () => {
        const frames = new Map<number, FrameRequestCallback>();
        let nextFrame = 0;
        vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(callback => { frames.set(++nextFrame, callback); return nextFrame; });
        vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(id => { frames.delete(id); });
        const actions: HappierLiveStreamInputGesture[] = [];
        const supports = () => true;
        const render = () => <HappierLiveStreamInputLayer inputAccepted supports={supports}
            viewport={{ width: 800, height: 400 }} onGesture={({ action }) => actions.push(action)} testID="viewer" />;
        const mounted = mountThroughReactNativeWeb(render());
        const capture = mounted.container.querySelector('[data-testid="viewer-capture"]')!;
        const move = (x: number, pointerType = 'mouse', buttons = 0) => {
            const event = new MouseEvent('pointermove', { bubbles: true, clientX: x, clientY: 200, buttons });
            Object.defineProperty(event, 'pointerType', { value: pointerType });
            act(() => capture.dispatchEvent(event));
        };
        const frame = () => act(() => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback(0)); });
        try {
            move(100); move(200); move(400, 'pen'); move(500, 'touch'); move(600, 'mouse', 1);
            await mounted.render(render());
            expect(frames.size).toBe(1);
            frame();
            expect(actions).toMatchObject([{ kind: 'move', point: { x: 0.5, y: 0.5 } }]);
            move(600, 'pen'); frame();
            expect(actions).toMatchObject([{ kind: 'move' }, { kind: 'move', point: { x: 0.75, y: 0.5 } }]);
        } finally { mounted.unmount(); vi.restoreAllMocks(); }
    });
    it('keeps a held browser drag across host callback changes and releases it when control is withdrawn', async () => {
        const actions: HappierLiveStreamInputGesture[] = [];
        const supports = () => true;
        const render = (inputAccepted: boolean) => <HappierLiveStreamInputLayer inputAccepted={inputAccepted} mode="trackpad"
            supports={supports} viewport={{width: 800, height: 400}} onGesture={({action}) => actions.push(action)} testID="viewer" />;
        const mounted = mountThroughReactNativeWeb(render(true));
        const capture = mounted.container.querySelector('[data-testid="viewer-capture"]')!;
        const mouse = (kind: string, at: number, x: number) => {
            const event = new MouseEvent(kind, {bubbles: true, button: 0, buttons: 1, clientX: x, clientY: 10});
            Object.defineProperty(event, 'timeStamp', {value: at});
            act(() => capture.dispatchEvent(event));
        };
        try {
            mouse('mousedown', 1, 10);
            mouse('mousemove', 601, 40);
            expect(actions).toMatchObject([{kind: 'pointer', phase: 'down'}]);
            await mounted.render(render(true));
            expect(actions.some(action => action.kind === 'pointer' && action.phase === 'cancel')).toBe(false);
            await mounted.render(render(false));
            expect(actions.at(-1)).toMatchObject({kind: 'pointer', phase: 'cancel'});
        } finally { mounted.unmount(); }
    });
    it('drops pending hover on loss of control and on unmount', async () => {
        const frames = new Map<number, FrameRequestCallback>();
        let nextFrame = 0;
        vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(callback => { frames.set(++nextFrame, callback); return nextFrame; });
        vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(id => { frames.delete(id); });
        const onGesture = vi.fn();
        const render = (inputAccepted: boolean) => <HappierLiveStreamInputLayer inputAccepted={inputAccepted}
            supports={() => true} viewport={{ width: 800, height: 400 }} onGesture={onGesture} testID="viewer" />;
        const mounted = mountThroughReactNativeWeb(render(true));
        const move = () => {
            const event = new MouseEvent('pointermove', { bubbles: true, clientX: 400, clientY: 200 });
            Object.defineProperty(event, 'pointerType', { value: 'mouse' });
            act(() => mounted.container.querySelector('[data-testid="viewer-capture"]')!.dispatchEvent(event));
        };
        try {
            move();
            expect(frames.size).toBe(1);
            await mounted.render(render(false));
            expect(frames.size).toBe(0);
            move();
            expect(frames.size).toBe(0);
            expect(onGesture).not.toHaveBeenCalled();
            await mounted.render(render(true));
            move();
            expect(frames.size).toBe(1);
            mounted.unmount();
            expect(frames.size).toBe(0);
        } finally { mounted.unmount(); vi.restoreAllMocks(); }
    });
    it('consumes supported wheel input at its viewer without scrolling the host', () => {
        const onGesture = vi.fn();
        const mounted = mountThroughReactNativeWeb(<HappierLiveStreamInputLayer inputAccepted supports={() => true}
            viewport={{ width: 800, height: 400 }} onGesture={onGesture} testID="viewer" />);
        try {
            const capture = mounted.container.querySelector<HTMLElement>('[data-testid="viewer-capture"]')!;
            const wheel = new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: 400, clientY: 200, deltaY: 420 });
            act(() => capture.dispatchEvent(wheel));
            expect(wheel.defaultPrevented).toBe(true);
            expect(onGesture).toHaveBeenCalledWith(expect.objectContaining({ action: expect.objectContaining({
                kind: 'wheel', point: { x: 0.5, y: 0.5 }, deltaY: 420,
            }) }));
        } finally { mounted.unmount(); }
    });
    it('binds keyboard and Copy to the viewer that was clicked, without an external focus call', () => {
        const onClipboardShortcut = vi.fn();
        const mounted = mountThroughReactNativeWeb(<HappierLiveStreamInputLayer inputAccepted supports={() => true}
            onGesture={() => {}} onClipboardShortcut={onClipboardShortcut} testID="viewer" />);
        try {
            const capture = mounted.container.querySelector<HTMLElement>('[data-testid="viewer-capture"]')!;
            act(() => {
                capture.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 10, clientY: 10 }));
                capture.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, clientX: 10, clientY: 10 }));
            });
            expect(document.activeElement).toBe(capture);
            act(() => capture.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true, cancelable: true })));
            expect(onClipboardShortcut).toHaveBeenCalledWith('copy');
        } finally { mounted.unmount(); }
    });
    it('routes focused command/control clipboard shortcuts to the host without typing their letters', () => {
        const onGesture = vi.fn();
        const onClipboardShortcut = vi.fn();
        const mounted = mountThroughReactNativeWeb(
            <HappierLiveStreamInputLayer inputAccepted supports={() => true}
                onGesture={onGesture} onClipboardShortcut={onClipboardShortcut} testID="viewer" />,
        );
        try {
            const capture = mounted.container.querySelector<HTMLElement>('[data-testid="viewer-capture"]')!;
            act(() => capture.focus());
            for (const modifier of ['metaKey', 'ctrlKey']) {
                for (const key of ['c', 'x', 'v']) {
                    const event = new KeyboardEvent('keydown', { key, [modifier]: true, bubbles: true, cancelable: true });
                    act(() => capture.dispatchEvent(event));
                    expect(event.defaultPrevented).toBe(true);
                }
            }
            expect(onClipboardShortcut.mock.calls.map(([action]) => action)).toEqual(['copy', 'cut', 'paste', 'copy', 'cut', 'paste']);
            expect(onGesture).not.toHaveBeenCalled();
            act(() => capture.blur());
            act(() => capture.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', metaKey: true, bubbles: true })));
            expect(onClipboardShortcut).toHaveBeenCalledTimes(6);
        } finally { mounted.unmount(); }
    });
    it('leaves Shift+Tab to local traversal while retaining ordinary guest keys and text', () => {
        const gestures: HappierLiveStreamInputGesture[] = [];
        const mounted = mountThroughReactNativeWeb(
            <HappierLiveStreamInputLayer inputAccepted supports={() => true}
                onGesture={({ action }) => gestures.push(action)} testID="viewer" />,
        );
        try {
            const capture = mounted.container.querySelector<HTMLElement>('[data-testid="viewer-capture"]');
            expect(capture).not.toBeNull();
            act(() => capture!.focus());
            expect(document.activeElement).toBe(capture);

            const leave = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true });
            act(() => capture!.dispatchEvent(leave));
            expect(leave.defaultPrevented).toBe(false);
            expect(gestures).toEqual([]);

            for (const key of ['Tab', 'Escape', 'a']) {
                const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
                act(() => capture!.dispatchEvent(event));
                expect(event.defaultPrevented).toBe(true);
            }
            expect(gestures).toEqual([
                { kind: 'keyboard_key', key: 'Tab' },
                { kind: 'keyboard_key', key: 'Escape' },
                { kind: 'keyboard_text', text: 'a' },
            ]);

            act(() => capture!.blur());
            const unfocused = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
            act(() => capture!.dispatchEvent(unfocused));
            expect(unfocused.defaultPrevented).toBe(false);
            expect(gestures).toHaveLength(3);
        } finally {
            mounted.unmount();
        }
    });
});
