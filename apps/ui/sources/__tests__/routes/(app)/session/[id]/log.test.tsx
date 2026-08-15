import * as React from 'react';
import { act } from 'react-test-renderer';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    createMachineFixture,
    createSessionFixture,
    flushHookEffects,
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';
import { storage as machineTargetStorage } from '@/sync/domains/state/storageStore';
import { installSessionRouteCommonModuleMocks } from './sessionRouteTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type MachineReadSessionLogTailMockResponse =
    | Readonly<{ success: true; path: string; tail: string }>
    | Readonly<{ success: false; error: string }>;

const machineReadSessionLogTailMock = vi.fn(
    async (_machineId?: string, _params?: unknown, _options?: unknown): Promise<MachineReadSessionLogTailMockResponse> => ({
        success: true,
        path: '/tmp/.happier/logs/session.log',
        tail: 'tail line',
    }),
);

const machineGetBugReportLogTailMock = vi.fn(async (_machineId?: string, _params?: unknown, _options?: unknown) => ({
    ok: false,
    path: '/tmp/.happier/logs/session.log',
    tail: 'tail line',
}));

let sessionLogPath: string | null = null;
let sessionMachineId: string | null = null;
let routeSession = createSessionFixture({ metadata: null });
let sessionHydrated = true;
let mockServerId: string | undefined;
let previousSessions = machineTargetStorage.getState().sessions;
let previousMachines = machineTargetStorage.getState().machines;
const hydrateSpy = vi.fn((sessionId: string, _tag: string, options?: { serverId?: string }) =>
    sessionHydrated
        ? { kind: 'available', sessionId, serverId: options?.serverId }
        : { kind: 'loading', sessionId, serverId: options?.serverId, reason: 'cold' },
);

installSessionRouteCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'ios',
                select: (spec: Record<string, unknown>) =>
                    spec && Object.prototype.hasOwnProperty.call(spec, 'ios')
                        ? (spec as Record<string, unknown> & { ios?: unknown }).ios
                        : (spec as Record<string, unknown> & { default?: unknown }).default,
            },
        });
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        const routerMock = createExpoRouterMock({
            params: {
                id: 'session-1',
                serverId: mockServerId,
            },
        });
        return {
            ...routerMock.module,
            useLocalSearchParams: () => ({ id: 'session-1', serverId: mockServerId }),
        };
    },
    storageModule: async (importOriginal) => {
        const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleMock({
            importOriginal,
            overrides: {
                // Boundary fixture: this route only reads `metadata.sessionLogPath` from the session object.
                useSession: (() => routeSession) as typeof import('@/sync/domains/state/storage')['useSession'],
                useIsDataReady: () => true,
            },
        });
    },
});

vi.mock('@/hooks/session/useHydrateSessionForRoute', () => ({
    useHydrateSessionForRoute: (sessionId: string, tag: string, options?: { serverId?: string }) =>
        hydrateSpy(sessionId, tag, options),
}));

vi.mock('@expo/vector-icons', async () => {
    const Ionicons = (props: any) => React.createElement('Ionicons', props);
    return { Ionicons };
});

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: ({ children }: any) => React.createElement('ItemList', null, children),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children, title }: any) => React.createElement('ItemGroup', { title }, children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => React.createElement('Item', props),
}));

vi.mock('@/components/ui/media/CodeView', () => ({
    CodeView: ({ code }: { code: string }) => React.createElement('CodeView', { code }),
}));

vi.mock('@/sync/ops', () => ({
    machineReadSessionLogTail: (machineId: string, params?: unknown, options?: unknown) =>
        machineReadSessionLogTailMock(machineId, params, options),
    machineGetBugReportLogTail: (machineId: string, params?: unknown, options?: unknown) =>
        machineGetBugReportLogTailMock(machineId, params, options),
}));

function setRouteSession(logPath: string | null, machineId: string | null) {
    sessionLogPath = logPath;
    sessionMachineId = machineId;
    routeSession = createSessionFixture({
        active: true,
        metadata: logPath
            ? {
                  sessionLogPath: logPath,
                  machineId,
                  path: '/repo',
                  host: 'tester.local',
                  homeDir: '/Users/tester',
              } as ReturnType<typeof createSessionFixture>['metadata']
            : null,
    });
}

function setCanonicalMachineTarget(target: { machineId: string; basePath: string } | null) {
    machineTargetStorage.setState({
        sessions: {
            'session-1': createSessionFixture({
                active: true,
                metadata: {
                    machineId: target?.machineId ?? sessionMachineId,
                    path: target?.basePath ?? '/repo',
                    host: 'tester.local',
                    homeDir: '/Users/tester',
                } as ReturnType<typeof createSessionFixture>['metadata'],
            }),
        },
        machines: target
            ? {
                  [target.machineId]: createMachineFixture({ id: target.machineId, active: true }),
              }
            : {},
    });
}

