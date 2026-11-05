import 'fake-indexeddb/auto';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import type { PaneBuiltinAdapter } from './types';

const viewport = vi.hoisted(() => ({ width: 1200, height: 900 }));
const route = vi.hoisted(() => ({ pathname: '/session/source' }));
// Native geometry and modal presentation are the only substituted UI boundaries.
vi.mock('react-native', async () => {
    const dimensions = () => ({ ...viewport, scale: 1, fontScale: 1 });
    return (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
        useWindowDimensions: dimensions,
        Dimensions: { get: dimensions, addEventListener: () => ({ remove() {} }) },
    });
});
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ renderCustomModals: true }).module);
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ pathname: () => route.pathname }).module);
installDisconnectedServerSocketBoundary();
const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
await loadSyncSingletonForTests();
const { Modal, ModalProvider } = await import('@/modal');
const { AppPaneProvider, useAppPaneContext } = await import('./AppPaneProvider');
const { AppPaneScopeHost } = await import('./AppPaneScopeHost');
const { useAppPaneScope } = await import('./hooks/useAppPaneScope');
const { createSessionBoardDetailsTab } = await import('@/components/sessions/panes/details/sessionDetailsTabBuilders');

afterEach(async () => {
    route.pathname = '/session/source';
    await act(async () => Modal.hideAll());
    await standardCleanup();
});

it.each(['desktop', 'phone'] as const)('retains Start across adapter updates on %s and dismisses its borrowed sheet after route navigation', async device => {
    viewport.width = device === 'phone' ? 390 : 1200;
    let pane!: ReturnType<typeof useAppPaneScope>;
    let startScope: string | null = null;
    let driverRegistryVersion = 0;
    let hasRegisteredDriver = false;
    let mounts = 0;
    let unmounts = 0;
    function Body({ label }: { label: string }) {
        const selection = useAppPaneScope('direct-start');
        React.useEffect(() => { mounts++; return () => { unmounts++; }; }, []);
        return <div data-start-body>{`${label}:${selection.scopeState?.details.activeTabKey}`}</div>;
    }
    function Observe() {
        pane = useAppPaneScope('direct-start');
        startScope = useAppPaneContext(value => value.detailsStartScopeId);
        driverRegistryVersion = useAppPaneContext(value => value.driverRegistryVersion);
        hasRegisteredDriver = useAppPaneContext(value => value.getDriver('direct-start') !== null);
        return null;
    }
    const adapter = (label: string): PaneBuiltinAdapter => ({
        destinationIds: ['details'], defaultDestinationId: 'details', render: () => <Body label={label} />,
    });
    // The App's modal root does not rerender when this route's adapter changes.
    const ModalHost = React.memo((_props: Readonly<{ pathname: string }>) => <ModalProvider>{null}</ModalProvider>);
    function Harness({ details }: { details?: PaneBuiltinAdapter }) {
        return <AppPaneProvider>
            <AppPaneScopeHost scopeId="direct-start" main={<Observe />} detailsPaneBuiltinAdapter={details} />
            <ModalHost pathname={route.pathname} />
        </AppPaneProvider>;
    }
    const screen = await renderScreen(<Harness details={adapter('Start')} />);
    const tab = createSessionBoardDetailsTab();
    await act(async () => pane.openDetailsTab(tab, { intent: 'pinned', start: true }));
    expect(screen.root.findAllByType(Body)).toHaveLength(1);
    expect(screen.getTextContent()).toContain(`Start:${tab.key}`);
    expect(startScope).toBe(device === 'phone' ? 'direct-start' : null);
    const mountedDriverRegistryVersion = driverRegistryVersion;
    await screen.update(<Harness details={adapter('Updated Start')} />);
    expect(driverRegistryVersion).toBe(mountedDriverRegistryVersion);
    expect(screen.getTextContent()).toContain(`Updated Start:${tab.key}`);
    expect({ mounts, unmounts }).toEqual({ mounts: 1, unmounts: 0 });
    route.pathname = '/session/source/template';
    await screen.update(<Harness details={adapter('Updated Start')} />);
    expect(screen.root.findAllByType(Body)).toHaveLength(device === 'phone' ? 0 : 1);
    await act(async () => pane.closeDetails());
    expect(screen.root.findAllByType(Body)).toHaveLength(0);
    expect(hasRegisteredDriver).toBe(true);
    await screen.update(<Harness />);
    expect(hasRegisteredDriver).toBe(false);
    await screen.unmount();
});

it('keeps simultaneous direct and registered adapter producers unresolved until the registered producer retires', async () => {
    viewport.width = 1200;
    let pane!: ReturnType<typeof useAppPaneScope>;
    let retireExternal!: () => void;
    const direct: PaneBuiltinAdapter = { destinationIds: ['details'], defaultDestinationId: 'details',
        render: () => <div>{'Direct Start'}</div> };
    const external: PaneBuiltinAdapter = { destinationIds: ['details'], defaultDestinationId: 'details',
        render: () => <div>{'External Start'}</div> };
    function Main() {
        pane = useAppPaneScope('conflicting-start');
        const register = useAppPaneContext(value => value.registerDriver);
        const [enabled, setEnabled] = React.useState(true);
        retireExternal = () => setEnabled(false);
        React.useEffect(() => enabled ? register({ scopeId: 'conflicting-start', detailsPaneBuiltinAdapter: external })
            : undefined, [enabled, register]);
        return null;
    }
    const screen = await renderScreen(<AppPaneProvider>
        <AppPaneScopeHost scopeId="conflicting-start" main={<Main />} detailsPaneBuiltinAdapter={direct} />
        <ModalProvider>{null}</ModalProvider>
    </AppPaneProvider>);
    await act(async () => pane.openDetailsTab(createSessionBoardDetailsTab(), { intent: 'pinned', start: true }));
    expect(screen.getTextContent()).not.toContain('Direct Start');
    expect(screen.getTextContent()).not.toContain('External Start');
    await act(async () => retireExternal());
    expect(screen.getTextContent()).toContain('Direct Start');
    await screen.unmount();
});

it.each([false, true])('a contextual Start replaces Info while an ordinary Details open retains it (start=%s)', async start => {
    viewport.width = 1200;
    let pane!: ReturnType<typeof useAppPaneScope>;
    function Main() { pane = useAppPaneScope('info-start'); return <>{'Chat'}</>; }
    const screen = await renderScreen(<AppPaneProvider>
        <AppPaneScopeHost scopeId="info-start" main={<Main />}
            rightPaneBuiltinAdapter={{ destinationIds: ['info'], render: () => <>{'Session Info'}</> }}
            detailsPaneBuiltinAdapter={{ destinationIds: ['details'], defaultDestinationId: 'details', render: () => <>{'Editor'}</> }} />
        <ModalProvider>{null}</ModalProvider>
    </AppPaneProvider>);
    try {
        await act(async () => pane.openRight({ tabId: 'info' }));
        expect(pane.scopeState?.right.isOpen).toBe(true);
        await act(async () => pane.openDetailsTab(createSessionBoardDetailsTab(), { intent: 'pinned', start }));
        expect(pane.scopeState?.details.isOpen).toBe(true);
        expect(pane.scopeState?.right.isOpen).toBe(!start);
        expect(screen.getTextContent()).toContain('Chat');
        expect(screen.getTextContent()).toContain(start ? 'Editor' : 'Session Info');
    } finally { await screen.unmount(); }
});
