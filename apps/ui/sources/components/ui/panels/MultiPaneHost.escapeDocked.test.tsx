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
                layout={{ kind: 'threePane', right: 'docked', details: 'docked' }}
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
                    layout={{ kind: 'threePane', right: 'docked', details: 'docked' }}
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
