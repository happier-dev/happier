import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { renderHook, standardCleanup } from '@/dev/testkit';
import { installBrowserRuntimeForTests } from '@/dev/testkit/harness/browserRuntimeHarness';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { buildBrowserAdapterCapabilities } from '@/sync/domains/browser/adapters/capabilities';
import type { BrowserControlViewState } from '@/sync/domains/browser/control';
import type { BrowserDiagnosticsRequestDetailClientInput, BrowserDiagnosticsRequestDetailClientResult } from './machineRpc';
import { BrowserDiagnosticEventV1Schema, BrowserDiagnosticsSnapshotV1Schema, DaemonBrowserDiagnosticsSnapshotResponseV1Schema } from '@happier-dev/protocol/browser/diagnostics/v1';
import { createBrowserDiagnosticsDaemonStore } from '../../../../../../cli/src/daemon/browser/diagnostics/store';
import { createBrowserDiagnosticsRoutes } from '../../../../../../cli/src/daemon/browser/diagnostics/routes';
import { applyBrowserDiagnosticEvents, createBrowserDiagnosticsUiStore } from './store';
import { useBrowserDiagnosticsDaemonSnapshot, useBrowserDiagnosticsRequestDetail, type BrowserDiagnosticsSnapshotClient } from './daemonSnapshot';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
// Only the RPC transport is replaced; demand, event selection and cancellation stay real.
const recoveryListeners = vi.hoisted(() => new Set<() => void>());
vi.mock('./machineRpc', () => ({ fetchBrowserDiagnosticsSnapshotViaMachineRpc: vi.fn(), fetchBrowserDiagnosticsRequestDetailViaMachineRpc: vi.fn() }));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/subscribeMachineRpcRecovery', () => ({
    subscribeMachineRpcRecovery: (_input: unknown, recover: () => void) => {
        recoveryListeners.add(recover);
        return () => { recoveryListeners.delete(recover); };
    },
}));

it('fetches selected-request values only while demanded, cancels on close and never publishes a stale selection', async () => {
    const settles: ((result: BrowserDiagnosticsRequestDetailClientResult) => void)[] = [];
    const requests: BrowserDiagnosticsRequestDetailClientInput[] = [];
    const client = vi.fn((input: BrowserDiagnosticsRequestDetailClientInput): Promise<BrowserDiagnosticsRequestDetailClientResult> => {
        requests.push(input);
        return new Promise(resolve => { settles.push(resolve); });
    });
    let selectedRequestId: string | null = null;
    const hook = await renderHook(() => useBrowserDiagnosticsRequestDetail({ view, selectedRequestId, detailClient: client }));
    expect(client).not.toHaveBeenCalled();
    selectedRequestId = 'request-a';
    await hook.rerender();
    expect(client).toHaveBeenCalledTimes(1);
    expect(hook.getCurrent()).toMatchObject({ status: 'loading' });
    selectedRequestId = 'request-b';
    await hook.rerender();
    expect(requests[0].signal?.aborted).toBe(true);
    await act(async () => { settles[0]({ ok: true, detail: { status: 'unavailable', reason: 'request_evicted' } }); });
    expect(hook.getCurrent()).toMatchObject({ status: 'loading' });
    await act(async () => { settles[1]({ ok: true, detail: { status: 'unavailable', reason: 'page_unavailable' } }); });
    expect(hook.getCurrent()).toMatchObject({ status: 'unavailable', reason: 'page_unavailable' });
    selectedRequestId = null;
    await hook.rerender();
    expect(requests[1].signal?.aborted).toBe(true);
    expect(hook.getCurrent()).toEqual({ status: 'idle' });
    expect(client).toHaveBeenCalledTimes(2);
    await hook.unmount();
});

const browser = await installBrowserRuntimeForTests({ url: 'https://diagnostics.test/' });
let visible = true;
Object.defineProperty(browser.document, 'visibilityState', { configurable: true,
    get: () => visible ? 'visible' : 'hidden' });
beforeEach(() => {
    browser.activate();
    visible = true;
    browser.document.dispatchEvent(new browser.window.Event('visibilitychange'));
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
});
afterEach(() => { standardCleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });
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

