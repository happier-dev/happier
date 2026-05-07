import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createExpoRouterMock } from '@/dev/testkit/mocks/router';
import {
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';
import { getStyleValue, installSessionRouteCommonModuleMocks } from './sessionRouteTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let mockSessionId = 'session-1';
let mockServerId: string | undefined;
let isFocused = true;
let sessionHydrated = true;
let mockDetailsParam: string | undefined;
let mockPathParam: string | undefined;
let mockShaParam: string | undefined;
let mockSourceSurfaceParam: string | undefined;
let safeAreaInsets = { top: 47, right: 0, bottom: 34, left: 0 };
const routerBackSpy = vi.fn();
const routerReplaceSpy = vi.fn();
const ensureSessionVisibleSpy = vi.fn((_sessionId: string, _options?: { serverId?: string }) => Promise.resolve());
const closeDetailsSpy = vi.fn();
const openDetailsTabSpy = vi.fn();
let canGoBack = true;
let deviceType: 'phone' | 'tablet' | 'desktop' = 'desktop';
let mobileWorkspaceExperience: 'classic' | 'cockpit' = 'classic';
const routerMock = createExpoRouterMock({
    router: {
        back: routerBackSpy,
        push: vi.fn(),
        replace: routerReplaceSpy,
        setParams: vi.fn(),
    },
});

type DetailsTab = Readonly<{ key: string }>;
type MockScopeState = Readonly<{
    details:
        | null
        | Readonly<{
              isOpen?: boolean;
              tabs?: readonly DetailsTab[];
              activeTabKey?: string | null;
              tabState?: Record<string, unknown>;
          }>;
}>;

let scopeState: MockScopeState = { details: null };

installSessionRouteCommonModuleMocks({
    safeAreaInsets: () => safeAreaInsets,
    router: () => ({
        ...routerMock.module,
        useLocalSearchParams: () => ({
            id: mockSessionId,
            serverId: mockServerId,
            details: mockDetailsParam,
            path: mockPathParam,
            sha: mockShaParam,
            sourceSurface: mockSourceSurfaceParam,
        }),
        useGlobalSearchParams: () => ({
            id: mockSessionId,
            serverId: mockServerId,
            details: mockDetailsParam,
            path: mockPathParam,
            sha: mockShaParam,
            sourceSurface: mockSourceSurfaceParam,
        }),
        useNavigation: () => ({ canGoBack: () => canGoBack }),
    }),
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
                    if (key === 'sessionLastMobileSurfaceBySessionId') return {};
                    return null;
                }) as any,
            },
        });
    },
});

vi.mock('@react-navigation/native', () => ({
    useIsFocused: () => isFocused,
}));

vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
    useAppPaneScope: () => {
        const [state, setState] = React.useState<MockScopeState>(scopeState);
        return {
            scopeId: `session:${mockSessionId}`,
            scopeState: state,
            setDetailsTabState: vi.fn(),
            openDetailsTab: (tab: any) => {
                openDetailsTabSpy(tab);
                setState((prev) => ({
                    ...prev,
                    details: {
                        isOpen: true,
                        tabs: [tab],
                        activeTabKey: tab.key,
                        tabState: {},
                    },
                }));
            },
            closeDetails: () => {
                closeDetailsSpy();
                setState((prev) => ({
                    ...prev,
                    details: prev.details ? { ...prev.details, isOpen: false } : prev.details,
                }));
            },
            closeDetailsTab: vi.fn(),
            setActiveDetailsTab: vi.fn(),
            pinDetailsTab: vi.fn(),
        };
    },
}));

vi.mock('@/components/sessions/panes/SessionDetailsPanel', () => ({
    SessionDetailsPanel: (props: any) => React.createElement('SessionDetailsPanel', props),
}));

vi.mock('@/components/workspaceCockpit/session/SessionCockpitShell', () => ({
    SessionCockpitShell: (props: any) => React.createElement('SessionCockpitShell', props),
}));

vi.mock('@/utils/platform/responsive', () => ({
    useDeviceType: () => deviceType,
}));

