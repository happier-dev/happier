import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

import { MultiPaneHostWithBottom } from './MultiPaneHostWithBottom';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';


describe('MultiPaneHostWithBottom (overlayBottom)', () => {
    const overlayCloseDurationMs = motionTokens.durationMs.base;
    const originalWindow = (globalThis as any).window;

    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        standardCleanup();
        vi.useRealTimers();
        (globalThis as any).window = originalWindow;
    });

    it('renders a scrim for overlay bottom and closes on scrim press', async () => {
        const onCloseBottom = vi.fn();

        const screen = await renderScreen(<MultiPaneHostWithBottom
                    main={<Main />}
                    rightPane={null}
                    detailsPane={null}
                    layout={{ kind: 'single', right: 'hidden', details: 'hidden' }}
                    rightDockWidthPx={360}
                    detailsDockWidthPx={520}
                    onCloseRight={() => {}}
                    onCloseDetails={() => {}}
                    onCommitRightDockWidthPx={() => {}}
                    onCommitDetailsDockWidthPx={() => {}}
                    bottomPane={<Bottom />}
                    bottomPresentation="overlay"
                    bottomDockHeightPx={320}
                    bottomDockMinHeightPx={200}
                    bottomDockMaxHeightPx={600}
                    onCloseBottom={onCloseBottom}
                    onCommitBottomDockHeightPx={() => {}}
                />);

        expect(screen.findByTestId('multi-pane-bottom-scrim')).toBeTruthy();
        await screen.pressByTestIdAsync('multi-pane-bottom-scrim');
        expect(onCloseBottom).toHaveBeenCalledTimes(0);
        await flushHookEffects({ advanceTimersMs: overlayCloseDurationMs });
        expect(onCloseBottom).toHaveBeenCalledTimes(1);
    });

    it('closes overlay bottom on Escape key press and prevents inner pane closures', async () => {
        const onCloseBottom = vi.fn();
        const onCloseRight = vi.fn();

        const fakeWindow = new (globalThis as any).EventTarget();
        (globalThis as any).window = fakeWindow;

        const screen = await renderScreen(<MultiPaneHostWithBottom
                    main={<Main />}
                    rightPane={<Right />}
                    detailsPane={null}
                    layout={{ kind: 'overlayStack', right: 'overlay', details: 'hidden' }}
                    rightDockWidthPx={360}
                    detailsDockWidthPx={520}
                    onCloseRight={onCloseRight}
                    onCloseDetails={() => {}}
                    onCommitRightDockWidthPx={() => {}}
                    onCommitDetailsDockWidthPx={() => {}}
                    bottomPane={<Bottom />}
                    bottomPresentation="overlay"
                    bottomDockHeightPx={320}
                    bottomDockMinHeightPx={200}
                    bottomDockMaxHeightPx={600}
                    onCloseBottom={onCloseBottom}
                    onCommitBottomDockHeightPx={() => {}}
                />);

        expect(screen.findByTestId('multi-pane-bottom-scrim')).toBeTruthy();
        act(() => {
            dispatchEscapeKeyDown(fakeWindow);
        });
        expect(onCloseBottom).toHaveBeenCalledTimes(0);
        expect(onCloseRight).toHaveBeenCalledTimes(0);
        await flushHookEffects({ advanceTimersMs: overlayCloseDurationMs });
        expect(onCloseBottom).toHaveBeenCalledTimes(1);
        expect(onCloseRight).toHaveBeenCalledTimes(0);
    });

    it('keeps the overlay bottom resizable', async () => {
        const screen = await renderScreen(<MultiPaneHostWithBottom
                    main={<Main />}
                    rightPane={null}
                    detailsPane={null}
                    layout={{ kind: 'single', right: 'hidden', details: 'hidden' }}
                    rightDockWidthPx={360}
                    detailsDockWidthPx={520}
                    onCloseRight={() => {}}
                    onCloseDetails={() => {}}
                    onCommitRightDockWidthPx={() => {}}
                    onCommitDetailsDockWidthPx={() => {}}
                    bottomPane={<Bottom />}
                    bottomPresentation="overlay"
                    bottomDockHeightPx={320}
                    bottomDockMinHeightPx={200}
                    bottomDockMaxHeightPx={600}
                    onCloseBottom={() => {}}
                    onCommitBottomDockHeightPx={() => {}}
                />);

        expect(screen.findByTestId('multi-pane-bottom-overlay-pane')).toBeTruthy();
        expect(screen.findByTestId('multi-pane-bottom-overlay-resize-handle')).toBeTruthy();
    });
});

function Main() {
    return React.createElement('Main');
}

function Right() {
    return React.createElement('Right');
}

function Bottom() {
    return React.createElement('Bottom');
}

function dispatchEscapeKeyDown(target: EventTarget) {
    const event = new Event('keydown');
    Object.defineProperty(event, 'key', {
        configurable: true,
        enumerable: true,
        value: 'Escape',
    });
    target.dispatchEvent(event);
}