it('publishes pending, retained-disconnected and recovered state without a polling timer', async () => {
    let settle: (result: Awaited<ReturnType<BrowserDiagnosticsSnapshotClient>>) => void = () => {};
    const snapshotClient = vi.fn<BrowserDiagnosticsSnapshotClient>(() => new Promise(resolve => { settle = resolve; }));
    const onSnapshotState = vi.fn();
    const hook = await renderHook(() => useBrowserDiagnosticsDaemonSnapshot({ view, snapshotClient, onEvents: () => {}, onSnapshotState }));
    expect(onSnapshotState).toHaveBeenLastCalledWith(expect.objectContaining({ connection: 'connecting' }));
    await act(async () => { settle({ ok: false, reason: 'request_failed' }); });
    expect(onSnapshotState).toHaveBeenLastCalledWith(expect.objectContaining({ connection: 'disconnected', reasonCode: 'request_failed' }));
    await act(async () => { for (const recover of recoveryListeners) recover(); });
    const snapshot = BrowserDiagnosticsSnapshotV1Schema.parse({ v: 1, machineId: 'machine', generatedAt: 42,
        refreshState: 'idle', events: [], diagnostics: [{ code: 'events_evicted', count: 3,
            browserSessionId: view.browserSessionId, viewId: view.viewId, navigationGeneration: 1 },
            { code: 'snapshot_events_omitted', count: 2, browserSessionId: view.browserSessionId, viewId: view.viewId, navigationGeneration: 1 }] });
    await act(async () => { settle({ ok: true, snapshot, revision: 2 }); });
    expect(onSnapshotState).toHaveBeenLastCalledWith(expect.objectContaining({ connection: 'connected', evictedEventCount: 3, omittedEventCount: 2 }));
    expect(vi.getTimerCount()).toBe(0);
    await hook.unmount();
});

it.each(['chromiumSidecar', 'streamedBrowserSurface'] as const)('reads the exact %s view on its host Machine', async adapterKind => {
    const snapshotClient = vi.fn<BrowserDiagnosticsSnapshotClient>(async () => ({ ok: false, reason: 'unavailable' }));
    const managedView = { ...view, browserSessionId: 'managed-browser-session', adapterKind,
        target: { kind: 'streamedBrowser' as const, targetId: 'managed-source', streamId: 'managed-source',
            daemonView: { browserSessionId: 'managed-browser-session', viewId: view.viewId } } };
    const hook = await renderHook(() => useBrowserDiagnosticsDaemonSnapshot({ view: managedView,
        machineId: 'target-machine', serverId: 'target-home', snapshotClient, onEvents: () => {} }));
    expect(snapshotClient).toHaveBeenCalledOnce();
    expect(snapshotClient).toHaveBeenCalledWith(expect.objectContaining({ machineId: 'target-machine', serverId: 'target-home',
        view: { browserSessionId: 'managed-browser-session', viewId: view.viewId, navigationGeneration: view.navigationGeneration } }));
    await hook.unmount();
});

it('keeps preview Machine authority and does not grant client-local views a daemon source from host context', async () => {
    const snapshotClient = vi.fn<BrowserDiagnosticsSnapshotClient>(async () => ({ ok: false, reason: 'unavailable' }));
    const preview = await renderHook(() => useBrowserDiagnosticsDaemonSnapshot({ view, machineId: 'different-host-machine',
        snapshotClient, onEvents: () => {} }));
    expect(snapshotClient).toHaveBeenCalledWith(expect.objectContaining({ machineId: 'machine' }));
    await preview.unmount();
    snapshotClient.mockClear();
    const localView = { ...view, adapterKind: 'externalUrl' as const,
        target: { kind: 'externalUrl' as const, targetId: 'local', url: 'https://client.test/' } };
    const client = await renderHook(() => useBrowserDiagnosticsDaemonSnapshot({ view: localView, machineId: 'host-machine',
        snapshotClient, onEvents: () => {} }));
    expect(snapshotClient).not.toHaveBeenCalled();
    await client.unmount();
    const empty = await renderHook(() => useBrowserDiagnosticsDaemonSnapshot({ view: null, machineId: 'host-machine',
        snapshotClient, onEvents: () => {} }));
    expect(snapshotClient).not.toHaveBeenCalled();
    await empty.unmount();
});