vi.mock('@/components/sessions/panes/url/sessionPaneUrlState', () => ({
    parseSessionPaneUrlState: () => {
        if (mockDetailsParam === 'file' && mockPathParam) {
            return { details: { kind: 'file', path: mockPathParam } };
        }
        if (mockDetailsParam === 'commit' && mockShaParam) {
            return { details: { kind: 'commit', sha: mockShaParam } };
        }
        return null;
    },
    buildActiveDetailsRouteParams: (detailsTabs: any[], activeDetailsKey: string | null) => {
        const activeTab = detailsTabs.find((tab) => tab?.key === activeDetailsKey) ?? detailsTabs.at(-1) ?? null;
        if (!activeTab) return {};
        if (activeTab.kind === 'file') {
            return { details: 'file', path: activeTab.resource?.path };
        }
        if (activeTab.kind === 'commit') {
            return { details: 'commit', sha: activeTab.resource?.commitHash ?? activeTab.resource?.sha };
        }
        return {};
    },
    applySessionPaneUrlState: (pane: any, state: any) => {
        if (state?.details?.kind === 'file') {
            pane.openDetailsTab({
                key: `file:${state.details.path}`,
                kind: 'file',
                resource: { kind: 'file', path: state.details.path },
            });
            return;
        }
        if (state?.details?.kind === 'commit') {
            pane.openDetailsTab({
                key: `commit:${state.details.sha}`,
                kind: 'commit',
                resource: { kind: 'commit', commitHash: state.details.sha },
            });
        }
    },
}));

vi.mock('@/hooks/session/useHydrateSessionForRoute', () => ({
    useHydrateSessionForRoute: (sessionId: string, _tag: string, options?: { serverId?: string }) => {
        ensureSessionVisibleSpy(sessionId, options);
        return sessionHydrated;
    },
}));

vi.mock('@/components/sessions/shell/SessionInvalidLinkFallback', () => ({
    SessionInvalidLinkFallback: () => React.createElement('SessionInvalidLinkFallback', { testID: 'session-invalid-link' }),
}));

vi.mock('@/sync/sync', () => ({
    sync: {
        ensureSessionVisibleForMessageRoute: (sessionId: string) => ensureSessionVisibleSpy(sessionId),
    },
}));

