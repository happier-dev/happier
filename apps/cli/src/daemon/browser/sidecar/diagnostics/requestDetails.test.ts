import { describe, expect, it, vi } from 'vitest';
import type { RpcHandler, RpcHandlerContext, RpcHandlerRegistrar } from '@/api/rpc/types';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createBrowserDiagnosticsDaemonStore } from '../../diagnostics/store';
import { createBrowserDiagnosticsRoutes } from '../../diagnostics/routes';
import { registerDaemonBrowserDiagnosticsSnapshotHandler } from '@/rpc/handlers/daemonBrowserDiagnosticsSnapshot';
import { createSidecarCdpDiagnosticsRuntime } from './runtime';
import type { BrowserSidecarCdpEventSubscriber, BrowserSidecarViewLifecycleSubscriber } from '../controlAdapter';

const view = { browserSessionId: 'browser', viewId: 'page', navigationGeneration: 0 };

function harness() {
    let cdp: BrowserSidecarCdpEventSubscriber = () => {};
    let lifecycle: BrowserSidecarViewLifecycleSubscriber = () => {};
    const commands: string[] = [];
    // CDP is the external boundary. All mapping, retention, routes and egress below it are real.
    const dispatchPageCommand = vi.fn(async (input: { method: string; params?: Record<string, unknown> }) => {
        commands.push(input.method);
        if (input.method === 'Network.getRequestPostData') return { postData: 'fixture-request-secret' };
        if (input.method === 'Network.getResponseBody') return { body: 'fixture-response-secret', base64Encoded: false };
        return {};
    });
    const store = createBrowserDiagnosticsDaemonStore({ machineId: 'machine', maxEventsPerView: 1 });
    const runtime = createSidecarCdpDiagnosticsRuntime({ ownerAccountId: 'owner', store, isEnabled: () => true,
        contextCapture: { transport: { dispatchPageCommand }, resolvePageHandle: () => ({ targetId: 'target', sessionId: 'cdp' }),
            subscribeCdpEvents(listener) { cdp = listener; return () => { cdp = () => {}; }; },
            subscribeViewLifecycle(listener) { lifecycle = listener; return () => {}; } } });
    const routes = createBrowserDiagnosticsRoutes({ store, readRequestDetail: runtime.readRequestDetail });
    let handler: RpcHandler<unknown, unknown> = () => {};
    const rpc: RpcHandlerRegistrar = { registerHandler(method, read) {
        // Erase only the generic transport registration; the real handler validates each payload.
        if (method === RPC_METHODS.DAEMON_BROWSER_DIAGNOSTICS_SNAPSHOT) handler = read as RpcHandler<unknown, unknown>;
    } };
    registerDaemonBrowserDiagnosticsSnapshotHandler(rpc, { browserDiagnostics: routes });
    lifecycle({ type: 'bound', ...view });
    const emit = (method: string, params: Record<string, unknown>) => cdp({ sessionId: 'cdp', method, params });
    const person = { callerAuthority: 'present_user' as const, signal: new AbortController().signal };
    const read = (payload: unknown, authority: RpcHandlerContext = person) => handler(payload, authority);
    return { emit, read, store, runtime, commands, dispatchPageCommand };
}

