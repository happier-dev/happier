import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { mountThroughReactNativeWeb } from '../../rnwMount.testSupport.js';
import { HappierLiveStreamInputLayer } from './LiveStreamInputLayer.js';
import type { HappierLiveStreamInputGesture } from './inputGesture.js';

describe('live stream viewer cursor', () => {
    it('stays on the drawn picture when the picture settles after the layer mounted', async () => {
        const positions: { x: number; y: number }[] = [];
        const layer = (content: { x: number; y: number; width: number; height: number }) => <HappierLiveStreamInputLayer
            inputAccepted supports={() => true} onGesture={() => {}} testID="viewer"
            viewport={{ width: 591, height: 759 }} content={content}
            renderCursor={position => { positions.push(position); return null; }} />;
        // Before the page's shape is known the picture stands in for the whole stage; then the page arrives
        // as a 591×374 band at the top (the live desktop pane, DESIGN-ACCEPT-138 fix 6).
        const mounted = mountThroughReactNativeWeb(layer({ x: 0, y: 0, width: 591, height: 759 }));
        try {
            await mounted.render(layer({ x: 0, y: 0, width: 591, height: 374 }));
            const last = positions[positions.length - 1]!;
            expect(last.y).toBeLessThanOrEqual(374);
            expect(last).toEqual({ x: 295.5, y: 187 });
        } finally { mounted.unmount(); }
    });
});

