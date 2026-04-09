import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';
import { createDeferred } from '@/dev/testkit';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { installSessionRouteCommonModuleMocks } from './sessionRouteTestHelpers';
import { storage } from '@/sync/domains/state/storageStore';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let mockSessionId = 'session-1';
const hydrationReadyState = vi.hoisted(() => ({ current: true }));

const hydrateSpy = vi.hoisted(() => vi.fn((_sessionId: string, _tag: string) => true));
const serverRuntimeState = vi.hoisted(() => ({
    generation: 0,
    listener: null as null | ((snapshot: { serverId: string; serverUrl: string; generation: number }) => void),
}));

installSessionRouteCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: 'View',
            ActivityIndicator: 'ActivityIndicator',
            Platform: {
                OS: 'web',
            },
        });
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        const routerMock = createExpoRouterMock({
            params: {
                id: mockSessionId,
            },
        });
        return {
            ...routerMock.module,
            useLocalSearchParams: () => ({ id: mockSessionId }),
        };
    },
});

vi.mock('@/components/sessions/shell/SessionView', () => ({
    SessionView: (props: any) => React.createElement('SessionView', props),
}));

vi.mock('@/components/sessions/panes/url/sessionPaneUrlState', () => ({
    parseSessionPaneUrlState: () => null,
}));

vi.mock('@/hooks/session/useHydrateSessionForRoute', () => ({
    useHydrateSessionForRoute: (sessionId: string, tag: string) => {
        hydrateSpy(sessionId, tag);
        return hydrationReadyState.current;
    },
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => ({
        serverId: 'srv',
        serverUrl: 'http://example.test',
        generation: serverRuntimeState.generation,
    }),
    subscribeActiveServer: (listener: (snapshot: { serverId: string; serverUrl: string; generation: number }) => void) => {
        serverRuntimeState.listener = listener;
        return () => {
            if (serverRuntimeState.listener === listener) {
                serverRuntimeState.listener = null;
            }
        };
    },
}));

describe('/session/[id] hydration (active server generation)', () => {
    let SessionRouteScreen: React.ComponentType<any>;

    beforeAll(async () => {
        SessionRouteScreen = (await import('@/app/(app)/session/[id]')).default;
    }, 60_000);

    beforeEach(() => {
        mockSessionId = 'session-1';
        hydrationReadyState.current = true;
        hydrateSpy.mockClear();
        serverRuntimeState.generation = 0;
        serverRuntimeState.listener = null;
    });

    afterEach(() => {
        standardCleanup();
        vi.resetModules();
    });

    it('restarts deep-link hydration when the active server generation changes', async () => {
        await renderScreen(<SessionRouteScreen />);

        expect(serverRuntimeState.listener).not.toBeNull();
        expect(hydrateSpy).toHaveBeenCalledWith(
            'session-1',
            expect.stringContaining('gen=0'),
        );

        await act(async () => {
            serverRuntimeState.generation = 1;
            serverRuntimeState.listener?.({ serverId: 'srv', serverUrl: 'http://example.test', generation: 1 });
        });

        const lastTag = hydrateSpy.mock.calls.at(-1)?.[1] ?? '';
        expect(lastTag).toContain('gen=1');
    });

    it('waits for route hydration before mounting the session view', async () => {
        hydrationReadyState.current = false;

        const screen = await renderScreen(<SessionRouteScreen />);

        expect(screen.findAllByType('SessionView')).toHaveLength(0);
        expect(screen.findAllByType('ActivityIndicator')).toHaveLength(1);
    });

    it('mounts the session view immediately when the session is already cached locally', async () => {
        const previousState = storage.getState();
        try {
            storage.setState((state) => ({
                ...state,
                sessions: {
                    ...state.sessions,
                    'session-1': createSessionFixture({ id: 'session-1' }),
                },
            }));
            hydrationReadyState.current = false;

            const screen = await renderScreen(<SessionRouteScreen />);

            expect(screen.findAllByType('SessionView')).toHaveLength(1);
            expect(screen.findAllByType('ActivityIndicator')).toHaveLength(0);
        } finally {
            storage.setState(previousState);
        }
    });
});