describe('/session/[id]/details', () => {
    let Screen: React.ComponentType<any>;

    beforeAll(async () => {
        Screen = (await import('@/app/(app)/session/[id]/details')).default;
    }, 60_000);

    beforeEach(() => {
        mockSessionId = 'session-1';
        mockServerId = undefined;
        isFocused = true;
        sessionHydrated = true;
        mockDetailsParam = undefined;
        mockPathParam = undefined;
        mockShaParam = undefined;
        mockSourceSurfaceParam = undefined;
        safeAreaInsets = { top: 47, right: 0, bottom: 34, left: 0 };
        canGoBack = true;
        deviceType = 'desktop';
        mobileWorkspaceExperience = 'classic';
        scopeState = { details: null };
        routerBackSpy.mockClear();
        routerReplaceSpy.mockClear();
        ensureSessionVisibleSpy.mockClear();
        closeDetailsSpy.mockClear();
        openDetailsTabSpy.mockClear();
        vi.clearAllMocks();
    });

    afterEach(() => {
        standardCleanup();
    });

    it('keeps the fullscreen details surface inside the vertical safe area', async () => {
        scopeState = { details: { tabs: [{ key: 'file:README.md' }], activeTabKey: 'file:README.md' } };
        const screen = await renderScreen(<Screen />);
        const surface = screen.findByTestId('session-details-screen');
        if (!surface) throw new Error('Expected session details screen surface to render');

        expect(getStyleValue(surface.props.style, 'paddingTop')).toBe(47);
        expect(getStyleValue(surface.props.style, 'paddingBottom')).toBe(34);
    });

    it('restores file details from route params before falling back to the session route', async () => {
        mockDetailsParam = 'file';
        mockPathParam = 'README.md';
        await renderScreen(<Screen />);

        expect(openDetailsTabSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                key: 'file:README.md',
                kind: 'file',
                resource: { kind: 'file', path: 'README.md' },
            })
        );
        expect(routerBackSpy).not.toHaveBeenCalled();
    });

    it('navigates back when there are no details tabs to display', async () => {
        mockServerId = 'server-b';
        await renderScreen(<Screen />);
        expect(routerBackSpy).not.toHaveBeenCalled();
        expect(routerReplaceSpy).toHaveBeenCalledWith('/session/session-1?serverId=server-b');
    });

    it('keeps the details route alive as the cockpit tabs surface when details are empty', async () => {
        deviceType = 'phone';
        mobileWorkspaceExperience = 'cockpit';
        mockServerId = 'server-b';

        const screen = await renderScreen(<Screen />);

        const cockpit = screen.findByType('SessionCockpitShell' as any);
        expect(cockpit.props.sessionId).toBe('session-1');
        expect(cockpit.props.scopeId).toBe('session:session-1');
        expect(cockpit.props.surface).toBe('tabs');
        expect(cockpit.props.safeAreaPadding).toBe(false);
        expect(cockpit.props.routeServerId).toBe('server-b');
        const routeSurface = screen.findByTestId('session-cockpit-route-screen');
        expect(getStyleValue(routeSurface?.props.style, 'paddingTop')).toBe(0);
        expect(getStyleValue(routeSurface?.props.style, 'paddingBottom')).toBe(34);
        expect(routerReplaceSpy).not.toHaveBeenCalled();
    });

    it('does not redirect away before the session has hydrated', async () => {
        sessionHydrated = false;
        await renderScreen(<Screen />);

        expect(routerBackSpy).not.toHaveBeenCalled();
        expect(routerReplaceSpy).not.toHaveBeenCalled();
    });

    it('renders the shared SessionDetailsPanel when tabs exist', async () => {
        scopeState = { details: { tabs: [{ key: 'file:README.md' }], activeTabKey: 'file:README.md' } };
        const screen = await renderScreen(<Screen />);
        const panel = screen.findByType('SessionDetailsPanel' as any);
        expect(panel.props.sessionId).toBe('session-1');
        expect(panel.props.scopeId).toBe('session:session-1');
        expect(panel.props.presentation).toBe('screen');
    });

    it('hydrates the session for deep links by requesting session visibility', async () => {
        mockServerId = 'server-b';
        scopeState = { details: { tabs: [{ key: 'file:README.md' }], activeTabKey: 'file:README.md' } };
        await renderScreen(<Screen />);
        expect(ensureSessionVisibleSpy).toHaveBeenCalledWith('session-1', { serverId: 'server-b' });
    });

    it('passes an onRequestClose that closes the pane and navigates back', async () => {
        scopeState = { details: { isOpen: true, tabs: [{ key: 'file:README.md' }], activeTabKey: 'file:README.md' } };
        const screen = await renderScreen(<Screen />);

        const panel = screen.findByType('SessionDetailsPanel' as any);
        await act(async () => {
            panel.props.onRequestClose();
        });

        expect(closeDetailsSpy).toHaveBeenCalled();
        expect(routerBackSpy).toHaveBeenCalledTimes(1);
    });

    it('falls back to the parent session route when there is no back stack', async () => {
        canGoBack = false;
        scopeState = { details: { isOpen: true, tabs: [{ key: 'file:README.md' }], activeTabKey: 'file:README.md' } };
        const screen = await renderScreen(<Screen />);

        const panel = screen.findByType('SessionDetailsPanel' as any);
        await act(async () => {
            panel.props.onRequestClose();
        });

        expect(routerBackSpy).not.toHaveBeenCalled();
        expect(routerReplaceSpy).toHaveBeenCalledWith('/session/session-1');
    });

    it('falls back to the source surface when a sourced details route has no back stack', async () => {
        canGoBack = false;
        mockServerId = 'server-b';
        mockSourceSurfaceParam = 'git';
        scopeState = { details: { isOpen: true, tabs: [{ key: 'file:README.md' }], activeTabKey: 'file:README.md' } };
        const screen = await renderScreen(<Screen />);

        const panel = screen.findByType('SessionDetailsPanel' as any);
        await act(async () => {
            panel.props.onRequestClose();
        });

        expect(routerBackSpy).not.toHaveBeenCalled();
        expect(routerReplaceSpy).toHaveBeenCalledWith('/session/session-1/git?serverId=server-b');
    });
});
