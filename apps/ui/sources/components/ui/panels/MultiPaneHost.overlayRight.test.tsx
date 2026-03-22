import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderScreen } from '@/dev/testkit';
import { MultiPaneHost } from './MultiPaneHost';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('MultiPaneHost (overlayRight)', () => {
    it('renders a scrim for overlay right and closes on scrim press', async () => {
        vi.useFakeTimers();
        const onCloseRight = vi.fn();
        const screen = await renderScreen(<MultiPaneHost
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
                />);

        const overlay = screen.findByTestId('multi-pane-right-overlay');
        if (!overlay) {
            throw new Error('Expected right overlay to be present');
        }
        const overlayWrapper = overlay.parent?.parent;
        expect(readZIndex(overlayWrapper?.props?.style)).toBeGreaterThan(0);

        const scrim = screen.findByTestId('multi-pane-right-scrim');
        if (!scrim) {
            throw new Error('Expected right scrim to be present');
        }
        act(() => {
            scrim.props.onPress();
        });
        expect(onCloseRight).toHaveBeenCalledTimes(0);
        act(() => {
            vi.runAllTimers();
        });
        expect(onCloseRight).toHaveBeenCalledTimes(1);
    });

    it('closes overlay right on Escape key press (web)', async () => {
        vi.useFakeTimers();
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

        const screen = await renderScreen(<MultiPaneHost
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
                />);

        expect(screen.findByTestId('multi-pane-right-scrim')).toBeTruthy();
        act(() => {
            (globalThis as any).window.dispatchEvent(new (globalThis as any).KeyboardEvent('keydown', { key: 'Escape' }));
        });
        expect(onCloseRight).toHaveBeenCalledTimes(0);
        act(() => {
            vi.runAllTimers();
        });
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

function Main() {
    return React.createElement('Main');
}

function Right() {
    return React.createElement('Right');
}
