import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserInjectedRuntimeResultMessageV1Schema, BrowserAutomationActionResultV1Schema, UiBrowserAutomationDispatchRequestV1Schema, UiBrowserAutomationDispatchResultV1Schema, uiBrowserAutomationDispatchMethod, type RuntimeActionExecuteArgs } from '@happier-dev/protocol';

import { handleUiBrowserAutomationDispatchRequest } from './reverseDispatchHandler';
import { createBrowserAutomationControlService } from './controlService';
import { registerBrowserRuntimeControlAdapter, clearBrowserRuntimeControlRegistryForTests } from '../actions/runtimeControlRegistry';
import { applyBrowserControlEvent, createBrowserControlState } from '../control/reducer';
import { buildBrowserAdapterCapabilities } from '../adapters/capabilities';
import { createInjectedPageAutomationOwner } from '@/components/browser/adapters/automation/injectedPageRuntime';
import { createActionExecutor, FeaturesResponseSchema } from '@happier-dev/protocol';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit';
import { loadBrowserDaemonRuntimeForTests } from '@/dev/testkit/harness/browserDaemonRuntime';
import { openExternalUrl } from '@/utils/url/openExternalUrl';

import type { DesktopWebViewNativeAvailability } from '../adapters/desktopWebView';
import { importSavedSecretPasskeysInContext } from '@/sync/ops/actions/browserProfileLoginsImport';

const { nativeInvoke, nativeHost } = vi.hoisted(() => ({ nativeInvoke: vi.fn(), nativeHost: vi.fn(() => true) }));
vi.mock('@/utils/platform/desktopHost', async importOriginal => ({
  ...await importOriginal<typeof import('@/utils/platform/desktopHost')>(),
  isDesktopHost: nativeHost,
  invokeDesktopHost: (command: string, input?: Record<string, unknown>) => nativeInvoke(command, input),
}));

const desktopAvailability: DesktopWebViewNativeAvailability = {
  available: true, platform: 'macos', primitive: 'macosNsViewWebKit', renderEngine: 'desktopWebView',
  producer: 'tauriWryNativeChildView', privilegedIpc: false, disabledReasons: [],
  supports: { navigation: true, goBackForward: true, reload: true, stop: true,
    pageInfoDiagnostics: true, nativeDevtools: true, capture: true, recording: false, automation: true },
};

// The system browser is the only effect substituted in this composed route.
vi.mock('@/utils/url/openExternalUrl', () => ({ openExternalUrl: vi.fn(async () => true) }));

const view = { browserSessionId: 'visible-session', viewId: 'visible-view' };
const boundView = { ...view, sessionId: 'happier-session' };
const request = { v: 1, ...view, automationRequestId: 'click-1', actionKind: 'click', navigationGeneration: 0, requestedBy: 'agent', requesterRef: { kind: 'agent', id: 'agent-1' }, timeoutMs: 1000, payload: { selector: '#button' } } as const;
const args: RuntimeActionExecuteArgs = { actionId: 'browser.automation.click', input: request,
  context: { surface: 'agent', authority: 'account_automation', defaultSessionId: 'happier-session' } };
const { createDaemonRuntimeActionExecutor, createBrowserAutomationReverseDispatcher } = await loadBrowserDaemonRuntimeForTests();

