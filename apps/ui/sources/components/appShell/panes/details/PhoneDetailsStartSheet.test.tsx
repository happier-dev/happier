import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import type { AppPaneContextValue } from '../AppPaneContext';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
    Dimensions: { get: () => ({ width: 390, height: 844, scale: 1, fontScale: 1 }), addEventListener: () => ({ remove() {} }) },
}));
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ renderCustomModals: true }).module);
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);

const { Modal, ModalProvider } = await import('@/modal');
const { AppPaneProvider, useAppPaneContext } = await import('../AppPaneProvider');
const { useAppPaneScope, useOptionalDetailsRegionTabOpener } = await import('../hooks/useAppPaneScope');
const { PanePresentationProvider } = await import('../panePresentation');
const { createSessionBoardDetailsTab } = await import('@/components/sessions/panes/details/sessionDetailsTabBuilders');
type Pane = ReturnType<typeof useAppPaneScope>;

afterEach(async () => { await act(async () => Modal.hideAll()); await standardCleanup(); });

it('admits Start into the shared scope before a Details renderer mounts while ordinary opens require a held scope', async () => {
    const scopeId = 'session:held-start-renderer';
    let pane!: Pane;
    let open!: NonNullable<ReturnType<typeof useOptionalDetailsRegionTabOpener>>;
    let register!: AppPaneContextValue['registerDriver'];
    function Scope() {
        pane = useAppPaneScope(scopeId);
        open = useOptionalDetailsRegionTabOpener()!;
        register = useAppPaneContext(value => value.registerDriver);
        return null;
    }
    const screen = await renderScreen(<AppPaneProvider>
        <PanePresentationProvider value={intent => intent.pane === 'details' && intent.start ? 'startSheet' : undefined}><Scope /></PanePresentationProvider>
        <ModalProvider>{null}</ModalProvider>
    </AppPaneProvider>);
    const tab = createSessionBoardDetailsTab();
    const file = { key: 'file:README.md', kind: 'file', title: 'README.md',
        resource: { kind: 'file' as const, path: 'README.md' } };
    let retire: (() => void) | undefined;
    try {
        expect(pane.scopeState).toBeNull();
        await act(async () => expect(open(scopeId, file, { present: false }, 'heldScopeOnly')).toBe(false));
        expect(pane.scopeState).toBeNull();
        await act(async () => expect(open(scopeId, tab, { start: true }, 'heldScopeOnly')).toBe(true));
        expect(pane.scopeState?.details.activeTabKey).toBe(tab.key);
        await act(async () => pane.closeDetailsTab(tab.key));
        await act(async () => pane.openRight({ tabId: 'git' }));
        await act(async () => expect(open(scopeId, tab, { start: true }, 'heldScopeOnly')).toBe(true));
        await act(async () => pane.closeDetailsTab(tab.key));
        expect(pane.scopeState?.details.tabs).toHaveLength(0);
        await act(async () => expect(open(scopeId, file, { present: false }, 'heldScopeOnly')).toBe(true));
        expect(pane.scopeState?.details.activeTabKey).toBe(file.key);
        await act(async () => pane.closeDetailsTab(file.key));
        await act(async () => {
            retire = register({ scopeId, detailsPaneBuiltinAdapter: {
                destinationIds: ['details'], render: () => <>{'Held Session Start body'}</>,
            } });
        });
        await act(async () => expect(open(scopeId, tab, { start: true }, 'heldScopeOnly')).toBe(true));
        expect(screen.getTextContent()).toContain('Held Session Start body');
        await act(async () => pane.closeDetails());
        await act(async () => retire?.());
        await act(async () => expect(open(scopeId, tab, { start: true }, 'heldScopeOnly')).toBe(true));
    } finally {
        await act(async () => retire?.());
        await screen.unmount();
    }
});

it('mounts one retained Details renderer only while the phone Start sheet is open and replaces its result in place', async () => {
    let pane!: Pane;
    let mounts = 0;
    let unmounts = 0;
    const ordinaryNavigation = vi.fn();
    function Body() {
        const selection = useAppPaneScope('start-test');
        React.useEffect(() => { mounts += 1; return () => { unmounts += 1; }; }, []);
        return <>{selection.scopeState?.details.activeTabKey}</>;
    }
    function Scope() {
        pane = useAppPaneScope('start-test');
        const register = useAppPaneContext(value => value.registerDriver);
        React.useEffect(() => register({ scopeId: 'start-test', detailsPaneBuiltinAdapter: {
            destinationIds: ['details'], render: () => <Body />,
        } }), [register]);
        return null;
    }
    const screen = await renderScreen(<AppPaneProvider>
        <PanePresentationProvider value={intent => {
            if (intent.pane === 'details' && intent.start) return;
            ordinaryNavigation();
            return 'ownTab';
        }}><Scope /></PanePresentationProvider>
        <ModalProvider>{null}</ModalProvider>
    </AppPaneProvider>);
    expect(mounts).toBe(0);
    const start = createSessionBoardDetailsTab();
    await act(async () => pane.openDetailsTab(start, { start: true, intent: 'pinned' }));
    expect(mounts).toBe(1);
    expect(ordinaryNavigation).not.toHaveBeenCalled();
    expect(screen.getTextContent()).toContain(start.key);
    const result = { ...start, key: 'accepted-result' };
    await act(async () => pane.replaceDetailsTab(start.key, result, { intent: 'pinned' }));
    expect(screen.getTextContent()).toContain(result.key);
    expect(mounts).toBe(1);
    await act(async () => pane.closeDetails());
    expect(unmounts).toBe(1);
    await act(async () => pane.openDetailsTab(start));
    expect(ordinaryNavigation).toHaveBeenCalledOnce();
    expect(mounts).toBe(1);
    await screen.unmount();
});

it('retains a Start-sheet selection before its newly created Session registers its Details driver', async () => {
    let pane!: Pane;
    let registerSession!: () => void;
    function Scope() {
        pane = useAppPaneScope('created-session');
        const [ready, setReady] = React.useState(false);
        registerSession = () => setReady(true);
        const register = useAppPaneContext(value => value.registerDriver);
        React.useEffect(() => ready ? register({ scopeId: 'created-session', detailsPaneBuiltinAdapter: {
            destinationIds: ['details'], render: () => <>{'New Session Start body'}</>,
        } }) : undefined, [ready, register]);
        return null;
    }
    const screen = await renderScreen(<AppPaneProvider>
        <PanePresentationProvider value={intent => intent.pane === 'details' && intent.start ? 'startSheet' : undefined}><Scope /></PanePresentationProvider>
        <ModalProvider>{null}</ModalProvider>
    </AppPaneProvider>);
    const start = createSessionBoardDetailsTab();
    await act(async () => pane.openDetailsTab(start, { start: true, intent: 'preview' }));
    expect(pane.scopeState?.details.activeTabKey).toBe(start.key);
    expect(screen.getTextContent()).not.toContain('New Session Start body');
    await act(async () => registerSession());
    expect(screen.getTextContent()).toContain('New Session Start body');
    expect(pane.scopeState?.details.tabs).toHaveLength(1);
    await screen.unmount();
});
