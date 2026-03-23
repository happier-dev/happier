import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { MultiPaneHost } from './MultiPaneHost';
import { renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('MultiPaneHost (overlayDetails)', () => {
    it('renders a scrim for overlay details, exposes a resizer, and closes on scrim press', async () => {
        vi.useFakeTimers();
        const onCloseDetails = vi.fn();

        const screen = await renderScreen(<MultiPaneHost
                main={<Main />}
                rightPane={<Right />}
                detailsPane={<Details />}
                layout={{ kind: 'twoPane', right: 'docked', details: 'overlay' }}
                rightDockWidthPx={360}
                detailsDockWidthPx={520}
                onCloseRight={() => {}}
                onCloseDetails={onCloseDetails}
                onCommitRightDockWidthPx={() => {}}
                onCommitDetailsDockWidthPx={() => {}}
            />);

        const overlay = screen.tree.findByProps({ testID: 'multi-pane-details-overlay' });
        expect(overlay).toBeTruthy();

        const overlayWrapper = overlay.parent;
        expect(readZIndex(overlayWrapper?.props?.style)).toBeGreaterThan(0);

        await screen.pressByTestIdAsync('multi-pane-details-scrim');
        expect(onCloseDetails).toHaveBeenCalledTimes(0);
        await act(async () => {
            await vi.runAllTimersAsync();
        });
        expect(onCloseDetails).toHaveBeenCalledTimes(1);
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

function Details() {
    return React.createElement('Details');
}
