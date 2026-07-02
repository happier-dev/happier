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
const runListSpy = vi.hoisted(() => vi.fn<(sessionId: string, options: unknown) => Promise<{ ok: true; runs: never[] }>>(async () => ({ ok: true, runs: [] })));

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
vi.mock('expo-router', async () => {
    const actual = await vi.importActual<typeof import('expo-router')>('expo-router');
    return {
        ...actual,
        useFocusEffect: () => {},
        ...routerMock.module,
    };
});

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        View: 'View',
        ActivityIndicator: 'ActivityIndicator',
        Pressable: 'Pressable',
        Platform: { OS: 'web', select: (spec: Record<string, unknown>) => spec.web ?? spec.default },
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: (props: any) => React.createElement('Ionicons', props),
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

vi.mock('@/hooks/session/useHydrateSessionForRoute', () => ({
    useHydrateSessionForRoute: (sessionId: string, reason: string) => hydrateSessionSpy(sessionId, reason),
}));

vi.mock('@/sync/ops/sessionExecutionRuns', () => ({
    sessionExecutionRunList: (sessionId: string, options: unknown) => runListSpy(sessionId, options),
}));

vi.mock('@/hooks/session/useSessionExecutionRunLaunchability', () => ({
    useSessionExecutionRunLaunchability: () => ({
        canLaunchExecutionRuns: false,
        executionRunsBackends: [],
    }),
}));

const storageMock = createStorageModuleStub({
    useSession: (sessionId: string) => useSessionSpy(sessionId),
});

vi.mock('@/sync/domains/state/storage', () => storageMock);

describe('session runs route', () => {
    beforeEach(() => {
        hydrateSessionSpy.mockClear();
        useSessionSpy.mockReset();
        useSessionSpy.mockReturnValue({
            id: 's1',
            metadata: null,
        });
        runListSpy.mockClear();
    });

    afterEach(() => {
        standardCleanup();
    });

    it('normalizes array session ids before hydrating and loading runs', async () => {
        const { default: RunsRoute } = await import('@/app/(app)/session/[id]/runs');

        await renderScreen(<RunsRoute />);

        expect(hydrateSessionSpy).toHaveBeenCalledWith('s1', 'SessionRunsScreen.hydrate');
        expect(useSessionSpy).toHaveBeenCalledWith('s1');
    });
});