function mountView(executePageAction?: (signal: AbortSignal) => Promise<Readonly<{ status: 'succeeded' }>>, withAutomation = true,
  availability?: DesktopWebViewNativeAvailability, adapterKind: 'localPreview' | 'externalUrl' = 'localPreview') {
  const controlService = createBrowserAutomationControlService({ nowMs: () => Date.now() });
  let clicks = 0;
  // The page transport is the real system boundary; controller and Action internals stay real.
  controlService.registerOwner({ ownerId: 'mounted-owner', ...view, navigationGeneration: 0, authority: 'uiLocal', adapterKind, fidelity: 'injectedPage', trustedInput: false, supportedActions: ['click'], executeAction: async (_request, context) => { clicks += 1; return executePageAction ? executePageAction(context.signal) : { status: 'succeeded', resultSummary: { clicked: true, cookie: 'secret' } }; } });
  const state = applyBrowserControlEvent(applyBrowserControlEvent(createBrowserControlState(), {
    kind: 'sessionCreated', eventId: 'session-created', browserSessionId: view.browserSessionId, profileId: 'profile-1', occurredAt: 1,
  }), {
    kind: 'viewOpened', eventId: 'view-opened', ...view, occurredAt: 2, platform: availability ? 'desktop' : 'web', adapterKind, engineKind: availability ? 'desktopWebView' : 'webIframe',
    target: { kind: 'externalUrl', targetId: 'page', url: 'https://example.test', display: { title: 'Page', addressLabel: 'example.test' } },
    adapterCapabilities: buildBrowserAdapterCapabilities({ adapterKind, supportedTargetKinds: ['externalUrl'], supportedRenderEngines: [availability ? 'desktopWebView' : 'webIframe'] }),
  });
  const dispose = registerBrowserRuntimeControlAdapter({ browserSessionId: view.browserSessionId, control: {
    readState: () => state, applyDispatchResult: () => {}, readDispatchOptions: () => ({ desktopWebViewAvailability: availability }),
  },
    ...(withAutomation ? { automation: { controlService } } : {}) });
  return { dispose, controlService, state, clicks: () => clicks };
}

afterEach(() => {
  clearBrowserRuntimeControlRegistryForTests();
  nativeInvoke.mockReset();
  nativeHost.mockReturnValue(true);
  vi.useRealTimers();
});