describe('live stream keyboard focus', () => {
    it('preserves native Space, navigation and editing keys while sending printable Unicode as text', () => {
        const gestures: HappierLiveStreamInputGesture[] = [];
        const mounted = mountThroughReactNativeWeb(<HappierLiveStreamInputLayer inputAccepted supports={() => true}
            onGesture={({ action }) => gestures.push(action)} testID="viewer" />);
        try {
            const capture = mounted.container.querySelector<HTMLElement>('[data-testid="viewer-capture"]')!;
            act(() => capture.focus());
            const keys = [' ', 'Enter', 'Tab', 'Backspace', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'];
            for (const key of keys) {
                const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
                act(() => capture.dispatchEvent(event));
                expect(event.defaultPrevented).toBe(true);
            }
            act(() => capture.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', shiftKey: true, bubbles: true })));
            for (const key of ['a', 'é', '日']) {
                act(() => capture.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })));
            }
            expect(gestures).toEqual([
                ...keys.map(key => ({ kind: 'keyboard_key', key })),
                { kind: 'keyboard_key', key: ' ', modifiers: ['shift'] },
                ...['a', 'é', '日'].map(text => ({ kind: 'keyboard_text', text })),
            ]);
        } finally { mounted.unmount(); }
    });

    it('withholds dead keys and IME candidates and sends only committed composition as text', () => {
        const gestures: HappierLiveStreamInputGesture[] = [];
        const mounted = mountThroughReactNativeWeb(<HappierLiveStreamInputLayer inputAccepted supports={() => true}
            onGesture={({ action }) => gestures.push(action)} testID="viewer" />);
        try {
            const capture = mounted.container.querySelector<HTMLElement>('[data-testid="viewer-capture"]')!;
            act(() => capture.focus());
            for (const key of ['Dead', 'Process']) {
                const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
                act(() => capture.dispatchEvent(event));
                expect(event.defaultPrevented).toBe(false);
            }
            for (const key of ['n', ' ', 'Enter']) {
                const event = new KeyboardEvent('keydown', { key, isComposing: true, bubbles: true, cancelable: true });
                act(() => capture.dispatchEvent(event));
                expect(event.defaultPrevented).toBe(false);
            }
            expect(gestures).toEqual([]);
            act(() => capture.dispatchEvent(new CompositionEvent('compositionend', { data: '日本 é ', bubbles: true })));
            expect(gestures).toEqual([{ kind: 'keyboard_text', text: '日本 é ' }]);
            act(() => capture.blur());
            act(() => capture.dispatchEvent(new CompositionEvent('compositionend', { data: 'ignored', bubbles: true })));
            expect(gestures).toHaveLength(1);
        } finally { mounted.unmount(); }
    });

    it.each([true, false])('consumes host file drops and delivers only when input is accepted (%s)', inputAccepted => {
        const onFileDrop = vi.fn();
        const mounted = mountThroughReactNativeWeb(<HappierLiveStreamInputLayer inputAccepted={inputAccepted} supports={() => true}
            viewport={{ width: 800, height: 400 }} onGesture={() => {}} onFileDrop={onFileDrop} testID="viewer" />);
        try {
            const capture = mounted.container.querySelector('[data-testid="viewer-capture"]')!;
            const file = new File(['proof'], 'proof.txt');
            const drop = new MouseEvent('drop', { bubbles: true, cancelable: true, clientX: 400, clientY: 200 });
            Object.defineProperty(drop, 'dataTransfer', { value: { types: ['Files'], files: [file] } });
            act(() => capture.dispatchEvent(drop));
            expect(drop.defaultPrevented).toBe(true);
            if (inputAccepted) expect(onFileDrop).toHaveBeenCalledWith([file], { x: 0.5, y: 0.5 });
            else expect(onFileDrop).not.toHaveBeenCalled();
        } finally { mounted.unmount(); }
    });
    it('exposes the named remote input capture as a group', () => {
        const mounted = mountThroughReactNativeWeb(<HappierLiveStreamInputLayer inputAccepted supports={() => true}
            viewport={{ width: 800, height: 400 }} onGesture={() => {}} accessibilityLabel="Control the page" testID="viewer" />);
        try {
            const capture = mounted.container.querySelector('[data-testid="viewer-capture"]')!;
            expect(capture.getAttribute('role')).toBe('group');
            expect(capture.getAttribute('aria-label')).toBe('Control the page');
        } finally { mounted.unmount(); }
    });
    it.each([true, false])('owns every touch on the picture, so a pinch never zooms the app page (input accepted: %s)', inputAccepted => {
        const mounted = mountThroughReactNativeWeb(<HappierLiveStreamInputLayer inputAccepted={inputAccepted} supports={() => true}
            viewport={{ width: 390, height: 511 }} onGesture={() => {}} testID="viewer" />);
        try {
            const capture = mounted.container.querySelector('[data-testid="viewer-capture"]')! as HTMLElement;
            // React Native Web writes atomic classes; jsdom does not compute touch-action, so read the capture's rules.
            const rules = Array.from(document.styleSheets).flatMap(sheet => Array.from(sheet.cssRules)) as CSSStyleRule[];
            const touchAction = rules.filter(rule => rule.selectorText && Array.from(capture.classList)
                .some(name => rule.selectorText.split(',').some(selector => selector.trim() === `.${name}`)))
                .map(rule => rule.style.getPropertyValue('touch-action')).filter(Boolean);
            expect(capture.style.getPropertyValue('touch-action') || touchAction.at(-1)).toBe('none');
        } finally { mounted.unmount(); }
    });
    it.each(['direct', 'trackpad'] as const)('%s emits a wire-valid atomic drag from fractional browser timestamps', async mode => {
        const actions: HappierLiveStreamInputGesture[] = [];
        const mounted = mountThroughReactNativeWeb(<HappierLiveStreamInputLayer inputAccepted mode={mode}
            supports={kind => kind !== 'pointer' && kind !== 'swipe'} viewport={{ width: 800, height: 400 }}
            onGesture={({ action }) => actions.push(action)} testID="viewer" />);
        const capture = mounted.container.querySelector('[data-testid="viewer-capture"]')!;
        const mouse = (kind: string, at: number, x: number, y: number) => {
            const event = new MouseEvent(kind, { bubbles: true, button: 0, buttons: kind === 'mouseup' ? 0 : 1, clientX: x, clientY: y });
            Object.defineProperty(event, 'timeStamp', { value: at });
            act(() => capture.dispatchEvent(event));
        };
        try {
            mouse('mousedown', 1.125, 320, 172);
            mouse('mousemove', 701.25, 380, 222);
            mouse('mouseup', 1301.375, 380, 222);
            expect(actions).toMatchObject([{ kind: 'drag', durationMs: 1300 }]);
        } finally { mounted.unmount(); }
    });
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
    it('retains an off-center hover across Direct to Trackpad and releases the native atomic drag after a host rerender', async () => {
        const actions: HappierLiveStreamInputGesture[] = [];
        const render = (mode: 'direct' | 'trackpad' = 'trackpad') => <HappierLiveStreamInputLayer inputAccepted mode={mode}
            supports={kind => kind !== 'pointer'} viewport={{ width: 800, height: 400 }}
            onGesture={({ action }) => actions.push(action)} testID="viewer" />;
        const mounted = mountThroughReactNativeWeb(render('direct'));
        const capture = mounted.container.querySelector('[data-testid="viewer-capture"]')!;
        const mouse = (kind: string, at: number, x: number, y: number) => {
            const event = new MouseEvent(kind, { bubbles: true, button: 0, buttons: kind === 'mouseup' ? 0 : 1, clientX: x, clientY: y });
            Object.defineProperty(event, 'timeStamp', { value: at });
            act(() => capture.dispatchEvent(event));
        };
        try {
            const hover = new MouseEvent('pointermove', { bubbles: true, clientX: 320, clientY: 172, buttons: 0 });
            Object.defineProperty(hover, 'pointerType', { value: 'mouse' });
            act(() => capture.dispatchEvent(hover));
            await mounted.render(render());
            mouse('mousedown', 1, 320, 172);
            mouse('mousemove', 701, 380, 222);
            expect(actions.filter(action => action.kind !== 'move')).toEqual([]);
            await mounted.render(render());
            mouse('mouseup', 801, 380, 222);
            const released = actions.filter(action => action.kind !== 'move');
            expect(released).toMatchObject([{ kind: 'drag', from: { x: 0.4, y: 0.43 },
                to: { x: expect.any(Number), y: expect.any(Number) } }]);
            const drag = released[0];
            if (drag?.kind !== 'drag') throw new Error('Native drag was not released');
            expect(drag.to.x).toBeGreaterThan(drag.from.x);
            expect(drag.to.y).toBeGreaterThan(drag.from.y);
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
