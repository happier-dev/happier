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
const useSessionSpy = vi.hoisted(() => vi.fn());
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
        ActivityIndicator: 'ActivityIndicator',
        Platform: { OS: 'web', select: (spec: Record<string, unknown>) => spec.web ?? spec.default },
    });
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: (props: any) => React.createElement('Ionicons', props),
}));

vi.mock('expo-crypto', () => ({
    getRandomBytes: () => new Uint8Array(12),
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

const storageMock = createStorageModuleStub({
    useSession: (sessionId: string) => useSessionSpy(sessionId),
    useIsDataReady: () => true,
});

vi.mock('@/sync/domains/state/storage', () => storageMock);

describe('session sharing route', () => {
    beforeEach(() => {
        hydrateSessionSpy.mockClear();
        useSessionSpy.mockReset();
        useSessionSpy.mockReturnValue({
            id: 's1',
            accessLevel: 'viewer',
            encryptionMode: 'plain',
            canApprovePermissions: false,
            metadata: null,
        });
    });

    afterEach(() => {
        standardCleanup();
    });

    it('normalizes array session ids before hydrating and reading session state', async () => {
        const { default: SharingRoute } = await import('@/app/(app)/session/[id]/sharing');

        await renderScreen(<SharingRoute />);

        expect(hydrateSessionSpy).toHaveBeenCalledWith('s1', 'SessionSharingRoute.ensureSessionVisible');
        expect(useSessionSpy).toHaveBeenCalledWith('s1');
    });
});
