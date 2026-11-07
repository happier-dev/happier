import * as React from 'react';
import 'fake-indexeddb/auto';
import { useRouter } from 'expo-router';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';

let width = 1200;
// Geometry and the disconnected network are system boundaries; pane/settings owners remain real.
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ View: 'View', useWindowDimensions: () => ({ width, height: 900, scale: 1, fontScale: 1 }) });
});
installDisconnectedServerSocketBoundary();
const { storage } = await import('@/sync/domains/state/storageStore');
const initialStorage = storage.getState();
beforeEach(() => storage.getState().applyLocalSettings({ paneArrangement: 'session', uiMultiPanePanelsEnabled: true }, { source: 'ui' }));
afterEach(async () => { await standardCleanup(); storage.setState(initialStorage, true); width = 1200; });
const { AppPaneProvider, useAppPaneContext } = await import('./AppPaneProvider');
const { AppPaneScopeHost } = await import('./AppPaneScopeHost');
const { usePaneMainColumn } = await import('./mainColumn/usePaneMainColumn');
const { invokeScopeAction, readShellColumnActionOwner } = await import('@/sync/ops/actions/scopeActionFamily');
const { useAppPaneScope } = await import('./hooks/useAppPaneScope');
const { useOptionalAppPaneScopeLayout } = await import('./hooks/useAppPaneScopeLayout');
const { PaneHeader } = await import('./PaneHeader');
const { createSessionCompanionPanePresentation } = await import('@/components/sessions/companion/presentation/sessionCompanionPanePresentation');
import type { PaneMainColumnState } from './mainColumn/usePaneMainColumn';
import { DestinationInstanceContext } from '@/components/appShell/workspace/destinationInstanceContext';

function Main() {
    const context = useAppPaneContext();
    const main = usePaneMainColumn();
    return React.createElement('MainStateProbe', { hidden: context.state.scopes.app?.mainHidden, main });
}
function Harness(props: Readonly<{ detailsOpen: boolean; unnamed?: boolean; unavailableSide?: boolean; detailsPane?: React.ReactNode }>) {
    return <AppPaneProvider><AppPaneScopeHost scopeId="app"
        mainColumn={props.unnamed ? undefined : { hideLabel: 'Hide page', showLabel: 'Show page', identity: { name: 'Page' } }}
        main={<Main />}
        rightSidebarAdapter={props.unavailableSide ? { available: false, render: () => null } : undefined}
        destinationDetails={props.detailsOpen ? { pane: props.detailsPane ?? <div />, onClose: () => {} } : null}
    /></AppPaneProvider>;
}

