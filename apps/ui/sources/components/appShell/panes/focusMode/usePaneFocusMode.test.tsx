import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderHook, standardCleanup } from '@/dev/testkit';
import { AppPaneProvider, useAppPaneContext } from '../AppPaneProvider';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const routeState = vi.hoisted(() => ({
    pathname: '/session/s1',
}));

const platformState = vi.hoisted(() => ({
    os: 'web' as 'web' | 'ios',
}));

const deviceTypeState = vi.hoisted(() => ({
    value: 'tablet' as 'phone' | 'tablet',
}));

vi.mock('expo-router', () => ({
    usePathname: () => routeState.pathname,
}));

vi.mock('react-native', () => ({
    Platform: {
        get OS() {
            return platformState.os;
        },
        select: (values: Record<string, unknown>) => values[platformState.os] ?? values.default,
    },
}));

vi.mock('@/utils/platform/responsive', () => ({
    useDeviceType: () => deviceTypeState.value,
}));

function AppPaneStateBootstrap(props: Readonly<{ scopeId: string }>) {
    const { dispatch } = useAppPaneContext();

    React.useEffect(() => {
        dispatch({ type: 'activateScope', scopeId: props.scopeId });
        dispatch({ type: 'openRight', scopeId: props.scopeId, tabId: 'files' });
    }, [dispatch, props.scopeId]);

    return null;
}

function createWrapper(scopeId: string): React.ComponentType<React.PropsWithChildren> {
    return function AppPaneFocusModeTestWrapper({ children }: React.PropsWithChildren) {
        return (
            <AppPaneProvider>
                <AppPaneStateBootstrap scopeId={scopeId} />
                {children}
            </AppPaneProvider>
        );
    };
}

describe('usePaneFocusMode', () => {
    afterEach(() => {
        standardCleanup();
        routeState.pathname = '/session/s1';
        platformState.os = 'web';
        deviceTypeState.value = 'tablet';
    });

    it('does not allow entering focus mode on native tablets with permanent sidebar chrome', async () => {
        platformState.os = 'ios';
        deviceTypeState.value = 'tablet';

        const { usePaneFocusMode } = await import('./usePaneFocusMode');
        const hook = await renderHook(() => usePaneFocusMode('session:s1'), {
            wrapper: createWrapper('session:s1'),
        });

        expect(hook.getCurrent().canEnter).toBe(false);
        expect(hook.getCurrent().active).toBe(false);

        await act(async () => {
            hook.getCurrent().toggle();
        });

        expect(hook.getCurrent().active).toBe(false);
    });

    it('keeps focus mode available on web tablets for active session scopes with focusable panes', async () => {
        platformState.os = 'web';
        deviceTypeState.value = 'tablet';

        const { usePaneFocusMode } = await import('./usePaneFocusMode');
        const hook = await renderHook(() => usePaneFocusMode('session:s1'), {
            wrapper: createWrapper('session:s1'),
        });

        expect(hook.getCurrent().canEnter).toBe(true);
        expect(hook.getCurrent().active).toBe(false);

        await act(async () => {
            hook.getCurrent().toggle();
        });

        expect(hook.getCurrent().active).toBe(true);
    });
});
