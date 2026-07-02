import * as React from 'react';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installSessionRouteCommonModuleMocks } from './sessionRouteTestHelpers';
import type { SessionRouteHydrationState } from '@/sync/domains/session/sessionRouteHydrationState';


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
const readMachineTargetForSessionMock = vi.fn((_sessionId: string) => ({
    machineId: 'machine-1',
    basePath: '/tmp',
}));

let sessionLogPath: string | null = null;
let sessionMachineId: string | null = null;
let isDataReady = true;
let routeHydrationState: SessionRouteHydrationState = { kind: 'available', sessionId: 'session-1' };

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
    storageModule: async (importOriginal) => {
        const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleMock({
            importOriginal,
            overrides: {
                // Boundary fixture: this route only reads `metadata.sessionLogPath` from the session object.
                useSession: (() =>
                    (sessionLogPath
                        ? {
                              id: 'session-1',
                              metadata: { sessionLogPath, machineId: sessionMachineId },
                          }
                        : {
                              id: 'session-1',
                              metadata: null,
                          }) as unknown) as typeof import('@/sync/domains/state/storage')['useSession'],
                useIsDataReady: () => isDataReady,
            },
        });
    },
});

vi.mock('@/hooks/session/useHydrateSessionForRoute', () => ({
    useHydrateSessionForRoute: (sessionId: string) => ({
        ...routeHydrationState,
        sessionId,
    }),
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

vi.mock('@/sync/ops/sessionMachineTarget', () => ({
    readMachineTargetForSession: (sessionId: string) => readMachineTargetForSessionMock(sessionId),
}));

describe('Session log screen', () => {
    beforeEach(() => {
        sessionLogPath = null;
        sessionMachineId = null;
        isDataReady = true;
        routeHydrationState = { kind: 'available', sessionId: 'session-1' };
        machineReadSessionLogTailMock.mockClear();
        machineGetBugReportLogTailMock.mockClear();
        readMachineTargetForSessionMock.mockClear();
        readMachineTargetForSessionMock.mockReturnValue({
            machineId: 'machine-1',
            basePath: '/tmp',
        });
    });

    it('does not fetch log tail until session hydration is ready', async () => {
        routeHydrationState = { kind: 'loading', sessionId: 'session-1', reason: 'store-miss' };
        sessionLogPath = '/tmp/.happier/logs/session.log';
        sessionMachineId = 'machine-1';
        const { default: SessionLogScreen } = await import('@/app/(app)/session/[id]/log');

        await renderScreen(React.createElement(SessionLogScreen));

        expect(machineReadSessionLogTailMock).not.toHaveBeenCalled();
        expect(machineGetBugReportLogTailMock).not.toHaveBeenCalled();
    });

    it('does not fetch log tail while route hydration is retrying', async () => {
        routeHydrationState = { kind: 'retrying', sessionId: 'session-1', cause: 'server_unavailable' };
        sessionLogPath = '/tmp/.happier/logs/session.log';
        sessionMachineId = 'machine-1';
        const { default: SessionLogScreen } = await import('@/app/(app)/session/[id]/log');

        const screen = await renderScreen(React.createElement(SessionLogScreen));

        expect(screen.getTextContent()).toContain('common.loading');
        expect(machineReadSessionLogTailMock).not.toHaveBeenCalled();
        expect(machineGetBugReportLogTailMock).not.toHaveBeenCalled();
    });

    it('renders terminal fallback when route hydration is missing', async () => {
        routeHydrationState = { kind: 'missing', sessionId: 'session-1', cause: 'not_found' };
        sessionLogPath = '/tmp/.happier/logs/session.log';
        sessionMachineId = 'machine-1';
        const { default: SessionLogScreen } = await import('@/app/(app)/session/[id]/log');

        const screen = await renderScreen(React.createElement(SessionLogScreen));

        expect(screen.findByProps({ testID: 'session-invalid-link' })).toBeDefined();
        expect(machineReadSessionLogTailMock).not.toHaveBeenCalled();
        expect(machineGetBugReportLogTailMock).not.toHaveBeenCalled();
    });

    it('does not keep the route loading after route hydration is available when global data is not ready', async () => {
        isDataReady = false;
        sessionLogPath = '/tmp/.happier/logs/session.log';
        sessionMachineId = 'machine-1';
        const { default: SessionLogScreen } = await import('@/app/(app)/session/[id]/log');

        const screen = await renderScreen(React.createElement(SessionLogScreen));

        expect(screen.getTextContent()).not.toContain('common.loading');
        expect(machineReadSessionLogTailMock).toHaveBeenCalledWith('machine-1', { path: sessionLogPath, maxBytes: 200000 }, undefined);
    });

    it('does not fetch log tail when log path is unavailable', async () => {
        const { default: SessionLogScreen } = await import('@/app/(app)/session/[id]/log');

        await renderScreen(React.createElement(SessionLogScreen));

        expect(machineReadSessionLogTailMock).not.toHaveBeenCalled();
    });

    it('fetches session log tail when log path exists', async () => {
        sessionLogPath = '/tmp/.happier/logs/session.log';
        sessionMachineId = 'machine-1';
        const { default: SessionLogScreen } = await import('@/app/(app)/session/[id]/log');

        await renderScreen(React.createElement(SessionLogScreen));

        expect(machineReadSessionLogTailMock).toHaveBeenCalledWith('machine-1', { path: sessionLogPath, maxBytes: 200000 }, undefined);
    });

    it('fetches session log tail from the resolved live machine target instead of stale metadata', async () => {
        sessionLogPath = '/tmp/.happier/logs/session.log';
        sessionMachineId = 'old-machine';
        readMachineTargetForSessionMock.mockReturnValue({
            machineId: 'replacement-machine',
            basePath: '/tmp',
        });
        const { default: SessionLogScreen } = await import('@/app/(app)/session/[id]/log');

        await renderScreen(React.createElement(SessionLogScreen));

        expect(machineReadSessionLogTailMock).toHaveBeenCalledWith('replacement-machine', { path: sessionLogPath, maxBytes: 200000 }, undefined);
    });

    it('does not call bug report log tail RPC for session logs', async () => {
        sessionLogPath = '/tmp/.happier/logs/session.log';
        sessionMachineId = 'machine-1';
        const { default: SessionLogScreen } = await import('@/app/(app)/session/[id]/log');

        await renderScreen(React.createElement(SessionLogScreen));

        expect(machineGetBugReportLogTailMock).not.toHaveBeenCalled();
    });
});
