import * as React from 'react';
import 'fake-indexeddb/auto';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
import { renderScreen, standardCleanup, flushHookEffects, createRootLayoutFeaturesResponse } from '@/dev/testkit';
import { selectActiveTestHomeForTests } from '@/dev/testkit/fixtures/persistedHomeProfiles';
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
const state = vi.hoisted(() => ({ width: 390, push: vi.fn(), replace: vi.fn(), openHref: vi.fn((_href: string, _options?: unknown) => true), show: vi.fn(() => 'personalize-modal') }));
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ useWindowDimensions: () => ({ width: state.width, height: 844, scale: 1, fontScale: 1 }) });
});
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ router: { push: state.push, replace: state.replace } }).module);
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ spies: { show: state.show } }).module);
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
// The tour is paused by local policy (featureLocalPolicy); this suite pins the completion handoff the retained
// journey host performs, so only that one decision is enabled and every other feature resolves for real.
vi.mock('@/hooks/server/useFeatureDecision', async (importOriginal) => {
    const original = await importOriginal<typeof import('@/hooks/server/useFeatureDecision')>();
    return {
        ...original,
        useFeatureDecision: ((featureId, scope) => featureId === 'app.ui.onboardingTour'
            ? { featureId, state: 'enabled', blockedBy: null, blockerCode: 'none', diagnostics: [], evaluatedAt: 0, scope: {
                scopeKind: scope?.scopeKind ?? 'main_selection',
                ...(scope?.scopeKind === 'spawn' && scope.serverId ? { serverId: scope.serverId } : {}),
            } }
            : original.useFeatureDecision(featureId, scope)) satisfies typeof original.useFeatureDecision,
    };
});

const initialStorageState = storage.getState();
let initialServerId: string;
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
let caseNumber = 0;
beforeEach(async () => {
    await selectActiveTestHomeForTests();
    initialServerId = getActiveServerId();
    await loadSyncSingletonForTests();
    vi.stubEnv('EXPO_PUBLIC_DEBUG', '1');
    state.width = 390;
    state.push.mockClear(); state.replace.mockClear(); state.openHref.mockClear(); state.show.mockClear();
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
        canGoBack: false, canGoForward: false, openHref: state.openHref, activateTab: () => {}, closeTab: () => {}, closeTabs: () => {}, dispatch: () => {},
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
    // The Journey host is a lazily imported surface; wait for that import to mount it.
    await vi.waitFor(() => { expect(screen.tree.root.findAllByType(OnboardingJourneyHost)).toHaveLength(1); }, { timeout: 15_000 });
    const host = screen.tree.root.findByType(OnboardingJourneyHost);
    expect(host.props.onExit).toBeTypeOf('function');
    const onExit = host.props.onExit;
    if (!onExit) throw new Error('Expected the journey completion callback');
    await act(async () => { onExit({ completedBeatId: 'S5' }); });
    await flushHookEffects({ cycles: 3, turns: 3 });
}

describe('PreAuth onboarding completion Personalize handoff', () => {
    it.each([390, 1280])('hands the consumed authenticated Done exit to the Personalize owner at width %s', async (width) => {
        state.width = width;
        await completeJourney();
        if (width === 390) {
            expect(state.show).toHaveBeenCalledWith(expect.objectContaining({ chrome: expect.objectContaining({ testID: 'personalize-sheet.modal', phonePresentation: 'sheet' }) }));
            expect(state.openHref).not.toHaveBeenCalled();
            expect(state.push).not.toHaveBeenCalled();
        } else {
            // On a computer Personalize is a workspace destination, opened through the workspace navigation owner.
            expect(state.openHref).toHaveBeenCalledWith('/personalize');
            expect(state.push).not.toHaveBeenCalled();
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