describe('daemon to exact mounted UI browser Action', () => {
  it('opens native DevTools from the public agent Action through the exact mounted view without automation', async () => {
    const mounted = mountView(undefined, false, desktopAvailability);
    let enabled = true;
    nativeInvoke.mockResolvedValue({ ok: true, availability: desktopAvailability });
    const runtimeActionExecute = createDaemonRuntimeActionExecutor({ env: { NODE_ENV: 'test' },
      resolveRouteOwners: () => ({ browserUiAutomation: { ownsAutomationView: () => false,
        uiAutomation: createBrowserAutomationReverseDispatcher({ getMachineClient: () => ({
          callConnectedClientRpc: async (method, payload) => {
            expect(method).toBe(uiBrowserAutomationDispatchMethod(view));
            const wire = UiBrowserAutomationDispatchRequestV1Schema.parse(payload);
            return { ok: true, result: UiBrowserAutomationDispatchResultV1Schema.parse(
              await handleUiBrowserAutomationDispatchRequest(wire, boundView)) };
          },
        }) }),
      } }),
      resolveServerFeaturesSnapshot: () => ({ status: 'ready', features: FeaturesResponseSchema.parse({ features: {
        browser: { enabled: true, viewTargets: { enabled: true }, internal: { enabled: true }, sidecar: { enabled: true } },
      } }) }),
    });
    const executor = createActionExecutor(createActionExecutorBoundaryFixture({ runtimeActionExecute, isActionEnabled: () => enabled }));
    const input = { ...view, commandId: 'open-devtools' };
    const context = { ...args.context, bypassApprovals: true,
      externalActionTarget: { kind: 'machine' as const, machineId: 'machine-1' } };
    const result = await executor.execute('browser.view.openDevtools', input, context);
    expect(result, JSON.stringify(result))
      .toMatchObject({ ok: true, result: { status: 'dispatched', commandId: input.commandId, adapterKind: 'localPreview' } });
    expect(nativeInvoke).toHaveBeenCalledWith('desktop_browser_open_devtools', { request: view });
    nativeInvoke.mockClear();
    enabled = false;
    expect(await executor.execute('browser.view.openDevtools', input, context)).toMatchObject({ ok: false });
    expect(nativeInvoke).not.toHaveBeenCalled();
    enabled = true;
    mounted.dispose();
    expect(await executor.execute('browser.view.openDevtools', input, context))
      .toMatchObject({ ok: false, errorCode: 'runtime_action_disabled' });
    expect(nativeInvoke).not.toHaveBeenCalled();
  });

  it.each([undefined, { ...desktopAvailability, supports: { ...desktopAvailability.supports, nativeDevtools: false } }])(
    'refuses DevTools on an unsupported mounted engine before invoking native code', async availability => {
      mountView(undefined, false, availability);
      expect(await handleUiBrowserAutomationDispatchRequest({ v: 1, sessionId: boundView.sessionId,
        actionId: 'browser.view.openDevtools', input: { ...view, commandId: 'unsupported-devtools' },
        authority: 'account_automation' }, boundView)).toMatchObject({ ok: false, errorCode: 'runtime_action_disabled' });
      expect(nativeInvoke).not.toHaveBeenCalled();
    });

  it('does not report DevTools opened when the native bridge refuses', async () => {
    mountView(undefined, false, desktopAvailability);
    nativeInvoke.mockResolvedValue({ ok: false, availability: desktopAvailability });
    expect(await handleUiBrowserAutomationDispatchRequest({ v: 1, sessionId: boundView.sessionId,
      actionId: 'browser.view.openDevtools', input: { ...view, commandId: 'refused-devtools' },
      authority: 'account_automation' }, boundView)).toMatchObject({ ok: false, errorCode: 'runtime_action_disabled' });
    expect(nativeInvoke).toHaveBeenCalledWith('desktop_browser_open_devtools', { request: view });
  });

  it('rejects dialog responses through the mounted Action route without clicking the page', async () => {
    const mounted = mountView();
    const result = await handleUiBrowserAutomationDispatchRequest({ v: 1, actionId: args.actionId,
      input: { ...request, dialogResponse: { kind: 'confirm', message: 'Continue?', accept: true } },
      authority: args.context.authority, sessionId: boundView.sessionId }, boundView);
    expect(result).toMatchObject({ status: 'unsupported', errorCode: 'unsupported_action' });
    expect(mounted.clicks()).toBe(0);
  });

  it.each([true, false])('opens the mounted page through the real Machine-targeted Action with its canonical kindless input (automation=%s)', async withAutomation => {
    const mounted = mountView(undefined, withAutomation);
    const runtimeActionExecute = createDaemonRuntimeActionExecutor({ env: { NODE_ENV: 'test' },
      resolveRouteOwners: () => ({ browserUiAutomation: {
        ownsAutomationView: () => false,
        uiAutomation: createBrowserAutomationReverseDispatcher({ getMachineClient: () => ({
          hasConnectedClientRpcHandler: () => true,
          callConnectedClientRpc: async (_method, payload) => ({ ok: true,
            result: await handleUiBrowserAutomationDispatchRequest(payload, boundView) }),
        }) }),
      } }),
      resolveServerFeaturesSnapshot: () => ({ status: 'ready', features: FeaturesResponseSchema.parse({ features: {
        browser: { enabled: true, viewTargets: { enabled: true }, internal: { enabled: true }, sidecar: { enabled: true } },
      } }) }),
    });
    const executor = createActionExecutor(createActionExecutorBoundaryFixture({ runtimeActionExecute }));
    const input = { ...view, commandId: 'open-external' };
    try {
      const result = await executor.execute('browser.view.openExternal', input, { ...args.context, bypassApprovals: true,
        externalActionTarget: { kind: 'machine', machineId: 'machine-1' } });
      expect(result, !result.ok ? result.errorCode : undefined)
        .toMatchObject({ ok: true, result: { status: 'dispatched', commandId: input.commandId, adapterKind: 'externalUrl' } });
      expect(openExternalUrl).toHaveBeenCalledWith('https://example.test');
      mounted.dispose();
      expect(await executor.execute('browser.view.openExternal', input, { ...args.context, bypassApprovals: true,
        externalActionTarget: { kind: 'machine', machineId: 'machine-1' } })).toMatchObject({ ok: false, errorCode: 'runtime_action_disabled' });
    } finally { mounted.dispose(); }
  });

  it.each(['snapshot', 'queryElements', 'semanticSnapshot'] as const)('returns full redacted %s data through the real injected reverse route', async (actionKind) => {
    const mounted = mountView();
    mounted.controlService.unregisterOwner({ ownerId: 'mounted-owner', reasonCode: 'owner_disconnected' });
    const listeners = new Set<(raw: string) => void>();
    const text = 'Observation '.repeat(60);
    const data = { text, elements: Array.from({ length: 40 }, (_, index) => ({ selector: `#item-${index}`, text })),
      unsafe: 'https://example.test/?token=private-token',
      locator: { kind: 'css', value: '[href="https://example.test/?token=private-token"]' } };
    let envelopeIssues: unknown[] = [];
    mounted.controlService.registerOwner(createInjectedPageAutomationOwner({ ownerId: 'injected-owner', ...view,
      navigationGeneration: 0, adapterKind: 'localPreview', collectorId: 'collector', nonce: 'nonce',
      capabilityVersion: '1', supportedActions: [actionKind], nowMs: () => Date.now(), transport: {
        subscribeToResults: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
        sendCommand: command => {
          const { commandName: _commandName, payload: _payload, ...identity } = command;
          const result = BrowserInjectedRuntimeResultMessageV1Schema.safeParse({ ...identity,
            kind: 'browser.injectedRuntime.result', ok: true, stale: false, fidelity: 'injectedPage', trusted: false, durationMs: 1, data });
          if (!result.success) { envelopeIssues = result.error.issues; throw result.error; }
          for (const listener of listeners) listener(JSON.stringify(result.data));
        },
      } }));
    const input = { ...request, actionKind, automationRequestId: `read-${actionKind}`, payload: {} };
    const result = await handleUiBrowserAutomationDispatchRequest({ v: 1, actionId: `browser.automation.${actionKind}`,
      input, authority: 'account_automation', sessionId: boundView.sessionId }, boundView);
    expect(envelopeIssues).toEqual([]);
    const actionResult = BrowserAutomationActionResultV1Schema.parse(result);
    expect(actionResult.status).toBe('succeeded');
    expect(actionResult.resultSummary.text).toBe(text);
    expect(actionResult.resultSummary.elements).toEqual(data.elements);
    expect(JSON.stringify(result)).not.toContain('private-token');
    expect(mounted.controlService.getActionTimeline(view)[0]?.resultSummary).toMatchObject({ textLength: text.length, truncated: true });
  });

  it('takes and hands back the mounted controller through scoped Actions', async () => {
    const mounted = mountView();
    const invoke = (kind: 'takeControl' | 'handBack', sessionId = boundView.sessionId) => handleUiBrowserAutomationDispatchRequest({
      v: 1, sessionId, authority: 'account_automation', actionId: `browser.control.${kind}`,
      input: { ...view, kind, commandId: kind },
    }, boundView);
    expect(await invoke('takeControl', 'wrong-session')).toMatchObject({ ok: false });
    expect(mounted.controlService.getStatus(request)?.resultSummary.controller).toBe('none');
    expect(await invoke('takeControl')).toMatchObject({ status: 'dispatched' });
    expect(mounted.controlService.getStatus(request)?.resultSummary.controller).toBe('human');
    expect(await mounted.controlService.executeAction(request)).toMatchObject({ status: 'interrupted', errorCode: 'human_interrupted' });
    expect(await invoke('handBack')).toMatchObject({ status: 'dispatched' });
    expect(mounted.controlService.getStatus(request)?.resultSummary.controller).toBe('none');
    // Hand back preserves the controller's fresh-observation requirement.
    expect(await mounted.controlService.executeAction(request)).toMatchObject({ status: 'stale', errorCode: 'stale_navigation' });
  });

  it('refuses handback while the mounted engine is still settling interrupted input', async () => {
    let began!: () => void;
    const started = new Promise<void>(resolve => { began = resolve; });
    let settle!: (result: { status: 'succeeded' }) => void;
    const mounted = mountView(() => { began(); return new Promise(resolve => { settle = resolve; }); });
    const running = mounted.controlService.executeAction(request);
    await started;
    const invoke = (kind: 'takeControl' | 'handBack') => handleUiBrowserAutomationDispatchRequest({
      v: 1, sessionId: boundView.sessionId, actionId: `browser.control.${kind}`,
      input: { ...view, kind, commandId: kind },
    }, boundView);
    try {
      expect(await invoke('takeControl')).toMatchObject({ status: 'dispatched' });
      expect(await invoke('handBack')).toMatchObject({ status: 'failed', error: { code: 'permission_denied' } });
      expect(mounted.controlService.getStatus(request)?.resultSummary.controller).toBe('human');
    } finally { settle({ status: 'succeeded' }); await running; }
    expect(await invoke('handBack')).toMatchObject({ status: 'dispatched' });
  });

  it('binds a legitimate slot-derived browser identity to its invoking Happier Session', async () => {
    const mounted = mountView();
    const result = await handleUiBrowserAutomationDispatchRequest({ v: 1, actionId: args.actionId, input: request,
      authority: 'account_automation', sessionId: 'happier-session' }, { ...view, sessionId: 'happier-session' });
    expect(result).toMatchObject({ status: 'succeeded' });
    expect(mounted.clicks()).toBe(1);
  });

  it('refuses another Happier Session addressing the same mounted pane on the same machine', async () => {
    const mounted = mountView();
    const result = await handleUiBrowserAutomationDispatchRequest({ v: 1, actionId: args.actionId, input: request,
      authority: 'account_automation', sessionId: 'another-session' }, { ...view, sessionId: 'happier-session' });
    expect(result).toMatchObject({ ok: false });
    expect(mounted.clicks()).toBe(0);
  });

  it('aborts the deferred page effect when the invoking transport cancels', async () => {
    let started!: () => void;
    const effectStarted = new Promise<void>(resolve => { started = resolve; });
    let effectSignal: AbortSignal | undefined;
    let settle!: (result: { status: 'succeeded' }) => void;
    const mounted = mountView(signal => {
      effectSignal = signal;
      started();
      return new Promise(resolve => { settle = resolve; });
    });
    const abort = new AbortController();
    const running = handleUiBrowserAutomationDispatchRequest({ v: 1, actionId: args.actionId, input: request,
      authority: 'account_automation', sessionId: boundView.sessionId }, boundView, { signal: abort.signal });
    await effectStarted;
    abort.abort();
    try { expect(effectSignal?.aborted).toBe(true); }
    finally { settle({ status: 'succeeded' }); }
    await expect(running).resolves.toMatchObject({ status: 'interrupted', completion: 'unknown' });
    expect(mounted.controlService.getStatus({ ...request, actionKind: 'getStatus' })?.resultSummary.controller).toBe('none');
  });

  it('clicks the exact mounted page through the public dispatch contract and redacts result egress', async () => {
    const mounted = mountView();
    const wireRequest = UiBrowserAutomationDispatchRequestV1Schema.parse({ v: 1, actionId: args.actionId, input: request,
      authority: args.context.authority, sessionId: boundView.sessionId });
    const result = UiBrowserAutomationDispatchResultV1Schema.parse(await handleUiBrowserAutomationDispatchRequest(wireRequest, boundView));
    expect(result).toMatchObject({ v: 1, status: 'succeeded', adapterKind: 'localPreview', trustedInput: false, resultSummary: { clicked: true } });
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(mounted.clicks()).toBe(1);
  });

  it('rejects wrong and retired view identities at the mounted UI owner', async () => {
    const mounted = mountView();
    const raw = { v: 1, actionId: args.actionId, input: request, sessionId: boundView.sessionId };
    expect(await handleUiBrowserAutomationDispatchRequest({ ...raw, input: { ...request, viewId: 'other-view' } }, boundView)).toMatchObject({ ok: false });
    mounted.dispose();
    expect(await handleUiBrowserAutomationDispatchRequest(raw, boundView)).toMatchObject({ ok: false });
    expect(mounted.clicks()).toBe(0);
  });

  it('projects exact controller status and preserves present-user cancellation authority', async () => {
    vi.useFakeTimers();
    let settle!: (result: { status: 'succeeded' }) => void;
    const mounted = mountView(() => new Promise(resolve => { settle = resolve; }));
    const active = mounted.controlService.executeAction(request);
    const invoke = (actionId: string, authority: string) => handleUiBrowserAutomationDispatchRequest({ v: 1, actionId,
      input: actionId === 'browser.automation.status' ? { ...request, automationRequestId: 'status-1', actionKind: 'getStatus' } : view,
      authority, sessionId: boundView.sessionId }, boundView);
    expect(await invoke('browser.automation.cancelActive', 'account_automation')).toEqual({ v: 1, outcome: 'owner_mismatch', canceledCount: 0 });
    expect(await invoke('browser.automation.status', 'account_automation')).toMatchObject({ status: 'succeeded', resultSummary: { controller: 'agent', activeAutomationRequestId: 'click-1' } });
    expect(await invoke('browser.automation.cancelActive', 'present_user')).toEqual({ v: 1, outcome: 'canceled', canceledCount: 1, completion: 'uncertain' });
    settle({ status: 'succeeded' });
    expect(await active).toMatchObject({ status: 'canceled' });
  });
});