it('bootstraps once, then delivers daemon changes without rereading unchanged history', async () => {
    const store = createBrowserDiagnosticsDaemonStore({ machineId: 'machine', now: () => 42 });
    const routes = createBrowserDiagnosticsRoutes({ store });
    const event = BrowserDiagnosticEventV1Schema.parse({ v: 1, eventId: 'history', browserSessionId: view.browserSessionId,
        viewId: view.viewId, navigationGeneration: view.navigationGeneration, capturedAtMs: 1,
        family: 'pageInfo', kind: 'pageInfo.snapshot', fidelity: 'nativeCallback', trusted: true,
        redaction: { level: 'metadataOnly' }, data: { loading: false } });
    // Fill the daemon's existing retained ring, rather than projecting a synthetic transport reply.
    for (let n = 0; n < 1_000; n++) store.publishEvent({ ...event, eventId: `history-${n}`, capturedAtMs: n });
    const transported: number[] = [];
    const client = vi.fn<BrowserDiagnosticsSnapshotClient>(async input => {
        const response = DaemonBrowserDiagnosticsSnapshotResponseV1Schema.parse({ protocolVersion: 1,
            ...await routes.readViewSnapshot({ ...view, sinceRevision: input.sinceRevision, signal: input.signal }) });
        transported.push(response.snapshot.events.length);
        return { ok: true, ...response };
    });
    let uiState = createBrowserDiagnosticsUiStore();
    const onEvents = vi.fn<Parameters<typeof useBrowserDiagnosticsDaemonSnapshot>[0]['onEvents']>(events => {
        uiState = applyBrowserDiagnosticEvents(uiState, { events });
    });
    const hook = await renderHook(() => useBrowserDiagnosticsDaemonSnapshot({ view, snapshotClient: client, onEvents }));
    expect(transported).toEqual([1_000]);
    expect(onEvents.mock.calls.map(([events]) => events.length)).toEqual([1_000]);
    await act(async () => { await vi.advanceTimersByTimeAsync(300_000); });
    expect(transported).toEqual([1_000]);
    const pushed = { ...event, eventId: 'pushed', capturedAtMs: 1_001 };
    await act(async () => { store.publishEvent(pushed); });
    expect(transported).toEqual([1_000, 1]);
    expect(onEvents.mock.calls.map(([events]) => events.length)).toEqual([1_000, 1]);
    expect(Object.values(uiState.viewsByKey)[0].events).toContainEqual(pushed);
    const changed = { ...pushed, data: { loading: true } };
    await act(async () => { store.publishEvent(changed); });
    expect(transported).toEqual([1_000, 1, 1]);
    expect(Object.values(uiState.viewsByKey)[0].events).toContainEqual(changed);
    await act(async () => { for (let n = 0; n < 10; n++) store.publishEvent(changed); });
    expect(transported).toEqual([1_000, 1, 1]);
    expect(onEvents.mock.calls.map(([events]) => events.length)).toEqual([1_000, 1, 1]);
    await act(async () => { for (const recover of recoveryListeners) recover(); });
    expect(transported).toEqual([1_000, 1, 1, 1_000]);
    expect(onEvents.mock.calls.map(([events]) => events.length)).toEqual([1_000, 1, 1, 1_000]);
    expect(vi.getTimerCount()).toBe(0);
    await hook.unmount();
});

it('rebootstraps after transport recovery and retires the prior pending watch', async () => {
    const snapshot = BrowserDiagnosticsSnapshotV1Schema.parse({ v: 1, machineId: 'machine', generatedAt: 42,
        refreshState: 'idle', events: [] });
    const snapshotClient = vi.fn<BrowserDiagnosticsSnapshotClient>(async () => ({ ok: true, snapshot, revision: 0 }));
    const watchClient = vi.fn<BrowserDiagnosticsSnapshotClient>(() => new Promise(() => {}));
    const client: BrowserDiagnosticsSnapshotClient = input => input.sinceRevision === undefined ? snapshotClient(input) : watchClient(input);
    const hook = await renderHook(() => useBrowserDiagnosticsDaemonSnapshot({ view, snapshotClient: client, onEvents: () => {} }));
    const firstSignal = watchClient.mock.calls[0]?.[0].signal;
    await act(async () => { for (const recover of recoveryListeners) recover(); });
    expect(firstSignal?.aborted).toBe(true);
    expect(snapshotClient).toHaveBeenCalledTimes(2);
    expect(watchClient).toHaveBeenCalledTimes(2);
    await hook.unmount();
    expect(recoveryListeners.size).toBe(0);
});

