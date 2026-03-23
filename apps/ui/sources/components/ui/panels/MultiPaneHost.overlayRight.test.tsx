import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { MultiPaneHost } from './MultiPaneHost';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const RIGHT_OVERLAY_TEST_ID = 'multi-pane-right-overlay';
const RIGHT_SCRIM_TEST_ID = 'multi-pane-right-scrim';
const OVERLAY_CLOSE_DURATION_MS = motionTokens.durationMs.base;

describe('MultiPaneHost (overlayRight)', () => {
    const originalWindow = (globalThis as any).window;
    const originalKeyboardEvent = (globalThis as any).KeyboardEvent;

    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        standardCleanup();
        vi.useRealTimers();
        (globalThis as any).window = originalWindow;
        (globalThis as any).KeyboardEvent = originalKeyboardEvent;
    });

    it('renders a scrim for overlay right and closes on scrim press', async () => {
        const onCloseRight = vi.fn();
        const tree = (await renderScreen(<MultiPaneHost
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
                />)).tree;

        const overlay = tree.findByTestId(RIGHT_OVERLAY_TEST_ID);
        if (!overlay) {
            throw new Error('Expected right overlay to be present');
        }
        const overlayWrapper = findAncestorWithPositiveZIndex(overlay);
        if (!overlayWrapper) {
            throw new Error('Expected right overlay wrapper to be present');
        }
        expect(readZIndex(overlayWrapper?.props?.style)).toBeGreaterThan(0);

        expect(tree.findByTestId(RIGHT_SCRIM_TEST_ID)).toBeTruthy();
        await act(async () => {
            await tree.pressByTestIdAsync(RIGHT_SCRIM_TEST_ID);
        });
        expect(onCloseRight).toHaveBeenCalledTimes(0);
        await flushHookEffects({ advanceTimersMs: OVERLAY_CLOSE_DURATION_MS });
        expect(onCloseRight).toHaveBeenCalledTimes(1);
    });

    it('closes overlay right on Escape key press (web)', async () => {
        const onCloseRight = vi.fn();
        const fakeWindow = new (globalThis as any).EventTarget();
        (globalThis as any).window = fakeWindow;
        (globalThis as any).KeyboardEvent = class KeyboardEvent extends Event {
            key: string;
            constructor(type: string, init: { key: string }) {
                super(type);
                this.key = init.key;
            }
        };

        const tree = (await renderScreen(<MultiPaneHost
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
                />)).tree;

        expect(tree.findByTestId(RIGHT_SCRIM_TEST_ID)).toBeTruthy();
        act(() => {
            (globalThis as any).window.dispatchEvent(new (globalThis as any).KeyboardEvent('keydown', { key: 'Escape' }));
        });
        expect(onCloseRight).toHaveBeenCalledTimes(0);
        await flushHookEffects({ advanceTimersMs: OVERLAY_CLOSE_DURATION_MS });
        expect(onCloseRight).toHaveBeenCalledTimes(1);
    });
});

function readZIndex(style: unknown): number {
    if (Array.isArray(style)) return Math.max(0, ...style.map(readZIndex));
    if (!style || typeof style !== 'object') return 0;
    const asAny = style as any;
    const value = asAny?.zIndex;
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function findAncestorWithPositiveZIndex(node: { parent?: { parent?: unknown; props?: { style?: unknown } } | null } | null | undefined) {
    let current = node?.parent ?? null;
    while (current) {
        if (readZIndex(current.props?.style) > 0) {
            return current;
        }
        current = current.parent ?? null;
    }
    return null;
}

function Main() {
    return React.createElement('Main');
}

function Right() {
    return React.createElement('Right');
}
