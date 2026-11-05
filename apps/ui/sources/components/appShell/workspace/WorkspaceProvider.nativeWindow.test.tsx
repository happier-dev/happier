/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createDesktopSecureStorageBoundary } from '@/dev/testkit/mocks/desktopSecureStorage';
import { registerDesktopAppWindowReturnHandler } from '@/sync/ops/actions/desktopAppWindowActionDispatch';
import { resolveCompactAppDestinations } from '../destinations/compactAppDestinationCatalog';
import { AppWindowWorkspace } from '@/desktop/window/AppWindowWorkspace';
import { useOptionalWorkspaceNavigation, type WorkspaceNavigationContextValue } from './WorkspaceNavigationContext';

// Host availability is acquired once per renderer realm. Keep the native journey
// separate from browser fixtures rather than resetting its production authority.
const boundary = vi.hoisted(() => ({ pathname: '/desktop/window', params: {}, mirrors: [] as string[] }));
const nativeWindow = { handlers: new Map<string, (event: { payload: unknown }) => void>() };
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({
    splitStreamingRevealTextParts: () => { throw new Error('Unexpected Markdown reveal in native navigation'); },
}));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
    pathname: () => boundary.pathname, params: () => boundary.params,
    router: { replace: (href: unknown) => { boundary.mirrors.push(String(href)); } },
}).module);
vi.mock('expo-router/build/fork/getPathFromState', async () =>
    (await import('@/dev/testkit/runtime/installedExpoPathSerializer')).loadInstalledExpoPathSerializer());
