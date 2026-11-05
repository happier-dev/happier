import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createDesktopSecureStorageBoundary } from '@/dev/testkit/mocks/desktopSecureStorage';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { MainAppTabStateProvider } from '@/components/navigation/mobile/chrome/MainAppTabStateProvider';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { CurrentUiContextProvider, useOptionalCurrentUiContextReader, type CurrentUiContextReader } from '@/components/appShell/currentUiContext/CurrentUiContextProvider';
import { CurrentUiContextActionHost } from '@/components/appShell/currentUiContext/currentUiContextVoiceToolPort';
import { executeCurrentUiContextAction } from '@/components/appShell/currentUiContext/currentUiContextActionRuntime';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { getStorage } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { useDesktopAppWindowCommands } from './useDesktopAppWindowCommands';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { registerDesktopAppWindowWorkspace } from './appWindowRuntime';
import { createWorkspaceState, reduceWorkspaceState } from '@/components/appShell/workspace/workspaceState';
import { AppWindowRecordSchema } from './appWindowBoot';
import type { DesktopWindowsOpenInput } from '@happier-dev/protocol/actions/actionSpecs';
import { JSDOM } from 'jsdom';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ pathname: () => '/', segments: () => ['(app)'] }).module);
const native = vi.hoisted(() => ({ close: false, calls: [] as string[], opened: [] as unknown[], listeners: new Map<string, (event: { payload: unknown }) => void>() }));
// Native IPC is the boundary. Command composition, opaque addresses and admission remain real.
let home: Awaited<ReturnType<typeof serveActionHomes>> | undefined;
let dom: JSDOM | undefined;
let reader: CurrentUiContextReader | null = null;
function installNativeBoundary(invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>) {
    dom = new JSDOM('', { url: 'https://window-controls.test/' });
    Object.defineProperty(dom.window.document, 'hasFocus', { value: () => true });
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    const callbacks = new Map<number, (event: { payload: unknown }) => void>();
    let nextId = 0;
    const internals = {
        metadata: { currentWindow: { label: 'main' } },
        transformCallback: (callback: (event: { payload: unknown }) => void) => { const id = ++nextId; callbacks.set(id, callback); return id; },
        invoke: async (command: string, args?: Record<string, unknown>) => {
            if (command === 'plugin:event|listen') {
                if (typeof args?.event !== 'string' || typeof args.handler !== 'number') throw new TypeError('Invalid native event listener');
                const callback = callbacks.get(args.handler);
                if (!callback) throw new TypeError('Missing native callback');
                native.listeners.set(args.event, callback); return args.handler;
            }
            if (command === 'plugin:event|unlisten') { native.listeners.delete(String(args?.event)); return; }
            return invoke(command, args);
        },
    };
    Object.defineProperty(dom.window, '__TAURI_INTERNALS__', { value: internals });
    Object.defineProperty(dom.window, '__TAURI_EVENT_PLUGIN_INTERNALS__', { value: { unregisterListener: () => {} } });
    vi.stubGlobal('__TAURI_INTERNALS__', internals);
}
function Controls() {
    const actions = React.useMemo(() => createFrontDoorActionExecute(), []);
    const open = React.useCallback(async (input: DesktopWindowsOpenInput) =>
        (await actions('desktop.windows.open', input, { surface: 'ui' })).ok, [actions]);
    useDesktopAppWindowCommands(open); reader = useOptionalCurrentUiContextReader(); return null;
}
afterEach(async () => {
    standardCleanup(); retireActiveServerAccountScopeLifetime(); await home?.dispose();
    dom?.window.close(); dom = undefined;
    vi.unstubAllGlobals(); native.calls.length = 0; native.opened.length = 0; native.listeners.clear(); reader = null;
});

