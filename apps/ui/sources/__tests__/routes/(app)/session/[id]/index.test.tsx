import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installSessionRouteCommonModuleMocks } from './sessionRouteTestHelpers';

const runAfterInteractionsSpy = vi.hoisted(() => vi.fn(() => () => {}));
const deviceTypeState = vi.hoisted(() => ({
    value: 'desktop' as 'phone' | 'tablet' | 'desktop',
}));
const routeParamsState = vi.hoisted(() => ({
    id: 'session-1',
    mobileSurface: undefined as string | undefined,
}));
const storageState = vi.hoisted(() => ({
    mobileWorkspaceExperience: 'classic' as 'classic' | 'cockpit',
    sessionLastMobileSurfaceBySessionId: {} as Record<string, string>,
}));

installSessionRouteCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: { OS: 'ios' },
            View: 'View',
            ActivityIndicator: 'ActivityIndicator',
        });
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({
            params: routeParamsState,
        }).module;
    },
    storageModule: async (importOriginal) => {
        const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleMock({
            importOriginal,
            overrides: {
                useLocalSetting: ((key: string) => {
                    if (key === 'mobileWorkspaceExperienceV1') {
                        return storageState.mobileWorkspaceExperience;
                    }
                    if (key === 'sessionLastMobileSurfaceBySessionId') {
                        return storageState.sessionLastMobileSurfaceBySessionId;
                    }
                    return null;
                }) as any,
            },
        });
    },
});

vi.mock('@/components/sessions/shell/SessionView', () => ({
    SessionView: (props: any) => React.createElement('SessionView', props),
}));
vi.mock('@/components/workspaceCockpit/session/SessionCockpitShell', () => ({
    SessionCockpitShell: (props: any) => React.createElement('SessionCockpitShell', props),
}));
vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
    useAppPaneScope: () => ({
        scopeState: {
            right: { activeTabId: null },
            details: { tabs: [] },
        },
    }),
}));

vi.mock('@/components/sessions/shell/SessionInvalidLinkFallback', () => ({
    SessionInvalidLinkFallback: () => React.createElement('SessionInvalidLinkFallback'),
}));

vi.mock('@/hooks/session/useHydrateSessionForRoute', () => ({
    useHydrateSessionForRoute: () => true,
}));

vi.mock('@/utils/timing/runAfterInteractionsWithFallback', () => ({
    runAfterInteractionsWithFallback: runAfterInteractionsSpy,
}));

vi.mock('@/utils/sessions/tempDataStore', () => ({
    getTempData: () => null,
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => ({ generation: 1 }),
    subscribeActiveServer: () => () => {},
}));

vi.mock('@/components/sessions/panes/url/sessionPaneUrlState', () => ({
    parseSessionPaneUrlState: () => null,
}));
vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => true,
}));

vi.mock('@/utils/platform/responsive', () => ({
    useDeviceType: () => deviceTypeState.value,
}));

describe('session route index', () => {
    afterEach(() => {
        standardCleanup();
        runAfterInteractionsSpy.mockClear();
        deviceTypeState.value = 'desktop';
        routeParamsState.id = 'session-1';
        routeParamsState.mobileSurface = undefined;
        storageState.mobileWorkspaceExperience = 'classic';
        storageState.sessionLastMobileSurfaceBySessionId = {};
    });

    it('mounts the session view immediately on native instead of waiting for interaction deferral', async () => {
        const Route = await import('@/app/(app)/session/[id]');

        const screen = await renderScreen(React.createElement(Route.default));

        expect(runAfterInteractionsSpy).not.toHaveBeenCalled();
        expect(screen.findAllByType('SessionView')).toHaveLength(1);
    });

    it('renders the session cockpit shell on phone when cockpit mode is enabled', async () => {
        deviceTypeState.value = 'phone';
        storageState.mobileWorkspaceExperience = 'cockpit';
        storageState.sessionLastMobileSurfaceBySessionId = { 'session-1': 'git' };

        const Route = await import('@/app/(app)/session/[id]');
        const screen = await renderScreen(React.createElement(Route.default));

        const cockpit = screen.findByType('SessionCockpitShell' as never);
        expect(cockpit.props.sessionId).toBe('session-1');
        expect(cockpit.props.surface).toBe('git');
        expect(screen.findAllByType('SessionView')).toHaveLength(0);
    });

    it('lets the explicit mobile-surface route hint override stale persisted cockpit surface state', async () => {
        deviceTypeState.value = 'phone';
        routeParamsState.mobileSurface = 'chat';
        storageState.mobileWorkspaceExperience = 'cockpit';
        storageState.sessionLastMobileSurfaceBySessionId = { 'session-1': 'terminal' };

        const Route = await import('@/app/(app)/session/[id]');
        const screen = await renderScreen(React.createElement(Route.default));

        const cockpit = screen.findByType('SessionCockpitShell' as never);
        expect(cockpit.props.surface).toBe('chat');
    });
});
