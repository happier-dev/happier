// @vitest-environment jsdom
import * as React from 'react';
import 'fake-indexeddb/auto';
import { afterEach, expect, it, vi } from 'vitest';
import { act, renderScreen, standardCleanup } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { WorkspaceRefV1Schema } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import type { AppPaneScopeLayoutState } from './hooks/useAppPaneScopeLayout';

vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storageStore');
const { AppPaneScopeControls } = await import('./AppPaneScopeControls');
const { AppPaneScopeLayoutProvider } = await import('./hooks/useAppPaneScopeLayout');
const { PresentedDetailNavigationProvider, usePresentedDetailNavigation } = await import('../rightSidebar/usePresentedDetailNavigation');
const { resolveDetailNavigationItems } = await import('../rightSidebar/detailNavigationItems');
const { readProjectWidgetAreaContextV1 } = await import('@/sync/domains/widgets/projectWidgetAreaContext');
const { invokeScopeAction, readShellColumnActionOwner, subscribeShellColumnActionOwners } = await import('@/sync/ops/actions/scopeActionFamily');
const initial = storage.getState();
afterEach(async () => { await standardCleanup(); storage.setState(initial, true); });

it('keeps physical main arrangement, search and visibility when presented detail supplies navigation', async () => {
    const scope = { serverId: 'home', accountId: 'alice' };
    const checkout = WorkspaceRefV1Schema.parse({ id: 'checkout', projectKey: 'project', serverId: 'home',
        machineId: 'machine', rootPath: '/repo', createdAtMs: 1 });
    const projectContext = readProjectWidgetAreaContextV1({ serverId: scope.serverId, activeCheckout: checkout });
    const items = resolveDetailNavigationItems({ scope: 'environment' });
    let showDetail = (_shown: boolean) => {};
    function Detail(props: Readonly<{ shown: boolean }>) {
        usePresentedDetailNavigation({ pageKind: 'environment', identity: 'staging', scope, items, activeId: 'overview',
            phone: false, presented: props.shown, selectPage: () => {} });
        return null;
    }
    function Fixture() {
        const [shown, setShown] = React.useState(false);
        const [hidden, setHidden] = React.useState(false);
        showDetail = setShown;
        const layout: AppPaneScopeLayoutState = { arrangement: 'session', mainHidden: hidden, mainDrawerOpen: true,
            effectiveDetailsOpen: false, detailsAvailable: false, containerWidthPx: 1200, containerHeightPx: 900,
            mainRegionWidthPx: 800, mainRegionHeightPx: 900, multiPaneEnabled: true, deviceType: 'tablet',
            layout: { kind: 'twoPane', main: 'docked', right: 'docked', details: 'hidden' }, bottomPresentation: 'hidden' };
        return <AppPaneScopeLayoutProvider value={layout}><AppPaneScopeControls scopeId="project" focused
            descriptor={{ hideLabel: 'Hide Project', showLabel: 'Show Project', identity: { name: 'Project' } }}
            surfaceScope={{ targetKind: 'project', projectContext, projectionPhase: 'current', accountLifetime: {
                scope, isCurrent: () => true, onRetire: () => ({ dispose() {} }),
            } }} rightOpen detailsOpen={false} sideAvailable arrangementHonoured setHidden={setHidden}
            setSideVisible={() => {}} sideActions={{ current: null }}><Detail shown={shown} /></AppPaneScopeControls></AppPaneScopeLayoutProvider>;
    }
    const screen = await renderScreen(<PresentedDetailNavigationProvider><Fixture /></PresentedDetailNavigationProvider>);
    const physical = { arrangementAvailable: true,
        searchScope: { accountId: 'alice', serverId: 'home', machineId: 'machine', rootPath: '/repo', sessionId: null } };
    // The mounted title strip synchronously re-reads the registry when owner facts change.
    const unsubscribe = subscribeShellColumnActionOwners(() => { readShellColumnActionOwner('main'); });
    try {
        expect(readShellColumnActionOwner('main')).toMatchObject(physical);
        await act(async () => showDetail(true));
        expect(readShellColumnActionOwner('main')).toMatchObject({ ...physical, activeTab: 'overview',
            items: expect.arrayContaining([expect.objectContaining({ id: 'overview', pageKind: 'environment' })]),
            openNavigationCustomizer: expect.any(Function) });
        await act(async () => { expect(await invokeScopeAction('shell.column.set', { column: 'main', visible: false })).toEqual({ ok: true }); });
        expect(readShellColumnActionOwner('main')).toMatchObject({ ...physical, visible: false });
        await act(async () => showDetail(false));
        expect(readShellColumnActionOwner('main')).toMatchObject({ ...physical, visible: false });
        expect(readShellColumnActionOwner('main')?.items).toBeUndefined();
    } finally {
        unsubscribe();
        await screen.unmount();
    }
});