describe('Session log screen', () => {
    beforeEach(() => {
        previousSessions = machineTargetStorage.getState().sessions;
        previousMachines = machineTargetStorage.getState().machines;
        setRouteSession(null, null);
        setCanonicalMachineTarget(null);
        sessionHydrated = true;
        mockServerId = undefined;
        hydrateSpy.mockClear();
        machineReadSessionLogTailMock.mockClear();
        machineGetBugReportLogTailMock.mockClear();
    });

    afterEach(() => {
        standardCleanup();
        machineTargetStorage.setState({
            sessions: previousSessions,
            machines: previousMachines,
        });
    });

    it('does not fetch log tail until session hydration is ready', async () => {
        sessionHydrated = false;
        mockServerId = 'server-b';
        setRouteSession('/tmp/.happier/logs/session.log', 'machine-1');
        setCanonicalMachineTarget({ machineId: 'machine-1', basePath: '/repo' });
        const { default: SessionLogScreen } = await import('@/app/(app)/session/[id]/log');

        await renderScreen(React.createElement(SessionLogScreen));

        expect(machineReadSessionLogTailMock).not.toHaveBeenCalled();
        expect(machineGetBugReportLogTailMock).not.toHaveBeenCalled();
        expect(hydrateSpy).toHaveBeenCalledWith('session-1', 'SessionLogRoute.ensureSessionVisible', { serverId: 'server-b' });
    });

    it('does not fetch log tail when log path is unavailable', async () => {
        const { default: SessionLogScreen } = await import('@/app/(app)/session/[id]/log');

        await renderScreen(React.createElement(SessionLogScreen));

        expect(machineReadSessionLogTailMock).not.toHaveBeenCalled();
    });

    it('fetches session log tail when log path exists', async () => {
        setRouteSession('/tmp/.happier/logs/session.log', 'machine-1');
        setCanonicalMachineTarget({ machineId: 'machine-1', basePath: '/repo' });
        const { default: SessionLogScreen } = await import('@/app/(app)/session/[id]/log');

        await renderScreen(React.createElement(SessionLogScreen));

        expect(machineReadSessionLogTailMock).toHaveBeenCalledWith('machine-1', { path: sessionLogPath, maxBytes: 200000 }, undefined);
    });

    it('does not target stale metadata when canonical reachability is unavailable', async () => {
        setRouteSession('/tmp/.happier/logs/session.log', 'machine-stale');
        setCanonicalMachineTarget(null);
        const { default: SessionLogScreen } = await import('@/app/(app)/session/[id]/log');

        await renderScreen(React.createElement(SessionLogScreen));

        expect(machineReadSessionLogTailMock).not.toHaveBeenCalled();
    });

    it('does not call bug report log tail RPC for session logs', async () => {
        setRouteSession('/tmp/.happier/logs/session.log', 'machine-1');
        setCanonicalMachineTarget({ machineId: 'machine-1', basePath: '/repo' });
        const { default: SessionLogScreen } = await import('@/app/(app)/session/[id]/log');

        await renderScreen(React.createElement(SessionLogScreen));

        expect(machineGetBugReportLogTailMock).not.toHaveBeenCalled();
    });

    it('wires copy rows through item-local copy feedback', async () => {
        setRouteSession('/tmp/.happier/logs/session.log', 'machine-1');
        setCanonicalMachineTarget({ machineId: 'machine-1', basePath: '/repo' });
        const { default: SessionLogScreen } = await import('@/app/(app)/session/[id]/log');

        const screen = await renderScreen(React.createElement(SessionLogScreen));
        const itemByTitle = (title: string) =>
            screen.findAllByType('Item' as any).find((node: any) => node.props?.title === title);

        expect(itemByTitle('sessionLog.logPathTitle')?.props.copy).toBe('/tmp/.happier/logs/session.log');
        expect(itemByTitle('sessionLog.logPathTitle')?.props.onPress).toBeUndefined();
        expect(itemByTitle('sessionLog.copyVisibleTitle')?.props.onPress).toBeUndefined();
    });

    it('fetches when only the machine record hydrates and the session identity stays stable', async () => {
        setRouteSession('/tmp/.happier/logs/session.log', 'machine-1');
        setCanonicalMachineTarget(null);
        const stableSession = machineTargetStorage.getState().sessions['session-1'];
        const { default: SessionLogScreen } = await import('@/app/(app)/session/[id]/log');

        await renderScreen(React.createElement(SessionLogScreen));
        expect(machineReadSessionLogTailMock).not.toHaveBeenCalled();

        await act(async () => {
            machineTargetStorage.setState({
                machines: {
                    'machine-1': createMachineFixture({ id: 'machine-1', active: true }),
                },
            });
        });
        await flushHookEffects();

        expect(machineTargetStorage.getState().sessions['session-1']).toBe(stableSession);
        expect(machineReadSessionLogTailMock).toHaveBeenCalledWith(
            'machine-1',
            { path: sessionLogPath, maxBytes: 200000 },
            undefined,
        );
    });
});
