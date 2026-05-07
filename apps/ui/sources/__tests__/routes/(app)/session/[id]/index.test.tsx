import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installSessionRouteCommonModuleMocks } from './sessionRouteTestHelpers';

const runAfterInteractionsSpy = vi.hoisted(() => vi.fn(() => () => {}));
let deviceType: 'phone' | 'tablet' | 'desktop' = 'desktop';
let mobileWorkspaceExperience: 'classic' | 'cockpit' = 'classic';
let lastMobileSurfaceBySessionId: Record<string, string> = {};
let terminalTabAvailableForSessionId: string | null = null;
const terminalAvailabilityCalls: Array<unknown> = [];
const routeParams = vi.hoisted(() => ({
    value: { id: 'session-1' } as Record<string, string | undefined>,
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
        const routerMock = createExpoRouterMock();
        return {
            ...routerMock.module,
            useLocalSearchParams: () => routeParams.value,
            useGlobalSearchParams: () => routeParams.value,
        };
    },
    storageModule: async (importOriginal) => {
        const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleMock({
            importOriginal,
            overrides: {
                useSetting: ((key: string) => {
                    if (key === 'mobileWorkspaceExperienceV1') return mobileWorkspaceExperience;
                    return null;
                }) as any,
                useSettingMutable: ((key: string) => [
                    key === 'mobileWorkspaceExperienceV1' ? mobileWorkspaceExperience : null,
                    vi.fn(),
                ]) as any,
                useLocalSetting: ((key: string) => {
                    if (key === 'sessionLastMobileSurfaceBySessionId') return lastMobileSurfaceBySessionId;
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

vi.mock('@/components/sessions/terminal/useSessionTerminalAvailability', () => ({
    useSessionTerminalAvailability: (params?: { sessionId?: string | null }) => {
        terminalAvailabilityCalls.push(params);
        return {
            sidebarTabAvailable: terminalTabAvailableForSessionId == null || params?.sessionId === terminalTabAvailableForSessionId,
        };
    },
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

vi.mock('@/utils/platform/responsive', () => ({
    useDeviceType: () => deviceType,
}));

describe('session route index', () => {
    afterEach(() => {
        standardCleanup();
        runAfterInteractionsSpy.mockClear();
        deviceType = 'desktop';
        mobileWorkspaceExperience = 'classic';
        lastMobileSurfaceBySessionId = {};
        terminalTabAvailableForSessionId = null;
        terminalAvailabilityCalls.length = 0;
        routeParams.value = { id: 'session-1' };
    });

    it('mounts the session view immediately on native instead of waiting for interaction deferral', async () => {
        const Route = await import('@/app/(app)/session/[id]');

        const screen = await renderScreen(React.createElement(Route.default));

        expect(runAfterInteractionsSpy).not.toHaveBeenCalled();
        expect(screen.findAllByType('SessionView')).toHaveLength(1);
    });

    it('renders the session cockpit shell on phone when cockpit mode is enabled by default', async () => {
        deviceType = 'phone';
        mobileWorkspaceExperience = 'cockpit';
        routeParams.value = { id: 'session-1', serverId: 'server-b' };
        lastMobileSurfaceBySessionId = { 'session-1': 'git' };
        const Route = await import('@/app/(app)/session/[id]');

        const screen = await renderScreen(React.createElement(Route.default));

        const cockpit = screen.findByType('SessionCockpitShell' as never);
        expect(cockpit.props.sessionId).toBe('session-1');
        expect(cockpit.props.scopeId).toBe('session:session-1');
        expect(cockpit.props.surface).toBe('git');
        expect(cockpit.props.routeServerId).toBe('server-b');
        expect(screen.findAllByType('SessionView')).toHaveLength(0);
    });

    it('keeps the cockpit terminal surface when the viewed session server enables terminal', async () => {
        deviceType = 'phone';
        mobileWorkspaceExperience = 'cockpit';
        terminalTabAvailableForSessionId = 'session-1';
        routeParams.value = { id: 'session-1', serverId: 'server-b', mobileSurface: 'terminal' };
        lastMobileSurfaceBySessionId = { 'session-1': 'terminal' };
        const Route = await import('@/app/(app)/session/[id]');

        const screen = await renderScreen(React.createElement(Route.default));

        const cockpit = screen.findByType('SessionCockpitShell' as never);
        expect(cockpit.props.surface).toBe('terminal');
    });

    it('scopes terminal availability to the viewed session id in cockpit mode', async () => {
        deviceType = 'phone';
        mobileWorkspaceExperience = 'cockpit';
        terminalTabAvailableForSessionId = 'session-scoped';
        routeParams.value = { id: 'session-scoped' };
        const Route = await import('@/app/(app)/session/[id]');

        await renderScreen(React.createElement(Route.default));

        expect(terminalAvailabilityCalls.at(-1)).toEqual(expect.objectContaining({ sessionId: 'session-scoped' }));
    });
});
