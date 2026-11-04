import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit';
import { installBrowserRuntimeForTests } from '@/dev/testkit/harness/browserRuntimeHarness';
import { buildBrowserAdapterCapabilities } from '@/sync/domains/browser/adapters/capabilities';
import type { BrowserControlViewState } from '@/sync/domains/browser/control';
import type {
    BrowserDiagnosticsRequestDetailClientInput,
    BrowserDiagnosticsRequestDetailClientResult,
} from '@/sync/domains/browser/diagnostics';

import { BrowserNetworkPanel } from './BrowserNetworkPanel';
import { BrowserDiagnosticsRequestDetailSourceContext } from './BrowserNetworkRequestExtras';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/sync/domains/state/storage', async () => (await import('@/dev/testkit/mocks/storage')).createStorageModuleStub({}));
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

async function renderWith(client: (input: BrowserDiagnosticsRequestDetailClientInput) => Promise<BrowserDiagnosticsRequestDetailClientResult>) {
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
