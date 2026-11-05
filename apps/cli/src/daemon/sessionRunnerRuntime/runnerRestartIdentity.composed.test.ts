import '../../../../ui/sources/dev/vitestSetup';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { ProviderConnectionIdSchema } from '@happier-dev/protocol/providers/ids';
import type { SessionProviderBindingMetadataV1 } from '@happier-dev/protocol/providers/sessions/bindingMetadataV1';
import { installSessionOpsNetworkBoundary } from '../../../../ui/sources/dev/testkit/harness/sessionOpsNetworkBoundary';
import type { TrackedSession } from '../types';
import { hashProcessCommand } from '../sessionRegistry';

vi.mock('../../../../ui/sources/modal', async () =>
  (await import('../../../../ui/sources/dev/testkit/mocks/modal')).createModalModuleMock().module);

const boundary = await installSessionOpsNetworkBoundary();
const { socketRpcCodec } = await import('@happier-dev/sync-client');
const { createDaemonControlApp } = await import('../controlServer');
const { adoptTrackedSessionRunnerIdentity } = await import('../sessions/sessionReportCorrelation');
const { resolveSessionRunnerRuntimeState } = await import('./resolveRuntimeState');
const { resolveSessionRunnerRuntimeStatusV2 } = await import('./resolveRuntimeStatusV2');
const { restartSessionRunnerOnCurrentRuntime } = await import('../plannedRunnerRestart/restartSessionRunnerOnCurrentRuntime');
const { requestPlannedRunnerRestart } = await import('../plannedRunnerRestart/requestPlannedRunnerRestart');
const { requestConnectedServiceSessionRestartSignal } = await import('../connectedServices/sessionAuthSwitch/requestConnectedServiceSessionRestartSignal');
const { isPidSafeHappySessionProcess } = await import('../pidSafety');
await (await import('../../../../ui/sources/dev/testkit/harness/syncSingletonLoader')).loadSyncSingletonForTests();
const ops = await import('../../../../ui/sources/sync/ops/sessionRunnerRestart');
const { storage } = await import('../../../../ui/sources/sync/domains/state/storage');
const { serverScopedRpcSocketPool } = await import('../../../../ui/sources/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
const { resetScopedMachineTransportCacheForTests } = await import('../../../../ui/sources/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcPool');
const { resetServerReachabilitySupervisors } = await import('../../../../ui/sources/sync/runtime/connectivity/serverReachabilitySupervisorPool');

afterEach(async () => {
  await serverScopedRpcSocketPool.stopAll();
  await resetServerReachabilitySupervisors();
  vi.restoreAllMocks();
});
afterAll(() => boundary.dispose());

describe('wrapped runner status → UI provider restart → daemon signal custody', () => {
  it('reports no runner before startup without blaming the current daemon version', async () => {
    boundary.resetRequests();
    resetScopedMachineTransportCacheForTests();
    const home = await boundary.addHome('https://pending-restart.test', 'account-a');
    boundary.setHttpResponder(async input => {
      const path = new URL(String(input)).pathname;
      if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
      if (path === '/v2/account/settings') return Response.json({ version: 1, content: { t: 'plain', v: {} } });
      return null;
    });
    const currentIdentity = { status: 'known' as const, source: 'launch_spec' as const,
      comparableId: 'version:0.3.0', entrypointVersion: '0.3.0' };
    const app = createDaemonControlApp({ getChildren: () => [], controlToken: 'fixture-token',
      stopSession: async () => ({ status: 'stopped' }), spawnSession: async () => ({ type: 'success', sessionId: 's1' }),
      requestShutdown: () => {}, onHappySessionWebhook: () => {},
      handleSessionRunnerStatusV2Get: async () => resolveSessionRunnerRuntimeStatusV2({ tracked: null,
        state: resolveSessionRunnerRuntimeState({ sessionId: 's1', tracked: null, currentIdentity }) }),
    });
    const methods: string[] = [];
    try {
      await app.ready();
      boundary.setRpcResponder(async request => {
        methods.push(request.method);
        const decoded = await socketRpcCodec.decodeRequestParams({ mode: 'plain' }, request.payload, `${request.targetId}:${request.method}`);
        const response = await app.inject({ method: 'POST', url: '/session-runners/status-v2',
          headers: { 'x-happier-daemon-token': 'fixture-token' }, payload: decoded.params });
        expect(response.statusCode).toBe(200);
        return socketRpcCodec.encodeResponse({ mode: 'plain' }, response.json(), decoded.callId);
      });
      const { createDefaultActionExecutor } = await import('../../../../ui/sources/sync/ops/actions/defaultActionExecutor');
      const { ActionIdSchema } = await import('@happier-dev/protocol/actions/actionIds');
      expect(await createDefaultActionExecutor().execute(ActionIdSchema.parse('session.runtime.refresh'),
        { sessionId: 's1', machineId: 'm1', serverId: home.id },
        { surface: 'ui', authority: 'present_user', serverId: home.id, actionCaller: { kind: 'host' } }))
        .toMatchObject({ ok: true, result: { ok: false, status: 'runner_not_active', reasonCode: 'no_tracked_process' } });
      expect(methods).toEqual([RPC_METHODS.DAEMON_SESSION_RUNNER_STATUS_V2_GET]);
    } finally { await app.close(); }
  });
  it.each(['stable', 'missing launcher birth', 'missing runner birth', 'missing launcher custody', 'missing runner birth replaced', 'replaced before request', 'reused at signal'] as const)('uses the executable guard while retaining exact launcher cleanup custody (%s)', async change => {
    boundary.resetRequests();
    resetScopedMachineTransportCacheForTests();
    storage.setState({ sessions: {}, sessionListRowsByServerId: {} });
    const home = await boundary.addHome('https://wrapped-restart.test', 'account-a');
    boundary.setHttpResponder(async input => {
      const path = new URL(String(input)).pathname;
      if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
      if (path === '/v2/account/settings') return Response.json({ version: 1, content: { t: 'plain', v: {} } });
      return null;
    });
    const command = 'node /cli/versions/0.3.0/package-dist/index.mjs codex --happy-starting-mode remote --started-by daemon';
    const launchBinding: SessionProviderBindingMetadataV1 = { v: 1, connectionId: ProviderConnectionIdSchema.parse('pc_gateway'),
      contributionKey: null, connectionRevision: 1, protocol: 'openai-responses', materialization: 'engineConfig',
      compatibilityFingerprint: 'compatibility:v1:a', bindingSecurityFingerprint: 'binding-security:v1:alpha',
      displaySnapshot: { providerName: 'Gateway', connectionName: 'Work' } };
    const missingLauncherBirth = change === 'missing launcher birth' || change === 'missing launcher custody';
    const missingRunnerBirth = change === 'missing runner birth' || change === 'missing runner birth replaced';
    const tracked: TrackedSession = { pid: 4242, startedBy: 'daemon', happySessionId: 's1',
      processCommandHash: change === 'missing launcher custody' ? undefined : hashProcessCommand('source-launcher'),
      processStartTimeMs: missingLauncherBirth ? undefined : 100, processCommand: 'source-launcher',
      spawnOptions: { directory: '/work', resume: 'thread-1', providerBindingMetadataV1: launchBinding,
        backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' } } };
    const runner = { pid: 4343, processStartTimeMs: 200, processCommandHash: hashProcessCommand(command), processCommand: command };
    adoptTrackedSessionRunnerIdentity(tracked, { ...runner, processStartTimeMs: missingRunnerBirth ? undefined : 200 });
    const currentIdentity = { status: 'known' as const, source: 'launch_spec' as const,
      comparableId: 'version:0.3.0', entrypointVersion: '0.3.0' };
    let childBirth = 200;
    const readIdentity = async (pid: number) => ({ pid, command: pid === tracked.pid ? 'source-launcher' : command,
      processStartTimeMs: pid === tracked.pid ? 100 : childBirth });
    let statusReads = 0;
    let restartRequests = 0;
    let recoveryOptions: TrackedSession['spawnOptions'];
    const deliveryErrors: unknown[] = [];
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const app = createDaemonControlApp({ getChildren: () => [tracked], machineId: 'm1', controlToken: 'fixture-token',
      stopSession: async () => ({ status: 'stopped' }), spawnSession: async () => ({ type: 'success', sessionId: 's1' }),
      requestShutdown: () => {}, onHappySessionWebhook: () => {},
      handleSessionRunnerStatusV2Get: async () => {
        statusReads++;
        return resolveSessionRunnerRuntimeStatusV2({ tracked, readProcessIdentityByPidFn: readIdentity,
          state: resolveSessionRunnerRuntimeState({ sessionId: 's1', tracked, currentIdentity, machineId: 'm1' }) });
      },
      handleSessionRunnerRestart: request => {
        restartRequests++;
        return restartSessionRunnerOnCurrentRuntime({ request, tracked, currentIdentity,
          readProcessIdentityByPidFn: readIdentity,
          requestRestart: input => {
            recoveryOptions = input.transientSpawnOptions;
            return requestPlannedRunnerRestart({ ...input, deferral: { kind: 'none' },
            restartRequestedPids: new Set(), pidToTrackedSession: new Map([[tracked.pid, tracked]]),
            isProcessSafeToSignal: params => isPidSafeHappySessionProcess(params, { readProcessIdentityByPidFn: readIdentity }),
            captureRunnerRemainder: async () => {
              if (change === 'reused at signal') childBirth++;
              return { scope: 'subtree', roots: [], ownership: [] };
            },
            requestSignal: signal => requestConnectedServiceSessionRestartSignal({ pid: tracked.pid, delayMs: 0,
              shouldSignal: signal.shouldSignal, onSignalFailure: signal.onSignalFailure }),
            });
          },
        });
      },
    });
    try {
      await app.ready();
      // Replace only network delivery; real UI routing/codec, daemon HTTP dispatcher,
      // strict request schemas and both restart owners execute beneath this adapter.
      boundary.setRpcResponder(async request => {
        try {
          const decoded = await socketRpcCodec.decodeRequestParams({ mode: 'plain' }, request.payload, `${request.targetId}:${request.method}`);
          const url = request.method === RPC_METHODS.DAEMON_SESSION_RUNNER_STATUS_V2_GET
            ? '/session-runners/status-v2' : request.method === RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART_V2
              ? '/session-runners/restart-v2' : null;
          if (!url) throw new Error(`Unexpected RPC: ${request.method}`);
          const response = await app.inject({ method: 'POST', url,
            headers: { 'x-happier-daemon-token': 'fixture-token' }, payload: decoded.params });
          expect(response.statusCode).toBe(200);
          return socketRpcCodec.encodeResponse({ mode: 'plain' }, response.json(), decoded.callId);
        } catch (error) { deliveryErrors.push(error); throw error; }
      });
      const snapshot = await ops.getSessionRunnerRuntimeStatusSnapshot({ sessionId: 's1', machineId: 'm1', serverId: home.id });
      expect(deliveryErrors).toEqual([]);
      expect(snapshot).not.toBeNull();
      if (!snapshot) throw new Error('Missing daemon status');
      if (change === 'replaced before request') adoptTrackedSessionRunnerIdentity(tracked, { ...runner, pid: 4444 });
      if (change === 'missing runner birth replaced') childBirth++;
      const result = await ops.restartSessionRunnerForProviderBindingChange({ runtimeState: snapshot.state,
        runnerProcessIdentity: snapshot.runnerProcessIdentity, serverId: home.id,
        providerBindingSecurityChangeConfirmationV1: { v: 1, sessionId: 's1', connectionId: launchBinding.connectionId,
          previousBindingSecurityFingerprint: launchBinding.bindingSecurityFingerprint,
          nextBindingSecurityFingerprint: 'binding-security:v1:beta' } });
      const succeeds = change === 'stable' || change === 'missing launcher birth' || change === 'missing runner birth';
      expect(result).toMatchObject(succeeds ? { ok: true, status: 'restarted' }
        : { ok: false, status: 'runner_identity_changed' });
      expect(restartRequests).toBe(1);
      expect(statusReads).toBe(1); // Terminal refusals settle without status re-polls.
      if (succeeds) expect(kill).toHaveBeenCalledExactlyOnceWith(4242, 'SIGTERM');
      else expect(kill).not.toHaveBeenCalled();
      if (succeeds) expect(recoveryOptions).toMatchObject({ resume: 'thread-1',
        providerBindingSecurityChangeConfirmationV1: { sessionId: 's1', connectionId: launchBinding.connectionId,
          previousBindingSecurityFingerprint: 'binding-security:v1:alpha', nextBindingSecurityFingerprint: 'binding-security:v1:beta' } });
      expect(tracked.spawnOptions?.providerBindingMetadataV1).toEqual(launchBinding);
      expect(tracked.spawnOptions).not.toHaveProperty('providerBindingSecurityChangeConfirmationV1');
    } finally { await app.close(); }
  });
});
