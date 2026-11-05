import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createWorkspaceState } from './workspaceState';
import { WorkspaceNavigationProvider, type WorkspaceNavigationContextValue } from './WorkspaceNavigationContext';
import { resolveCompactAppDestinations } from '../destinations/compactAppDestinationCatalog';

// Native host acquisition is the real external boundary; role selection and the menu stay real.
vi.mock('@tauri-apps/api/core', () => ({ invoke: async () => ({
    activity: { kind: 'available' }, pet: { kind: 'available' }, windows: { kind: 'available' },
}) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

import { resolveWorkspaceOpenModeFromPointer, useWorkspaceOpenActions } from './useWorkspaceOpenActions';

afterEach(() => { standardCleanup(); vi.unstubAllGlobals(); });

describe('workspace Session window menu', () => {
    it('offers the native Session presentation through the shared row builder and keeps phone tabs ordinary', async () => {
        vi.stubGlobal('isTauri', true);
        const state = createWorkspaceState({ id: 'session', target: { kind: 'session', params: { id: 's1' } }, pinned: false, preview: false });
        const value = {
            active: true, state, canGoBack: false, canGoForward: false, desktopPresentation: { serverId: 'home', accountId: 'account' },
            catalog: resolveCompactAppDestinations({ pages: [], builtins: { externalSessions: false, inbox: true, workflows: false, friends: false } }),
            openHref: () => false, activateTab: () => {}, closeTab: () => {}, closeTabs: () => {}, dispatch: () => {},
            navigationForTab: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
            registerBackStep: () => () => {}, back: () => {}, forward: () => {},
        } satisfies WorkspaceNavigationContextValue;
        function Probe(props: { href: string; present?: () => void }) {
            return React.createElement('menu-probe', { actions: useWorkspaceOpenActions(props.href, undefined,
                props.present ? { presentationAction: { item: { id: 'surface.presentation', title: 'Presentation', icon: <></> },
                    onSelect: props.present } } : undefined) });
        }
        const screen = await renderScreen(<WorkspaceNavigationProvider value={value}><Probe href="/session/s1?serverId=home" /></WorkspaceNavigationProvider>);
        await vi.waitFor(() => { expect(screen.root.findByType('menu-probe').props.actions.items.map((item: { id: string }) => item.id)).toContain('workspace.open.window'); });
        await screen.update(<WorkspaceNavigationProvider value={{ ...value, phone: {
            catalog: [], onTab: true, openHref: () => false, activateTab: () => {}, closeTab: () => {},
        } }}><Probe href="/session/s1?serverId=home" /></WorkspaceNavigationProvider>);
        expect(screen.root.findByType('menu-probe').props.actions.items.map((item: { id: string }) => item.id)).toEqual(['workspace.open.newTab']);
        await screen.update(<WorkspaceNavigationProvider value={value}><Probe href="/settings" /></WorkspaceNavigationProvider>);
        expect(screen.root.findByType('menu-probe').props.actions.items.map((item: { id: string }) => item.id)).toContain('workspace.open.window');
        let presentations = 0;
        await screen.update(<WorkspaceNavigationProvider value={value}><Probe href="/session/s1?serverId=home" present={() => { presentations += 1; }} /></WorkspaceNavigationProvider>);
        const actions = screen.root.findByType('menu-probe').props.actions;
        expect(actions.items.map((item: { id: string }) => item.id)).toContain('surface.presentation');
        expect(actions.select('surface.presentation')).toBe(true);
        expect(presentations).toBe(1);
    });

    it('offers the shared window action for an addressed pane without recreating its route', async () => {
        vi.stubGlobal('isTauri', true);
        function Probe() {
            return React.createElement('menu-probe', { actions: useWorkspaceOpenActions(null, undefined, {
                windowTarget: { kind: 'paneTab', serverId: 'home', accountId: 'account', layoutId: 'main', scopeId: 'scope', tabKey: 'file:app.ts' },
            }) });
        }
        const screen = await renderScreen(<Probe />);
        await vi.waitFor(() => {
            expect(screen.root.findByType('menu-probe').props.actions.items.map((item: { id: string }) => item.id))
                .toEqual(['workspace.open.window']);
        });
    });

    it('keeps the Session window presentation available in the legacy shell', async () => {
        vi.stubGlobal('isTauri', true);
        function Probe() {
            return React.createElement('menu-probe', { actions: useWorkspaceOpenActions('/session/s1?serverId=home') });
        }
        const screen = await renderScreen(<Probe />);
        await vi.waitFor(() => {
            expect(screen.root.findByType('menu-probe').props.actions.items.map((item: { id: string }) => item.id))
                .toEqual(['workspace.open.window']);
        });
    });

    it('can move an existing workspace tab whose destination currently has no href', async () => {
        vi.stubGlobal('isTauri', true);
        const state = createWorkspaceState({ id: 'retained', target: { kind: 'session', params: { id: 's1' } }, pinned: false, preview: false });
        const workspace = {
            active: true, state, canGoBack: false, canGoForward: false,
            desktopPresentation: { serverId: 'home', accountId: 'account', layoutId: 'main' },
            openHref: () => false, activateTab: () => {}, closeTab: () => {}, closeTabs: () => {}, dispatch: () => {},
            navigationForTab: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
            registerBackStep: () => () => {}, back: () => {}, forward: () => {},
        } satisfies WorkspaceNavigationContextValue;
        function Probe() {
            return React.createElement('menu-probe', { actions: useWorkspaceOpenActions(null, undefined, { sourceTabId: 'retained' }) });
        }
        const screen = await renderScreen(<WorkspaceNavigationProvider value={workspace}><Probe /></WorkspaceNavigationProvider>);
        await vi.waitFor(() => {
            expect(screen.root.findByType('menu-probe').props.actions.items.map((item: { id: string }) => item.id))
                .toEqual(['workspace.open.window']);
        });
    });
});

describe('workspace row pointer intent', () => {
    it('keeps Alt, middle, and platform command clicks as intentional tabs', () => {
        vi.stubGlobal('navigator', { platform: 'MacIntel' });
        expect(resolveWorkspaceOpenModeFromPointer({ altKey: true })).toBe('newTab');
        expect(resolveWorkspaceOpenModeFromPointer({ nativeEvent: { altKey: true } })).toBe('newTab');
        expect(resolveWorkspaceOpenModeFromPointer({ button: 1 })).toBe('newTab');
        expect(resolveWorkspaceOpenModeFromPointer({ metaKey: true })).toBe('newTab');
        expect(resolveWorkspaceOpenModeFromPointer({ nativeEvent: { metaKey: true } })).toBe('newTab');
        expect(resolveWorkspaceOpenModeFromPointer({ ctrlKey: true })).toBeNull();
        vi.stubGlobal('navigator', { platform: 'Win32' });
        expect(resolveWorkspaceOpenModeFromPointer({ ctrlKey: true })).toBe('newTab');
        expect(resolveWorkspaceOpenModeFromPointer({ metaKey: true })).toBeNull();
        expect(resolveWorkspaceOpenModeFromPointer({ button: 2, ctrlKey: true })).toBeNull();
        expect(resolveWorkspaceOpenModeFromPointer({ button: 0 })).toBeNull();
        vi.unstubAllGlobals();
    });
});
