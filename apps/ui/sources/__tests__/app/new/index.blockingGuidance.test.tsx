import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const mockState = vi.hoisted(() => ({
    persistedDraft: null as Record<string, unknown> | null,
    tempData: null as Record<string, unknown> | null,
    serverId: 's1',
    resolvedTargetServerId: undefined as string | null | undefined,
    localSearchParams: {
        dataId: 'draft-data-id',
    } as { dataId?: string; spawnServerId?: string },
    serverListeners: new Set<() => void>(),
    guidanceModelListeners: new Set<() => void>(),
    guidanceKind: 'connect_machine' as 'connect_machine' | 'select_session',
    shouldBlockNewSession: true,
    guidanceHookCalls: 0,
    newSessionBlockHookCalls: 0,
    wizardRenders: 0,
    portalScopeRenders: 0,
}));

function setMockServerId(serverId: string): void {
    mockState.serverId = serverId;
    for (const listener of mockState.serverListeners) {
        listener();
    }
}

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                            View: 'View',
                        }
    );
});

vi.mock('@/components/sessions/guidance/SessionGettingStartedGuidance', () => ({
    SessionGettingStartedGuidance: 'SessionGettingStartedGuidance',
}));
vi.mock('@/components/sessions/guidance/useSessionGettingStartedGuidanceBaseModel', () => ({
    useSessionGettingStartedGuidanceBaseModel: () => {
        mockState.guidanceHookCalls += 1;

        const serverId = React.useSyncExternalStore(
            (listener) => {
                mockState.guidanceModelListeners.add(listener);
                return () => {
                    mockState.guidanceModelListeners.delete(listener);
                };
            },
            () => mockState.serverId,
            () => mockState.serverId,
        );

        return {
            kind: mockState.guidanceKind,
            targetLabel: 'Test server',
            serverId,
            serverName: 'Test',
            serverUrl: 'https://api.happier.dev',
            showServerSetup: false,
        };
    },
}));
vi.mock('@/components/sessions/guidance/useShouldBlockNewSessionWithGettingStartedGuidance', () => ({
    useShouldBlockNewSessionWithGettingStartedGuidance: () => {
        mockState.newSessionBlockHookCalls += 1;
        return mockState.shouldBlockNewSession;
    },
}));

vi.mock('@/sync/store/hooks', () => ({
    useActiveServerAccountScope: () => null,
    useSettings: () => ({
        serverSelectionGroups: [],
        serverSelectionActiveTargetKind: 'server',
        serverSelectionActiveTargetId: mockState.serverId,
    }),
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => ({
        serverId: mockState.serverId,
        serverUrl: 'https://api.happier.dev',
        generation: 1,
    }),
    subscribeActiveServer: (listener: (snapshot: { serverId: string; serverUrl: string; generation: number }) => void) => {
        mockState.serverListeners.add(() => {
            listener({
                serverId: mockState.serverId,
                serverUrl: 'https://api.happier.dev',
                generation: 1,
            });
        });
        return () => {
            mockState.serverListeners.delete(listener as unknown as () => void);
        };
    },
}));

vi.mock('@/components/sessions/new/hooks/serverTarget/useNewSessionServerTargetState', () => ({
    useNewSessionServerTargetState: ({ request }: { request: { spawnServerIdParam?: string | null } }) => ({
        targetServerId: typeof request?.spawnServerIdParam === 'string'
            ? request.spawnServerIdParam
            : mockState.resolvedTargetServerId === undefined
                ? mockState.serverId
                : mockState.resolvedTargetServerId,
    }),
}));

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    const expoRouterMock = createExpoRouterMock({
        params: mockState.localSearchParams,
    });
    return expoRouterMock.module;
});

vi.mock('@/sync/domains/state/persistence', () => ({
    loadNewSessionDraft: () => {
        if (!mockState.persistedDraft) {
            return null;
        }
        return mockState.persistedDraft;
    },
}));

vi.mock('@/utils/sessions/tempDataStore', () => ({
    peekTempData: () => mockState.tempData,
}));

vi.mock('@/components/sessions/new/hooks/useNewSessionScreenModel', () => ({
    useNewSessionScreenModel: () => ({
        variant: 'wizard',
        popoverBoundaryRef: { current: null },
        wizardProps: {
            layout: null,
            profiles: null,
            agent: null,
            machine: null,
            footer: null,
        },
    }),
}));

