import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit';
import { installBrowserRuntimeForTests } from '@/dev/testkit/harness/browserRuntimeHarness';
import { buildBrowserAdapterCapabilities } from '@/sync/domains/browser/adapters/capabilities';
import type { BrowserControlViewState } from '@/sync/domains/browser/control';
import { applyBrowserDiagnosticsSnapshotState, createBrowserDiagnosticsUiStore,
    selectBrowserDiagnosticsForView, useBrowserDiagnosticsDaemonSnapshot } from '@/sync/domains/browser/diagnostics';
import type {
    BrowserDiagnosticsRequestDetailClientInput,
    BrowserDiagnosticsRequestDetailClientResult,
} from '@/sync/domains/browser/diagnostics';

import { BrowserDiagnosticsPanel } from './BrowserDiagnosticsPanel';
import { BrowserNetworkPanel } from './BrowserNetworkPanel';
import { BrowserDiagnosticsRequestDetailSourceContext } from './BrowserNetworkRequestExtras';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { renderMountedCurrentUiContext } from '@/dev/testkit/harness/mountedCurrentUiContext';
import { usePublishCurrentUiContext } from '@/components/appShell/currentUiContext/CurrentUiContextProvider';
import { useCurrentUiContextComposedCommands } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { CurrentUiContextSnapshotV1Schema } from '@happier-dev/protocol/plugins/ui/currentUiContext';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { t } from '@/text';

const daemonRpc = vi.hoisted(() => vi.fn());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: daemonRpc,
}));

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock({ translate: (key) => key }));

const browser = await installBrowserRuntimeForTests({ url: 'https://diagnostics.test/' });
Object.defineProperty(browser.document, 'visibilityState', { configurable: true, get: () => 'visible' });
beforeEach(() => {
    browser.activate();
    browser.document.dispatchEvent(new browser.window.Event('visibilitychange'));
});
afterEach(() => { standardCleanup(); vi.restoreAllMocks(); });
afterAll(() => browser.restore());

const view: BrowserControlViewState = {
    browserSessionId: 'browser', viewId: 'view',
    target: { kind: 'localServicePreview', targetId: 'preview', sessionId: 'session', machineId: 'machine',
        display: { title: 'Preview', addressLabel: 'localhost:5173' } },
    platform: 'web', adapterKind: 'localPreview', engineKind: 'webIframe',
    adapterCapabilities: buildBrowserAdapterCapabilities({ adapterKind: 'localPreview',
        supportedTargetKinds: ['localServicePreview'], supportedRenderEngines: ['webIframe'] }),
    currentUrl: 'https://preview.test/', currentUrlExpiresAt: null, pendingUrl: null,
    title: 'Preview', faviconUrl: null, loadingState: 'ready', loadingProgress: 1, navigationGeneration: 1,
    canGoBack: false, canGoForward: false, securityOrigin: 'https://preview.test', lastError: null,
    openerViewId: null, adapterRefreshStatus: 'idle', adapterRefreshError: null,
};

const request = {
    eventId: 'evt_post', family: 'network', kind: 'network.finished', fidelity: 'cdp', trusted: true, capturedAtMs: 1,
    detail: { fields: [
        { key: 'method', value: 'POST' }, { key: 'url', value: 'https://preview.test/api/session' },
        { key: 'statusCode', value: 401 }, { key: 'requestId', value: 'req_1' },
    ] },
} as const;

async function renderWith(client?: (input: BrowserDiagnosticsRequestDetailClientInput) => Promise<BrowserDiagnosticsRequestDetailClientResult>) {
    return renderScreen(
        <BrowserDiagnosticsRequestDetailSourceContext.Provider value={{ view, machineId: 'machine', detailClient: client }}>
            <BrowserNetworkPanel
                family={{ family: 'network', status: 'available', fidelity: 'cdp', trusted: true }}
                events={[request]}
                testID="diag"
            />
        </BrowserDiagnosticsRequestDetailSourceContext.Provider>,
    );
}

const row = 'diag-network-row-evt_post';
const extras = `${row}-detail-extras-req_1`;

