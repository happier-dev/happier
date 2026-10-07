import { describe, expect, it } from 'vitest';
import { createBrowserAutomationDaemonService } from '../automation/service';
import { createBrowserSidecarCdpControlAdapter } from '../sidecar/controlAdapter';
import { createBrowserDaemonControlBroker } from './broker';
import { createBrowserDaemonControlRoutes } from './routes';
import { createBrowserAutomationCdpAdapter } from '../automation/adapters/cdp';
import { createCliActionExecutorHarness } from '@/session/actions/createCliActionExecutorHarness';
import { createDaemonRuntimeActionExecutor } from '../../runtimeActionExecutor';
import { ActionsSettingsV1Schema, FeaturesResponseSchema, type ApprovalRequest, type BrowserCommandV1 } from '@happier-dev/protocol';
import { createControlAdapterAutomationTransport } from '../automation/adapters/controlBridge';
import { createUnavailableRuntimeActionExecutor } from '@happier-dev/protocol/actions/executor/dispatch';

function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function navigationHarness(input: Readonly<{ cleanupFails?: boolean }> = {}) {
  const view = { browserSessionId: 'browser', viewId: 'view' };
  const pressed = deferred();
  const releasePress = deferred();
  const releasing = deferred();
  const releaseCleanup = deferred();
  const navigating = deferred();
  const releaseNavigation = deferred();
  const pageCommands: string[] = [];
  const navigationUrls: unknown[] = [];
  let holdInput = true;
  // Only Chromium is replaced. Navigation, automation admission and held-input cleanup stay real.
  const transport = {
    openPage: async () => ({ targetId: 'page', sessionId: 'cdp-page' }),
    dispatchBrowserCommand: async () => ({}),
    dispatchPageCommand: async (command: Readonly<{ method: string; params?: Record<string, unknown> }>) => {
      pageCommands.push(command.method);
      if (command.method === 'Page.navigate') {
        navigationUrls.push(command.params?.url);
        if (command.params?.url === 'https://example.test/pending-agent') {
          navigating.resolve(); await releaseNavigation.promise;
        }
      }
      if (holdInput && command.method === 'Input.dispatchMouseEvent') {
        if (command.params?.type === 'mousePressed') {
          pressed.resolve(); await releasePress.promise;
        } else if (command.params?.type === 'mouseReleased') {
          releasing.resolve(); await releaseCleanup.promise;
          if (input.cleanupFails) throw new Error('CDP release acknowledgement unavailable');
        }
      }
      if (command.method === 'Page.getNavigationHistory') {
        return { currentIndex: 1, entries: [{ id: 1 }, { id: 2 }, { id: 3 }] };
      }
      return {};
    },
  };
  const adapter = createBrowserSidecarCdpControlAdapter({ browserSessionId: view.browserSessionId, sidecarId: 'sidecar', transport });
  const broker = createBrowserDaemonControlBroker();
  broker.registerAdapter(adapter);
  const automation = createBrowserAutomationDaemonService({ adapter: createBrowserAutomationCdpAdapter({
    transport: createControlAdapterAutomationTransport({ adapter,
      contextCapture: { transport, resolvePageHandle: adapter.resolvePageHandle } }),
  }) });
  const routes = createBrowserDaemonControlRoutes({ broker, automation: () => automation });
  const request = { v: 1 as const, ...view, automationRequestId: 'agent-input', navigationGeneration: 0,
    requestedBy: 'agent' as const, requesterRef: { kind: 'agent', id: 'agent' }, timeoutMs: 5000,
    actionKind: 'tap' as const, payload: { x: 10, y: 20 } };
  return { view, adapter, broker, automation, routes, request, pressed, releasePress, releasing, releaseCleanup,
    navigating, releaseNavigation, pageCommands, navigationUrls,
    resumeInput: () => { holdInput = false; releasePress.resolve(); releaseCleanup.resolve(); },
    open: () => broker.dispatchCommand({ kind: 'openView', ...view, commandId: 'open', focus: true, platform: 'web',
      target: { kind: 'externalUrl', targetId: 'target', url: 'https://example.test' } }),
    dispose: () => { releasePress.resolve(); releaseCleanup.resolve(); releaseNavigation.resolve(); automation.dispose(); adapter.dispose(); },
  };
}