vi.mock('@/components/sessions/new/components/NewSessionSimplePanel', () => ({
    NewSessionSimplePanel: 'NewSessionSimplePanel',
}));

vi.mock('@/components/sessions/new/components/NewSessionWizard', () => ({
    NewSessionWizard: (props: Record<string, unknown>) => {
        mockState.wizardRenders += 1;
        return React.createElement('NewSessionWizard', props);
    },
}));

vi.mock('@/components/sessions/new/navigation/newSessionContainedModalScreen', () => ({
    NewSessionScreenPortalScope: ({ children }: { children: React.ReactNode }) => {
        mockState.portalScopeRenders += 1;
        return React.createElement(React.Fragment, null, children);
    },
}));

vi.mock('@/components/ui/popover', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/components/ui/popover')>();
    return {
        ...actual,
        PopoverBoundaryProvider: ({ children }: any) => React.createElement(React.Fragment, null, children),
        PopoverPortalTargetProvider: ({ children }: any) => React.createElement(React.Fragment, null, children),
        PopoverScope: ({ children }: any) => React.createElement(React.Fragment, null, children),
    };
});

afterEach(() => {
    mockState.persistedDraft = null;
    mockState.tempData = null;
    mockState.serverListeners.clear();
    mockState.guidanceModelListeners.clear();
    mockState.serverId = 's1';
    mockState.guidanceKind = 'connect_machine';
    mockState.shouldBlockNewSession = true;
    mockState.resolvedTargetServerId = undefined;
    mockState.localSearchParams = {
        dataId: 'draft-data-id',
    };
    mockState.guidanceHookCalls = 0;
    mockState.newSessionBlockHookCalls = 0;
    mockState.wizardRenders = 0;
    mockState.portalScopeRenders = 0;
});

describe('/new (blocking guidance)', () => {
    it('hard-stops with connect-machine guidance when no machines exist', async () => {
        setMockServerId('s1');
        mockState.persistedDraft = null;
        mockState.tempData = null;
        mockState.shouldBlockNewSession = true;

        const Screen = (await import('@/app/(app)/new')).default;

        const screen = await renderScreen(React.createElement(Screen));

        expect(() => screen.findByType('SessionGettingStartedGuidance')).not.toThrow();
        expect(() => screen.findByType('NewSessionWizard')).toThrow();
        expect(mockState.portalScopeRenders).toBe(0);
    });

    it('keeps the new-session panel out of full getting-started model invalidations', async () => {
        setMockServerId('s1');
        mockState.persistedDraft = null;
        mockState.tempData = null;
        mockState.guidanceKind = 'select_session';
        mockState.shouldBlockNewSession = false;

        const Screen = (await import('@/app/(app)/new')).default;

        await renderScreen(React.createElement(Screen));

        expect(mockState.wizardRenders).toBe(1);
        expect(mockState.portalScopeRenders).toBe(1);
        expect(mockState.guidanceHookCalls).toBe(0);
        expect(mockState.newSessionBlockHookCalls).toBe(1);

        for (const listener of mockState.guidanceModelListeners) {
            listener();
        }

        expect(mockState.wizardRenders).toBe(1);
        expect(mockState.guidanceHookCalls).toBe(0);
    });

    it('keeps the wizard path when temp data seeds a worktree draft intent', async () => {
        setMockServerId('s1');
        mockState.persistedDraft = null;
        mockState.tempData = {
            workspaceId: 'workspace-1',
            workspaceLocationId: 'location-1',
            checkoutCreationDraft: {
                kind: 'git_worktree',
                displayName: 'feature-x',
                baseRef: 'main',
            },
        };

        const Screen = (await import('@/app/(app)/new')).default;

        const screen = await renderScreen(React.createElement(Screen));

        expect(() => screen.findByType('NewSessionWizard')).not.toThrow();
        expect(() => screen.findByType('SessionGettingStartedGuidance')).toThrow();
    });

    it('does not subscribe to getting-started guidance when temp data seeds a machine intent', async () => {
        setMockServerId('s1');
        mockState.persistedDraft = null;
        mockState.tempData = {
            machineId: 'machine-1',
        };

        const Screen = (await import('@/app/(app)/new')).default;

        await renderScreen(React.createElement(Screen));

        expect(mockState.guidanceHookCalls).toBe(0);
        expect(mockState.wizardRenders).toBe(1);

        setMockServerId('s2');

        expect(mockState.guidanceHookCalls).toBe(0);
        expect(mockState.wizardRenders).toBe(1);
    });
});
