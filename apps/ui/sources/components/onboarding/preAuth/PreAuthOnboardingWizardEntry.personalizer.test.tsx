import * as React from 'react';
import 'fake-indexeddb/auto';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup, flushHookEffects, createRootLayoutFeaturesResponse } from '@/dev/testkit';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { storage } from '@/sync/domains/state/storageStore';
import { getActiveServerId, removeServerProfile, setActiveServerId } from '@/sync/domains/server/serverProfiles';
import { primeServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createHomeHubArtifactHttpBoundary } from '@/dev/testkit/harness/homeHubArtifactHttpBoundary';
import { WorkspaceNavigationContext, type WorkspaceNavigationContextValue } from '@/components/appShell/workspace/WorkspaceNavigationContext';
import { createWorkspaceState } from '@/components/appShell/workspace/workspaceState';
import { endOnboardingJourneySession } from '@/components/onboarding/tour/state/journeySession';

installDisconnectedServerSocketBoundary();
const state = vi.hoisted(() => ({ width: 390, push: vi.fn(), replace: vi.fn(), show: vi.fn(() => 'personalize-modal') }));
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ useWindowDimensions: () => ({ width: state.width, height: 844, scale: 1, fontScale: 1 }) });
});
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ router: { push: state.push, replace: state.replace } }).module);
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ spies: { show: state.show } }).module);
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());

const initialStorageState = storage.getState();
const initialServerId = getActiveServerId();
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
let caseNumber = 0;
beforeEach(async () => {
    await loadSyncSingletonForTests();
    vi.stubEnv('EXPO_PUBLIC_DEBUG', '1');
    state.width = 390;
    state.push.mockClear(); state.replace.mockClear(); state.show.mockClear();
    const serverUrl = `https://personalizer-${++caseNumber}.example.test`;
    const features = createRootLayoutFeaturesResponse();
    const http = createHomeHubArtifactHttpBoundary('personalizer-account');
    connection = await restoreServerAccountForTest({ serverUrl, accountId: 'personalizer-account', request: (url, init) => {
        const path = new URL(String(url)).pathname;
        return path === '/v1/features' || path === '/v1/features/authenticated' ? Promise.resolve(Response.json(features)) : http.request(url, init);
    } });
    primeServerFeaturesSnapshot({ serverId: connection.home.id, snapshot: { status: 'ready', features } });
    storage.getState().applyLocalSettings({ hasCompletedAuthOnce: true });
});
afterEach(async () => {
    standardCleanup();
    endOnboardingJourneySession();
    const homeId = connection?.home.id;
    await connection?.dispose(); connection = undefined;
    await setActiveServerId(initialServerId);
    if (homeId) await removeServerProfile(homeId);
    storage.setState(initialStorageState, true);
    vi.unstubAllGlobals(); vi.unstubAllEnvs();
});

function OwnerShell({ children }: React.PropsWithChildren) {
    if (!connection) throw new Error('Expected the real Home Account fixture');
    const workspace: WorkspaceNavigationContextValue = {
        active: true, state: createWorkspaceState({ id: 'home', target: { kind: 'home', params: {} }, pinned: false, preview: true }),
        phone: state.width === 390 ? { catalog: [], onTab: true, openHref: () => true, activateTab: () => {}, closeTab: () => {} } : null,
        canGoBack: false, canGoForward: false, openHref: () => true, activateTab: () => {}, closeTab: () => {}, closeTabs: () => {}, dispatch: () => {},
        navigationForTab: () => { throw new Error('Unexpected tab navigation'); }, registerBackStep: () => () => {}, back: () => {}, forward: () => {},
    };
    return <InjectedAuthProvider credentials={connection.credentials}><WorkspaceNavigationContext.Provider value={workspace}>{children}</WorkspaceNavigationContext.Provider></InjectedAuthProvider>;
}

async function completeJourney() {
    vi.stubGlobal('window', { location: { href: 'https://app.example.test/?happier_journey_beat=A13', search: '?happier_journey_beat=A13' } });
    vi.stubGlobal('navigator', state.width === 390 ? { userAgent: 'iPhone', maxTouchPoints: 1 } : { userAgent: 'X11', maxTouchPoints: 0 });
    const { PreAuthOnboardingWizardEntry } = await import('./PreAuthOnboardingWizardEntry');
    const screen = await renderScreen(<OwnerShell><PreAuthOnboardingWizardEntry /></OwnerShell>);
    await flushHookEffects({ cycles: 3, turns: 3 });
    const { OnboardingJourneyHost } = await import('@/components/onboarding/tour/OnboardingJourneyHost');
    const host = screen.tree.root.findByType(OnboardingJourneyHost);
    expect(host.props.onExit).toBeTypeOf('function');
    await act(async () => { host.props.onExit({ completedBeatId: 'S5' }); });
    await flushHookEffects({ cycles: 3, turns: 3 });
}

describe('PreAuth onboarding completion Personalize handoff', () => {
    it.each([390, 1280])('hands the consumed authenticated Done exit to the Personalize owner at width %s', async (width) => {
        state.width = width;
        await completeJourney();
        if (width === 390) {
            expect(state.show).toHaveBeenCalledWith(expect.objectContaining({ chrome: expect.objectContaining({ testID: 'personalize-sheet.modal', phonePresentation: 'sheet' }) }));
            expect(state.push).not.toHaveBeenCalled();
        } else {
            expect(state.push).toHaveBeenCalledWith('/personalize');
            expect(state.show).not.toHaveBeenCalled();
        }
    });
    it('retires the consumed replay URL before opening the phone Personalize sheet', async () => {
        await completeJourney();
        expect(state.replace).toHaveBeenCalledWith('/');
        expect(state.show).toHaveBeenCalledOnce();
        expect(state.replace.mock.invocationCallOrder[0]).toBeLessThan(state.show.mock.invocationCallOrder[0]);
    });
});
