import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserInjectedRuntimeResultMessageV1Schema, BrowserAutomationActionResultV1Schema, UiBrowserAutomationDispatchRequestV1Schema, UiBrowserAutomationDispatchResultV1Schema, type RuntimeActionExecuteArgs } from '@happier-dev/protocol';

import { handleUiBrowserAutomationDispatchRequest } from './reverseDispatchHandler';
import { createBrowserAutomationControlService } from './controlService';
import { registerBrowserRuntimeControlAdapter, clearBrowserRuntimeControlRegistryForTests } from '../actions/runtimeControlRegistry';
import { applyBrowserControlEvent, createBrowserControlState } from '../control/reducer';
import { buildBrowserAdapterCapabilities } from '../adapters/capabilities';
import { createInjectedPageAutomationOwner } from '@/components/browser/adapters/automation/injectedPageRuntime';

const view = { browserSessionId: 'visible-session', viewId: 'visible-view' };
const boundView = { ...view, sessionId: 'happier-session' };
const request = { v: 1, ...view, automationRequestId: 'click-1', actionKind: 'click', navigationGeneration: 0, requestedBy: 'agent', requesterRef: { kind: 'agent', id: 'agent-1' }, timeoutMs: 1000, payload: { selector: '#button' } } as const;
const args: RuntimeActionExecuteArgs = { actionId: 'browser.automation.click', input: request,
  context: { surface: 'agent', authority: 'account_automation', defaultSessionId: 'happier-session' } };

function mountView(executePageAction?: (signal: AbortSignal) => Promise<Readonly<{ status: 'succeeded' }>>) {
  const controlService = createBrowserAutomationControlService({ nowMs: () => Date.now() });
  let clicks = 0;
  // The page transport is the real system boundary; controller and Action internals stay real.
  controlService.registerOwner({ ownerId: 'mounted-owner', ...view, navigationGeneration: 0, authority: 'uiLocal', adapterKind: 'localPreview', fidelity: 'injectedPage', trustedInput: false, supportedActions: ['click'], executeAction: async (_request, context) => { clicks += 1; return executePageAction ? executePageAction(context.signal) : { status: 'succeeded', resultSummary: { clicked: true, cookie: 'secret' } }; } });
  const state = applyBrowserControlEvent(applyBrowserControlEvent(createBrowserControlState(), {
    kind: 'sessionCreated', eventId: 'session-created', browserSessionId: view.browserSessionId, profileId: 'profile-1', occurredAt: 1,
  }), {
    kind: 'viewOpened', eventId: 'view-opened', ...view, occurredAt: 2, platform: 'web', adapterKind: 'localPreview', engineKind: 'webIframe',
    target: { kind: 'externalUrl', targetId: 'page', url: 'https://example.test', display: { title: 'Page', addressLabel: 'example.test' } },
    adapterCapabilities: buildBrowserAdapterCapabilities({ adapterKind: 'localPreview', supportedTargetKinds: ['externalUrl'], supportedRenderEngines: ['webIframe'] }),
  });
  const dispose = registerBrowserRuntimeControlAdapter({ browserSessionId: view.browserSessionId, control: { readState: () => state, applyDispatchResult: () => {} }, automation: { controlService } });
  return { dispose, controlService, clicks: () => clicks };
}

afterEach(() => {
  clearBrowserRuntimeControlRegistryForTests();
  vi.useRealTimers();
});

describe('daemon to exact mounted UI browser Action', () => {
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
