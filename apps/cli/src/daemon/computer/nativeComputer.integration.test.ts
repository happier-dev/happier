import { spawn, type ChildProcess } from 'node:child_process';
import type { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { ActionIdSchema, ComputerCaptureResponseV1Schema, createActionExecutor, type ActionExecutorDeps, type ApprovalRequest, type MachineLiveStreamFrameV1 } from '@happier-dev/protocol';
import { createComputerRoutes } from './routes';
import { createDaemonRuntimeActionExecutor } from '../runtimeActionExecutor';
import { createMachineLiveStreamCaptureRegistry } from '../peer/mediation/stream/captureRegistry';
import { createDaemonMachineLiveStreamCaptureAdapter } from '../peer/mediation/stream/captureAdapter';
import { registerHappierMcpBuiltInTools } from '@/mcp/server/registerHappierMcpBuiltInTools';

function line(stream: Readable): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const data = (chunk: Buffer) => { buffer += chunk.toString(); if (buffer.includes('\n')) { stream.off('data', data); resolve(buffer.split('\n')[0]!); } };
    stream.on('data', data);
    stream.once('error', reject);
    stream.once('end', () => reject(new Error('Fixture exited before readiness')));
  });
}
async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exit = new Promise<void>(resolve => child.once('exit', () => resolve()));
  child.kill('SIGTERM');
  await exit;
}
const executablePath = process.env.HAPPIER_TEST_NATIVE_EXECUTABLE;
const fixturePath = process.env.HAPPIER_TEST_NATIVE_FIXTURE;
describe.skipIf(!executablePath || !fixturePath || process.platform !== 'linux')('isolated native computer journey', () => {
  it('selects the actual X11 primary display and dispatches one capture-bound click', async () => {
    const xvfb = spawn('Xvfb', ['-displayfd', '3', '-screen', '0', '1024x768x24', '-nolisten', 'tcp'], { stdio: ['ignore', 'ignore', 'pipe', 'pipe'] });
    let fixture: ChildProcess | undefined;
    const registry = createMachineLiveStreamCaptureRegistry();
    let routes: ReturnType<typeof createComputerRoutes> | undefined;
    try {
      const displayId = `:${await line(xvfb.stdio[3] as Readable)}`;
      fixture = spawn(fixturePath!, [], { env: { ...process.env, DISPLAY: displayId }, stdio: ['ignore', 'pipe', 'pipe'] });
      await line(fixture.stdout!);
      routes = createComputerRoutes({ machineId: 'native-machine', registry, defaultDisplayId: displayId, executablePath });
      const machine = { machineId: 'native-machine' };
      const human = { authority: 'present_user' as const, defaultSessionId: 'native-session' };
      const agent = { authority: 'account_automation' as const, defaultSessionId: 'native-session', bypassApprovals: true };
      const target = { kind: 'display' as const, displayId };
      expect(await routes.dispatch('computer.targets.list', machine, human)).toMatchObject({
        displays: { status: 'available' }, targets: expect.arrayContaining([expect.objectContaining({ target })]),
      });
      expect(registry.list()).toHaveLength(0);
      expect(await routes.dispatch('computer.target.select', { ...machine, target, access: 'see' }, human))
        .toMatchObject({ consentGranted: false, access: 'see', approvalDisplay: { target: { kind: 'display' } } });
      const viewed = ComputerCaptureResponseV1Schema.parse(await routes.dispatch('computer.capture', machine, human));
      expect(viewed).toMatchObject({ status: 'captured', geometry: { captureWidth: 1024, captureHeight: 768,
        nativeWidth: 1024, nativeHeight: 768, originX: 0, originY: 0, scaleX: 1, scaleY: 1 } });
      if (viewed.status !== 'captured') throw new Error(viewed.status);
      expect(await routes.dispatch('computer.input', { ...machine, captureId: viewed.captureId,
        operation: { kind: 'click', x: 70, y: 70 } }, agent)).toMatchObject({ status: 'failed', code: 'computer_access_read_only' });
      await routes.dispatch('computer.target.select', { ...machine, target, access: 'use' }, human);
      const capture = ComputerCaptureResponseV1Schema.parse(await routes.dispatch('computer.capture', machine, agent));
      if (capture.status !== 'captured') throw new Error(capture.status);
      const clicked = line(fixture.stdout!);
      expect(await routes.dispatch('computer.input', { ...machine, captureId: capture.captureId,
        operation: { kind: 'click', x: 70, y: 70 } }, agent)).toMatchObject({ status: 'dispatched' });
      expect(await clicked).toBe('clicks:1');
      expect(await routes.dispatch('computer.input', { ...machine, captureId: capture.captureId,
        operation: { kind: 'click', x: 70, y: 70 } }, agent)).toMatchObject({ status: 'failed', code: 'stale_capture' });
      expect(await routes.dispatch('computer.control.interrupt', machine, human))
        .toMatchObject({ status: 'interrupted', completion: 'known' });
      expect(await routes.dispatch('computer.control.status', machine, human))
        .toMatchObject({ controller: 'human', stopping: false, uncertain: false });
      const humanCapture = ComputerCaptureResponseV1Schema.parse(await routes.dispatch('computer.capture', machine, human));
      if (humanCapture.status !== 'captured') throw new Error(humanCapture.status);
      const humanClicked = line(fixture.stdout!);
      expect(await routes.dispatch('computer.input', { ...machine, captureId: humanCapture.captureId,
        operation: { kind: 'click', x: 70, y: 70 } }, human)).toMatchObject({ status: 'dispatched' });
      expect(await humanClicked).toBe('clicks:2');
      expect(await routes.dispatch('computer.control.handBack', machine, human)).toMatchObject({ status: 'dispatched' });
      expect(await routes.dispatch('computer.input', { ...machine, captureId: humanCapture.captureId,
        operation: { kind: 'click', x: 70, y: 70 } }, agent)).toMatchObject({ status: 'failed', code: 'observation_required' });
      expect(await routes.dispatch('computer.target.close', machine, human)).toMatchObject({ status: 'dispatched' });
      expect(registry.list()).toHaveLength(0);
    } finally { await routes?.dispose(); if (fixture) await stop(fixture); await stop(xvfb); }
  });
  it('admits exact Session consent, observes actual pixels through MCP, streams and hands control back', async () => {
    const xvfb = spawn('Xvfb', ['-displayfd', '3', '-screen', '0', '1024x768x24', '-nolisten', 'tcp'], { stdio: ['ignore', 'ignore', 'pipe', 'pipe'] });
    let fixture: ChildProcess | null = null;
    const registry = createMachineLiveStreamCaptureRegistry();
    const routes = createComputerRoutes({ machineId: 'native-test-machine', machineDisplayName: 'Native fixture machine', registry,
      executablePath: executablePath === 'managed' ? undefined : executablePath });
    try {
      const displayId = `:${await line(xvfb.stdio[3] as Readable)}`;
      fixture = spawn(fixturePath!, [], { env: { ...process.env, DISPLAY: displayId }, stdio: ['ignore', 'pipe', 'pipe'] });
      const windowId = Number((await line(fixture.stdout!)).split(':')[1]);
      if (!fixture.pid || !windowId) throw new Error('Native fixture identity unavailable');
      const target = { kind: 'window' as const, displayId, pid: fixture.pid, windowId };
      const input = { machineId: 'native-test-machine' };
      const runtimeActionExecute = createDaemonRuntimeActionExecutor({ env: {}, resolveRouteOwners: () => ({ computer: routes }), resolveServerFeaturesSnapshot: () => undefined });
      const unused = async (): Promise<never> => { throw new Error('Unrelated service is outside the fixture'); };
      const approvals: ApprovalRequest[] = [];
      let approve = false;
      const deps: ActionExecutorDeps = {
        executionRunStart: unused, executionRunList: unused, executionRunGet: unused, detachedExecutionRunSend: unused,
        executionRunStop: unused, executionRunAction: unused, executionRunWait: unused,
        sessionOpen: unused, sessionFork: unused, sessionRollback: unused, sessionSpawnNew: unused,
        pathsListRecent: unused, machinesList: unused, serversList: unused, reviewEnginesList: unused,
        agentsBackendsList: unused, agentsModelsList: unused, sessionSendMessage: unused,
        sessionPermissionRespond: unused, sessionUserActionAnswer: unused, sessionModeSet: unused, sessionModesList: unused,
        sessionTargetPrimarySet: unused, sessionTargetTrackedSet: unused, sessionList: unused, sessionActivityGet: unused,
        sessionRecentMessagesGet: unused, resetGlobalVoiceAgent() {}, runtimeActionExecute,
        daemonMemorySearch: unused, daemonMemoryGetWindow: unused, daemonMemoryEnsureUpToDate: unused,
        // The Artifact transport/present human are genuine external boundaries; approval policy and replay remain real.
        approvalsCreate: async ({ request }) => { approvals.push(request); return { artifactId: `approval-${approvals.length}` }; },
        approvalsUpdate: async () => ({ ok: true }),
        approvalsWaitForDecision: async ({ request }) => {
          if (approve) {
            expect(await routes.dispatch('computer.target.select', { ...input, target },
              { authority: 'present_user', defaultSessionId: 'native-test-session' })).toMatchObject({
                consentGranted: false, approvalDisplay: { target: { kind: 'window', title: 'Happier native computer fixture' } } });
          }
          return { decision: approve ? 'approve' : 'reject', request };
        },
        isApprovalExecutionOriginCurrent: async () => true,
      };
      const executor = createActionExecutor(deps);
      const context = { surface: 'agent' as const, authority: 'account_automation' as const,
        serverId: 'native-test-home',
        actionRequestId: 'native-test-action',
        defaultSessionId: 'native-test-session', defaultSessionMachineId: 'native-test-machine' };
      expect(await executor.execute('computer.capture', input, context)).toMatchObject({ ok: false, errorCode: 'approval_rejected' });
      expect(registry.list()).toHaveLength(0);
      expect(approvals[0]).toMatchObject({ actionId: 'computer.capture', actionArgs: input });
      expect(approvals[0]?.preview).toMatchObject({ computerApprovalDisplay: {
        machineDisplayName: 'Native fixture machine', requiresTargetSelection: true } });
      approve = true;
      const handlers = new Map<string, (args: unknown) => Promise<unknown>>();
      let captured: unknown;
      registerHappierMcpBuiltInTools({ registerTool(name, _meta, handler) { handlers.set(name, handler); } }, {
        sessionId: context.defaultSessionId, sessionMachineId: context.defaultSessionMachineId, surface: 'agent',
        // The Session media owner, not this deliberately unrelated MCP cwd, resolves daemon artifacts.
        workingDirectory: '/not-the-computer-media-owner',
        deps: { changeTitle: unused, async executeActionByToolName(_toolName, rawArgs) {
          const args = rawArgs as { actionId: string; input: unknown };
          const result = await executor.execute(ActionIdSchema.parse(args.actionId), args.input, context);
          if (result.ok) captured = result.result;
          return result;
        } },
      });
      const output = await handlers.get('action_execute')!({ actionId: 'computer.capture', input });
      expect(output).toMatchObject({ isError: false, content: expect.arrayContaining([{ type: 'image', mimeType: 'image/png', data: expect.any(String) }]) });
      const observation = ComputerCaptureResponseV1Schema.parse(captured);
      if (observation.status !== 'captured') throw new Error(observation.status);
      expect(observation.geometry).toMatchObject({ captureWidth: 400, captureHeight: 240, originX: 20, originY: 20 });
      const clicked = line(fixture.stdout!);
      expect(await executor.execute('computer.input', { ...input, captureId: observation.captureId, operation: { kind: 'click', x: 50, y: 50 } }, context)).toMatchObject({ ok: true, result: { status: 'dispatched' } });
      expect(await clicked).toBe('clicks:1');
      expect(approvals).toHaveLength(2);
      expect(await routes.dispatch('computer.target.get', input, context)).toMatchObject({ consentGranted: true,
        approvalDisplay: { requiresTargetSelection: false, target: { kind: 'window', title: 'Happier native computer fixture' },
          captureMedia: observation.media } });
      expect(await routes.dispatch('computer.targets.list', { ...input, displayId }, context)).toMatchObject({ ok: false, errorCode: 'approval_required' });
      const frames: MachineLiveStreamFrameV1[] = [];
      const now = Date.now();
      const caps = { maxBitrateBps: 1_000_000, maxFramesPerSecond: 10, maxFrameBytes: 100_000, maxDurationMs: 60_000 };
      const stream = await createDaemonMachineLiveStreamCaptureAdapter(registry).start({
        streamId: 'native-test-stream', streamFamily: 'screen', sourceMachineId: 'native-test-machine', targetMachineId: 'native-test-machine', caps,
        startRequest: { v: 1, streamId: 'native-test-stream', streamFamily: 'screen', sourceId: observation.sourceId, codecId: 'image.frame.v1',
          routeKind: 'loopback_direct', sourceMachineId: 'native-test-machine', targetMachineId: 'native-test-machine', ...caps },
        startedAtMs: now, expiresAtMs: now + caps.maxDurationMs, nowMs: () => Date.now(),
        offerFrame(frame) { frames.push(frame); return { ok: true }; }, applyControl: () => ({ ok: true }), emitReceipt() {},
      });
      expect(stream.ok).toBe(true);
      expect(frames[0]).toMatchObject({ codecId: 'image.frame.v1', payloadKind: 'image_keyframe' });
      const humanContext = { ...context, surface: 'ui' as const, authority: 'present_user' as const };
      expect(await executor.execute('computer.control.interrupt', input, humanContext)).toMatchObject({ ok: true, result: { status: 'interrupted', completion: 'known' } });
      expect(await executor.execute('computer.control.status', input, humanContext)).toMatchObject({ ok: true, result: { controller: 'human', stopping: false, uncertain: false } });
      expect(await executor.execute('computer.input', { ...input, captureId: observation.captureId, operation: { kind: 'click', x: 50, y: 50 } }, context)).toMatchObject({ ok: true, result: { status: 'failed', code: 'human_interrupted' } });
      expect(await executor.execute('computer.control.handBack', input, humanContext)).toMatchObject({ ok: true, result: { status: 'dispatched' } });
      expect(await executor.execute('computer.input', { ...input, captureId: observation.captureId, operation: { kind: 'click', x: 50, y: 50 } }, context)).toMatchObject({ ok: true, result: { status: 'failed', code: 'observation_required' } });
      if (stream.ok) await stream.session.stop();
      await stop(fixture);
      expect(await routes.dispatch('computer.target.get', input, context)).toMatchObject({ consentGranted: false,
        approvalDisplay: { requiresTargetSelection: true } });
      await routes.closeSession(context.defaultSessionId);
      expect(registry.list()).toHaveLength(0);
    } finally { await routes.dispose(); if (fixture) await stop(fixture); await stop(xvfb); }
  });
});