describe('admitted private cookie continuation to the exact native view', () => {
  beforeEach(() => { nativeHost.mockReturnValue(true); });
  const cookies = [{ name: 'session', value: 'COOKIE_SENTINEL', domain: '.example.test', path: '/', secure: true,
    httpOnly: true, sameSite: 'None' as const, expires: 1900000000 }];
  const input = { ...view, profileId: 'profile-1', cookies };
  it('applies native cookies with their full scope/attributes and returns the typed partial metadata', async () => {
    mountView(undefined, false, desktopAvailability);
    const expected = { status: 'completed', records: [{ name: 'session', domain: '.example.test', status: 'imported' }] };
    nativeInvoke.mockResolvedValue(expected);
    expect(await handleUiBrowserAutomationDispatchRequest(input, boundView)).toEqual(expected);
    expect(nativeInvoke).toHaveBeenCalledWith('desktop_browser_apply_login_cookies', { request: input });
  });
  it('refuses another view and non-native engines before sending material to the platform', async () => {
    mountView(undefined, false);
    expect(await handleUiBrowserAutomationDispatchRequest(input, boundView)).toEqual({ status: 'unavailable', code: 'engine_unsupported' });
    expect(await handleUiBrowserAutomationDispatchRequest({ ...input, viewId: 'another-view' }, boundView))
      .toEqual({ status: 'unavailable', code: 'destination_unavailable' });
    expect(nativeInvoke).not.toHaveBeenCalled();
  });
  it('preserves native profile refusal, cancellation and unavailable reasons without exposing native exceptions', async () => {
    mountView(undefined, false, desktopAvailability);
    nativeInvoke.mockResolvedValue({ status: 'unavailable', code: 'profile_mismatch' });
    expect(await handleUiBrowserAutomationDispatchRequest({ ...input, profileId: 'other' }, boundView))
      .toEqual({ status: 'unavailable', code: 'profile_mismatch' });
    nativeInvoke.mockClear();
    expect(await handleUiBrowserAutomationDispatchRequest(input, boundView, { signal: AbortSignal.abort() }))
      .toEqual({ status: 'unavailable', code: 'canceled' });
    expect(nativeInvoke).not.toHaveBeenCalled();
    nativeInvoke.mockRejectedValue(new Error('COOKIE_SENTINEL /native/path'));
    expect(await handleUiBrowserAutomationDispatchRequest(input, boundView))
      .toEqual({ status: 'unavailable', code: 'import_unknown' });
  });
});