it('keeps selected HTTP body reads behind the person press while exposing safe disclosure commands', async () => {
    const home = await serveActionHomes({ homes: [{ key: 'a', serverUrl: 'https://selected-request-controls.test', accountId: 'account-a' }],
        route: request => request.path === '/v1/kv/bulk' ? Response.json({ values: [] }) : undefined });
    const server = home.homes.a!;
    publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
    const socketRow = 'diag-network-row-evt_socket';
    const socket = { eventId: 'evt_socket', family: 'network', kind: 'network.websocketSummary', fidelity: 'cdp', trusted: true,
        capturedAtMs: 2, detail: { fields: [{ key: 'socketId', value: 'socket_1' }, { key: 'state', value: 'open' }] } } as const;
    // The daemon RPC is the network boundary; retain the real detail hook, decoder and disclosure path.
    daemonRpc.mockReset();
    daemonRpc.mockResolvedValue({ protocolVersion: 1,
        snapshot: { v: 1, machineId: 'machine', generatedAt: 1, refreshState: 'idle', events: [], diagnostics: [] },
        requestDetail: { status: 'available', requestId: 'req_1',
            requestBody: { status: 'available', text: 'private selected body', encoding: 'utf8' },
            responseBody: { status: 'unavailable', reason: 'not_finished' },
            requestExtraInfo: [{ cookies: [{ name: 'sid', value: 'private selected cookie', blockedReasons: [] }] }], responseExtraInfo: [] } });
    function Host() {
        const commands = useCurrentUiContextComposedCommands();
        usePublishCurrentUiContext(React.useMemo(() => ({ commands }), [commands]));
        return <BrowserDiagnosticsRequestDetailSourceContext.Provider value={{ view, machineId: 'machine', serverId: server.id }}>
            <BrowserNetworkPanel family={{ family: 'network', status: 'available', fidelity: 'cdp', trusted: true }}
                events={[request, socket]} testID="diag" />
        </BrowserDiagnosticsRequestDetailSourceContext.Provider>;
    }
    const screen = await renderMountedCurrentUiContext(<Host />);
    const executor = createDefaultActionExecutor();
    const caller = { serverId: server.id, surface: 'agent' as const, authority: 'account_automation' as const };
    async function inventory() {
        const read = await executor.execute('ui.current_context.read', {}, caller);
        if (!read.ok) throw new Error(read.errorCode);
        return CurrentUiContextSnapshotV1Schema.parse(read.result).commands;
    }
    async function invoke(commandId: string) {
        await act(async () => expect(await executor.execute('ui.current_context.command.invoke', { commandId }, caller))
            .toMatchObject({ ok: true, result: { value: null } }));
    }
    const describe = (commands: Awaited<ReturnType<typeof inventory>>) => commands.map(command => ({ title: command.title, description: command.description }));
    try {
        const closed = await inventory();
        expect.soft(describe(closed)).toEqual([{ title: t('common.expand'), description: socketRow }]);
        for (const command of closed) await invoke(command.id);
        expect(daemonRpc).not.toHaveBeenCalled();
        expect(screen.findByTestId(`${socketRow}-detail`)).toBeTruthy();
        const socketCollapse = (await inventory()).find(command => command.description === socketRow)!;
        await invoke(socketCollapse.id);
        expect(screen.findHostByTestId(`${socketRow}-detail`)).toBeNull();

        await screen.pressByTestIdAsync(row);
        expect(daemonRpc).toHaveBeenCalledTimes(1);
        expect(daemonRpc).toHaveBeenCalledWith(expect.objectContaining({ method: RPC_METHODS.DAEMON_BROWSER_DIAGNOSTICS_SNAPSHOT,
            payload: expect.objectContaining({ requestId: 'req_1' }) }));
        expect(screen.getTextContent()).toContain('private selected body');
        expect(screen.getTextContent()).toContain('sid=private selected cookie');
        const open = await inventory();
        expect(describe(open).sort((a, b) => a.description!.localeCompare(b.description!))).toEqual([
            { title: t('common.collapse'), description: row }, { title: t('common.expand'), description: socketRow },
        ].sort((a, b) => a.description.localeCompare(b.description)));
        expect(JSON.stringify(open)).not.toContain('private selected');
        const collapse = open.find(command => command.description === row)!;
        await invoke(collapse.id);
        expect(screen.findHostByTestId(`${row}-detail`)).toBeNull();
        expect(daemonRpc).toHaveBeenCalledTimes(1);
        expect(describe(await inventory())).toEqual([{ title: t('common.expand'), description: socketRow }]);
        expect(await executor.execute('ui.current_context.command.invoke', { commandId: collapse.id }, caller)).toMatchObject({ ok: false });
    } finally {
        await screen.unmount();
        await home.dispose();
        daemonRpc.mockReset();
    }
});