describe('selected-request diagnostics through the person RPC', () => {
    it('acquires bodies only on selection, keeps cookie values private, and denies agents before acquisition', async () => {
        const h = harness();
        h.emit('Network.requestWillBeSentExtraInfo', { requestId: 'raw', headers: { Cookie: 'sid=fixture-cookie-secret' },
            associatedCookies: [{ cookie: { name: 'sid', value: 'fixture-cookie-secret', domain: 'example.test', path: '/', secure: true, httpOnly: true }, blockedReasons: ['SecureOnly'] }] });
        h.emit('Network.requestWillBeSent', { requestId: 'raw', timestamp: 1,
            request: { method: 'POST', url: 'https://example.test/', hasPostData: true } });
        h.emit('Network.responseReceivedExtraInfo', { requestId: 'raw', headers: { 'Set-Cookie': 'sid=fixture-new-secret; Secure' },
            blockedCookies: [{ cookieLine: 'sid=fixture-new-secret; Secure', blockedReasons: ['SameSiteNoneInsecure'] }] });
        h.emit('Network.responseReceived', { requestId: 'raw', hasExtraInfo: true, response: { url: 'https://example.test/', status: 200 } });
        h.emit('Network.loadingFinished', { requestId: 'raw', timestamp: 2, encodedDataLength: 123 });
        expect(h.commands.filter(method => method.startsWith('Network.get'))).toEqual([]);
        const event = h.store.getViewSnapshot(view).events.find(event => event.family === 'network')!;
        const payload = { machineId: 'machine', view, requestId: event.data.requestId };
        const denied = await h.read(payload, { callerAuthority: 'account_automation', signal: new AbortController().signal });
        expect(denied).toMatchObject({ requestDetail: { status: 'unavailable', reason: 'permission_denied' } });
        expect(h.commands.filter(method => method.startsWith('Network.get'))).toEqual([]);
        const response = await h.read(payload);
        expect(response).toMatchObject({ requestDetail: { status: 'available', requestId: event.data.requestId,
            requestBody: { status: 'available', text: 'fixture-request-secret', encoding: 'utf8' },
            responseBody: { status: 'available', text: 'fixture-response-secret', encoding: 'utf8' },
            requestExtraInfo: [{ cookieHeader: 'sid=fixture-cookie-secret', cookies: [{ name: 'sid', value: 'fixture-cookie-secret', blockedReasons: ['SecureOnly'] }] }],
            responseExtraInfo: [{ setCookieHeaders: ['sid=fixture-new-secret; Secure'], cookies: [{ cookieLine: 'sid=fixture-new-secret; Secure', blockedReasons: ['SameSiteNoneInsecure'] }] }],
        } });
        expect(h.commands.filter(method => method.startsWith('Network.get'))).toEqual(['Network.getRequestPostData', 'Network.getResponseBody']);
        expect(JSON.stringify(h.store.getSnapshot())).not.toContain('fixture-');
        const snapshot = await h.read({ machineId: 'machine', view });
        expect(JSON.stringify(snapshot)).not.toContain('fixture-');
        h.runtime.dispose();
    });

    it('settles retained failures, binary bodies and eviction without raw CDP errors or new acquisition', async () => {
        const h = harness();
        h.emit('Network.requestWillBeSent', { requestId: 'raw', request: { method: 'GET', url: 'https://example.test/' } });
        h.emit('Network.loadingFinished', { requestId: 'raw', timestamp: 2 });
        const requestId = h.store.getViewSnapshot(view).events.find(event => event.family === 'network')!.data.requestId;
        h.dispatchPageCommand.mockImplementation(async input => {
            if (input.method === 'Network.getResponseBody') return { body: 'AAEC', base64Encoded: true };
            throw new Error('fixture-secret-in-error');
        });
        const payload = { machineId: 'machine', view, requestId };
        expect(await h.read(payload)).toMatchObject({ requestDetail: { status: 'available',
            requestBody: { status: 'unavailable', reason: 'not_captured' }, responseBody: { status: 'available', text: 'AAEC', encoding: 'base64' } } });
        h.dispatchPageCommand.mockRejectedValue(new Error('fixture-secret-in-error'));
        const failed = await h.read(payload);
        expect(failed).toMatchObject({ requestDetail: { responseBody: { status: 'unavailable', reason: 'body_unavailable' } } });
        expect(JSON.stringify(failed)).not.toContain('fixture-secret-in-error');
        h.emit('Network.requestWillBeSent', { requestId: 'next', request: { method: 'GET', url: 'https://example.test/next' } });
        h.dispatchPageCommand.mockClear();
        expect(await h.read(payload)).toMatchObject({ requestDetail: { status: 'unavailable', reason: 'request_evicted' } });
        expect(h.dispatchPageCommand).not.toHaveBeenCalled();
        h.runtime.dispose();
    });
});
