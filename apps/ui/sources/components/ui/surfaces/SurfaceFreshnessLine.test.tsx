// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { createDeferred, renderScreen } from '@/dev/testkit';

import { SurfaceFreshnessLine, SurfaceFreshnessOnSheetProvider } from './SurfaceFreshnessLine';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ View: 'View' });
});

function flattenStyle(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) return Object.assign({}, ...style.map(flattenStyle));
    return typeof style === 'object' && style !== null ? style as Record<string, unknown> : {};
}

describe('SurfaceFreshnessLine content', () => {
    it('keeps content honest: as of when, why, and one retry', async () => {
        const { formatAsOfTime } = await import('@/utils/time/formatAsOfTime');
        const retry = vi.fn();
        const asOf = Date.now() - 60_000;
        const screen = await renderScreen(
            <SurfaceFreshnessLine
                testID="fresh"
                asOf={asOf}
                reason="devbox isn’t answering"
                action={{ label: 'Retry', onPress: retry }}
            />,
        );
        expect(screen.getTextContent()).toContain(`As of ${formatAsOfTime(asOf)}`);
        expect(screen.getTextContent()).toContain('devbox isn’t answering');
        await act(async () => {
            screen.pressByTestId('fresh-action');
        });
        expect(retry).toHaveBeenCalledTimes(1);
    });

    it('never cuts its reason short beside two recoveries, with or without a time', async () => {
        const reason = 'Input delivery is uncertain. Copy your input and check the terminal before sending it again.';
        for (const asOf of [undefined, Date.now() - 60_000]) {
            const screen = await renderScreen(
                <SurfaceFreshnessLine testID="uncertain" tone="warning" reason={reason} {...(asOf ? { asOf } : {})}
                    actions={[{ label: 'Copy', onPress: () => {} }, { label: 'Discard', onPress: () => {} }]} />,
            );
            const clamped = screen.root.findAll((node) => typeof node.props.numberOfLines === 'number'
                && JSON.stringify(node.props.children ?? '').includes('uncertain'));
            expect(clamped).toHaveLength(0);
            expect(screen.getTextContent()).toContain(reason);
            await screen.unmount();
        }
    });

    it('shows a working ring on the line while it reconnects', async () => {
        const screen = await renderScreen(<SurfaceFreshnessLine testID="fresh" reason="Reconnecting to MacBook Pro…" busy />);
        expect(screen.findByTestId('fresh-spinner')).not.toBeNull();
    });
});

describe('SurfaceFreshnessLine recovery', () => {
    it('keeps Retry keyboard-visible and prevents reentry while its async action is pending', async () => {
        const deferred = createDeferred<void>();
        const retry = vi.fn(() => deferred.promise);
        const screen = await renderScreen(<SurfaceFreshnessLine testID="stale" reason="Refresh failed" action={{ label: 'Retry', onPress: retry }} />);
        const action = screen.findByTestId('stale-action')!;
        const target = { matches: (selector: string) => selector === ':focus-visible' };
        document.dispatchEvent(new Event('pointerdown', { bubbles: true }));
        await act(async () => { action.props.onFocus({ target }); });
        expect(flattenStyle(screen.findByTestId('stale-action')!.props.style({ pressed: false })).outlineStyle).toBeUndefined();
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
        await act(async () => { action.props.onFocus({ target }); });
        expect(flattenStyle(screen.findByTestId('stale-action')!.props.style({ pressed: false })))
            .toMatchObject({ outlineStyle: 'solid', outlineWidth: 2 });
        let pending: unknown;
        await act(async () => {
            pending = action.props.onPress();
            action.props.onPress();
        });
        expect(retry).toHaveBeenCalledOnce();
        expect(screen.findByTestId('stale-action')!.props.accessibilityState).toMatchObject({ busy: true, disabled: true });
        await act(async () => { deferred.resolve(); await pending; });
        expect(screen.findByTestId('stale-action')!.props.accessibilityState).toMatchObject({ busy: false, disabled: false });
    });
});