describe('native passkeys use provider availability without credential transfer', () => {
  beforeEach(() => { nativeHost.mockReturnValue(true); });
  const input = { ...view, profileId: 'profile-1', credentials: [] };
  it.each([
    { platform: 'Windows', availability: { status: 'available' }, code: 'passkey_import_unavailable' },
    { platform: 'macOS', availability: { status: 'unavailable', code: 'passkey_import_unavailable' }, code: 'passkey_import_unavailable' },
    { platform: 'Linux', availability: { status: 'unavailable', code: 'engine_unsupported' }, code: 'engine_unsupported' },
  ] as const)('settles the $platform SavedSecret import before acquiring key material', async ({ availability, code }) => {
    mountView(undefined, false, desktopAvailability);
    nativeInvoke.mockResolvedValue(availability);
    // Only Home HTTP and the native host are substituted; material acquisition and the
    // private capability continuation use their real owners beneath the admitted Action.
    const acquire = vi.fn(async (): Promise<never> => { throw new Error('passkey material must not be acquired'); });
    const result = await importSavedSecretPasskeysInContext({
      serverId: 'home', accountId: 'person', credentials: { token: 'unused-account-token' },
      request: acquire, assertCurrent: () => {}, resolveAccountMode: async () => 'plain',
      resolveAccountEncryption: async () => ({ accountMode: 'plain', encryption: null }),
    }, { kind: 'passkeys', machineId: 'machine', ...input, refs: ['happier:shared-secret:v1:private-key'] },
    async request => handleUiBrowserAutomationDispatchRequest(request.input, boundView));
    expect(result).toEqual({ status: 'unavailable', code });
    expect(acquire).not.toHaveBeenCalled();
    expect(nativeInvoke).toHaveBeenCalledWith('desktop_browser_get_native_passkey_availability', {
      request: { ...view, profileId: 'profile-1' },
    });
    expect(JSON.stringify(nativeInvoke.mock.calls)).not.toMatch(/credentials|private-key|privateKey/);
  });
  it('strips supplied private credentials before invoking the OS provider', async () => {
    mountView(undefined, false, desktopAvailability);
    nativeInvoke.mockResolvedValue({ status: 'available' });
    const credentials = [{ kind: 'passkey', rpId: 'example.test', credentialId: 'Y3JlZA==', userHandle: 'dXNlcg==',
      privateKey: 'cHJpdmF0ZS1rZXk=', algorithm: -7, signCount: 0, backupEligibility: true, backupState: true }];
    expect(await handleUiBrowserAutomationDispatchRequest({ ...input, credentials }, boundView))
      .toEqual({ status: 'unavailable', code: 'passkey_import_unavailable' });
    expect(nativeInvoke).toHaveBeenCalledWith('desktop_browser_get_native_passkey_availability', {
      request: { ...view, profileId: 'profile-1' },
    });
    expect(JSON.stringify(nativeInvoke.mock.calls)).not.toMatch(/credentials|cHJpdmF0ZS1rZXk=/);
  });
  it('preserves the native profile binding and refuses a different live view', async () => {
    mountView(undefined, false, desktopAvailability);
    nativeInvoke.mockResolvedValue({ status: 'unavailable', code: 'profile_mismatch' });
    expect(await handleUiBrowserAutomationDispatchRequest({ ...input, profileId: 'other-profile' }, boundView))
      .toEqual({ status: 'unavailable', code: 'profile_mismatch' });
    nativeInvoke.mockClear();
    expect(await handleUiBrowserAutomationDispatchRequest({ ...input, viewId: 'other' }, boundView))
      .toEqual({ status: 'unavailable', code: 'destination_unavailable' });
    expect(nativeInvoke).not.toHaveBeenCalled();
  });
});