it('publishes a mounted opaque Close request and keeps native refusal and retirement intact', async () => {
    const secure = createDesktopSecureStorageBoundary();
    installNativeBoundary(async (command, args) => {
        native.calls.push(command);
        if (command.startsWith('desktop_secure_storage_')) return secure.invoke(command, args);
        if (command === 'desktop_host_get_availability') return { activity: { kind: 'available' }, pet: { kind: 'available' }, windows: { kind: 'available' } };
        if (command === 'desktop_get_window_chrome_policy') return { strategy: 'custom-controls' };
        if (command === 'desktop_close_window') return native.close;
        if (command === 'desktop_app_window_restore') return [];
        if (command === 'desktop_app_window_placement') return { frame: null, previousFrame: null, workArea: null };
        if (command === 'desktop_app_window_open') {
            const record = AppWindowRecordSchema.parse(args?.record);
            native.opened.push(record);
            return { windowId: record.windowId, windowLabel: `destination_${record.windowId}`, ready: true, reused: false };
        }
        return undefined;
    });
    home = await serveActionHomes({ homes: [{ key: 'a', serverUrl: 'https://window-controls.test', accountId: 'account-a' }],
        route: request => request.path === '/v1/kv/bulk' ? Response.json({ values: [] }) : undefined });
    const server = home.homes.a!;
    publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
    getStorage().getState().activateProfileScope({ serverId: server.id, accountId: 'account-a' });
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const credentials = (await TokenStorage.getCredentialsForServerUrl(server.serverUrl))!;
    const screen = await renderScreen(<InjectedAuthProvider credentials={credentials}>
        <MainAppTabStateProvider><AppPaneProvider><CurrentUiContextProvider>
            <CurrentUiContextActionHost /><Controls />
        </CurrentUiContextProvider></AppPaneProvider></MainAppTabStateProvider>
    </InjectedAuthProvider>);
    await vi.waitFor(() => expect(reader?.readCurrentUiContext()?.commands.find(command => command.title === t('common.closeWindow'))).toBeDefined());
    const commandId = reader!.readCurrentUiContext()!.commands.find(command => command.title === t('common.closeWindow'))!.id;
    const invoke = () => executeCurrentUiContextAction({ actionId: 'ui.current_context.command.invoke', input: { commandId }, context: { surface: 'agent' } });
    expect(await invoke()).toMatchObject({ ok: false });
    expect(native.calls.filter(command => command === 'desktop_close_window')).toHaveLength(1);
    native.close = true;
    expect(await invoke()).toMatchObject({ ok: true });
    await act(async () => screen.unmount());
    expect(await invoke()).toMatchObject({ ok: false });
    expect(native.calls.filter(command => command === 'desktop_close_window')).toHaveLength(2);
});

it('opens a full Home through the mounted New Window command and native menu using the invoking Home', async () => {
    const secure = createDesktopSecureStorageBoundary();
    installNativeBoundary(async (command, args) => {
        if (command.startsWith('desktop_secure_storage_')) return secure.invoke(command, args);
        if (command === 'desktop_host_get_availability') return { activity: { kind: 'available' }, pet: { kind: 'available' }, windows: { kind: 'available' } };
        if (command === 'desktop_get_window_chrome_policy') return { strategy: 'custom-controls' };
        if (command === 'desktop_app_window_restore') return [];
        if (command === 'desktop_app_window_placement') return { frame: null, previousFrame: null, workArea: null };
        if (command === 'desktop_app_window_open') {
            const record = AppWindowRecordSchema.parse(args?.record);
            native.opened.push(record);
            return { windowId: record.windowId, windowLabel: `destination_${record.windowId}`, ready: true, reused: false };
        }
        return undefined;
    });
    home = await serveActionHomes({ homes: [{ key: 'b', serverUrl: 'https://new-window-home.test', accountId: 'account-b' }],
        route: request => request.path === '/v1/kv/bulk' ? Response.json({ values: [] }) : undefined });
    const server = home.homes.b!;
    publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
    getStorage().getState().activateProfileScope({ serverId: server.id, accountId: 'account-b' });
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const credentials = (await TokenStorage.getCredentialsForServerUrl(server.serverUrl))!;
    let state = createWorkspaceState({ id: 'source', target: { kind: 'newTab', params: {} }, pinned: false, preview: false });
    const initial = state;
    const stop = registerDesktopAppWindowWorkspace({ windowId: 'main', layoutId: 'main',
        scope: { serverId: server.id, accountId: 'account-b' }, getState: () => state,
        dispatch: action => { state = reduceWorkspaceState(state, action); }, catalog: [], activateTab: () => {},
        placementMetrics: { cascadeOffset: 24, screenInset: 24 } });
    try {
        await renderScreen(<InjectedAuthProvider credentials={credentials}>
            <MainAppTabStateProvider><AppPaneProvider><CurrentUiContextProvider>
                <CurrentUiContextActionHost /><Controls />
            </CurrentUiContextProvider></AppPaneProvider></MainAppTabStateProvider>
        </InjectedAuthProvider>);
        await vi.waitFor(() => expect(reader?.readCurrentUiContext()?.commands.find(command => command.title === t('common.newWindow'))).toBeDefined());
        const commandId = reader!.readCurrentUiContext()!.commands.find(command => command.title === t('common.newWindow'))!.id;
        expect(await executeCurrentUiContextAction({ actionId: 'ui.current_context.command.invoke', input: { commandId }, context: { surface: 'agent' } })).toMatchObject({ ok: true });
        expect(native.opened).toHaveLength(1);
        expect(native.opened[0]).toMatchObject({ chrome: 'full', homeId: server.id, accountId: 'account-b', selectedAddress: { kind: 'home' } });
        await vi.waitFor(() => expect(native.listeners.has('desktop_new_window_requested')).toBe(true));
        await act(async () => native.listeners.get('desktop_new_window_requested')!({ payload: null }));
        await vi.waitFor(() => expect(native.opened).toHaveLength(2));
        expect(native.opened[1]).toMatchObject({ chrome: 'full', homeId: server.id, accountId: 'account-b', selectedAddress: { kind: 'home' } });
        expect(state).toBe(initial);
    } finally { native.listeners.get('desktopAppWindow://records')?.({ payload: [] }); stop(); }
});
