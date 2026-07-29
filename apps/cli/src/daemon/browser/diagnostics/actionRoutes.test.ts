import { describe, expect, it, vi } from 'vitest';

import { createBrowserDiagnosticsActionRoutes } from './actionRoutes';
import { createBrowserDiagnosticsDaemonStore, type BrowserDiagnosticsDaemonStore } from './store';

const view = { browserSessionId: 'browser_session_1', viewId: 'view_1' } as const;

function diagnosticEvent(
  eventId: string,
  target: Readonly<{ browserSessionId: string; viewId: string }>,
  capturedAtMs: number,
) {
  return {
    v: 1 as const,
    eventId,
    browserSessionId: target.browserSessionId,
    viewId: target.viewId,
    navigationGeneration: 1,
    capturedAtMs,
    family: 'network' as const,
    kind: 'network.requestStarted' as const,
    fidelity: 'cdp' as const,
    trusted: true,
    data: {
      method: 'GET',
      url: `https://example.test/${eventId}.js`,
    },
    redaction: { level: 'metadataOnly' as const, queryRedacted: true, headersRedacted: true, truncated: false },
  };
}

function emptyDiagnosticsSnapshot() {
  return { v: 1 as const, machineId: 'm', generatedAt: 0, refreshState: 'idle' as const, events: [], diagnostics: [] };
}

function createDiagnosticsStore(
  overrides: Partial<Pick<BrowserDiagnosticsDaemonStore, 'getSnapshot' | 'getViewSnapshot' | 'clearView' | 'clearSession'>> = {},
) {
  const getSnapshot = () => emptyDiagnosticsSnapshot();
  return {
    getSnapshot,
    getViewSnapshot: getSnapshot,
    clearView: vi.fn(),
    clearSession: vi.fn(),
    ...overrides,
  } satisfies Pick<BrowserDiagnosticsDaemonStore, 'getSnapshot' | 'getViewSnapshot' | 'clearView' | 'clearSession'>;
}

