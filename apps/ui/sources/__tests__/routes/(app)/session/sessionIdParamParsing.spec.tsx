import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';
import { installSessionRouteCommonModuleMocks } from './[id]/sessionRouteTestHelpers';


type SearchParams = { id?: string; jumpSeq?: string };
let searchParams: SearchParams = {};
const ensureSessionVisibleSpy = vi.fn((_sessionId: string) => Promise.resolve());
let hydrateReady = true;
let lastMobileSurfaceBySessionId: Record<string, string> = {};
const routeSessions = {
    'session-123': {
        id: 'session-123',
        seq: 0,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        thinking: false,
        metadata: null,
        agentState: null,
    },
};
const routerMock = createExpoRouterMock({
    params: () => searchParams,
});

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installSessionRouteCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'web',
            },
            View: (props: any) => React.createElement('View', props, props.children),
        });
    },
    router: async () => routerMock.module,
    storageModule: async (importOriginal) => {
        const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleMock({
            importOriginal,
            overrides: {
                useSetting: ((key: string) => {
                    if (key === 'mobileWorkspaceExperienceV1') return 'classic';
                    return null;
                }) as any,
                useSettingMutable: ((key: string) => [
                    key === 'mobileWorkspaceExperienceV1' ? 'classic' : null,
                    vi.fn(),
                ]) as any,
                useLocalSetting: ((key: string) => {
                    if (key === 'sessionLastMobileSurfaceBySessionId') return lastMobileSurfaceBySessionId;
                    return null;
                }) as any,
                getStorage: (() => ({
                    getState: () => ({
                        sessions: routeSessions,
                        sessionListViewDataByServerId: {},
                        localSettings: {
                            sessionLastMobileSurfaceBySessionId: lastMobileSurfaceBySessionId,
                        },
                    }),
                })) as any,
            },
        });
    },
});

vi.mock('@react-navigation/native', async () => {
    const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
    return {
        ...createReactNavigationNativeMock(),
        useRoute: () => {
            throw new Error('session/[id] screen should not depend on react-navigation useRoute() in expo-router web');
        },
    };
});

vi.mock('@/components/sessions/shell/SessionView', () => ({
    SessionView: ({ id, jumpToSeq, paneUrlState }: { id: string; jumpToSeq?: number | null; paneUrlState?: any }) =>
        React.createElement('SessionView', { id, jumpToSeq, paneUrlState }),
}));

vi.mock('@/components/workspaceCockpit/session/SessionCockpitShell', () => ({
    SessionCockpitShell: (props: any) => React.createElement('SessionCockpitShell', props),
}));

vi.mock('@/components/sessions/shell/SessionInvalidLinkFallback', () => ({
    SessionInvalidLinkFallback: () => React.createElement('SessionInvalidLinkFallback', { testID: 'session-invalid-link' }),
}));

vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
    useAppPaneScope: () => ({
        scopeId: 'session:test',
        scopeState: {
            right: { activeTabId: null },
            details: { tabs: [] },
        },
        openRight: vi.fn(),
        closeRight: vi.fn(),
        setRightTab: vi.fn(),
        setRightTabState: vi.fn(),
        openDetailsTab: vi.fn(),
        setDetailsTabState: vi.fn(),
        pinDetailsTab: vi.fn(),
        closeDetails: vi.fn(),
        closeDetailsTab: vi.fn(),
        setActiveDetailsTab: vi.fn(),
    }),
}));

vi.mock('@/components/sessions/terminal/useSessionTerminalAvailability', () => ({
    useSessionTerminalAvailability: () => ({
        deviceType: 'desktop',
        terminalEnabled: false,
        dockLocation: 'sidebar',
        sidebarTabAvailable: false,
    }),
}));

vi.mock('@/hooks/session/useHydrateSessionForRoute', () => ({
    useHydrateSessionForRoute: (sessionId: string) => {
        if (sessionId) {
            ensureSessionVisibleSpy(sessionId);
        }
        return hydrateReady;
    },
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => ({ serverId: '', serverUrl: '', generation: 1 }),
    subscribeActiveServer: () => () => undefined,
}));

vi.mock('@/utils/platform/responsive', () => ({
    useDeviceType: () => 'desktop',
}));

vi.mock('@/utils/sessions/tempDataStore', () => ({
    getTempData: () => null,
}));

async function renderSessionScreenTree() {
    routerMock.state.params = searchParams;
    const Screen = (await import('@/app/(app)/session/[id]')).default;

    const screen = await renderScreen(React.createElement(Screen));
    await flushHookEffects({ cycles: 1, turns: 1 });

    return screen;
}

async function renderSessionScreen() {
    const screen = await renderSessionScreenTree();
    const sessionView = screen.findByType('SessionView' as any);
    return { screen, sessionView };
}

describe('session/[id] param parsing', () => {
    afterEach(() => {
        standardCleanup();
        vi.resetModules();
        ensureSessionVisibleSpy.mockClear();
        hydrateReady = true;
        lastMobileSurfaceBySessionId = {};
    });

    it('renders the session view using expo-router search params', async () => {
        vi.resetModules();
        searchParams = { id: 'session-123' };
        const { sessionView } = await renderSessionScreen();
        expect(sessionView.props.id).toBe('session-123');
    });

    it('does not pass jumpToSeq when jumpSeq is missing', async () => {
        vi.resetModules();
        searchParams = { id: 'session-123' };
        const { sessionView } = await renderSessionScreen();
        expect(sessionView.props.jumpToSeq ?? null).toBeNull();
    });

    it('does not pass jumpToSeq when jumpSeq is empty or whitespace', async () => {
        vi.resetModules();
        searchParams = { id: 'session-123', jumpSeq: '   ' };
        const { sessionView } = await renderSessionScreen();
        expect(sessionView.props.jumpToSeq ?? null).toBeNull();
    });

    it('passes jumpSeq through to SessionView as jumpToSeq', async () => {
        vi.resetModules();
        searchParams = { id: 'session-123', jumpSeq: '42' } as any;
        const { sessionView } = await renderSessionScreen();
        expect(sessionView.props.jumpToSeq).toBe(42);
    });

    it('passes pane url params through to SessionView as paneUrlState', async () => {
        vi.resetModules();
        searchParams = { id: 'session-123', right: 'files', details: 'file', path: 'src/app.ts' } as any;
        const { sessionView } = await renderSessionScreen();
        expect(sessionView.props.paneUrlState).toEqual({
            rightTabId: 'files',
            details: { kind: 'file', path: 'src/app.ts' },
        });
    });

    it('hydrates sessions for deep links by requesting session visibility', async () => {
        vi.resetModules();
        searchParams = { id: 'session-123' };
        await renderSessionScreen();
        expect(ensureSessionVisibleSpy).toHaveBeenCalledWith('session-123');
    });

    it('still renders SessionView while hydration is pending so deleted-session UI can recover', async () => {
        vi.resetModules();
        hydrateReady = false;
        searchParams = { id: 'session-123' };
        const { sessionView } = await renderSessionScreen();
        expect(sessionView.props.id).toBe('session-123');
    });

    it('renders an invalid-link fallback when session id is missing', async () => {
        vi.resetModules();
        searchParams = {};
        const screen = await renderSessionScreenTree();
        expect(ensureSessionVisibleSpy).not.toHaveBeenCalled();
        expect(screen.findAllByType('SessionView' as any)).toHaveLength(0);
        expect(screen.findByTestId('session-invalid-link')).toBeTruthy();
  });
});