describe('daemon browser controller commands', () => {
  it.each([
    ['navigate', 'Page.navigate'], ['goBack', 'Page.navigateToHistoryEntry'],
    ['goForward', 'Page.navigateToHistoryEntry'], ['reload', 'Page.reload'], ['stop', 'Page.stopLoading'],
  ] as const)('drains agent input before present-user %s and holds control until hand back', async (kind, method) => {
    const harness = navigationHarness();
    const { automation, routes, view, request } = harness;
    try {
      await harness.open();
      const active = automation.execute(request);
      await harness.pressed.promise;
      const command: BrowserCommandV1 = kind === 'navigate'
        ? { ...view, kind, commandId: 'chrome', url: 'https://example.test/next' }
        : { ...view, kind, commandId: 'chrome' };
      const navigation = routes.dispatchCommand(command, { authority: 'present_user' });
      expect(automation.getStatus(view)).toMatchObject({ controller: 'human', interruptionSettling: true });
      expect(harness.pageCommands).not.toContain(method);
      expect(await routes.dispatchCommand({ ...view, kind: 'handBack', commandId: 'early' }, { authority: 'present_user' }))
        .toMatchObject({ status: 'failed' });
      harness.releasePress.resolve();
      await harness.releasing.promise;
      expect(harness.pageCommands).not.toContain(method);
      harness.releaseCleanup.resolve();
      expect(await active).toMatchObject({ status: 'canceled', resultSummary: { completion: 'stopped' } });
      expect(await navigation).toMatchObject({ status: 'dispatched', events: expect.arrayContaining([
        expect.objectContaining({ kind: 'controllerChanged', state: expect.objectContaining({ controller: 'human' }) }),
      ]) });
      expect(harness.pageCommands).toContain(method);
      expect(await automation.execute({ ...request, automationRequestId: 'held' })).toMatchObject({ errorCode: 'human_interrupted' });
      await routes.dispatchCommand({ ...view, kind: 'handBack', commandId: 'back' }, { authority: 'present_user' });
      expect(await automation.execute({ ...request, automationRequestId: 'unobserved' })).toMatchObject({ errorCode: 'stale_navigation' });
      await automation.execute({ ...request, automationRequestId: 'observe', actionKind: 'snapshot', payload: {} });
      harness.resumeInput();
      expect(await automation.execute({ ...request, automationRequestId: 'resumed' })).toMatchObject({ status: 'succeeded' });
    } finally { harness.dispose(); }
  });

  it('retains uncertain cleanup in the controller after human navigation and hand back', async () => {
    const harness = navigationHarness({ cleanupFails: true });
    try {
      await harness.open();
      const active = harness.automation.execute(harness.request);
      await harness.pressed.promise;
      const navigation = harness.routes.dispatchCommand({ ...harness.view, kind: 'navigate', commandId: 'chrome', url: 'https://example.test/next' }, { authority: 'present_user' });
      expect(harness.automation.getStatus(harness.view).controller).toBe('human');
      harness.releasePress.resolve(); harness.releaseCleanup.resolve();
      expect(await active).toMatchObject({ status: 'canceled', resultSummary: { completion: 'uncertain' } });
      expect(await navigation).toMatchObject({ status: 'dispatched' });
      expect(harness.automation.getStatus(harness.view)).toMatchObject({ controller: 'human', uncertain: true });
      await harness.routes.dispatchCommand({ ...harness.view, kind: 'handBack', commandId: 'back' }, { authority: 'present_user' });
      expect(harness.automation.getStatus(harness.view).uncertain).toBe(true);
      expect(await harness.automation.execute({ ...harness.request, automationRequestId: 'unobserved' })).toMatchObject({ errorCode: 'stale_navigation' });
    } finally { harness.dispose(); }
  });

  it('holds an idle view after present-user navigation until explicit hand back', async () => {
    const harness = navigationHarness();
    try {
      await harness.open();
      const command = { ...harness.view, kind: 'navigate' as const, commandId: 'chrome', url: 'https://example.test/next' };
      expect(await harness.routes.dispatchCommand(command, { authority: 'present_user' })).toMatchObject({ status: 'dispatched' });
      expect(harness.automation.getStatus(harness.view).controller).toBe('human');
      expect(await harness.routes.dispatchCommand({ ...command, commandId: 'second' }, { authority: 'present_user' })).toMatchObject({ status: 'dispatched' });
      expect(await harness.automation.execute(harness.request)).toMatchObject({ errorCode: 'human_interrupted' });
      expect(await harness.routes.dispatchCommand({ ...harness.view, kind: 'handBack', commandId: 'back' }, { authority: 'present_user' })).toMatchObject({ status: 'dispatched' });
      expect(harness.automation.getStatus(harness.view).controller).toBe('none');
    } finally { harness.dispose(); }
  });

  it.each(['navigate', 'goBack', 'goForward', 'reload', 'stop'] as const)(
    'refuses account-automation %s while the human holds the view', async kind => {
      const harness = navigationHarness();
      try {
        await harness.open();
        await harness.routes.dispatchCommand({ ...harness.view, kind: 'takeControl', commandId: 'take' }, { authority: 'present_user' });
        const before = harness.pageCommands.length;
        const command: BrowserCommandV1 = kind === 'navigate'
          ? { ...harness.view, kind, commandId: 'agent', url: 'https://example.test/agent' }
          : { ...harness.view, kind, commandId: 'agent' };
        expect(await harness.routes.dispatchCommand(command, { authority: 'account_automation', bypassApprovals: true }))
          .toMatchObject({ status: 'failed', error: { code: 'permission_denied' } });
        expect(harness.pageCommands).toHaveLength(before);
        expect(harness.automation.getStatus(harness.view).controller).toBe('human');
      } finally { harness.dispose(); }
    },
  );

  it('drains an in-flight account-automation control command before human navigation without granting human provenance', async () => {
    const harness = navigationHarness();
    try {
      await harness.open();
      const agent = harness.routes.dispatchCommand({ ...harness.view, kind: 'navigate', commandId: 'agent', url: 'https://example.test/pending-agent' },
        { authority: 'account_automation', bypassApprovals: true });
      await harness.navigating.promise;
      expect(harness.automation.getStatus(harness.view).controller).toBe('agent');
      const human = harness.routes.dispatchCommand({ ...harness.view, kind: 'navigate', commandId: 'human', url: 'https://example.test/human' }, { authority: 'present_user' });
      expect(harness.automation.getStatus(harness.view)).toMatchObject({ controller: 'human', interruptionSettling: true });
      expect(harness.navigationUrls).not.toContain('https://example.test/human');
      expect(await harness.routes.dispatchCommand({ ...harness.view, kind: 'handBack', commandId: 'early' }, { authority: 'present_user' }))
        .toMatchObject({ status: 'failed' });
      harness.releaseNavigation.resolve();
      expect(await agent).toMatchObject({ status: 'dispatched' });
      expect(await human).toMatchObject({ status: 'dispatched' });
      expect(harness.navigationUrls).toEqual(['https://example.test/pending-agent', 'https://example.test/human']);
      expect(harness.automation.getStatus(harness.view)).toMatchObject({ controller: 'human', interruptionSettling: false, uncertain: false });
    } finally { harness.dispose(); }
  });

  it('keeps focus, account-automation navigation and nonautomatable navigation outside human takeover', async () => {
    const harness = navigationHarness();
    try {
      await harness.open();
      await harness.routes.dispatchCommand({ ...harness.view, kind: 'focusView', commandId: 'focus' }, { authority: 'present_user' });
      expect(harness.automation.getStatus(harness.view).controller).toBe('none');
      const command = { ...harness.view, kind: 'navigate' as const, commandId: 'agent-nav', url: 'https://example.test/agent' };
      expect(await harness.routes.dispatchCommand(command, { authority: 'account_automation', bypassApprovals: true })).toMatchObject({ status: 'dispatched' });
      expect(harness.automation.getStatus(harness.view).controller).toBe('none');
      const withoutAutomation = createBrowserDaemonControlRoutes({ broker: harness.broker, automation: () => null });
      expect(await withoutAutomation.dispatchCommand(command, { authority: 'present_user' })).toMatchObject({ status: 'dispatched' });
      expect(await harness.routes.dispatchCommand({ ...command, viewId: 'missing' }, { authority: 'present_user' })).toMatchObject({ status: 'failed', error: { code: 'view_not_found' } });
      expect(harness.automation.getRuntimeStats().runtimeCount).toBe(1);
      harness.resumeInput();
      expect(await harness.automation.execute({ ...harness.request, actionKind: 'navigate', payload: { url: 'https://example.test/automation' } })).toMatchObject({ status: 'succeeded' });
    } finally { harness.dispose(); }
  });

  it.each(['takeControl', 'handBack'] as const)('routes agent %s through Action approval and the existing controller', async kind => {
    const view = { browserSessionId: 'browser', viewId: 'view' };
    const adapter = createBrowserSidecarCdpControlAdapter({ browserSessionId: 'browser', sidecarId: 'sidecar', transport: {
      openPage: async () => ({ targetId: 'page', sessionId: 'cdp-page' }),
      dispatchPageCommand: async () => ({}), dispatchBrowserCommand: async () => ({}),
    } });
    const broker = createBrowserDaemonControlBroker();
    broker.registerAdapter(adapter);
    await broker.dispatchCommand({ ...view, kind: 'openView', commandId: 'open', focus: true, platform: 'web',
      target: { kind: 'externalUrl', targetId: 'target', url: 'https://example.test' } });
    const automation = createBrowserAutomationDaemonService({ adapter: createBrowserAutomationCdpAdapter({ transport: {
      ownsView: broker.ownsView, dispatchControlCommand: broker.dispatchCommand,
      dispatchPageQuery: async () => ({ ok: true }), dispatchInputCommand: async () => ({ ok: true }),
    } }) });
    const control = createBrowserDaemonControlRoutes({ broker, automation: () => automation });
    let decision: 'approve' | 'reject' = 'reject';
    let stored: ApprovalRequest | undefined;
    const harness = createCliActionExecutorHarness({ token: 'token', sessionId: 'browser', mode: 'plain', ctx: null }, {
      runtimeActionExecute: createDaemonRuntimeActionExecutor({ env: {}, resolveRouteOwners: () => ({ browserControl: control,
        browserUiAutomation: { ownsAutomationView: broker.ownsView, uiAutomation: createUnavailableRuntimeActionExecutor() } }),
        resolveServerFeaturesSnapshot: () => ({ status: 'ready', features: FeaturesResponseSchema.parse({ features: {
          browser: { enabled: true, viewTargets: { enabled: true }, internal: { enabled: true }, sidecar: { enabled: true } },
        } }) }) }),
      approvalsCreate: async ({ request }) => { stored = request; return { artifactId: 'control-approval' }; },
      approvalsGet: async () => null, approvalsUpdate: async () => ({ ok: true }),
      approvalsWaitForDecision: async ({ request }) => ({ decision, request }),
      isApprovalExecutionOriginCurrent: async () => true,
    });
    const context = { surface: 'agent' as const, authority: 'account_automation' as const, defaultSessionId: 'browser',
      serverId: 'home', actionRequestId: 'browser-control', actionsSettings: ActionsSettingsV1Schema.parse({ v: 1 }) };
    try {
      if (kind === 'handBack') await control.dispatchCommand({ ...view, kind: 'takeControl', commandId: 'take' }, { authority: 'present_user' });
      const before = automation.getStatus(view).controller;
      expect(await harness.executor.execute(`browser.control.${kind}`, { ...view, kind, commandId: 'control' }, context))
        .toMatchObject({ ok: false, errorCode: 'approval_rejected' });
      expect(automation.getStatus(view).controller).toBe(before);
      expect(stored).toMatchObject({ executionOriginV1: { authority: 'account_automation' } });
      decision = 'approve';
      const approved = await harness.executor.execute(`browser.control.${kind}`, { ...view, kind, commandId: 'control' }, context);
      expect(approved, JSON.stringify(approved)).toMatchObject({ ok: true, result: { status: 'dispatched' } });
      expect(automation.getStatus(view).controller).toBe(kind === 'takeControl' ? 'human' : 'none');
      if (kind === 'handBack') {
        const request = { ...view, v: 1 as const, automationRequestId: 'next', navigationGeneration: 0,
          requestedBy: 'agent' as const, requesterRef: { kind: 'agent', id: 'agent' }, timeoutMs: 5000,
          actionKind: 'click' as const, payload: { selector: '#go' } };
        expect(await automation.execute(request)).toMatchObject({ errorCode: 'stale_navigation' });
        await automation.execute({ ...request, actionKind: 'snapshot', payload: {} });
        expect(await automation.execute(request)).toMatchObject({ status: 'succeeded' });
      }
      await control.dispatchCommand({ ...view, kind: kind === 'takeControl' ? 'handBack' : 'takeControl',
        commandId: 'reset-for-waiver' }, { authority: 'present_user' });
      stored = undefined;
      expect(await harness.executor.execute(`browser.control.${kind}`, { ...view, kind, commandId: 'waived' }, {
        ...context,
        actionsSettings: ActionsSettingsV1Schema.parse({ v: 1,
          approvalWaivedSurfaces: { [`browser.control.${kind}`]: ['agent'] } }),
      })).toMatchObject({ ok: true, result: { status: 'dispatched' } });
      expect(stored).toBeUndefined();
      expect(automation.getStatus(view).controller).toBe(kind === 'takeControl' ? 'human' : 'none');
    } finally { automation.dispose(); adapter.dispose(); }
  });
  it('requires host authority and hands the held view back through the control owner', async () => {
    const view = { browserSessionId: 'browser', viewId: 'view' };
    // CDP is the system boundary. Broker, route and controller admission remain real.
    const adapter = createBrowserSidecarCdpControlAdapter({ browserSessionId: 'browser', sidecarId: 'sidecar', transport: {
      openPage: async () => ({ targetId: 'page', sessionId: 'cdp-page' }),
      dispatchPageCommand: async () => ({}), dispatchBrowserCommand: async () => ({}),
    } });
    const broker = createBrowserDaemonControlBroker();
    broker.registerAdapter(adapter);
    await broker.dispatchCommand({ kind: 'openView', commandId: 'open', focus: true, ...view, platform: 'web',
      target: { kind: 'externalUrl', targetId: 'target', url: 'https://example.test/' } });
    const automation = createBrowserAutomationDaemonService({ adapter: { adapterKind: 'chromiumSidecar',
      execute: async () => ({ status: 'succeeded', fidelity: 'cdp', trustedInput: true }) } });
    const routes = createBrowserDaemonControlRoutes({ broker, automation: () => automation });
    try {
      expect(await routes.dispatchCommand({ kind: 'takeControl', commandId: 'take', ...view })).toMatchObject({
        status: 'failed', error: { code: 'permission_denied' },
      });
      expect(await routes.dispatchCommand({ kind: 'takeControl', commandId: 'take', ...view }, { authority: 'present_user' }))
        .toMatchObject({ status: 'dispatched', events: [{ kind: 'controllerChanged', state: { controller: 'human', controlEpoch: 1 } }] });
      const request = { v: 1 as const, ...view, automationRequestId: 'action', navigationGeneration: 0,
        requestedBy: 'agent' as const, requesterRef: { kind: 'agent', id: 'agent' }, timeoutMs: 5_000,
        actionKind: 'click' as const, payload: { selector: '#go' } };
      expect(await automation.execute(request)).toMatchObject({ errorCode: 'human_interrupted' });
      expect(await routes.dispatchCommand({ kind: 'handBack', commandId: 'back', ...view }, { authority: 'present_user' }))
        .toMatchObject({ status: 'dispatched', events: [{ kind: 'controllerChanged', state: { controller: 'none' } }] });
      expect(await automation.execute(request)).toMatchObject({ errorCode: 'stale_navigation' });
      await automation.execute({ ...request, actionKind: 'snapshot', payload: {} });
      expect(await automation.execute(request)).toMatchObject({ status: 'succeeded' });
    } finally { automation.dispose(); adapter.dispose(); }
  });
});
