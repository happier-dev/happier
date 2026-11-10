import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { makeMutable } from 'react-native-reanimated';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    readReanimatedFrameCallbacks,
    resetReanimatedFrameCallbacks,
    type ReanimatedFrameCallbackRecord,
} from '@/dev/testkit/mocks/reanimated';

import { LiquidFill } from './LiquidFill';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const host = vi.hoisted(() => ({
    appState: 'active' as string,
    listeners: new Set<(state: string) => void>(),
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: { OS: 'ios', select: (spec: Record<string, unknown>) => spec?.ios ?? spec?.default },
        AppState: {
            get currentState() {
                return host.appState;
            },
            addEventListener: (event: string, listener: (state: string) => void) => {
                if (event !== 'change') return { remove: () => {} };
                host.listeners.add(listener);
                return { remove: () => host.listeners.delete(listener) };
            },
        },
    });
});

/** Sets the host app state and notifies, whether or not a watch is running yet. */
function setAppState(next: string): void {
    host.appState = next;
    for (const listener of [...host.listeners]) listener(next);
}

/**
 * The fluid gauge is a shader on a frame clock, so "is anyone looking?" is a
 * correctness question, not a nicety. It used to answer it with a private
 * `AppState` subscription — one of six hand-rolled copies (§16.3) — whose
 * initial sample treated *anything but background* as active. On iOS that
 * includes `inactive`: a gauge mounted behind the app switcher, Control Centre
 * or a system prompt starts a 60 Hz shader nobody can see.
 */
describe('LiquidFill activation', () => {
    let tree: renderer.ReactTestRenderer | null = null;

    beforeEach(() => {
        resetReanimatedFrameCallbacks();
    });

    afterEach(() => {
        act(() => {
            tree?.unmount();
        });
        tree = null;
        setAppState('active');
    });

    function render(isStreaming: boolean): ReanimatedFrameCallbackRecord {
        act(() => {
            tree = renderer.create(
                <LiquidFill
                    fillPct={makeMutable(42)}
                    size={40}
                    isStreaming={isStreaming}
                    okColor="#0f0"
                    warnColor="#ff0"
                    dangerColor="#f00"
                    trackColor="#111"
                />,
            );
        });
        const records = readReanimatedFrameCallbacks();
        expect(records).toHaveLength(1);
        return records[0]!;
    }

    it('does not start the shader clock while the app is only inactive', () => {
        setAppState('inactive');
        const record = render(true);
        expect(record.setActiveCalls).toEqual([false]);
        expect(record.handle.isActive).toBe(false);
    });

    it('runs while streaming and stops when the app leaves the foreground', () => {
        const record = render(true);
        expect(record.setActiveCalls).toEqual([true]);

        act(() => {
            setAppState('background');
        });
        expect(record.setActiveCalls).toEqual([true, false]);

        act(() => {
            setAppState('active');
        });
        expect(record.setActiveCalls).toEqual([true, false, true]);
    });

    it('stays still while nothing is streaming', () => {
        const record = render(false);
        expect(record.setActiveCalls).toEqual([false]);
    });
});

/**
 * Skia blends a runtime shader's output as premultiplied colour. The dark theme's track is a faint white
 * (`rgba(255,255,255,0.06)`); handed over straight, it painted as an opaque white disc (owner 11-10, phone composer).
 */
describe('LiquidFill colour uniforms', () => {
    it('hands the shader premultiplied colours', async () => {
        const { liquidFillColorUniform } = await import('./LiquidFill');
        const [r, g, b, a] = liquidFillColorUniform('rgba(255,255,255,0.06)');
        expect(a).toBeCloseTo(0.06);
        expect([r, g, b].every((channel) => channel <= a + 1e-6)).toBe(true);
        const fill = liquidFillColorUniform('#9EB9FF', 0.85);
        expect(fill[3]).toBeCloseTo(0.85);
        expect(fill[2]).toBeCloseTo(0.85);
    });
});