describe('AppPaneScopeHost main column', () => {
    it('does not rebuild unrelated pane mounts for draft bytes or dirty pin metadata', async () => {
        let pane!: ReturnType<typeof useAppPaneScope>;
        let rightBuilds = 0;
        function Control() { pane = useAppPaneScope('app'); return null; }
        const right = { destinationIds: ['git'], render: () => { rightBuilds += 1; return <div />; } };
        const screen = await renderScreen(<AppPaneProvider><Control /><AppPaneScopeHost scopeId="app"
            main={<div />} rightPaneBuiltinAdapter={right} /></AppPaneProvider>);
        try {
            await act(async () => pane.openRight({ tabId: 'git' }));
            await act(async () => pane.openDetailsTab({ key: 'file:a.ts', kind: 'file', title: 'a.ts', resource: { kind: 'file', path: 'a.ts' } }, { intent: 'preview' }));
            const before = rightBuilds;
            expect(before).toBeGreaterThan(0);
            for (let index = 0; index < 20; index += 1) {
                await act(async () => pane.patchDetailsTabState('file:a.ts', { accountId: 'alice', isEditingFile: true, editorText: `draft${index}` }, { persist: false }));
            }
            await act(async () => pane.pinDetailsTab('file:a.ts', { persist: false }));
            expect(rightBuilds - before).toBe(0);
            await act(async () => pane.closeRight());
            await act(async () => pane.openRight({ tabId: 'git' }));
            expect(rightBuilds).toBeGreaterThan(before);
        } finally { await screen.unmount(); }
    });

    it('lets only the focused app destination offer an arrangement when multi-pane is enabled', async () => {
        storage.getState().applyLocalSettings({ uiMultiPanePanelsEnabled: false }, { source: 'ui' });
        await renderScreen(<AppPaneProvider><AppPaneScopeHost scopeId="app" arrangement="honour"
            mainColumn={{ hideLabel: 'Hide page', showLabel: 'Show page', identity: { name: 'Page' } }}
            main={<Main />} /></AppPaneProvider>);
        expect(readShellColumnActionOwner('main')?.arrangementAvailable).toBe(false);
    });
    it('lets only the focused app destination reconcile the shared hide preference', async () => {
        const mainColumn = { hideLabel: 'Hide page', showLabel: 'Show page', identity: { name: 'Page' } };
        function RetainedPage(props: Readonly<{ focused: boolean; detailsOpen: boolean }>) {
            const focus = React.useRef(props.focused);
            focus.current = props.focused;
            const navigation = useRouter();
            return <DestinationInstanceContext.Provider value={{ tabId: props.focused ? 'active' : 'retained',
                ref: { kind: 'plugins', params: {} }, pathname: '/plugins',
                focused: props.focused, isFocused: () => focus.current, visible: true, navigation }}>
                <AppPaneScopeHost scopeId="app" mainColumn={mainColumn} main={<Main />}
                    destinationDetails={props.detailsOpen ? { pane: <div />, onClose: () => {} } : null} />
            </DestinationInstanceContext.Provider>;
        }
        const screen = await renderScreen(<AppPaneProvider>
            <RetainedPage focused={false} detailsOpen={false} />
            <RetainedPage focused detailsOpen />
        </AppPaneProvider>);
        await act(async () => {
            expect(await invokeScopeAction('shell.column.set', { column: 'main', visible: false })).toEqual({ ok: true });
        });
        expect(screen.root.findAllByType('MainStateProbe').map(node => node.props.hidden)).toEqual([true, true]);
    });
    it('does not open an empty app side column when its catalog has no available tab', async () => {
        const screen = await renderScreen(<Harness detailsOpen={false} unavailableSide />);
        expect(await invokeScopeAction('shell.column.get', { column: 'side' })).toMatchObject({ available: false, visible: false });
        await act(async () => {
            expect(await invokeScopeAction('shell.column.set', { column: 'side', visible: true })).toMatchObject({ errorCode: 'client_control_unavailable' });
        });
        expect(screen.root.findByType('MainStateProbe').props.main.canHide).toBe(false);
    });

    it('returns to the folded session through published effective controls while the persisted flag is false', async () => {
        storage.getState().applyLocalSettings({ paneArrangement: 'editor' }, { source: 'ui' }); width = 834;
        const paneRef: { current: ReturnType<typeof useAppPaneScope> | null } = { current: null };
        const mainRef: { current: PaneMainColumnState | null } = { current: null };
        const layouts: ReturnType<typeof useOptionalAppPaneScopeLayout>[] = [];
        const receiveMain = (controls: PaneMainColumnState | null) => { mainRef.current = controls; };
        const LayoutProbe = () => { layouts.push(useOptionalAppPaneScopeLayout()); return null; };
        const wrap = (children: React.ReactNode) => <><LayoutProbe />{children}</>;
        function FoldedHost() {
            paneRef.current = useAppPaneScope('app');
            return <AppPaneScopeHost scopeId="app" arrangement="honour"
                mainColumn={{ hideLabel: 'Hide session', showLabel: 'Show session', identity: { name: 'Session' } }}
                main={<div />} emptyEditorPane={<div />} wrapScopeContent={wrap}
                onMainColumnControlsChange={receiveMain} />;
        }
        const presentation = createSessionCompanionPanePresentation({
            readPane: () => { if (!paneRef.current) throw new Error('Pane not mounted'); return paneRef.current; },
            readMainColumn: () => mainRef.current,
            isUndoCurrent: () => true,
        });
        await renderScreen(<AppPaneProvider><FoldedHost /></AppPaneProvider>);
        expect(paneRef.current?.scopeState?.mainHidden).toBe(false);
        expect(layouts.at(-1)?.layout.main).toBe('overlay');
        expect(mainRef.current?.hidden).toBe(true);
        await act(async () => { expect(presentation.returnToChat().status).toBe('applied'); });
        expect(mainRef.current?.hidden).toBe(false);
        expect(layouts.at(-1)?.mainDrawerOpen).toBe(true);
        expect(paneRef.current?.scopeState?.mainHidden).toBe(false);
    });
    it('does not expose hiding for a host without a named main column', async () => {
        const screen = await renderScreen(<Harness detailsOpen unnamed />);
        expect(screen.root.findByType('MainStateProbe').props.main).toBeNull();
        expect(await invokeScopeAction('shell.column.get', { column: 'main' })).toMatchObject({ available: false, visible: true });
        await act(async () => {
            expect(await invokeScopeAction('shell.column.set', { column: 'main', visible: false })).toMatchObject({ errorCode: 'client_control_unavailable' });
        });
        expect(screen.root.findByType('MainStateProbe').props.hidden).toBe(false);
    });

    it('keeps main retained when hidden and reconciles route-owned details closing', async () => {
        const screen = await renderScreen(<Harness detailsOpen />);
        const main = screen.root.findByType('MainStateProbe');
        expect(main.props.main.canHide).toBe(true);
        await act(async () => {
            expect(await invokeScopeAction('shell.column.set', { column: 'main', visible: false })).toEqual({ ok: true });
        });
        expect(screen.root.findByType('MainStateProbe')).toBe(main);
        expect(main.props.hidden).toBe(true);
        expect(main.props.main.hidden).toBe(true);
        await screen.update(<Harness detailsOpen={false} />);
        expect(screen.root.findByType('MainStateProbe')).toBe(main);
        expect(main.props.hidden).toBe(false);
    });

    it('draws the restore chip itself when the open neighbour has no header to carry it', async () => {
        const { createSecretSettingsTestHarness } = await import('@/components/settings/secrets/secretSettingsTestHarness');
        const { settingsParse } = await import('@/sync/domains/settings/settings');
        const account = await createSecretSettingsTestHarness({ settings: settingsParse({}) });
        try {
            const screen = await renderScreen(<Harness detailsOpen />);
            await act(async () => {
                expect(await invokeScopeAction('shell.column.set', { column: 'main', visible: false })).toEqual({ ok: true });
            });
            expect(screen.findAllHostsByTestId('pane-main-restore-fallback')).toHaveLength(1);
            expect(screen.findAllHostsByTestId('pane-main-restore-chip')).toHaveLength(1);
            await act(async () => { screen.pressByTestId('pane-main-restore-chip'); });
            await vi.waitFor(() => expect(screen.root.findByType('MainStateProbe').props.hidden).toBe(false));
            expect(screen.findAllHostsByTestId('pane-main-restore-fallback')).toHaveLength(0);
            await screen.unmount();
        } finally { await account.dispose(); }
    });

    it('leaves the restore chip to the neighbour header that draws it', async () => {
        const screen = await renderScreen(<Harness detailsOpen detailsPane={<PaneHeader title="Details" mainRestoreChip />} />);
        await act(async () => {
            expect(await invokeScopeAction('shell.column.set', { column: 'main', visible: false })).toEqual({ ok: true });
        });
        expect(screen.findAllHostsByTestId('pane-main-restore-chip')).toHaveLength(1);
        expect(screen.findAllHostsByTestId('pane-main-restore-fallback')).toHaveLength(0);
    });
});
