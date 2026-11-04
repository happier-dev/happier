import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { act, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { storage } from '@/sync/domains/state/storageStore';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { setActiveServerId } from '@/sync/domains/server/serverProfiles';
import { publishAppliedActiveServerRuntimeAvailability, publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { buildOrdinarySessionListHomeState } from '@/sync/domains/session/listing/ordinarySessionListHomeState';
import { resolveSessionListQueryPresentation } from '@/sync/domains/session/listing/sessionListIndexPresentation';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () =>
    (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () =>
    (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () =>
    (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('expo-router', async () =>
    (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@/modal', async () =>
    (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);

vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
await loadSyncSingletonForTests();
const initialStorageState = storage.getState();
let appliedHomeId = '';

function setHealth(kind: 'connecting' | 'server_unreachable' | 'server_error') {
    storage.setState({ endpointStatus: kind === 'server_unreachable' ? 'offline' : kind === 'connecting' ? 'connecting' : 'online',
        socketStatus: kind === 'server_error' ? 'error' : 'disconnected', endpointReason: null, syncError: null });
}

describe('HomeReachabilityGate', () => {
    beforeEach(async () => {
        await homes.reset();
        appliedHomeId = await homes.addHome({ name: 'Studio', serverUrl: 'https://studio.example.test', accountId: 'gate-account' });
        const stagedHomeId = await homes.addHome({ name: 'Elsewhere', serverUrl: 'https://elsewhere.example.test', accountId: 'staged-account', active: false });
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        await setActiveServerId(stagedHomeId);
        publishAppliedActiveServerRuntimeAvailability(true);
        storage.setState({ machineListStatusByServerId: { [appliedHomeId]: 'idle' } });
        setHealth('connecting');
    });
    afterEach(async () => {
        standardCleanup();
        await homes.reset();
        publishAppliedActiveServerRuntimeAvailability(false);
        storage.setState(initialStorageState, true);
    });

    it('keeps the quiet loading state while the Home is still connecting', async () => {
        const { HomeReachabilityGate } = await import('./HomeReachabilityGate');
        const screen = await renderScreen(
            <HomeReachabilityGate variant="pane">{React.createElement('QuietLoading')}</HomeReachabilityGate>,
        );
        expect(screen.findAllByType('QuietLoading' as never)).toHaveLength(1);
        expect(screen.findAllByTestId('home-unreachable')).toHaveLength(0);
    });

    it('exposes list Retry after Home recovery and does not wake for Machine detail changes', async () => {
        const { useSettlingHomeServerId } = await import('./HomeReachabilityGate');
        const hook = await renderHook(useSettlingHomeServerId);
        const failed = buildOrdinarySessionListHomeState({ serverId: appliedHomeId, requestedQueryKey: 'ordinary', sessionIds: [],
            observation: { phase: 'error', lastSuccessAt: null }, online: true,
            lifecycle: { serverId: appliedHomeId, hasFetchedSnapshot: false, fetchInFlight: false, fetchMoreInFlight: false,
                frontier: { nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false } },
        });
        const presentation = () => resolveSessionListQueryPresentation({ selectedServerIds: [appliedHomeId],
            statesByServerId: { [appliedHomeId]: failed }, coverageComplete: false, retainedRowCount: 0,
            settlingHomeServerId: hook.getCurrent(),
        });
        expect(presentation()).toEqual({ kind: 'initial_loading' });
        await act(async () => { storage.setState({ endpointStatus: 'online', socketStatus: 'connected' }); });
        expect(hook.getCurrent()).toBeNull();
        expect(presentation()).toEqual({ kind: 'error', retainedRows: false });
        let publications = 0;
        const unsubscribe = hook.subscribe(() => { publications += 1; });
        await act(async () => {
            for (let index = 0; index < 100; index += 1) storage.setState({ machineListByServerId: {} });
        });
        expect(publications).toBe(0);
        // Miswiring the admitted census back to pending must re-enter settlement.
        await act(async () => { storage.setState({ machineListStatusByServerId: { [appliedHomeId]: 'loading' } }); });
        expect(hook.getCurrent()).toBe(appliedHomeId);
        await act(async () => { storage.setState({ machineListStatusByServerId: {} }); });
        expect(hook.getCurrent()).toBe(appliedHomeId);
        await act(async () => { storage.setState({ endpointStatus: 'connecting', endpointReason: 'server_restarting', socketStatus: 'disconnected' }); });
        expect(hook.getCurrent()).toBe(appliedHomeId);
        unsubscribe();
    });

    it.each(['server_unreachable', 'server_error'] as const)('says the Home cannot be reached, by name, with Retry (%s)', async (kind) => {
        setHealth(kind);
        const { HomeReachabilityGate } = await import('./HomeReachabilityGate');
        const screen = await renderScreen(
            <HomeReachabilityGate variant="pane">{React.createElement('QuietLoading')}</HomeReachabilityGate>,
        );

        expect(screen.findAllByType('QuietLoading' as never)).toHaveLength(0);
        expect(screen.findAllByTestId('home-unreachable').length).toBeGreaterThan(0);
        // The Home whose health is reported, not the one being switched to.
        expect(screen.getTextContent()).toContain('Studio');
        expect(screen.getTextContent()).not.toContain('Elsewhere');
        expect(screen.findAllByTestId('home-unreachable-retry').length).toBeGreaterThan(0);
    });

    it('offers the same Retry as a quiet line in a list', async () => {
        setHealth('server_unreachable');
        const { HomeReachabilityGate } = await import('./HomeReachabilityGate');
        const screen = await renderScreen(
            <HomeReachabilityGate variant="line">{React.createElement('SkeletonRows')}</HomeReachabilityGate>,
        );

        expect(screen.findAllByType('SkeletonRows' as never)).toHaveLength(0);
        expect(screen.findAllByTestId('home-unreachable-retry').length).toBeGreaterThan(0);
    });

    it('draws the line as the shared freshness line beside a page that keeps its own content', async () => {
        setHealth('server_unreachable');
        const { HomeReachabilityGate } = await import('./HomeReachabilityGate');
        const { SurfaceFreshnessLine } = await import('@/components/ui/surfaces/SurfaceFreshnessLine');
        const screen = await renderScreen(<HomeReachabilityGate variant="line">{null}</HomeReachabilityGate>);

        expect(screen.findAllByType(SurfaceFreshnessLine as never)).toHaveLength(1);
        expect(screen.findAllByTestId('home-unreachable-retry').length).toBeGreaterThan(0);
        await act(async () => { storage.setState({ endpointStatus: 'online', socketStatus: 'connected' }); });
        expect(screen.findAllByType(SurfaceFreshnessLine as never)).toHaveLength(0);
    });

    it('does not report the active Home for a list scoped only to another Home', async () => {
        setHealth('server_unreachable');
        const { HomeReachabilityGate } = await import('./HomeReachabilityGate');
        const screen = await renderScreen(
            <HomeReachabilityGate variant="line" relevantServerIds={['srv_other']}>
                {React.createElement('OtherHomeRows')}
            </HomeReachabilityGate>,
        );

        expect(screen.findAllByType('OtherHomeRows' as never)).toHaveLength(1);
        expect(screen.findAllByTestId('home-unreachable')).toHaveLength(0);
    });
});
