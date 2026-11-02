import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createComputerRoutes } from './routes';
import { createMachineLiveStreamCaptureRegistry } from '../peer/mediation/stream/captureRegistry';
import { createDaemonRuntimeActionExecutor } from '../runtimeActionExecutor';
import { createDaemonApprovalExecutionOriginCurrentness, createDaemonExternalActionTargetResolver } from '../externalActions/daemonExternalActionTargetResolver';
import { accountSettingsParse, ActionsSettingsV1Schema, ComputerCaptureResponseV1Schema, ComputerQueryResponseV1Schema, type ApprovalRequest } from '@happier-dev/protocol';
import { decideApprovalRequestTransition } from '@happier-dev/protocol/approvals/approvalRequestTransition';
import { createComputerCaptureSource } from './source';
import { createCliActionExecutorHarness } from '@/session/actions/createCliActionExecutorHarness';
import { native, target as cuaTarget, captureResult, png } from './driver/nativeComputerBoundary.testkit';

const processBoundary = vi.hoisted(() => ({ spawn: vi.fn(), calls: [] as string[][] }));
// Native processes are the system boundary; provider admission and both adapters stay real.
vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), spawn: processBoundary.spawn }));

const agentContext = { authority: 'account_automation' as const, surface: 'agent' as const,
  defaultSessionId: 'session', defaultSessionMachineId: 'machine', serverId: 'home', actionRequestId: 'computer-policy' };

function policyExecutor(routes: ReturnType<typeof createComputerRoutes>) {
  const requests: ApprovalRequest[] = [];
  const effects: string[] = [];
  const runtimeActionExecute = createDaemonRuntimeActionExecutor({ env: { NODE_ENV: 'test' },
    resolveRouteOwners: () => ({ computer: routes }), resolveServerFeaturesSnapshot: () => undefined });
  const { executor } = createCliActionExecutorHarness({ token: 'test', sessionId: 'session', mode: 'plain', ctx: null }, {
    runtimeActionExecute: async args => { effects.push(args.actionId); return runtimeActionExecute(args); },
    // Approval persistence and the person's decision are the external boundaries.
    approvalsCreate: async ({ request }) => { requests.push(request); return { artifactId: 'computer-approval' }; },
    approvalsGet: async () => requests[0] ?? null,
    approvalsUpdate: async ({ request }) => {
      const current = requests[0];
      if (!current) throw new Error('Missing Computer approval');
      const transition = decideApprovalRequestTransition(current, request);
      if (!transition.ok) return transition;
      requests[0] = request;
      return { ok: true };
    },
    isApprovalExecutionOriginCurrent: createDaemonApprovalExecutionOriginCurrentness({
      accountId: 'account', machineId: 'machine', serverId: 'home',
      resolveTarget: createDaemonExternalActionTargetResolver({ credentials: { token: 'fixture-account-token', encryption: null } }),
      // Home identity and Account eligibility are authenticated remote boundaries.
      resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: 'stable-home', machineId: 'machine' }),
      isAccountCurrent: async () => true,
      resolveCurrentSessionAgentSpawnPolicyV1: async () => accountSettingsParse({}).sessionAgentSpawnPolicyV1,
      listAccountApiTokens: async () => { throw new Error('Unsigned host approval has no API-token lookup'); },
    }),
  });
  const decide = (decision: 'approve' | 'reject') => executor.execute('approval.request.decide', {
    artifactId: 'computer-approval', decision,
  }, { ...agentContext, surface: 'ui', authority: 'present_user' });
  return { executor, requests, effects, decide };
}

function selectUnsupportedTarget(registry: ReturnType<typeof createMachineLiveStreamCaptureRegistry>) {
  const source = createComputerCaptureSource({ sessionId: 'session',
    target: { kind: 'window', displayId: ':not-an-x11-display', pid: 42, windowId: 7 }, executablePath: '/managed/cua-driver' });
  registry.register({ sourceId: source.sourceId, streamFamily: 'screen', computer: source, adapter: source.adapter,
    capabilities: { v: 1, sourceId: source.sourceId, sourceKind: 'screen', supportedCodecs: ['image.frame.v1'], inputMode: 'shared', sidebands: [], health: { status: 'available' } } });
}