vi.mock('@react-navigation/native', async () => (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock());
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
await (await import('@/dev/testkit/harness/syncSingletonLoader')).loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storage');
const { TokenStorage } = await import('@/auth/storage/tokenStorage');
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
const initialStorage = storage.getState();

function WorkspaceRecordProbe() {
    return React.createElement('WorkspaceOwner', { navigation: useOptionalWorkspaceNavigation() });
}
function installBrowserBoundary(input: Record<string, unknown> & { history: object }) {
    const events = new EventTarget();
    vi.stubGlobal('window', { ...input,
        addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events),
        dispatchEvent: events.dispatchEvent.bind(events),
    });
}
afterEach(async () => {
    standardCleanup();
    await homes.reset();
    storage.setState(initialStorage, true);
    vi.unstubAllGlobals();
});
describe('native workspace metadata admission', () => {
    it('initializes a destination from pushed metadata before a stale native read can admit another Session', async () => {
        const serverUrl = 'https://destination-window.example.test';
        const home = { id: await homes.addHome({ serverUrl, name: 'Destination', accountId: 'alice', currentAccount: true }) };
        const credentials = await TokenStorage.getCredentialsForServerUrl(serverUrl, { serverId: home.id });
        if (!credentials) throw new Error('Expected native destination credentials');
        const connection = await restoreServerAccountForTest({ serverUrl, accountId: 'alice', credentials, request: homes.request });
        const record = { windowId: 'native', accountId: 'alice', homeId: home.id, layoutId: 'native-layout',
            selectedAddress: { kind: 'session' as const, sessionId: 'fresh-session' } };
        let completeRead!: (value: unknown) => void;
        const read = new Promise<unknown>(resolve => { completeRead = resolve; });
        const callbacks = new Map<number, (event: { payload: unknown }) => void>();
        const secureStorage = createDesktopSecureStorageBoundary();
        // Keep the native SDK and all domain owners real beneath the OS invoke/callback boundary.
        const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
            if (command === 'plugin:event|listen' && typeof args?.event === 'string' && typeof args.handler === 'number') {
                nativeWindow.handlers.set(args.event, callbacks.get(args.handler)!); return args.handler;
            }
            if (command === 'plugin:event|unlisten' && typeof args?.event === 'string') { nativeWindow.handlers.delete(args.event); return null; }
            if (command === 'desktop_app_window_read') return await read;
            if (command === 'desktop_host_get_availability') return { activity: { kind: 'available' }, pet: { kind: 'available' }, windows: { kind: 'available' } };
            if (command === 'desktop_app_window_restore') return [record];
            if (command === 'desktop_app_window_placement') return { workArea: null, previousFrame: null, frame: null };
            if (command === 'desktop_app_window_open') return { windowId: 'native', windowLabel: 'destination_native', ready: true, reused: true };
            return await secureStorage.invoke(command, args) ?? null;
        });
        installBrowserBoundary({ location: { href: 'https://app.test/desktop/window', pathname: '/desktop/window', search: '', hash: '' },
            sessionStorage: globalThis.sessionStorage,
            history: { state: null, pushState() {}, replaceState() {}, go() {} },
            __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: (event: string) => nativeWindow.handlers.delete(event) },
            __TAURI_INTERNALS__: { invoke, metadata: { currentWindow: { label: 'destination_native' } },
                transformCallback: (callback: (event: { payload: unknown }) => void) => {
                    const id = callbacks.size + 1; callbacks.set(id, callback); return id;
                } } });
        storage.setState({ settings: { ...storage.getState().settings, workspaceTabsSyncEnabled: false } });
        const catalog = resolveCompactAppDestinations({ pages: [], builtins: { externalSessions: false, inbox: false, workflows: false, friends: false } });
        const screen = await renderScreen(<InjectedAuthProvider credentials={credentials}><AppWindowWorkspace catalog={catalog}><WorkspaceRecordProbe /></AppWindowWorkspace></InjectedAuthProvider>);
        try {
        expect(screen.root.findAllByType('WorkspaceOwner')).toHaveLength(0);
        await vi.waitFor(() => expect(nativeWindow.handlers.has('desktopAppWindow://record')).toBe(true));
        await act(async () => { nativeWindow.handlers.get('desktopAppWindow://record')?.({ payload: record }); });
        const navigation = () => screen.root.findByType('WorkspaceOwner').props.navigation as WorkspaceNavigationContextValue;
        const selected = () => navigation().state.tabs[navigation().state.groups[navigation().state.focusedGroupId].activeTabId]?.target;
        expect(selected()?.params).toMatchObject({ id: 'fresh-session', serverId: home.id, accountId: 'alice' });
        await act(async () => { completeRead({ ...record, selectedAddress: { kind: 'session', sessionId: 'stale-session' } }); });
        expect(selected()?.params.id).toBe('fresh-session');
        const stopReturn = registerDesktopAppWindowReturnHandler(async () => true);
        onTestFinished(stopReturn);
        await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('desktop_app_window_restore', { contexts: [{ serverId: home.id, accountId: 'alice' }], activeOnly: true }));
        await act(async () => { navigation().navigationForTab(navigation().state.groups[navigation().state.focusedGroupId].activeTabId)
            .push('/session/next-session'); });
        expect(selected()?.params.id).toBe('fresh-session');
        await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('desktop_app_window_open', expect.objectContaining({ record: expect.objectContaining({
            windowId: 'native', homeId: home.id, accountId: 'alice', selectedAddress: { kind: 'session', sessionId: 'next-session' },
        }) })));
        await act(async () => { nativeWindow.handlers.get('desktopAppWindow://record')?.({ payload: {
            ...record, selectedAddress: { kind: 'session', sessionId: 'next-session' },
        } }); });
        expect(selected()?.params.id).toBe('next-session');
        expect(boundary.mirrors).toEqual([]);
        await act(async () => { nativeWindow.handlers.get('desktopAppWindow://record')?.({ payload: { invalid: true } }); });
        await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('desktop_app_window_ready', { failure: 'metadata_unavailable' }));
        expect(screen.root.findAllByType('WorkspaceOwner')).toHaveLength(0);
        } finally {
            await screen.unmount();
            await connection.dispose();
            await vi.waitFor(() => expect([...nativeWindow.handlers.keys()].filter(event => event.startsWith('desktopAppWindow://'))).toEqual([]));
        }
    });
});
