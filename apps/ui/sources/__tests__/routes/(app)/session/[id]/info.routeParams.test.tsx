import * as React from 'react';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';
import { createStorageModuleStub } from '@/dev/testkit/mocks/storage';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const hydrateSessionSpy = vi.hoisted(() => vi.fn((sessionId: string, reason: string) => ({
    kind: 'available' as const,
    sessionId,
})));
const useSessionSpy = vi.hoisted(() => vi.fn<(sessionId: string) => unknown>());
const resolvePreferredServerIdForSessionIdSpy = vi.hoisted(() => vi.fn<(sessionId: string) => string | undefined>());
const useSessionExecutionRunsSupportedSpy = vi.hoisted(() => vi.fn<(sessionId: string, serverId: string | null) => boolean>(() => true));
const useSessionHandoffSourceReachabilitySpy = vi.hoisted(() => vi.fn());
const machineContributionRegistryProjectionDescribeMock = vi.hoisted(() =>
    vi.fn<(...args: unknown[]) => Promise<any>>(async () => ({ supported: false, reason: 'not-supported' })),
);

const routerMock = createExpoRouterMock({
    params: { id: ['s1', 's2'] },
    router: {
        push: vi.fn(),
        back: vi.fn(),
        replace: vi.fn(),
        setParams: vi.fn(),
    },
});

vi.mock('expo-router', () => routerMock.module);

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        View: 'View',
        Animated: {
            Value: class {
                setValue(_value: number) {}
            },
            loop: () => ({ start: () => {} }),
            sequence: () => [],
            timing: () => ({}),
            View: 'AnimatedView',
        },
        Platform: { OS: 'web', select: (spec: Record<string, unknown>) => spec.web ?? spec.default },
    });
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: (props: any) => React.createElement('Ionicons', props),
    Octicons: (props: any) => React.createElement('Octicons', props),
}));

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

vi.mock('@/hooks/session/useHydrateSessionForRoute', () => ({
    useHydrateSessionForRoute: (sessionId: string, reason: string) => hydrateSessionSpy(sessionId, reason),
}));

vi.mock('@/sync/ops/machineContributionRegistryProjection', () => ({
    machineContributionRegistryProjectionDescribe: (...args: any[]) => machineContributionRegistryProjectionDescribeMock(...args),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId', () => ({
    resolvePreferredServerIdForSessionId: (sessionId: string) => resolvePreferredServerIdForSessionIdSpy(sessionId),
}));

vi.mock('@/components/sessions/model/resolveSessionTargetServerId', () => ({
    resolveSessionTargetServerId: () => {
        throw new Error('legacy session target resolver should not be used in session info route');
    },
}));

vi.mock('@/hooks/server/useSessionExecutionRunsSupported', () => ({
    useSessionExecutionRunsSupported: (sessionId: string, serverId: string | null) =>
        useSessionExecutionRunsSupportedSpy(sessionId, serverId),
}));

const storageMock = createStorageModuleStub({
    useSession: (sessionId: string) => useSessionSpy(sessionId),
    useSessionMessagesVersion: () => 0,
    useIsDataReady: () => true,
    useLocalSetting: () => false,
    useSetting: () => false,
    storage: {
        getState: () => ({}),
    },
});

vi.mock('@/sync/domains/state/storage', () => storageMock);

vi.mock('@/components/sessions/model/useSessionMachineReachability', () => ({
    useSessionReachableMachineTarget: () => null,
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => true,
}));

vi.mock('@/hooks/session/useSessionSharingSupport', () => ({
    useSessionSharingSupport: () => true,
}));

vi.mock('@/hooks/server/useAutomationsSupport', () => ({
    useAutomationsSupport: () => ({ enabled: false }),
}));

vi.mock('@/sync/domains/sessionHandoff/useSessionHandoffSourceReachability', () => ({
    useSessionHandoffSourceReachability: (input: unknown) => {
        useSessionHandoffSourceReachabilitySpy(input);
        return { available: true };
    },
}));

describe('session info route', () => {
    beforeEach(() => {
        hydrateSessionSpy.mockClear();
        useSessionSpy.mockReset();
        useSessionSpy.mockReturnValue(null);
        resolvePreferredServerIdForSessionIdSpy.mockReset();
        resolvePreferredServerIdForSessionIdSpy.mockReturnValue('server-canonical');
        useSessionExecutionRunsSupportedSpy.mockClear();
        useSessionHandoffSourceReachabilitySpy.mockClear();
        machineContributionRegistryProjectionDescribeMock.mockReset();
        machineContributionRegistryProjectionDescribeMock.mockResolvedValue({ supported: false, reason: 'not-supported' });
    });

    afterEach(() => {
        standardCleanup();
    });

    it('normalizes array session ids before hydrating and looking up session state', async () => {
        const { default: InfoRoute } = await import('@/app/(app)/session/[id]/info');

        await renderScreen(<InfoRoute />);

        expect(hydrateSessionSpy).toHaveBeenCalledWith('s1', 'SessionInfoRoute.ensureSessionVisible');
        expect(useSessionSpy).toHaveBeenCalledWith('s1');
    });

    it('uses the canonical preferred server when wiring session info consumers', async () => {
        useSessionSpy.mockReturnValue({
            id: 's1',
            seq: 1,
            active: true,
            metadata: { machineId: 'm1' },
            accessLevel: 'edit',
            canApprovePermissions: true,
        });
        const { default: InfoRoute } = await import('@/app/(app)/session/[id]/info');

        await renderScreen(<InfoRoute />);

        expect(resolvePreferredServerIdForSessionIdSpy).toHaveBeenCalledWith('s1');
        expect(useSessionExecutionRunsSupportedSpy).toHaveBeenCalledWith('s1', 'server-canonical');
        expect(useSessionHandoffSourceReachabilitySpy).toHaveBeenCalledWith(expect.objectContaining({
            serverId: 'server-canonical',
        }));
    });
});