describe('browser diagnostics action routes (DEV-5)', () => {
  it('snapshot returns the live store snapshot (route contract: not *_route_unavailable)', async () => {
    const store = createBrowserDiagnosticsDaemonStore({ machineId: 'machine_1', now: () => 5000 });
    const owner = createBrowserDiagnosticsActionRoutes({ store });
    const result = await owner.dispatch('browser.diagnostics.snapshot', view);
    expect(result).toMatchObject({ v: 1, machineId: 'machine_1', generatedAt: 5000, events: [] });
  });

  it('snapshot returns only diagnostics for the requested browser view', async () => {
    const store = createBrowserDiagnosticsDaemonStore({ machineId: 'machine_1', now: () => 5000 });
    store.publishEvent(diagnosticEvent('evt_view_1', view, 1));
    store.publishEvent(diagnosticEvent('evt_view_2', { browserSessionId: 'browser_session_2', viewId: 'view_2' }, 2));
    const owner = createBrowserDiagnosticsActionRoutes({ store });

    const result = await owner.dispatch('browser.diagnostics.snapshot', view);

    expect(result).toMatchObject({ v: 1, machineId: 'machine_1', generatedAt: 5000 });
    expect((result as { events?: Array<{ eventId: string }> }).events?.map((event) => event.eventId)).toEqual(['evt_view_1']);
    expect(JSON.stringify(result)).not.toContain('evt_view_2');
  });

  it('snapshot redacts owner-only diagnostic values for runtime-action egress', async () => {
    const owner = createBrowserDiagnosticsActionRoutes({
      store: createDiagnosticsStore({
        getSnapshot: () => ({
          v: 1 as const,
          machineId: 'machine_1',
          generatedAt: 5000,
          refreshState: 'idle' as const,
          diagnostics: [],
          events: [],
        }),
        getViewSnapshot: () => ({
          v: 1 as const,
          machineId: 'machine_1',
          generatedAt: 5000,
          refreshState: 'idle' as const,
          diagnostics: [],
          events: [
            {
              v: 1 as const,
              eventId: 'evt_network_owner_values',
              browserSessionId: 'browser_session_1',
              viewId: 'view_1',
              navigationGeneration: 1,
              capturedAtMs: 1,
              family: 'network' as const,
              kind: 'network.response' as const,
              fidelity: 'injectedPage' as const,
              trusted: false,
              collector: { collectorId: 'collector_1', nonce: 'nonce_1', version: '1.0.0' },
              data: {
                requestId: 'req_1',
                method: 'POST',
                statusCode: 200,
                requestHeaders: { 'content-type': 'application/json' },
                responseBodyText: 'owner-only-secret-body',
              },
              redaction: { level: 'none' as const, queryRedacted: true, headersRedacted: false, truncated: false },
            },
            {
              v: 1 as const,
              eventId: 'evt_storage_owner_values',
              browserSessionId: 'browser_session_1',
              viewId: 'view_1',
              navigationGeneration: 1,
              capturedAtMs: 2,
              family: 'storage' as const,
              kind: 'storage.keyInventory' as const,
              fidelity: 'injectedPage' as const,
              trusted: false,
              collector: { collectorId: 'collector_1', nonce: 'nonce_1', version: '1.0.0' },
              data: {
                storageType: 'localStorage',
                keyCount: 1,
                keysTruncated: false,
                keys: ['theme'],
                entries: [{ key: 'theme', value: 'owner-only-storage-value', valueTruncated: false }],
              },
              redaction: { level: 'none' as const, queryRedacted: true, headersRedacted: false, truncated: false },
            },
          ],
        }),
      }),
    });

    const result = await owner.dispatch('browser.diagnostics.snapshot', view);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('owner-only-secret-body');
    expect(serialized).not.toContain('owner-only-storage-value');
    expect(result).toMatchObject({
      events: [
        {
          data: expect.objectContaining({ method: 'POST' }),
          redaction: expect.objectContaining({ level: 'metadataOnly' }),
        },
        {
          data: expect.objectContaining({ keys: ['theme'] }),
          redaction: expect.objectContaining({ level: 'metadataOnly' }),
        },
      ],
    });
  });

  it('clear routes to the store clearView for the targeted view', async () => {
    const clearView = vi.fn();
    const owner = createBrowserDiagnosticsActionRoutes({
      store: createDiagnosticsStore({ clearView }),
    });
    await expect(owner.dispatch('browser.diagnostics.clear', view)).resolves.toEqual({ ok: true });
    expect(clearView).toHaveBeenCalledWith(view);
  });

  it('clear releases live object groups for the targeted view before clearing the store', async () => {
    const calls: string[] = [];
    const clearView = vi.fn(() => calls.push('clearView'));
    const releaseObjectGroupsForView = vi.fn(async () => {
      calls.push('releaseObjectGroupsForView');
    });
    const interaction = {
      dispatch: vi.fn(),
      dispose: vi.fn(),
      releaseObjectGroupsForView,
    };
    const owner = createBrowserDiagnosticsActionRoutes({
      store: createDiagnosticsStore({ clearView }),
      interaction,
    });

    await expect(owner.dispatch('browser.diagnostics.clear', view)).resolves.toEqual({ ok: true });
    expect(releaseObjectGroupsForView).toHaveBeenCalledWith(view);
    expect(calls).toEqual(['releaseObjectGroupsForView', 'clearView']);
  });

  it('clear returns invalid_parameters without a viewId', async () => {
    const clearView = vi.fn();
    const owner = createBrowserDiagnosticsActionRoutes({
      store: createDiagnosticsStore({ clearView }),
    });
    await expect(owner.dispatch('browser.diagnostics.clear', { browserSessionId: 'browser_session_1' })).resolves.toEqual({
      ok: false,
      errorCode: 'invalid_parameters',
      error: 'invalid_parameters',
    });
    expect(clearView).not.toHaveBeenCalled();
  });

  it('interaction verbs dispatch through the live transport when present', async () => {
    const dispatch = vi.fn(async () => ({ ok: true as const }));
    const owner = createBrowserDiagnosticsActionRoutes({
      store: createDiagnosticsStore(),
      interaction: { dispatch, dispose: vi.fn() },
    });
    await owner.dispatch('browser.diagnostics.pause', view);
    await owner.dispatch('browser.diagnostics.resume', view);
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it('interaction verbs fail closed when no live transport is wired', async () => {
    const owner = createBrowserDiagnosticsActionRoutes({
      store: createDiagnosticsStore(),
    });
    await expect(owner.dispatch('browser.diagnostics.pause', view)).resolves.toEqual({
      ok: false,
      errorCode: 'runtime_action_disabled',
      error: 'runtime_action_disabled:browser:browser_diagnostics_route_unavailable',
    });
  });
});
