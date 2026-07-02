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
const onSessionVisibleSpy = vi.hoisted(() => vi.fn<(sessionId: string) => void>());
const detailsViewSpy = vi.hoisted(() => vi.fn<(props: any, ref?: any) => React.ReactElement>((props) => React.createElement('SessionMessageDetailsView', props)));
const useMessageSpy = vi.hoisted(() => vi.fn<(sessionId: string, messageId: string) => unknown>());
const useSessionSpy = vi.hoisted(() => vi.fn<(sessionId: string) => unknown>());
const useTranscriptIdsSpy = vi.hoisted(() => vi.fn<(sessionId: string) => unknown>());
const useResolvedRouteIdSpy = vi.hoisted(() => vi.fn<(sessionId: string, routeId: string) => string>());

const routerMock = createExpoRouterMock({
    params: { id: ['', 's1'], messageId: 'm1', jumpChildId: 'child-1' },
    router: {
        push: vi.fn(),
        back: vi.fn(),
        replace: vi.fn(),
        setParams: vi.fn(),
        canGoBack: () => false,
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

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

vi.mock('@/components/ui/forms/Deferred', () => ({
    Deferred: ({ children }: { children?: React.ReactNode }) => React.createElement(React.Fragment, null, children ?? null),
}));

vi.mock('@/hooks/session/useHydrateSessionForRoute', () => ({
    useHydrateSessionForRoute: (sessionId: string, reason: string) => hydrateSessionSpy(sessionId, reason),
}));

vi.mock('@/sync/sync', () => ({
    sync: {
        onSessionVisible: (sessionId: string) => onSessionVisibleSpy(sessionId),
        ensureSessionVisibleForMessageRoute: vi.fn(async (sessionId: string) => ({
            kind: 'available' as const,
            sessionId,
        })),
        loadOlderMessages: vi.fn(async () => ({ status: 'no_more' as const, hasMore: false, loaded: 0 })),
    },
}));

const storageMock = createStorageModuleStub({
    useMessage: (sessionId: string, messageId: string) => useMessageSpy(sessionId, messageId),
    useResolvedSessionMessageRouteId: (sessionId: string, routeId: string) => useResolvedRouteIdSpy(sessionId, routeId),
    useSession: (sessionId: string) => useSessionSpy(sessionId),
    useSessionTranscriptIds: (sessionId: string) => useTranscriptIdsSpy(sessionId),
});

vi.mock('@/sync/domains/state/storage', () => storageMock);

vi.mock('@/components/sessions/transcript/details/SessionMessageDetailsView', () => ({
    createSessionMessageDetailsStyles: () => ({ routeContent: {}, loadingContainer: {} }),
    SessionMessageDetailsView: (...args: [any, any?]) => detailsViewSpy(...args),
}));

describe('session message route', () => {
    beforeEach(() => {
        hydrateSessionSpy.mockClear();
        onSessionVisibleSpy.mockClear();
        detailsViewSpy.mockClear();
        useMessageSpy.mockReset();
        useSessionSpy.mockReset();
        useTranscriptIdsSpy.mockReset();
        useResolvedRouteIdSpy.mockReset();
        useMessageSpy.mockReturnValue({ id: 'm1', kind: 'text' });
        useSessionSpy.mockReturnValue({ id: 's1', metadata: null });
        useTranscriptIdsSpy.mockReturnValue({ isLoaded: true });
        useResolvedRouteIdSpy.mockImplementation((_sessionId: string, routeId: string) => routeId);
    });

    afterEach(() => {
        standardCleanup();
    });

    it('normalizes array session ids before hydrating and rendering message details', async () => {
        const { default: MessageRoute } = await import('@/app/(app)/session/[id]/message/[messageId]');

        await renderScreen(<MessageRoute />);

        expect(hydrateSessionSpy).toHaveBeenCalledWith('s1', 'MessageRoute.ensureSessionVisible');
        expect(onSessionVisibleSpy).toHaveBeenCalledWith('s1');
        expect(useSessionSpy).toHaveBeenCalledWith('s1');
        expect(useTranscriptIdsSpy).toHaveBeenCalledWith('s1');
        expect(useMessageSpy).toHaveBeenCalledWith('s1', 'm1');
        expect(detailsViewSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                sessionId: 's1',
                jumpChildId: 'child-1',
            }),
            undefined,
        );
    });
});