describe('native computer route authority', () => {
  it('refuses unknown provider and input contracts before any native effect', async () => {
    const routes = createComputerRoutes({ machineId: 'machine', registry: createMachineLiveStreamCaptureRegistry() });
    const workBefore = [native.instances.length, processBoundary.calls.length];
    try {
      for (const request of [
        { machineId: 'machine', captureId: 'capture-1', operation: { kind: 'unsupported_future_kind' } },
        { machineId: 'machine', provider: 'future-provider', captureId: 'capture-1', operation: { kind: 'press', key: 'Return' } },
        { machineId: 'machine', provider: { id: 'cua' }, captureId: 'capture-1', operation: { kind: 'press', key: 'Return' } },
      ]) expect(await routes.dispatch('computer.input', request, agentContext)).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
      expect([native.instances.length, processBoundary.calls.length]).toEqual(workBefore);
    } finally { await routes.dispose(); }
  });

  it.skipIf(process.platform !== 'linux')('selects and queries both providers in one Session and refuses elements bound to the other provider', async () => {
    const agentTarget = { ...cuaTarget, windowId: 'atspi:1.42:/window/1' };
    const window = { id: agentTarget.windowId, pid: 42, title: 'Fixture', app_name: 'Fixture', bounds: { x: 20, y: 30, width: 200, height: 100 } };
    native.call.mockImplementation(async ({ name }) => name === 'list_windows' ? { structuredContent: { windows: [{ pid: 42, window_id: 123, title: 'Fixture' }] } }
      : name === 'get_screen_size' ? { structuredContent: { width: 800, height: 600, scale_factor: 1 } }
        : name === 'get_window_state' ? { ...captureResult(), structuredContent: { ...captureResult().structuredContent,
          elements: [{ element_index: 0, element_token: 's12345678:0', role: 'button' }] } }
          : name === 'check_permissions' ? { structuredContent: { x11: true, xsend_event: true } }
            : { structuredContent: { effect: 'unverifiable' } });
    processBoundary.calls.length = 0;
    processBoundary.spawn.mockImplementation((_path: string, args: string[]) => {
      processBoundary.calls.push(args);
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill: vi.fn(), exitCode: null });
      queueMicrotask(() => {
        const data = args.includes('list-windows') ? [window]
          : args.includes('list-displays') ? [{ id: '0', bounds: { x: 0, y: 0, width: 800, height: 600 }, is_primary: true, scale: 1 }]
            : args.includes('snapshot') ? { snapshot_id: 's1', window, complete: true, tree: { ref_id: '@s1:e1', role: 'button', name: 'Apply' } }
              : args.includes('screenshot') ? { data: png, format: 'png', width: 200, height: 100, scale_factor: 1 }
                : { disposition: { delivery: 'delivered_unverified', retry: 'unsafe' } };
        child.stdout.end(JSON.stringify({ version: '2.5', ok: true, data }));
        child.emit('close', 0, null);
      });
      return child;
    });
    const registry = createMachineLiveStreamCaptureRegistry();
    const routes = createComputerRoutes({ machineId: 'machine', executablePath: '/managed/provider', registry,
      resolveProviderSettings: () => ({ enabledProviders: ['cua', 'agent-desktop'], defaultProvider: 'cua' }) });
    const context = { ...agentContext, bypassApprovals: true };
    try {
      const cua = await routes.dispatch('computer.target.select', { machineId: 'machine', target: cuaTarget }, context);
      const agent = await routes.dispatch('computer.target.select', { machineId: 'machine', provider: 'agent-desktop', target: agentTarget }, context);
      expect(cua).toMatchObject({ provider: 'cua', selectedTarget: cuaTarget });
      expect(agent).toMatchObject({ provider: 'agent-desktop', selectedTarget: agentTarget });
      expect(registry.list()).toHaveLength(2);
      const cuaCapture = ComputerQueryResponseV1Schema.parse(await routes.dispatch('computer.query', { machineId: 'machine' }, context));
      const agentCapture = ComputerQueryResponseV1Schema.parse(await routes.dispatch('computer.query', { machineId: 'machine', provider: 'agent-desktop' }, context));
      expect(cuaCapture).toMatchObject({ provider: 'cua', status: 'queried', captureId: 'capture-1' });
      expect(agentCapture).toMatchObject({ provider: 'agent-desktop', status: 'queried', captureId: expect.any(String), accessibility: { nodes: [{ id: '@s1:e1' }] } });
      if (!('sourceId' in cuaCapture) || !('sourceId' in agentCapture) || !('captureId' in agentCapture)) throw new Error('Missing queried source identity');
      const workBefore = [native.tools.length, processBoundary.calls.length];
      expect(await routes.dispatch('computer.input', { machineId: 'machine', provider: 'cua', sourceId: agentCapture.sourceId,
        captureId: agentCapture.captureId, operation: { kind: 'element', elementId: '@s1:e1', action: 'click' } }, context))
        .toMatchObject({ ok: false, errorCode: 'computer_element_stale' });
      expect(await routes.dispatch('computer.input', { machineId: 'machine', provider: 'cua', sourceId: cuaCapture.sourceId,
        captureId: agentCapture.captureId, operation: { kind: 'element', elementId: '0', action: 'click' } }, context))
        .toMatchObject({ status: 'failed', code: 'computer_element_stale' });
      expect([native.tools.length, processBoundary.calls.length]).toEqual(workBefore);
      expect(await routes.dispatch('computer.input', { machineId: 'machine', sourceId: cuaCapture.sourceId,
        captureId: 'capture-1', operation: { kind: 'element', elementId: '0', action: 'click' } }, context))
        .toMatchObject({ status: 'dispatched', provider: 'cua' });
      expect(await routes.dispatch('computer.input', { machineId: 'machine', provider: 'agent-desktop', sourceId: agentCapture.sourceId,
        captureId: agentCapture.captureId, operation: { kind: 'element', elementId: '@s1:e1', action: 'click' } }, context))
        .toMatchObject({ status: 'dispatched', provider: 'agent-desktop' });
      expect(await routes.dispatch('computer.target.select', { machineId: 'machine', target: { ...cuaTarget, windowId: 999 } },
        { ...context, defaultSessionId: 'another-session' })).toMatchObject({ ok: false, errorCode: 'computer_target_in_use' });
    } finally { await routes.dispose(); }
  });

  it('keeps both provider selections in one Session and recovers each source after provider withdrawal', async () => {
    const registry = createMachineLiveStreamCaptureRegistry();
    const sources = (['cua', 'agent-desktop'] as const).map(provider => createComputerCaptureSource({ sessionId: 'session', provider,
      target: { kind: 'display', displayId: ':fixture' }, executablePath: '/managed/provider' }));
    for (const source of sources) registry.register({ sourceId: source.sourceId, streamFamily: 'screen', computer: source, adapter: source.adapter,
      capabilities: { v: 1, sourceId: source.sourceId, sourceKind: 'screen', supportedCodecs: ['image.frame.v1'], inputMode: 'shared', sidebands: [], health: { status: 'available' } } });
    const routes = createComputerRoutes({ machineId: 'machine', executablePath: '/managed/cua-driver', registry,
      resolveProviderSettings: () => ({ enabledProviders: ['cua'], defaultProvider: 'cua' }) });
    try {
      expect(await routes.dispatch('computer.control.interrupt', { machineId: 'machine', provider: 'agent-desktop', sourceId: sources[1].sourceId }, agentContext))
        .toMatchObject({ status: 'interrupted', provider: 'agent-desktop', sourceId: sources[1].sourceId });
      expect(await routes.dispatch('computer.target.close', { machineId: 'machine', sourceId: sources[1].sourceId }, agentContext))
        .toMatchObject({ status: 'dispatched', provider: 'agent-desktop' });
      expect(registry.list().map(entry => entry.sourceId)).toEqual([sources[0].sourceId]);
      expect(await routes.dispatch('computer.control.interrupt', { machineId: 'machine', sourceId: sources[0].sourceId }, agentContext))
        .toMatchObject({ status: 'interrupted', provider: 'cua' });
    } finally { await routes.dispose(); }
  });

  it('lets policy-admitted automation close its selected target without bypassing Session or Machine admission', async () => {
    const registry = createMachineLiveStreamCaptureRegistry();
    selectUnsupportedTarget(registry);
    const routes = createComputerRoutes({ machineId: 'machine', executablePath: '/managed/cua-driver', registry });
    try {
      const { executor, requests, effects, decide } = policyExecutor(routes);
      expect(await executor.execute('computer.target.close', { machineId: 'machine' }, agentContext))
        .toMatchObject({ ok: true, result: { kind: 'approval_request_created', artifactId: 'computer-approval' } });
      expect(requests).toMatchObject([{ actionId: 'computer.target.close' }]);
      expect(registry.list()).toHaveLength(1);
      expect(effects).toEqual([]);
      expect(await decide('approve')).toMatchObject({ ok: true, result: { status: 'executed' } });
      expect(effects).toEqual(['computer.target.close']);
      expect(registry.list()).toHaveLength(0);
      selectUnsupportedTarget(registry);
      expect(await routes.dispatch('computer.target.close', { machineId: 'other' },
        { authority: 'account_automation', defaultSessionId: 'session' }))
        .toMatchObject({ ok: false, errorCode: 'computer_machine_mismatch' });
      expect(await routes.dispatch('computer.target.close', { machineId: 'machine' },
        { authority: 'account_automation' })).toMatchObject({ ok: false, errorCode: 'computer_session_required' });
      expect(registry.list()).toHaveLength(1);
      expect(await executor.execute('computer.target.close', { machineId: 'machine' }, {
        ...agentContext, actionsSettings: ActionsSettingsV1Schema.parse({ v: 1,
          approvalWaivedSurfaces: { 'computer.target.close': ['agent'] } }),
      })).toMatchObject({ ok: true, result: { status: 'dispatched' } });
      expect(registry.list()).toHaveLength(0);
    } finally { await routes.dispose(); }
  });
  it('refuses an old approved source after selection was revoked or replaced', async () => {
    const registry = createMachineLiveStreamCaptureRegistry();
    selectUnsupportedTarget(registry);
    const routes = createComputerRoutes({ machineId: 'machine', executablePath: '/managed/cua-driver', registry });
    expect(await routes.dispatch('computer.capture', { machineId: 'machine', sourceId: 'old-approved-source' },
      { authority: 'account_automation', defaultSessionId: 'session', bypassApprovals: true }))
      .toMatchObject({ ok: false, errorCode: 'computer_target_selection_changed' });
    await routes.dispose();
  });
  it('refuses agent window enumeration before starting any native process', async () => {
    const routes = createComputerRoutes({ machineId: 'machine', executablePath: '/managed/cua-driver', registry: createMachineLiveStreamCaptureRegistry() });
    const { executor, requests, effects, decide } = policyExecutor(routes);
    expect(await executor.execute('computer.targets.list', { machineId: 'machine', displayId: ':73' }, agentContext))
      .toMatchObject({ ok: true, result: { kind: 'approval_request_created', artifactId: 'computer-approval' } });
    expect(requests).toMatchObject([{ actionId: 'computer.targets.list', status: 'open' }]);
    expect(effects).toEqual([]);
    expect(await decide('reject')).toMatchObject({ ok: true, result: { status: 'rejected' } });
    expect(effects).toEqual([]);
    await routes.dispose();
  });

  it('lists the machine’s own display for the person, and says plainly when there is no screen to share', async () => {
    // Missing optional OS packages settle with the recipe remedy; discovery never installs them.
    vi.stubEnv('PATH', '');
    vi.stubEnv('WAYLAND_DISPLAY', '');
    const headless = createComputerRoutes({ machineId: 'machine', executablePath: '/managed/cua-driver', registry: createMachineLiveStreamCaptureRegistry() });
    expect(await headless.dispatch('computer.target.get', { machineId: 'machine' },
      { authority: 'present_user', defaultSessionId: 'session' }))
      .toEqual({ ok: false, errorCode: 'computer_display_unavailable', error: 'computer_display_unavailable' });
    expect(await headless.dispatch('computer.targets.list', { machineId: 'machine' },
      { authority: 'present_user', defaultSessionId: 'session' }))
      .toMatchObject({ ok: false, errorCode: 'computer_display_unavailable', error: expect.stringContaining('virtual-display') });
    await headless.dispose();
    vi.unstubAllEnvs();
    // An unsupported desktop is a typed refusal the picker can explain, never a thrown RPC.
    const unsupported = createComputerRoutes({ machineId: 'machine', executablePath: '/managed/cua-driver', defaultDisplayId: 'not-an-x11-display',
      registry: createMachineLiveStreamCaptureRegistry() });
    expect(await unsupported.dispatch('computer.target.get', { machineId: 'machine' },
      { authority: 'present_user', defaultSessionId: 'session' }))
      .toMatchObject({ consentGranted: false, approvalDisplay: { requiresTargetSelection: true } });
    expect(await unsupported.dispatch('computer.targets.list', { machineId: 'machine' },
      { authority: 'present_user', defaultSessionId: 'session' }))
      .toEqual({ ok: false, errorCode: 'target_unsupported', error: 'target_unsupported' });
    await unsupported.dispose();
  });

  it('requires a user-selected target instead of accepting an agent-chosen native identity', async () => {
    const registry = createMachineLiveStreamCaptureRegistry();
    const routes = createComputerRoutes({ machineId: 'machine', executablePath: '/managed/cua-driver', registry });
    expect(await routes.dispatch('computer.capture', { machineId: 'machine',
      target: { kind: 'window', displayId: ':73', pid: 42, windowId: 7 } },
      { authority: 'account_automation', defaultSessionId: 'session' }))
      .toMatchObject({ status: 'target_selection_required', approvalDisplay: { requiresTargetSelection: true } });
    expect(registry.list()).toHaveLength(0);
    await routes.dispose();
  });

  it('rejects an unbound Session and a different machine before native disclosure', async () => {
    const routes = createComputerRoutes({ machineId: 'machine', executablePath: '/managed/cua-driver', registry: createMachineLiveStreamCaptureRegistry() });
    const target = { kind: 'window', displayId: ':fixture', pid: 42, windowId: 7 };
    expect(await routes.dispatch('computer.capture', { machineId: 'machine', target }, { authority: 'account_automation' })).toMatchObject({ ok: false, errorCode: 'computer_session_required' });
    expect(await routes.dispatch('computer.capture', { machineId: 'other', target }, { authority: 'account_automation', defaultSessionId: 'session' })).toMatchObject({ ok: false, errorCode: 'computer_machine_mismatch' });
    const { executor, requests, effects, decide } = policyExecutor(routes);
    expect(await executor.execute('computer.control.interrupt', { machineId: 'machine' }, agentContext))
      .toMatchObject({ ok: true, result: { kind: 'approval_request_created', artifactId: 'computer-approval' } });
    expect(requests).toMatchObject([{ actionId: 'computer.control.interrupt', status: 'open' }]);
    expect(effects).toEqual([]);
    expect(await decide('reject')).toMatchObject({ ok: true, result: { status: 'rejected' } });
    expect(effects).toEqual([]);
    await routes.dispose();
  });
  it('resolves the native route owner at dispatch without unrelated feature refresh', async () => {
    const routes = createComputerRoutes({ machineId: 'machine', executablePath: '/managed/cua-driver', registry: createMachineLiveStreamCaptureRegistry() });
    const execute = createDaemonRuntimeActionExecutor({ env: { NODE_ENV: 'test' }, resolveRouteOwners: () => ({ computer: routes }), resolveServerFeaturesSnapshot: () => undefined });
    expect(await execute({ actionId: 'computer.capture', input: { machineId: 'machine', target: { kind: 'window', displayId: ':fixture', pid: 42, windowId: 7 } }, context: { authority: 'account_automation' } })).toMatchObject({ ok: false, errorCode: 'computer_session_required' });
    await routes.dispose();
  });
  it('does not publish a failed native target as an available stream source', async () => {
    const registry = createMachineLiveStreamCaptureRegistry();
    selectUnsupportedTarget(registry);
    const routes = createComputerRoutes({ machineId: 'machine', executablePath: '/managed/cua-driver', registry });
    const result = await routes.dispatch('computer.capture', { machineId: 'machine',
      target: { kind: 'window', displayId: ':not-an-x11-display', pid: 42, windowId: 7 } },
    { authority: 'account_automation', defaultSessionId: 'session', bypassApprovals: true });
    expect(result).toMatchObject({ status: 'failed', code: 'target_unsupported' });
    expect(registry.list()[0]?.computer?.captureMedia()).toBeUndefined();
    await routes.dispose();
  });
  it('publishes the declared native payload at the runtime boundary, without a nested Action envelope', async () => {
    const registry = createMachineLiveStreamCaptureRegistry();
    selectUnsupportedTarget(registry);
    const routes = createComputerRoutes({ machineId: 'machine', executablePath: '/managed/cua-driver', registry });
    const execute = createDaemonRuntimeActionExecutor({ env: { NODE_ENV: 'test' }, resolveRouteOwners: () => ({ computer: routes }), resolveServerFeaturesSnapshot: () => undefined });
    const result = await execute({ actionId: 'computer.capture', input: { machineId: 'machine',
      target: { kind: 'window', displayId: ':not-an-x11-display', pid: 42, windowId: 7 } },
    context: { authority: 'account_automation', defaultSessionId: 'session', bypassApprovals: true } });
    expect(ComputerCaptureResponseV1Schema.parse(result)).toMatchObject({ status: 'failed', code: 'target_unsupported' });
    expect(registry.list()[0]?.computer?.captureMedia()).toBeUndefined();
    await routes.dispose();
  });
});
