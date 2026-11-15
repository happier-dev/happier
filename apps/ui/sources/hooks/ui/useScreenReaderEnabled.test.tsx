import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type ScreenReaderListener = (enabled: boolean) => void;

// The platform accessibility service is the system boundary; react-native-web resolves it `true` after mount.
const host = vi.hoisted(() => ({
    enabled: true,
    queries: 0,
    listeners: [] as ScreenReaderListener[],
}));

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeNativeMock(
    { platformOS: 'ios' },
    {
        AccessibilityInfo: {
            isScreenReaderEnabled: () => {
                host.queries += 1;
                return Promise.resolve(host.enabled);
            },
            addEventListener: (event: string, listener: ScreenReaderListener) => {
                if (event === 'screenReaderChanged') host.listeners.push(listener);
                return { remove: () => { host.listeners.splice(host.listeners.indexOf(listener), 1); } };
            },
        },
    },
));

describe('useScreenReaderEnabled', () => {
    afterEach(() => {
        standardCleanup();
        vi.resetModules();
        host.enabled = true;
        host.queries = 0;
        host.listeners.length = 0;
    });

    it('renders consumers mounted after the host answered once, with the answer, however many mount', async () => {
        const { useScreenReaderEnabled } = await import('./useScreenReaderEnabled');
        const renders: boolean[] = [];
        function Consumer(): React.ReactElement | null {
            renders.push(useScreenReaderEnabled());
            return null;
        }
        // The app's first surface asks the host once.
        await renderScreen(<Consumer />);
        await act(async () => { await Promise.resolve(); });
        renders.length = 0;

        // A page that mounts its rows later (Services → Apps: 500 rows, each text reading the accessibility
        // context) must not render every one of them twice while the same answer resolves again.
        for (const count of [3, 30]) {
            renders.length = 0;
            await renderScreen(<>{Array.from({ length: count }, (_, index) => <Consumer key={index} />)}</>);
            await act(async () => { await Promise.resolve(); });
            expect(renders).toEqual(Array.from({ length: count }, () => true));
        }
        expect(host.queries).toBe(1);
    });

    it('notifies every consumer when the host setting changes', async () => {
        const { useScreenReaderEnabled } = await import('./useScreenReaderEnabled');
        const observed: boolean[] = [];
        function Consumer(props: Readonly<{ index: number }>): React.ReactElement | null {
            const enabled = useScreenReaderEnabled();
            React.useEffect(() => { observed[props.index] = enabled; }, [enabled, props.index]);
            return null;
        }
        await renderScreen(<>{[0, 1, 2].map((index) => <Consumer key={index} index={index} />)}</>);
        await act(async () => { await Promise.resolve(); });
        expect(observed).toEqual([true, true, true]);

        act(() => { for (const listener of [...host.listeners]) listener(false); });
        expect(observed).toEqual([false, false, false]);
    });
});
