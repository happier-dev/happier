import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createExpoRouterMock } from '@/dev/testkit/mocks/router';
import {
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';
import { installSessionRouteCommonModuleMocks } from './sessionRouteTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let mockSessionId = 'session-1';
let isFocused = true;
let sessionHydrated = true;
let mockDetailsParam: string | undefined;
let mockPathParam: string | undefined;
let mockShaParam: string | undefined;
let mockTerminalInstanceIdParam: string | undefined;
const routerBackSpy = vi.fn();
const routerReplaceSpy = vi.fn();
const routerSetParamsSpy = vi.fn();
const ensureSessionVisibleSpy = vi.fn((_sessionId: string) => Promise.resolve());
const closeDetailsSpy = vi.fn();
const openDetailsTabSpy = vi.fn();
let canGoBack = true;
let deviceType: 'phone' | 'tablet' | 'desktop' = 'desktop';
let mobileWorkspaceExperience: 'classic' | 'cockpit' = 'classic';
let setScopeStateForTest: React.Dispatch<React.SetStateAction<MockScopeState>> | null = null;
const routerMock = createExpoRouterMock({
    router: {
        back: routerBackSpy,
        push: vi.fn(),
        replace: routerReplaceSpy,
        setParams: routerSetParamsSpy,
    },
});

type DetailsTab = Readonly<{
    key: string;
    kind?: string;
    resource?: Readonly<Record<string, unknown>>;
}>;
type DetailsGroup = Readonly<{
    id: string;
    tabs?: readonly DetailsTab[];
    activeTabKey?: string | null;
    isFocused?: boolean;
}>;
type MockScopeState = Readonly<{
    details:
        | null
        | Readonly<{
              isOpen?: boolean;
              tabs?: readonly DetailsTab[];
              activeTabKey?: string | null;
              tabState?: Record<string, unknown>;
              groups?: readonly DetailsGroup[];
              focusedGroupId?: string | null;
          }>;
}>;

let scopeState: MockScopeState = { details: null };

installSessionRouteCommonModuleMocks({
    router: () => ({
        ...routerMock.module,
        useLocalSearchParams: () => ({
            id: mockSessionId,
            details: mockDetailsParam,
            path: mockPathParam,
            sha: mockShaParam,
            terminalInstanceId: mockTerminalInstanceIdParam,
        }),
        useGlobalSearchParams: () => ({
            id: mockSessionId,
            details: mockDetailsParam,
            path: mockPathParam,
            sha: mockShaParam,
            terminalInstanceId: mockTerminalInstanceIdParam,
        }),
        useNavigation: () => ({ canGoBack: () => canGoBack }),
    }),
    storageModule: async (importOriginal) => {
        const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleMock({
            importOriginal,
            overrides: {
                useLocalSetting: ((key: string) => (key === 'mobileWorkspaceExperienceV1' ? mobileWorkspaceExperience : null)) as any,
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
        setScopeStateForTest = setState;
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

vi.mock('@/components/sessions/panes/url/sessionPaneUrlState', () => ({
    parseSessionPaneUrlState: () => {
        if (mockDetailsParam === 'file' && mockPathParam) {
            return { details: { kind: 'file', path: mockPathParam } };
        }
        if (mockDetailsParam === 'commit' && mockShaParam) {
            return { details: { kind: 'commit', sha: mockShaParam } };
        }
        if (mockDetailsParam === 'terminal') {
            return {
                details: mockTerminalInstanceIdParam
                    ? { kind: 'terminal', terminalInstanceId: mockTerminalInstanceIdParam }
                    : { kind: 'terminal' },
            };
        }
        return null;
    },
    buildActiveDetailsRouteParams: (detailsTabs: any[], activeDetailsKey: string | null) => {
        const activeTab = detailsTabs.find((tab) => tab?.key === activeDetailsKey) ?? detailsTabs.at(-1) ?? null;
        if (!activeTab) return {};
        if (activeTab.kind === 'file') {
            return {
                details: 'file',
                path: activeTab.resource?.path,
            };
        }
        if (activeTab.kind === 'commit') {
            return {
                details: 'commit',
                sha: activeTab.resource?.commitHash ?? activeTab.resource?.sha,
            };
        }
        if (activeTab.kind === 'terminal') {
            return activeTab.resource?.terminalInstanceId
                ? { details: 'terminal', terminalInstanceId: activeTab.resource.terminalInstanceId }
                : { details: 'terminal' };
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
            return;
        }
        if (state?.details?.kind === 'terminal') {
            pane.openDetailsTab({
                key: state.details.terminalInstanceId ? `terminal:${state.details.terminalInstanceId}` : 'terminal:primary',
                kind: 'terminal',
                resource: state.details.terminalInstanceId
                    ? { kind: 'terminal', terminalInstanceId: state.details.terminalInstanceId }
                    : { kind: 'terminal' },
            });
        }
    },
}));

vi.mock('@/hooks/session/useHydrateSessionForRoute', () => ({
    useHydrateSessionForRoute: (sessionId: string) => {
        ensureSessionVisibleSpy(sessionId);
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

vi.mock('@/utils/platform/responsive', () => ({
    useDeviceType: () => deviceType,
}));

describe('/session/[id]/details', () => {
    let Screen: React.ComponentType<any>;

    beforeAll(async () => {
        Screen = (await import('@/app/(app)/session/[id]/details')).default;
    }, 60_000);

    beforeEach(() => {
        mockSessionId = 'session-1';
        isFocused = true;
        sessionHydrated = true;
        mockDetailsParam = undefined;
        mockPathParam = undefined;
        mockShaParam = undefined;
        mockTerminalInstanceIdParam = undefined;
        canGoBack = true;
        deviceType = 'desktop';
        mobileWorkspaceExperience = 'classic';
        scopeState = { details: null };
        routerBackSpy.mockClear();
        routerReplaceSpy.mockClear();
        routerSetParamsSpy.mockClear();
        ensureSessionVisibleSpy.mockClear();
        closeDetailsSpy.mockClear();
        openDetailsTabSpy.mockClear();
        setScopeStateForTest = null;
        vi.clearAllMocks();
    });

    afterEach(() => {
        standardCleanup();
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

    it('still restores the URL-selected details tab when split groups already exist', async () => {
        mockDetailsParam = 'file';
        mockPathParam = 'README.md';
        scopeState = {
            details: {
                isOpen: true,
                tabs: [{ key: 'file:OTHER.md' }],
                activeTabKey: 'file:OTHER.md',
                tabState: {},
                focusedGroupId: 'group:2',
                groups: [
                    {
                        id: 'group:1',
                        activeTabKey: 'file:OTHER.md',
                        tabs: [{ key: 'file:OTHER.md' }],
                    },
                    {
                        id: 'group:2',
                        activeTabKey: null,
                        tabs: [],
                        isFocused: true,
                    },
                ],
            },
        };

        await renderScreen(<Screen />);

        expect(openDetailsTabSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                key: 'file:README.md',
                kind: 'file',
                resource: { kind: 'file', path: 'README.md' },
            }),
        );
    });

    it('navigates back when there are no details tabs to display', async () => {
        await renderScreen(<Screen />);
        expect(routerBackSpy).toHaveBeenCalled();
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
    });

    it('renders the session cockpit shell on phone in cockpit mode', async () => {
        deviceType = 'phone';
        mobileWorkspaceExperience = 'cockpit';

        const screen = await renderScreen(<Screen />);

        const cockpit = screen.findByType('SessionCockpitShell' as any);
        expect(cockpit.props.sessionId).toBe('session-1');
        expect(cockpit.props.surface).toBe('tabs');
        expect(screen.findAllByType('SessionDetailsPanel' as any)).toHaveLength(0);
    });

    it('does not dismiss the cockpit details route when details pane state closes', async () => {
        deviceType = 'phone';
        mobileWorkspaceExperience = 'cockpit';
        scopeState = { details: { isOpen: true, tabs: [{ key: 'file:README.md' }], activeTabKey: 'file:README.md' } };

        await renderScreen(<Screen />);

        await act(async () => {
            setScopeStateForTest?.((prev) => ({
                ...prev,
                details: prev.details ? { ...prev.details, isOpen: false } : prev.details,
            }));
        });

        expect(routerBackSpy).not.toHaveBeenCalled();
        expect(routerReplaceSpy).not.toHaveBeenCalled();
    });

    it('stays on the fullscreen details route when the focused split group is empty but another group still has tabs', async () => {
        scopeState = {
            details: {
                isOpen: true,
                tabs: [],
                activeTabKey: null,
                tabState: {},
                focusedGroupId: 'group:2',
                groups: [
                    {
                        id: 'group:1',
                        activeTabKey: 'file:README.md',
                        tabs: [{ key: 'file:README.md' }],
                    },
                    {
                        id: 'group:2',
                        activeTabKey: null,
                        tabs: [],
                    },
                ],
            },
        };

        await renderScreen(<Screen />);

        expect(routerBackSpy).not.toHaveBeenCalled();
        expect(routerReplaceSpy).not.toHaveBeenCalled();
    });

    it('hydrates the session for deep links by requesting session visibility', async () => {
        scopeState = { details: { tabs: [{ key: 'file:README.md' }], activeTabKey: 'file:README.md' } };
        await renderScreen(<Screen />);
        expect(ensureSessionVisibleSpy).toHaveBeenCalledWith('session-1');
    });

    it('keeps the fullscreen details route params in sync with the selected split details tab after mount', async () => {
        mockDetailsParam = 'file';
        mockPathParam = 'README.md';
        scopeState = {
            details: {
                isOpen: true,
                tabs: [
                    { key: 'file:README.md', kind: 'file', resource: { kind: 'file', path: 'README.md' } },
                    { key: 'commit:abc1234', kind: 'commit', resource: { kind: 'commit', commitHash: 'abc1234' } },
                ],
                activeTabKey: 'file:README.md',
                tabState: {},
                focusedGroupId: 'group:1',
                groups: [
                    {
                        id: 'group:1',
                        activeTabKey: 'file:README.md',
                        tabs: [
                            { key: 'file:README.md', kind: 'file', resource: { kind: 'file', path: 'README.md' } },
                            { key: 'commit:abc1234', kind: 'commit', resource: { kind: 'commit', commitHash: 'abc1234' } },
                        ],
                        isFocused: true,
                    },
                ],
            },
        };

        await renderScreen(<Screen />);
        routerSetParamsSpy.mockClear();

        await act(async () => {
            setScopeStateForTest?.((prev) => ({
                ...prev,
                details: prev.details ? {
                    ...prev.details,
                    activeTabKey: 'commit:abc1234',
                    tabs: [
                        { key: 'file:README.md', kind: 'file', resource: { kind: 'file', path: 'README.md' } },
                        { key: 'commit:abc1234', kind: 'commit', resource: { kind: 'commit', commitHash: 'abc1234' } },
                    ],
                    groups: [
                        {
                            id: 'group:1',
                            activeTabKey: 'commit:abc1234',
                            tabs: [
                                { key: 'file:README.md', kind: 'file', resource: { kind: 'file', path: 'README.md' } },
                                { key: 'commit:abc1234', kind: 'commit', resource: { kind: 'commit', commitHash: 'abc1234' } },
                            ],
                            isFocused: true,
                        },
                    ],
                } : prev.details,
            }));
        });
        await act(async () => {});

        await vi.waitFor(() => {
            expect(routerSetParamsSpy).toHaveBeenCalledWith({
                details: 'commit',
                path: undefined,
                sha: 'abc1234',
                terminalInstanceId: undefined,
            });
        });
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

    it('closes details pane state when the fullscreen details route unmounts', async () => {
        scopeState = { details: { isOpen: true, tabs: [{ key: 'file:README.md' }], activeTabKey: 'file:README.md' } };
        const screen = await renderScreen(<Screen />);

        await screen.unmount();

        expect(closeDetailsSpy).toHaveBeenCalledTimes(1);
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
});