it('reads bodies and cookies only once the request detail is open, then shows them with their states', async () => {
    const client = vi.fn(async (): Promise<BrowserDiagnosticsRequestDetailClientResult> => ({ ok: true, detail: {
        status: 'available', requestId: 'req_1',
        requestBody: { status: 'available', text: '{"email":"ana@lumen.dev"}', encoding: 'utf8' },
        responseBody: { status: 'unavailable', reason: 'not_finished' },
        requestExtraInfo: [{ cookies: [{ name: 'sid', value: 'abc', httpOnly: true, blockedReasons: ['SameSiteStrict'] }] }],
        responseExtraInfo: [],
    } }));
    const screen = await renderWith(client);
    expect(client).not.toHaveBeenCalled();
    await act(async () => { await screen.pressByTestIdAsync(row); });
    expect(client).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'req_1' }));
    expect(screen.findByTestId(`${extras}-requestBody`)).toBeTruthy();
    expect(screen.getTextContent()).toContain('{"email":"ana@lumen.dev"}');
    expect(screen.findByTestId(`${extras}-responseBody-reason`)).toBeTruthy();
    expect(screen.findByTestId(`${extras}-requestCookies-0-blocked`)).toBeTruthy();
    expect(screen.getTextContent()).toContain('sid=abc');
    expect(screen.findHostByTestId(`${extras}-responseCookies`)).toBeNull();
});

it('says why values are unavailable instead of showing empty bodies', async () => {
    const screen = await renderWith(async () => ({ ok: true, detail: { status: 'unavailable', reason: 'permission_denied' } }));
    await act(async () => { await screen.pressByTestIdAsync(row); });
    expect(screen.findHostByTestId(`${row}-detail-extras-req_1-unavailable`)?.props.children)
        .toBe('browserDiagnostics.host.devtools.request.ownerOnly');
});

it('shows an owner refusal for a selected request without exposing daemon prose', async () => {
    daemonRpc.mockResolvedValueOnce({ ok: false, errorCode: 'RPC_FORBIDDEN', error: 'Private daemon diagnostic',
        requestId: 'diagnostics-request', effectAttempted: false, details: { reason: 'permission_denied' },
        failureCause: { phase: 'action.owner', errorClass: 'HttpStatusError', errorCode: 'forbidden', httpStatus: 403 } });
    const screen = await renderWith();
    await act(async () => { await screen.pressByTestIdAsync(row); });
    const text = screen.getTextContent();
    expect(text).toContain('errors.permissionDenied');
    expect(text).not.toContain('Private daemon diagnostic');
});

it('keeps a disconnected diagnostics drawer’s Machine refusal available to the person', async () => {
    daemonRpc.mockResolvedValueOnce({ ok: false, errorCode: 'RPC_FORBIDDEN', error: 'Private daemon snapshot diagnostic',
        requestId: 'diagnostics-snapshot', effectAttempted: false, details: { reason: 'permission_denied' },
        failureCause: { phase: 'action.owner', errorClass: 'HttpStatusError', errorCode: 'forbidden', httpStatus: 403 } });
    function OpenPanel() {
        const [store, setStore] = React.useState(createBrowserDiagnosticsUiStore);
        useBrowserDiagnosticsDaemonSnapshot({ view, onEvents: () => {},
            onSnapshotState: snapshot => setStore(prior => applyBrowserDiagnosticsSnapshotState(prior, snapshot)) });
        return <BrowserDiagnosticsPanel diagnostics={selectBrowserDiagnosticsForView(store, view)} testID="diag-snapshot" />;
    }
    const screen = await renderScreen(<OpenPanel />);
    await vi.waitFor(() => expect(screen.getTextContent()).toContain('errors.permissionDenied'));
    expect(screen.getTextContent()).not.toContain('Private daemon snapshot diagnostic');
});
