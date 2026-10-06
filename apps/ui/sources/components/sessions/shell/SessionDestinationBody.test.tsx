import * as React from 'react';
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { installShippedNativeFrameScheduler } from '@/dev/testkit/legend/shippedNativeLegendRuntime';
import { DestinationInstanceHost } from '@/components/appShell/workspace/DestinationInstanceHost';
import { storage } from '@/sync/domains/state/storageStore';
import { resetSessionSurfaceVisibilityForTests, getSessionSurfaceVisibilitySnapshot } from '@/sync/domains/session/sessionSurfaceVisibility';
import { SessionDestinationBody } from './SessionDestinationBody';
import { SessionView } from './SessionView';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import '@/sync/syncEngine';
import { prepareSessionDraftPersistenceStorage } from '@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage';

installDisconnectedServerSocketBoundary();

// Native SDK/navigation boundaries only; Session, hydration, pane and activation owners stay real.
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { OS: 'web' }, useWindowDimensions: () => ({ width: 1400, height: 900 }) });
});
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ pathname: '/session/focused' }).module;
});
vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    useSafeAreaFrame: () => ({ x: 0, y: 0, width: 1400, height: 900 }),
}));

afterEach(standardCleanup);
const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'account-shell' })).toString('base64url')}.signature` };

async function withSessionFixture(run: (serverId: string) => Promise<void>) {
    await prepareSessionDraftPersistenceStorage();
    const previousState = storage.getState();
    // Bind the real Account/Sync lifecycle while the canonical HTTP and Socket
    // adapters own an unavailable fixture Home. No hydration or admission owner is mocked.
    const account = await restoreServerAccountForTest({
        serverUrl: 'https://shell-test.example', credentials,
        request: async () => Response.json({ error: 'fixture_home_offline' }, { status: 503 }),
    });
    const serverId = account.home.id;
    const frameGlobals = ['requestAnimationFrame', 'cancelAnimationFrame'] as const;
    const previousFrameGlobals = frameGlobals.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
    resetSessionSurfaceVisibilityForTests();
    storage.getState().applySessions(['focused', 'companion'].map((id) => createSessionFixture({ id, serverId })));
    storage.setState({ settings: { ...storage.getState().settings, mobileWorkspaceExperienceV1: 'classic' } });
    storage.setState({ settingsScope: { serverId, accountId: 'account-shell' }, profileScope: { serverId, accountId: 'account-shell' } });
    try {
        installShippedNativeFrameScheduler();
        await run(serverId);
    } finally {
        try {
            await standardCleanup();
        } finally {
            await account.dispose();
            storage.setState(previousState);
            resetSessionSurfaceVisibilityForTests();
            for (const [key, descriptor] of previousFrameGlobals) {
                if (descriptor) Object.defineProperty(globalThis, key, descriptor);
                else Reflect.deleteProperty(globalThis, key);
            }
        }
    }
}

describe('SessionDestinationBody workspace activation', () => {
    it('presents both visible panes while only the focused pane owns the route anchor across retention', async () => {
        await withSessionFixture(async (serverId) => {
            const body = (companionVisible: boolean, focusedId = 'focused') => <InjectedAuthProvider credentials={credentials}><AppPaneProvider>
                {['focused', 'companion'].map((id) => <DestinationInstanceHost key={id} tabId={id}
                    ref={{ kind: 'session', params: { id, serverId } }} pathname={`/session/${id}`}
                    focused={id === focusedId} visible={id === 'focused' || companionVisible}
                    navigation={{ push: () => {}, replace: () => {}, back: () => {} }}>
                    <SessionDestinationBody />
                </DestinationInstanceHost>)}
            </AppPaneProvider></InjectedAuthProvider>;
            const screen = await renderScreen(body(true));
            expect(getSessionSurfaceVisibilitySnapshot()).toMatchObject({
                focusedSessionId: 'focused', routeAnchorSessionId: 'focused', visibleSessionIds: ['focused', 'companion'],
            });
            const companionSurface = screen.findHostByTestId('session-view-retained-surface:companion');
            expect(companionSurface?.props.pointerEvents).toBe('auto');
            expect(companionSurface?.props['aria-hidden']).toBe(false);
            await screen.update(body(false));
            expect(getSessionSurfaceVisibilitySnapshot()).toMatchObject({
                focusedSessionId: 'focused', routeAnchorSessionId: 'focused', visibleSessionIds: ['focused'],
            });
            expect(screen.findHostByTestId('session-view-retained-surface:companion')).toBe(companionSurface);
            expect(companionSurface?.props.pointerEvents).toBe('none');
            expect(companionSurface?.props['aria-hidden']).toBe(true);
            await screen.update(body(true));
            expect(getSessionSurfaceVisibilitySnapshot()).toMatchObject({
                focusedSessionId: 'focused', routeAnchorSessionId: 'focused', visibleSessionIds: ['focused', 'companion'],
            });
            expect(screen.findHostByTestId('session-view-retained-surface:companion')).toBe(companionSurface);
            expect(companionSurface?.props.pointerEvents).toBe('auto');
            await screen.update(body(true, 'companion'));
            expect(getSessionSurfaceVisibilitySnapshot()).toMatchObject({
                focusedSessionId: 'companion', routeAnchorSessionId: 'companion', visibleSessionIds: ['focused', 'companion'],
            });
            expect(screen.findHostByTestId('session-view-retained-surface:focused')?.props.pointerEvents).toBe('auto');
            await screen.update(body(false, 'companion'));
            expect(getSessionSurfaceVisibilitySnapshot()).toMatchObject({
                focusedSessionId: null, routeAnchorSessionId: null, visibleSessionIds: ['focused'],
            });
            expect(screen.findHostByTestId('session-view-retained-surface:focused')?.props.pointerEvents).toBe('auto');
        });
    });

    it('keeps the ordinary route presented before global data readiness without a host override', async () => {
        await withSessionFixture(async (serverId) => {
            storage.setState({ isDataReady: false });
            const screen = await renderScreen(<InjectedAuthProvider credentials={credentials}><AppPaneProvider>
                <SessionView id="focused" routeServerId={serverId} />
            </AppPaneProvider></InjectedAuthProvider>);
            expect(screen.findHostByTestId('session-view-retained-surface:focused')?.props).toMatchObject({
                pointerEvents: 'auto', 'aria-hidden': false, inert: false,
            });
            expect(getSessionSurfaceVisibilitySnapshot()).toMatchObject({
                focusedSessionId: 'focused', routeAnchorSessionId: 'focused', visibleSessionIds: ['focused'],
            });
        });
    });
});
