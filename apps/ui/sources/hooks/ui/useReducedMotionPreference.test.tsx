import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type MediaChangeListener = (event: { matches: boolean }) => void;

const hostState = vi.hoisted(() => ({
    reduceMotion: false,
    changeListeners: [] as MediaChangeListener[],
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

function installHostMediaQuery(): () => void {
    const previousWindow = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = {
        matchMedia: (query: string) => ({
            matches: query === '(prefers-reduced-motion: reduce)' ? hostState.reduceMotion : false,
            addEventListener: (event: string, listener: MediaChangeListener) => {
                if (event === 'change') hostState.changeListeners.push(listener);
            },
            removeEventListener: (event: string, listener: MediaChangeListener) => {
                if (event !== 'change') return;
                const index = hostState.changeListeners.indexOf(listener);
                if (index >= 0) hostState.changeListeners.splice(index, 1);
            },
        }),
    };
    return () => {
        (globalThis as { window?: unknown }).window = previousWindow;
    };
}

function publishHostPreference(reduceMotion: boolean): void {
    hostState.reduceMotion = reduceMotion;
    for (const listener of [...hostState.changeListeners]) {
        listener({ matches: reduceMotion });
    }
}

describe('useReducedMotionPreference', () => {
    afterEach(() => {
        standardCleanup();
        vi.resetModules();
        hostState.reduceMotion = false;
        hostState.changeListeners.length = 0;
    });

    it('watches the host preference once for every consumer, not once per consumer', async () => {
        const restoreWindow = installHostMediaQuery();
        try {
            const { useReducedMotionPreference } = await import('./useReducedMotionPreference');

            function Consumer(): React.ReactElement | null {
                useReducedMotionPreference();
                return null;
            }

            // Reduce motion is a host property. Transcript rows mount reveal slots by
            // the hundred, so one media-query listener per consumer is the cost this
            // hook exists to avoid.
            await renderScreen(
                <>
                    {Array.from({ length: 12 }, (_, index) => <Consumer key={index} />)}
                </>,
            );

            expect(hostState.changeListeners).toHaveLength(1);
        } finally {
            restoreWindow();
        }
    });

    it('notifies every consumer when the host preference changes', async () => {
        const restoreWindow = installHostMediaQuery();
        try {
            const { useReducedMotionPreference } = await import('./useReducedMotionPreference');
            const observed: boolean[] = [];

            function Consumer(props: Readonly<{ index: number }>): React.ReactElement | null {
                const reduceMotion = useReducedMotionPreference();
                React.useEffect(() => {
                    observed[props.index] = reduceMotion;
                }, [props.index, reduceMotion]);
                return null;
            }

            await renderScreen(
                <>
                    {Array.from({ length: 3 }, (_, index) => <Consumer key={index} index={index} />)}
                </>,
            );

            expect(observed).toEqual([false, false, false]);

            act(() => {
                publishHostPreference(true);
            });

            expect(observed).toEqual([true, true, true]);
        } finally {
            restoreWindow();
        }
    });

    it('exposes a non-reactive read that shares the one host watch', async () => {
        const restoreWindow = installHostMediaQuery();
        try {
            const { readReducedMotionPreference } = await import('./useReducedMotionPreference');

            expect(readReducedMotionPreference()).toBe(false);
            expect(hostState.changeListeners).toHaveLength(1);

            // Repeated reads are what a per-row consumer does; they must not register
            // another listener.
            expect(readReducedMotionPreference()).toBe(false);
            expect(hostState.changeListeners).toHaveLength(1);

            publishHostPreference(true);

            expect(readReducedMotionPreference()).toBe(true);
        } finally {
            restoreWindow();
        }
    });
});
