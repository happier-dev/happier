import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AppPaneProvider, useAppPaneContext } from '@/components/appShell/panes/AppPaneProvider';
import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).__DEV__ = false;

const layoutState = vi.hoisted(() => ({
    windowWidthPx: 1400,
    deviceType: 'tablet' as 'phone' | 'tablet',
    // The pane host normalizes web to `tablet` — a narrow browser still gets overlay panes — so the
    // phone case is only reachable on a native platform, and the test drives that same rule rather
    // than assuming a narrow window is a phone.
    platformOS: 'web' as 'web' | 'ios',
}));
const routerPushSpy = vi.hoisted(() => vi.fn());

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        useWindowDimensions: () => ({ width: layoutState.windowWidthPx, height: 900 }),
        Platform: Object.defineProperty({}, 'OS', {
            get: () => layoutState.platformOS,
            enumerable: true,
        }) as any,
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ router: { push: routerPushSpy } }).module;
});

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
        useLocalSetting: (key: string) => {
            if (key === 'uiMultiPanePanelsEnabled') return true;
            if (key === 'detailsPaneTabsBehavior') return 'preview';
            return undefined;
        },
    });
});

vi.mock('@/utils/platform/responsive', () => ({
    useDeviceType: () => layoutState.deviceType,
}));

const { useOpenSessionTarget } = await import('./useOpenSessionTarget');
const { Pressable } = await import('react-native');

const SIDECHAIN_SCOPE = { kind: 'sidechain', sessionId: 's1', sidechainId: 'wf/a1' } as const;

function OpenerHost(props: Readonly<{ target: Parameters<ReturnType<typeof useOpenSessionTarget>>[0] }>) {
    const open = useOpenSessionTarget({ sessionId: 's1' });
    return (
        <Pressable testID="open" accessibilityRole="button" onPress={() => open(props.target)} />
    );
}

/**
 * The SAME call site, two layouts, two outcomes — which is the whole reason this decision was
 * extracted. A caller states WHAT it wants opened; the layout decides whether that becomes a pane or
 * a screen. Before this, four call sites answered that question in four different ways and the
 * agent surfaces answered it wrong on a phone, where the pane they opened is never drawn.
 */
describe('useOpenSessionTarget', () => {
    let observedState: any = null;
    const Probe = () => {
        const { state } = useAppPaneContext();
        observedState = state;
        return null;
    };

    beforeEach(() => {
        layoutState.windowWidthPx = 1400;
        layoutState.deviceType = 'tablet';
        layoutState.platformOS = 'web';
        routerPushSpy.mockClear();
        observedState = null;
    });

    it('opens an agent transcript as a details tab where a pane fits', async () => {
        const screen = await renderScreen(
            <AppPaneProvider>
                <OpenerHost target={{ kind: 'transcript', scope: SIDECHAIN_SCOPE, title: 'Reviewer' }} />
                <Probe />
            </AppPaneProvider>,
        );

        await pressTestInstanceAsync(screen.findByTestId('open')!, 'open');

        expect(routerPushSpy).not.toHaveBeenCalled();
        const scope = observedState?.scopes?.['session:s1'];
        expect(scope?.details?.isOpen).toBe(true);
        expect(scope?.details?.tabs?.[0]?.key).toBe('transcript:sidechain:wf/a1');
        expect(scope?.details?.tabs?.[0]?.title).toBe('Reviewer');
    });

    it('opens the SAME agent transcript as a full screen on a phone', async () => {
        layoutState.deviceType = 'phone';
        layoutState.windowWidthPx = 390;
        layoutState.platformOS = 'ios';

        const screen = await renderScreen(
            <AppPaneProvider>
                <OpenerHost target={{ kind: 'transcript', scope: SIDECHAIN_SCOPE, title: 'Reviewer' }} />
                <Probe />
            </AppPaneProvider>,
        );

        await pressTestInstanceAsync(screen.findByTestId('open')!, 'open');

        expect(routerPushSpy).toHaveBeenCalledWith('/session/s1/transcript?sidechainId=wf%2Fa1&title=Reviewer');
        expect(observedState?.scopes?.['session:s1']?.details?.isOpen ?? false).toBe(false);
    });

    it('opens the agent roster in the right pane, or on its own screen where there is none', async () => {
        const wide = await renderScreen(
            <AppPaneProvider>
                <OpenerHost target={{ kind: 'agentRoster' }} />
                <Probe />
            </AppPaneProvider>,
        );
        await pressTestInstanceAsync(wide.findByTestId('open')!, 'open');
        expect(routerPushSpy).not.toHaveBeenCalled();
        expect(observedState?.scopes?.['session:s1']?.right?.isOpen).toBe(true);
        expect(observedState?.scopes?.['session:s1']?.right?.activeTabId).toBe('agents');
        await wide.unmount();

        layoutState.deviceType = 'phone';
        layoutState.windowWidthPx = 390;
        layoutState.platformOS = 'ios';
        observedState = null;
        const phone = await renderScreen(
            <AppPaneProvider>
                <OpenerHost target={{ kind: 'agentRoster' }} />
                <Probe />
            </AppPaneProvider>,
        );
        await pressTestInstanceAsync(phone.findByTestId('open')!, 'open');
        expect(routerPushSpy).toHaveBeenCalledWith('/session/s1/agents');
        expect(observedState?.scopes?.['session:s1']?.right?.isOpen ?? false).toBe(false);
    });

    it('does nothing at all for a target that resolves nowhere', async () => {
        layoutState.deviceType = 'phone';
        layoutState.platformOS = 'ios';
        const screen = await renderScreen(
            <AppPaneProvider>
                <OpenerHost target={{ kind: 'file', path: '   ' }} />
                <Probe />
            </AppPaneProvider>,
        );

        await pressTestInstanceAsync(screen.findByTestId('open')!, 'open');

        expect(routerPushSpy).not.toHaveBeenCalled();
        expect(observedState?.scopes?.['session:s1']?.details?.isOpen ?? false).toBe(false);
    });
});
