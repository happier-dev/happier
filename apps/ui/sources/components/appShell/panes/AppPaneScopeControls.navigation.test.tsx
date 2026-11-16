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
        return <AppPaneScopeLayoutProvider value={layout}><AppPaneScopeControls scopeId="project"
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

// Switching Sessions remounts the pane scope and its detail page under the one long-lived chrome provider.
// The new controls render while the previous page's model is still the chrome value; nothing they keep may
// hold that model, or each page's main-column controls pin the previous page (and its whole view) in a chain.
it('releases previous detail pages across remounts under one chrome provider', async () => {
    const { setFlagsFromString } = await import('node:v8');
    const { runInNewContext } = await import('node:vm');
    setFlagsFromString('--expose-gc');
    const collectGarbage = runInNewContext('gc') as () => void;
    const { usePaneMainColumn } = await import('./mainColumn/usePaneMainColumn');
    const scope = { serverId: 'home', accountId: 'alice' };
    const items = resolveDetailNavigationItems({ scope: 'environment' });
    const pages: WeakRef<object>[] = [];
    function Detail(props: Readonly<{ page: object }>) {
        const mainControls = React.useRef(usePaneMainColumn());
        mainControls.current = usePaneMainColumn();
        usePresentedDetailNavigation({ pageKind: 'environment', identity: 'staging', scope, items, activeId: 'overview',
            phone: false, presented: true, mainControls, selectPage: () => { void props.page; } });
        return null;
    }
    function Page(props: Readonly<{ index: number }>) {
        const [page] = React.useState(() => { const value = { index: props.index }; pages.push(new WeakRef(value)); return value; });
        const layout: AppPaneScopeLayoutState = { arrangement: 'session', mainHidden: false, mainDrawerOpen: true,
            effectiveDetailsOpen: false, detailsAvailable: false, containerWidthPx: 1200, containerHeightPx: 900,
            mainRegionWidthPx: 800, mainRegionHeightPx: 900, multiPaneEnabled: true, deviceType: 'tablet',
            layout: { kind: 'twoPane', main: 'docked', right: 'docked', details: 'hidden' }, bottomPresentation: 'hidden' };
        return <AppPaneScopeLayoutProvider value={layout}><AppPaneScopeControls scopeId={`session-${props.index}`}
            descriptor={{ hideLabel: 'Hide', showLabel: 'Show', identity: { name: 'Session' } }}
            rightOpen detailsOpen={false} sideAvailable arrangementHonoured setHidden={() => {}}
            setSideVisible={() => {}} sideActions={{ current: null }}><Detail page={page} /></AppPaneScopeControls></AppPaneScopeLayoutProvider>;
    }
    let show = (_index: number) => {};
    let rerender = () => {};
    function Fixture() {
        const [index, setIndex] = React.useState(0);
        const [, setTick] = React.useState(0);
        show = setIndex;
        rerender = () => setTick((tick) => tick + 1);
        return <Page key={index} index={index} />;
    }
    const screen = await renderScreen(<PresentedDetailNavigationProvider><Fixture /></PresentedDetailNavigationProvider>);
    try {
        const switches = 6;
        for (let index = 1; index <= switches; index += 1) await act(async () => show(index));
        // The last removed page stays referenced until the next commit (observed); a later render releases it.
        await act(async () => rerender());
        for (let pass = 0; pass < 3; pass += 1) {
            await new Promise((resolve) => setTimeout(resolve, 0));
            collectGarbage();
        }
        expect(pages).toHaveLength(switches + 1);
        // Only the mounted page stays reachable.
        expect(pages.slice(0, -1).filter((page) => page.deref() !== undefined)).toHaveLength(0);
        expect(pages.at(-1)?.deref()).toBeDefined();
    } finally {
        await screen.unmount();
    }
});
