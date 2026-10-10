import { describe, expect, it } from 'vitest';
import { createComputerRoutes } from './routes';
import { createMachineLiveStreamCaptureRegistry } from '../peer/mediation/stream/captureRegistry';
import { createDaemonRuntimeActionExecutor } from '../runtimeActionExecutor';
import { ComputerCaptureResponseV1Schema } from '@happier-dev/protocol';
import { createComputerCaptureSource } from './source';

function selectUnsupportedTarget(registry: ReturnType<typeof createMachineLiveStreamCaptureRegistry>) {
  const source = createComputerCaptureSource({ sessionId: 'session',
    target: { kind: 'window', displayId: ':not-an-x11-display', pid: 42, windowId: 7 } });
  registry.register({ sourceId: source.sourceId, streamFamily: 'screen', computer: source, adapter: source.adapter,
    capabilities: { v: 1, sourceId: source.sourceId, sourceKind: 'screen', supportedCodecs: ['image.frame.v1'], inputMode: 'shared', sidebands: [], health: { status: 'available' } } });
}

describe('native computer route authority', () => {
  it('refuses an old approved source after selection was revoked or replaced', async () => {
    const registry = createMachineLiveStreamCaptureRegistry();
    selectUnsupportedTarget(registry);
    const routes = createComputerRoutes({ machineId: 'machine', registry });
    expect(await routes.dispatch('computer.capture', { machineId: 'machine', sourceId: 'old-approved-source' },
      { authority: 'account_automation', defaultSessionId: 'session', bypassApprovals: true }))
      .toMatchObject({ ok: false, errorCode: 'computer_target_selection_changed' });
    await routes.dispose();
  });
  it('refuses agent window enumeration before starting any native process', async () => {
    const routes = createComputerRoutes({ machineId: 'machine', registry: createMachineLiveStreamCaptureRegistry() });
    expect(await routes.dispatch('computer.targets.list', { machineId: 'machine', displayId: ':73' },
      { authority: 'account_automation', defaultSessionId: 'session' }))
      .toMatchObject({ ok: false, errorCode: 'approval_required' });
    await routes.dispose();
  });

  it('lists the machine’s own display for the person, and says plainly when there is no screen to share', async () => {
    const headless = createComputerRoutes({ machineId: 'machine', registry: createMachineLiveStreamCaptureRegistry() });
    expect(await headless.dispatch('computer.targets.list', { machineId: 'machine' },
      { authority: 'present_user', defaultSessionId: 'session' }))
      .toEqual({ ok: false, errorCode: 'computer_display_unavailable', error: 'computer_display_unavailable' });
    await headless.dispose();
    // An unsupported desktop is a typed refusal the picker can explain, never a thrown RPC.
    const unsupported = createComputerRoutes({ machineId: 'machine', defaultDisplayId: 'not-an-x11-display',
      registry: createMachineLiveStreamCaptureRegistry() });
    expect(await unsupported.dispatch('computer.targets.list', { machineId: 'machine' },
      { authority: 'present_user', defaultSessionId: 'session' }))
      .toEqual({ ok: false, errorCode: 'target_unsupported', error: 'target_unsupported' });
    await unsupported.dispose();
  });

  it('requires a user-selected target instead of accepting an agent-chosen native identity', async () => {
    const registry = createMachineLiveStreamCaptureRegistry();
    const routes = createComputerRoutes({ machineId: 'machine', registry });
    expect(await routes.dispatch('computer.capture', { machineId: 'machine',
      target: { kind: 'window', displayId: ':73', pid: 42, windowId: 7 } },
      { authority: 'account_automation', defaultSessionId: 'session' }))
      .toMatchObject({ status: 'target_selection_required', approvalDisplay: { requiresTargetSelection: true } });
    expect(registry.list()).toHaveLength(0);
    await routes.dispose();
  });

  it('rejects an unbound Session and a different machine before native disclosure', async () => {
    const routes = createComputerRoutes({ machineId: 'machine', registry: createMachineLiveStreamCaptureRegistry() });
    const target = { kind: 'window', displayId: ':fixture', pid: 42, windowId: 7 };
    expect(await routes.dispatch('computer.capture', { machineId: 'machine', target }, { authority: 'account_automation' })).toMatchObject({ ok: false, errorCode: 'computer_session_required' });
    expect(await routes.dispatch('computer.capture', { machineId: 'other', target }, { authority: 'account_automation', defaultSessionId: 'session' })).toMatchObject({ ok: false, errorCode: 'computer_machine_mismatch' });
    expect(await routes.dispatch('computer.control.interrupt', { machineId: 'machine', target }, { authority: 'account_automation', defaultSessionId: 'session' })).toMatchObject({ ok: false, errorCode: 'approval_required' });
    await routes.dispose();
  });
  it('resolves the native route owner at dispatch without unrelated feature refresh', async () => {
    const routes = createComputerRoutes({ machineId: 'machine', registry: createMachineLiveStreamCaptureRegistry() });
    const execute = createDaemonRuntimeActionExecutor({ env: { NODE_ENV: 'test' }, resolveRouteOwners: () => ({ computer: routes }), resolveServerFeaturesSnapshot: () => undefined });
    expect(await execute({ actionId: 'computer.capture', input: { machineId: 'machine', target: { kind: 'window', displayId: ':fixture', pid: 42, windowId: 7 } }, context: { authority: 'account_automation' } })).toMatchObject({ ok: false, errorCode: 'computer_session_required' });
    await routes.dispose();
  });
  it('does not publish a failed native target as an available stream source', async () => {
    const registry = createMachineLiveStreamCaptureRegistry();
    selectUnsupportedTarget(registry);
    const routes = createComputerRoutes({ machineId: 'machine', registry });
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
    const routes = createComputerRoutes({ machineId: 'machine', registry });
    const execute = createDaemonRuntimeActionExecutor({ env: { NODE_ENV: 'test' }, resolveRouteOwners: () => ({ computer: routes }), resolveServerFeaturesSnapshot: () => undefined });
    const result = await execute({ actionId: 'computer.capture', input: { machineId: 'machine',
      target: { kind: 'window', displayId: ':not-an-x11-display', pid: 42, windowId: 7 } },
    context: { authority: 'account_automation', defaultSessionId: 'session', bypassApprovals: true } });
    expect(ComputerCaptureResponseV1Schema.parse(result)).toMatchObject({ status: 'failed', code: 'target_unsupported' });
    expect(registry.list()[0]?.computer?.captureMedia()).toBeUndefined();
    await routes.dispose();
  });
});
