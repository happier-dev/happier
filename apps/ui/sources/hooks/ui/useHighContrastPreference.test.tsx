import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type MediaChangeListener = (event: { matches: boolean }) => void;

// The browser's `prefers-contrast` media query is the system boundary.
const host = vi.hoisted(() => ({ more: true, queries: 0, listeners: [] as MediaChangeListener[] }));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

function installHostMediaQuery(): () => void {
    const previousWindow = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = {
        matchMedia: (query: string) => {
            host.queries += 1;
            return {
                matches: query === '(prefers-contrast: more)' ? host.more : false,
                addEventListener: (event: string, listener: MediaChangeListener) => {
                    if (event === 'change') host.listeners.push(listener);
                },
                removeEventListener: (event: string, listener: MediaChangeListener) => {
                    if (event === 'change') host.listeners.splice(host.listeners.indexOf(listener), 1);
                },
            };
        },
    };
    return () => {
        (globalThis as { window?: unknown }).window = previousWindow;
    };
}

describe('useHighContrastPreference', () => {
    afterEach(() => {
        standardCleanup();
        vi.resetModules();
        host.more = true;
        host.queries = 0;
        host.listeners.length = 0;
    });

    it('renders every consumer once with the host preference and watches it once, however many mount', async () => {
        const restoreWindow = installHostMediaQuery();
        try {
            const { useHighContrastPreference } = await import('./useHighContrastPreference');
            const renders: boolean[] = [];
            function Consumer(): React.ReactElement | null {
                renders.push(useHighContrastPreference());
                return null;
            }
            for (const count of [3, 30]) {
                renders.length = 0;
                await renderScreen(<>{Array.from({ length: count }, (_, index) => <Consumer key={index} />)}</>);
                expect(renders).toEqual(Array.from({ length: count }, () => true));
            }
            expect(host.listeners).toHaveLength(1);

            act(() => { for (const listener of [...host.listeners]) listener({ matches: false }); });
            renders.length = 0;
            await renderScreen(<Consumer />);
            expect(renders).toEqual([false]);
        } finally {
            restoreWindow();
        }
    });
});
