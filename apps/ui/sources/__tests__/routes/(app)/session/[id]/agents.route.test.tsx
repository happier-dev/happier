import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';
import { flushHookEffects, renderScreen } from '@/dev/testkit';
import { installSessionRouteCommonModuleMocks } from './sessionRouteTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const routeState = vi.hoisted(() => ({
    id: 'session-1' as string,
    serverId: 'server-b' as string | undefined,
    hydration: 'available' as 'available' | 'missing' | 'loading',
}));
const layoutState = vi.hoisted(() => ({ windowWidthPx: 390, deviceType: 'phone' as 'phone' | 'tablet' }));
const routerReplaceSpy = vi.hoisted(() => vi.fn());
const openRightSpy = vi.hoisted(() => vi.fn());
const setRightTabSpy = vi.hoisted(() => vi.fn());
const agentsViewSpy = vi.hoisted(() => vi.fn());

installSessionRouteCommonModuleMocks({
    router: async () =>
        createExpoRouterMock({
            router: { back: vi.fn(), push: vi.fn(), replace: routerReplaceSpy, setParams: vi.fn() },
            params: () => ({ id: routeState.id, serverId: routeState.serverId }),
        }).module,
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: (props: any) => React.createElement('View', props, props.children),
            useWindowDimensions: () => ({ width: layoutState.windowWidthPx, height: 900, scale: 1, fontScale: 1 }),
            // Native: `resolveMultiPaneDeviceType` keeps `phone` here, where web would normalize to
            // `tablet` and give every narrow window an overlay pane.
            Platform: Object.defineProperty({}, 'OS', { get: () => 'ios', enumerable: true }) as any,
        });
    },
    storageModule: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useLocalSetting: (key: string) => (key === 'uiMultiPanePanelsEnabled' ? true : null),
        });
    },
});

vi.mock('@/utils/platform/responsive', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/utils/platform/responsive')>();
    return { ...actual, useDeviceType: () => layoutState.deviceType, getDeviceType: () => layoutState.deviceType };
});

vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
    useAppPaneScope: (scopeId: string) => ({
        scopeId,
        scopeState: null,
        openRight: openRightSpy,
        setRightTab: setRightTabSpy,
        openDetailsTab: vi.fn(),
    }),
}));

vi.mock('@/hooks/session/useHydrateSessionForRoute', () => ({
    useHydrateSessionForRoute: (sessionId: string) => ({
        kind: routeState.hydration,
        sessionId,
        ...(routeState.hydration === 'missing' ? { cause: 'not_found' } : null),
        ...(routeState.hydration === 'loading' ? { reason: 'cold' } : null),
    }),
}));

vi.mock('@/components/sessions/panes/agents/SessionRightPanelAgentsView', () => ({
    SessionRightPanelAgentsView: (props: any) => {
        agentsViewSpy(props);
        return React.createElement('SessionRightPanelAgentsView', props);
    },
}));

vi.mock('@/components/sessions/shell/SessionInvalidLinkFallback', () => ({
    SessionInvalidLinkFallback: () => React.createElement('SessionInvalidLinkFallback'),
}));

const SessionAgentsScreen = (await import('@/app/(app)/session/[id]/agents')).default;

/**
 * The screen this corridor added so a phone has somewhere for the roster to go. It was shipped with
 * no test at all: param parsing, hydration gating, the invalid-link fallback and the fact that it
 * composes the SHARED host rather than a mobile variant were all unexecuted claims.
 */
describe('session agents route', () => {
    beforeEach(() => {
        routeState.id = 'session-1';
        routeState.serverId = 'server-b';
        routeState.hydration = 'available';
        layoutState.windowWidthPx = 390;
        layoutState.deviceType = 'phone';
        routerReplaceSpy.mockClear();
        openRightSpy.mockClear();
        setRightTabSpy.mockClear();
        agentsViewSpy.mockClear();
    });

    it('mounts the shared agents host on the session pane scope', async () => {
        const screen = await renderScreen(<SessionAgentsScreen />);

        expect(screen.findByTestId('session-agents-screen')).toBeTruthy();
        expect(agentsViewSpy).toHaveBeenCalledWith(
            expect.objectContaining({ sessionId: 'session-1', scopeId: 'session:session-1' }),
        );
    });

    it('falls back to the invalid-link surface for a missing session and an empty id', async () => {
        routeState.hydration = 'missing';
        const missing = await renderScreen(<SessionAgentsScreen />);
        expect(missing.findAll((node) => node.type === 'SessionInvalidLinkFallback')).toHaveLength(1);
        expect(agentsViewSpy).not.toHaveBeenCalled();

        routeState.hydration = 'available';
        routeState.id = '   ';
        const blank = await renderScreen(<SessionAgentsScreen />);
        expect(blank.findAll((node) => node.type === 'SessionInvalidLinkFallback')).toHaveLength(1);
        expect(agentsViewSpy).not.toHaveBeenCalled();
    });

    it('hands a deep link back to the pane when the window is wide enough to dock one', async () => {
        layoutState.windowWidthPx = 1400;
        layoutState.deviceType = 'tablet';

        const screen = await renderScreen(<SessionAgentsScreen />);
        await flushHookEffects(screen);

        expect(openRightSpy).toHaveBeenCalledWith({ tabId: 'agents' });
        expect(setRightTabSpy).toHaveBeenCalledWith('agents');
        expect(routerReplaceSpy).toHaveBeenCalledWith('/session/session-1?serverId=server-b');
        expect(agentsViewSpy).not.toHaveBeenCalled();
    });
});
