import * as React from 'react';
import { act } from 'react-test-renderer';
import { Platform } from 'react-native';
import { describe, expect, it, vi } from 'vitest';
import { MultiPaneHost } from './MultiPaneHost';
import { renderScreen } from '@/dev/testkit';
import {
    dispatchEscapeToLayerStack,
} from '@/keyboard/escape';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('MultiPaneHost (Escape closes docked panes)', () => {
    it('returns from the main surface after the companion closes', async () => {
        const originalPlatform = Platform.OS;
        const onCloseRight = vi.fn();
        const onCloseMainSurface = vi.fn();
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
        try {
            const tree = (side: boolean) => <MultiPaneHost
                main={<Main />}
                rightPane={side ? <Right /> : null}
                rightSurfaces={[
                    { id: 'info', placement: 'main', content: <Details /> },
                    { id: 'files', placement: side ? 'side' : 'hidden', content: <Right /> },
                ]}
                onCloseMainSurface={onCloseMainSurface}
                detailsPane={null}
                layout={{ main: 'docked', kind: 'twoPane', right: side ? 'docked' : 'hidden', details: 'hidden' }}
                rightDockWidthPx={360} detailsDockWidthPx={520}
                onCloseRight={onCloseRight} onCloseDetails={() => {}}
                onCommitRightDockWidthPx={() => {}} onCommitDetailsDockWidthPx={() => {}}
            />;
            const screen = await renderScreen(tree(true));
            act(() => { dispatchEscapeToLayerStack({ key: 'Escape' }); });
            expect(onCloseRight).toHaveBeenCalledTimes(1);
            expect(onCloseMainSurface).not.toHaveBeenCalled();
            await screen.update(tree(false));
            act(() => { dispatchEscapeToLayerStack({ key: 'Escape' }); });
            expect(onCloseMainSurface).toHaveBeenCalledTimes(1);
        } finally {
            Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatform });
        }
    });
    it('closes docked details first on Escape (web)', async () => {
        const originalPlatform = Platform.OS;
        const onCloseRight = vi.fn();
        const onCloseDetails = vi.fn();

        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });

        try {
            expect(Platform.OS).toBe('web');
            await renderScreen(<MultiPaneHost
                main={<Main />}
                rightPane={<Right />}
                detailsPane={<Details />}
                layout={{ main: 'docked', kind: 'threePane', right: 'docked', details: 'docked' }}
                rightDockWidthPx={360}
                detailsDockWidthPx={520}
                onCloseRight={onCloseRight}
                onCloseDetails={onCloseDetails}
                onCommitRightDockWidthPx={() => {}}
                onCommitDetailsDockWidthPx={() => {}}
            />);

            act(() => {
                dispatchEscapeToLayerStack({ key: 'Escape' });
            });

            expect(onCloseDetails).toHaveBeenCalledTimes(1);
            expect(onCloseRight).toHaveBeenCalledTimes(0);
        } finally {
            Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatform });
        }
    });

    it('does not close panes on Escape when event target is a text input', async () => {
        const originalPlatform = Platform.OS;
        const onCloseRight = vi.fn();
        const onCloseDetails = vi.fn();

        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });

        try {
            expect(Platform.OS).toBe('web');
            await renderScreen(<MultiPaneHost
                    main={<Main />}
                    rightPane={<Right />}
                    detailsPane={<Details />}
                    layout={{ main: 'docked', kind: 'threePane', right: 'docked', details: 'docked' }}
                    rightDockWidthPx={360}
                    detailsDockWidthPx={520}
                    onCloseRight={onCloseRight}
                    onCloseDetails={onCloseDetails}
                    onCommitRightDockWidthPx={() => {}}
                    onCommitDetailsDockWidthPx={() => {}}
                />);

            act(() => {
                dispatchEscapeToLayerStack({ key: 'Escape', target: { tagName: 'INPUT' } });
            });

            expect(onCloseDetails).toHaveBeenCalledTimes(0);
            expect(onCloseRight).toHaveBeenCalledTimes(0);
        } finally {
            Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatform });
        }
    });
});

function Main() {
    return React.createElement('Main');
}

function Right() {
    return React.createElement('Right');
}

function Details() {
    return React.createElement('Details');
}