describe('SurfaceFreshnessLine placement', () => {
    it('is a filled strip under a pane header, and a plain line on a sheet that already draws the surface', async () => {
        const strip = await renderScreen(<SurfaceFreshnessLine testID="line" reason="Still reading" />);
        expect(flattenStyle(strip.findByTestId('line')!.props.style).backgroundColor).not.toBe('transparent');
        expect(flattenStyle(strip.findByTestId('line')!.props.style).borderTopWidth).toBeGreaterThan(0);

        const onSheet = await renderScreen(
            <SurfaceFreshnessOnSheetProvider><SurfaceFreshnessLine testID="line" reason="Still reading" /></SurfaceFreshnessOnSheetProvider>,
        );
        const style = flattenStyle(onSheet.findByTestId('line')!.props.style);
        expect(style.backgroundColor).toBe('transparent');
        expect(style.borderTopWidth ?? 0).toBe(0);
        expect(style.borderBottomWidth ?? 0).toBe(0);
        expect(style.paddingLeft).toBe(0);
    });
});


describe('SurfaceFreshnessLine inline', () => {
    it('reads as a header facts line: no strip, no block height, its Retry right after the words with reach in its hit area (R139)', async () => {
        const screen = await renderScreen(<SurfaceFreshnessLine testID="line" presentation="inline" asOf={Date.now()}
            reason="Pull requests and branches aren't available right now." action={{ label: 'Retry', onPress: () => {}, testID: 'line-retry' }} />);
        const style = flattenStyle(screen.findByTestId('line')!.props.style);
        expect(style.backgroundColor).toBe('transparent');
        expect(style.minHeight ?? 0).toBe(0);
        expect(style.paddingTop ?? style.paddingVertical ?? 0).toBe(0);
        const retry = screen.findByTestId('line-retry')!;
        // Drawn at the words' height; the finger reaches past it through the hit area (SurfaceFreshnessLine.touch.test).
        expect(flattenStyle(retry.props.style({ pressed: false, focused: false })).minHeight ?? 0).toBe(0);
    });
});

describe('SurfaceFreshnessLine chip', () => {
    it('is an inline status (no strip) whose steady, checking and behind states share the line\'s recovery', async () => {
        const live = await renderScreen(<SurfaceFreshnessLine testID="chip" presentation="chip" signal="live" lead="Sampled while you look" reason="Live" />);
        const liveStyle = flattenStyle(live.findByTestId('chip')!.props.style);
        expect(liveStyle.backgroundColor).toBe('transparent');
        expect(liveStyle.borderTopWidth ?? 0).toBe(0);
        expect(liveStyle.paddingLeft).toBe(0);
        expect(live.findByTestId('chip-signal')).not.toBeNull();
        expect(live.findByTestId('chip-lead')).not.toBeNull();
        expect(live.findByTestId('chip-spinner')).toBeNull();

        const checking = await renderScreen(<SurfaceFreshnessLine testID="chip" presentation="chip" busy asOf={Date.now()} reason="Checking…" />);
        expect(checking.findByTestId('chip')!.props['aria-busy']).toBe(true);
        expect(checking.findByTestId('chip-spinner')).not.toBeNull();
        expect(checking.findByTestId('chip-signal')).toBeNull();

        const deferred = createDeferred<void>();
        const retry = vi.fn(() => deferred.promise);
        const behind = await renderScreen(
            <SurfaceFreshnessLine testID="chip" presentation="chip" asOf={Date.now()} reason="" action={{ label: 'Retry', onPress: retry, testID: 'chip-retry' }} />,
        );
        const action = behind.findByTestId('chip-retry')!;
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
        await act(async () => { action.props.onFocus({ target: { matches: (selector: string) => selector === ':focus-visible' } }); });
        expect(flattenStyle(behind.findByTestId('chip-retry')!.props.style({ pressed: false })))
            .toMatchObject({ outlineStyle: 'solid', outlineWidth: 2 });
        await act(async () => { action.props.onPress(); action.props.onPress(); });
        expect(retry).toHaveBeenCalledOnce();
        await act(async () => { deferred.resolve(); });
    });
});