it('does not acquire a snapshot when a presented drawer first mounts in a hidden document', async () => {
    visible = false;
    browser.document.dispatchEvent(new browser.window.Event('visibilitychange'));
    const snapshotClient = vi.fn<BrowserDiagnosticsSnapshotClient>(async () => ({ ok: false, reason: 'unavailable' }));
    const hook = await renderHook(() => useBrowserDiagnosticsDaemonSnapshot({ view, snapshotClient, onEvents: () => {} }));
    expect(snapshotClient).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => {
        visible = true;
        browser.document.dispatchEvent(new browser.window.Event('visibilitychange'));
    });
    expect(snapshotClient).toHaveBeenCalledTimes(1);
    await hook.unmount();
});

it.each(['host', 'layout'] as const)('ends snapshot demand while %s is hidden and resumes current history', async hiddenOwner => {
    let presented = true;
    const onEvents = vi.fn();
    const signals: AbortSignal[] = [];
    const snapshotClient = vi.fn<BrowserDiagnosticsSnapshotClient>(async input => {
        if (input.signal) signals.push(input.signal);
        return { ok: false, reason: 'unavailable' };
    });
    const hook = await renderHook(() => useBrowserDiagnosticsDaemonSnapshot({ view, snapshotClient, onEvents }), {
        wrapper: props => <PluginSurfaceFocusEligibilityProvider active={presented}>{props.children}</PluginSurfaceFocusEligibilityProvider>,
    });
    expect(snapshotClient).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(snapshotClient).toHaveBeenCalledTimes(1);
    expect(snapshotClient).toHaveBeenCalledWith(expect.objectContaining({
        view: { browserSessionId: view.browserSessionId, viewId: view.viewId, navigationGeneration: view.navigationGeneration },
    }));
    if (hiddenOwner === 'host') {
        await act(async () => {
            visible = false;
            browser.document.dispatchEvent(new browser.window.Event('visibilitychange'));
        });
    } else {
        presented = false;
        await hook.rerender();
    }
    snapshotClient.mockClear();
    await act(async () => { await vi.advanceTimersByTimeAsync(300_000); });
    expect(snapshotClient).toHaveBeenCalledTimes(0);
    expect(signals[0]?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);

    // An unavailable supplemental source must not disturb local history. On
    // re-presentation, the selected view's daemon history is delivered again.
    snapshotClient.mockRejectedValueOnce(new Error('RPC unavailable'));
    if (hiddenOwner === 'host') {
        await act(async () => {
            visible = true;
            browser.document.dispatchEvent(new browser.window.Event('visibilitychange'));
        });
    } else {
        presented = true;
        await hook.rerender();
    }
    expect(snapshotClient).toHaveBeenCalledTimes(1);
    expect(onEvents).not.toHaveBeenCalled();
    const snapshot = BrowserDiagnosticsSnapshotV1Schema.parse({ v: 1, machineId: 'machine', generatedAt: 42,
        refreshState: 'idle', events: [{ v: 1, eventId: 'history', browserSessionId: view.browserSessionId,
            viewId: view.viewId, navigationGeneration: view.navigationGeneration, capturedAtMs: 41,
            family: 'pageInfo', kind: 'pageInfo.snapshot', fidelity: 'nativeCallback', trusted: true,
            redaction: { level: 'metadataOnly' }, data: { loading: false } }] });
    snapshotClient.mockResolvedValue({ ok: true, snapshot });
    await act(async () => { presented = false; });
    await hook.rerender();
    await act(async () => { presented = true; });
    await hook.rerender();
    expect(onEvents).toHaveBeenLastCalledWith(snapshot.events);
    await hook.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(300_000); });
    expect(snapshotClient).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
});
