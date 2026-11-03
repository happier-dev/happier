import { describe, expect, it, vi } from 'vitest';
import { SessionSpawnNewResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { projectSessionSpawnFailure } from '@/session/creation/projectSessionSpawnFailure';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { projectCurrentAgentSessionView } from '@happier-dev/agents';

import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { awaitTrackedRunnerAgentSessionOpen, recordTrackedRunnerAgentSessionOpenAttestation } from '@/daemon/agentRuntime/runnerAgentSessionOpenAttestation';
import { createStopSession } from '@/daemon/sessions/stopSession';
import { createSessionRunnerRespawnManager } from '@/daemon/processSupervision/sessionRunnerRespawn';
import { createAgentSessionRunnerFactoryBinding } from '@/plugins/runtime/runner/agentSessionRunnerFactoryBinding';
import type { TrackedSession } from '@/daemon/types';
import { SPAWN_SESSION_ERROR_CODES, type SpawnSessionOptions, type SpawnSessionResult } from '@/session/shared/spawnSessionContract';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { AgentRuntimeDaemonServiceRequestV1Schema, AgentRuntimeDaemonServiceSessionOpenAttestationV1Schema } from '@/agent/runtime/session/process/agentRuntimeDaemonServiceProtocol';
import { createMachineSessionSpawnRpcHandler } from '../sessionLifecycleActions';
import { SessionStartupInputRefusalError } from '@/agent/runtime/session/input/sessionStartupInputRefusal';

import { createSpawnNewSessionLifecycleActionHandler } from './createSpawnNewSessionLifecycleActionHandler';
import { runRequesterSessionLifecycle } from './requesterSessionLifecycle';
import { attemptNativeForkOpen } from './fork/attemptNativeForkOpen';

describe('Session startup operation custody', () => {
  it('settles a carrier still waiting for native open with the Session startup owner timeout', async () => {
    vi.stubEnv('HAPPIER_DAEMON_SESSION_WEBHOOK_TIMEOUT_MS', '100');
    // The OS child is the native boundary; handler, startup observation,
    // operation settlement and strict Action projection remain real.
    const child = spawn(process.execPath, ['-e', 'process.stdin.resume()'], { stdio: ['pipe', 'ignore', 'ignore'] });
    const exited = once(child, 'exit');
    const sessionId = 'voice-home-carrier';
    const tracked: TrackedSession = { pid: child.pid!, startedBy: 'daemon', happySessionId: sessionId,
      childProcess: child, agentRuntimeDaemonServiceAuthorityFilePath: '/fixture/carrier-authority' };
    const operations = createHostActionOperationRuntime({ machineId: 'machine', resolveAccountId: async () => 'account',
      generateOperationId: () => 'carrier-startup', supportsCoreCancellation: () => true });
    const scope = { machineId: 'machine', accountId: 'account' };
    const handler = createMachineSessionSpawnRpcHandler({ handlers: {
      spawnSession: async () => ({ type: 'success', sessionId }),
      stopSession: async () => { throw new Error('An observation timeout must not stop admitted native startup'); },
    }, awaitAgentSessionOpen: input => awaitTrackedRunnerAgentSessionOpen({ ...input, getTrackedSessions: () => [tracked] }) });
    let result: unknown;
    const response = operations.observeExecution({ actionId: 'session.spawn_new', input: { creationKey: 'voice-home' },
      execute: async operation => ({ ok: true, result: await handler({ directory: '/project',
        agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
      }, { signal: operation.signal, localActionContext: operation }) }) });
    void response.then(value => { result = value; }, error => { result = error; });
    try {
      await vi.waitFor(() => expect(result).toMatchObject({ ok: true, result: { type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED,
        errorDetail: { kind: 'launch_error', code: SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT } } }));
      const terminal = await operations.handlers.getV2({ operationId: 'carrier-startup', waitForTerminal: true });
      expect(terminal).toMatchObject({ kind: 'found', operation: { state: 'succeeded' } });
      if (terminal.kind !== 'found') throw new Error('Missing carrier operation');
      const failure = terminal.operation.result;
      if (!failure || typeof failure !== 'object' || !('errorCode' in failure) || !('errorDetail' in failure)) {
        throw new Error('Missing typed carrier failure');
      }
      expect(SessionSpawnNewResultV1Schema.parse(projectSessionSpawnFailure({
        errorCode: String(failure.errorCode), errorMessage: 'Native open did not settle', errorDetail: failure.errorDetail,
      }))).toMatchObject({ type: 'error', code: 'spawn_failed',
        launchError: { code: SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT } });
      expect(child.exitCode).toBeNull();
      expect(tracked.stopRequestedAtMs).toBeUndefined();
    } finally {
      operations.runner.cancel(scope, 'carrier-startup');
      await response.catch(() => undefined);
      child.stdin.end();
      await exited;
      vi.unstubAllEnvs();
    }
  });

  it.each(['current', 'replacement', 'changed-birth', 'stop-throws', 'stop-incomplete'] as const)(
    'retires only the attested refused generation and preserves its typed failure (%s)', async scenario => {
    const sessionId = 'refused-child';
    const operations = createHostActionOperationRuntime({ machineId: 'machine', resolveAccountId: async () => 'account',
      generateOperationId: () => 'refused-startup', supportsCoreCancellation: () => true });
    const scope = { machineId: 'machine', accountId: 'account' };
    const binding = createAgentSessionRunnerFactoryBinding({ v: 1, pluginId: 'acme.plugin', pluginVersion: '1.0.0',
      agentId: 'acme-agent', localAgentId: 'acme-agent', sourceCustody: { kind: 'managed',
        immutableGenerationId: `sha256:${'1'.repeat(64)}`, installSource: 'localPath' },
      locator: { module: './runtime.mjs', export: 'createRuntime', runtimeApiVersion: 1 },
      normalizedModulePath: '/immutable/acme/runtime.mjs', loadMode: 'immutable-js' });
    const runner = { pid: 41001001, processStartTimeMs: 1000, processCommandHash: 'a'.repeat(64) };
    const refused: TrackedSession = { ...runner, startedBy: 'daemon', happySessionId: sessionId,
      runnerAgentSourceCustodyV1: binding.sourceCustody,
      agentRuntimeDaemonServiceAuthorityFilePath: '/fixture/refused-authority' };
    const replacement: TrackedSession = { pid: 41001002, processStartTimeMs: 2000, startedBy: 'daemon',
      happySessionId: sessionId, agentRuntimeDaemonServiceAuthorityFilePath: '/fixture/replacement-authority' };
    const tracked = new Map([[refused.pid, refused]]);
    const selected: number[][] = [];
    const retired: number[] = [];
    const physical = createStopSession({ pidToTrackedSession: tracked,
      // OS liveness/exit and terminal files are boundaries; no actual PID is signalled.
      areTrackedRunnersExited: async ({ trackedPids }) => { selected.push([...trackedPids]); return true; },
      waitForTrackedRunnersExit: async ({ trackedPids }) => {
        expect(operations.store.get(scope, 'refused-startup')).toMatchObject({ state: 'running' });
        retired.push(...trackedPids);
        return true;
      },
      readHostAttachmentState: async () => ({ status: 'absent' }), readTerminalAttachmentInfo: async () => null,
    });
    const handler = createMachineSessionSpawnRpcHandler({ handlers: {
      spawnSession: async () => {
        // External Agent producer -> exact private parser -> host recorder -> waiter.
        const request = AgentRuntimeDaemonServiceRequestV1Schema.parse({ v: 1,
          context: { token: 'a'.repeat(43), sessionId }, operation: { kind: 'session.open.attest',
            requestId: 'refused-open', phase: 'refused', request: { kind: 'create', sessionId, cwd: '/project' },
            providerSessionId: null } });
        if (request.operation.kind !== 'session.open.attest') throw new Error('Wrong attestation operation');
        expect(await recordTrackedRunnerAgentSessionOpenAttestation({ tracked: refused, retainedAgent: binding,
          runner: { ...runner, snapshotIdentity: 'refused-startup-runner' },
          ...request.operation, updateMarker: async () => true })).not.toBeNull();
        return { type: 'success', sessionId };
      },
      stopSession: scenario === 'stop-throws' ? async () => { throw new Error('OS Stop failed'); }
        : scenario === 'stop-incomplete' ? async () => ({ status: 'incomplete', reason: 'runner_signal_incomplete' })
        : physical,
    }, awaitAgentSessionOpen: input => awaitTrackedRunnerAgentSessionOpen({ ...input, getTrackedSessions: () => {
      const rows = [...tracked.values()];
      // Replacement registration or a mis-bound mutable birth occurs after observation, before Stop selection.
      if (scenario === 'replacement') queueMicrotask(() => { tracked.clear(); tracked.set(replacement.pid, replacement); });
      if (scenario === 'changed-birth') queueMicrotask(() => { refused.processStartTimeMs = 2000; });
      return rows;
    } }) });
    try {
      await expect(operations.observeExecution({ actionId: 'session.spawn_new', input: { creationKey: 'refused' },
        execute: async operation => ({ ok: true, result: await handler({ directory: '/project',
          agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
        }, { signal: operation.signal, localActionContext: operation }) }) })).rejects.toBeInstanceOf(SessionStartupInputRefusalError);
      await operations.handlers.getV2({ operationId: 'refused-startup', waitForTerminal: true });
      expect(operations.store.get(scope, 'refused-startup')).toMatchObject({ state: 'failed',
        error: { errorCode: 'native_agent_session_mode_unavailable' } });
      expect(retired).toEqual(scenario === 'current' ? [refused.pid] : []);
      expect(selected).toEqual(scenario === 'current' ? [[refused.pid]] : []);
      expect(replacement.stopRequestedAtMs).toBeUndefined();
      if (scenario !== 'current') expect(refused.stopRequestedAtMs).toBeUndefined();
      else expect(refused.stopRequestedAtMs).toBeTypeOf('number');
    } finally { operations.runner.cancel(scope, 'refused-startup'); }
  });

  it('joins refused-child retirement before failing the original startup operation', async () => {
    const operations = createHostActionOperationRuntime({ machineId: 'machine', resolveAccountId: async () => 'account',
      generateOperationId: () => 'refused-startup', supportsCoreCancellation: () => true });
    const tracked: TrackedSession = { pid: 103, startedBy: 'daemon', happySessionId: 'refused-child',
      agentRuntimeDaemonServiceAuthorityFilePath: '/private/refused-authority.json',
      agentRuntimeDaemonServiceSessionOpenAttestation: AgentRuntimeDaemonServiceSessionOpenAttestationV1Schema.parse({
        request: { kind: 'create', sessionId: 'refused-child', cwd: '/project' }, providerSessionId: null,
        refusal: { code: 'native_agent_session_mode_unavailable' },
      }) };
    let releaseStop!: () => void;
    const stopped = new Promise<void>(resolve => { releaseStop = resolve; });
    let stopEntered!: () => void;
    const stopping = new Promise<void>(resolve => { stopEntered = resolve; });
    const handler = createMachineSessionSpawnRpcHandler({ handlers: {
      spawnSession: async () => ({ type: 'success', sessionId: 'refused-child' }),
      // The process adapter acknowledges only after the exact child exits.
      stopSession: async sessionId => {
        expect(sessionId).toBe('refused-child'); stopEntered(); await stopped;
        return { status: 'stopped' };
      },
    }, awaitAgentSessionOpen: input => awaitTrackedRunnerAgentSessionOpen({ getTrackedSessions: () => [tracked], ...input }) });
    const scope = { accountId: 'account', machineId: 'machine' };
    const response = operations.observeExecution({ actionId: 'session.spawn_new', input: { creationKey: 'refused' },
      execute: async operation => ({ ok: true, result: await handler({ directory: '/project',
        agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
      }, { signal: operation.signal, localActionContext: operation }) }) });
    try {
      await stopping;
      expect(operations.store.get(scope, 'refused-startup')).toMatchObject({ state: 'running' });
      releaseStop();
      await expect(response).rejects.toBeInstanceOf(SessionStartupInputRefusalError);
      await vi.waitFor(() => expect(operations.store.get(scope, 'refused-startup')).toMatchObject({ state: 'failed',
        error: { errorCode: 'native_agent_session_mode_unavailable' } }));
    } finally { releaseStop(); operations.runner.cancel(scope, 'refused-startup'); }
  });
  it.each([null, 'machine-child'].flatMap(machineId =>
    ['current', 'replacement', 'changed-birth', 'stop-throws', 'stop-incomplete'].map(scenario => ({ machineId, scenario })),
  ))('keeps native-fork refusal cleanup bound to its observed runner ($scenario, Machine $machineId)', async ({ machineId, scenario }) => {
      const sessionId = 'refused-fork-child';
      const scope = { machineId: 'machine', accountId: 'account' };
      const operations = createHostActionOperationRuntime({ ...scope, resolveAccountId: async () => scope.accountId,
        generateOperationId: () => 'refused-fork-startup', supportsCoreCancellation: () => true });
      const binding = createAgentSessionRunnerFactoryBinding({ v: 1, pluginId: 'acme.plugin', pluginVersion: '1.0.0',
        agentId: 'acme-agent', localAgentId: 'acme-agent', sourceCustody: { kind: 'managed',
          immutableGenerationId: `sha256:${'1'.repeat(64)}`, installSource: 'localPath' },
        locator: { module: './runtime.mjs', export: 'createRuntime', runtimeApiVersion: 1 },
        normalizedModulePath: '/immutable/acme/runtime.mjs', loadMode: 'immutable-js' });
      const runner = { pid: 41001001, processStartTimeMs: 1000, processCommandHash: 'a'.repeat(64) };
      const refused: TrackedSession = { ...runner, startedBy: 'daemon', happySessionId: sessionId,
        runnerAgentSourceCustodyV1: binding.sourceCustody, agentRuntimeDaemonServiceAuthorityFilePath: '/fixture/p-authority' };
      const replacement: TrackedSession = { pid: 41001002, processStartTimeMs: 2000, startedBy: 'daemon',
        happySessionId: sessionId, agentRuntimeDaemonServiceAuthorityFilePath: '/fixture/q-authority' };
      const tracked = new Map([[refused.pid, refused]]);
      const selected: number[][] = [];
      const retired: number[] = [];
      const exitOperationStates: (string | undefined)[] = [];
      const physical = createStopSession({ pidToTrackedSession: tracked,
        // OS liveness/exit and terminal files are boundaries; no fake PID is signalled.
        areTrackedRunnersExited: async ({ trackedPids }) => { selected.push([...trackedPids]); return true; },
        waitForTrackedRunnersExit: async ({ trackedPids }) => {
          exitOperationStates.push(operations.store.get(scope, 'refused-fork-startup')?.state);
          if (scenario === 'stop-throws') throw new Error('OS exit observation failed');
          if (scenario === 'stop-incomplete') return false;
          retired.push(...trackedPids);
          return true;
        },
        readHostAttachmentState: async () => ({ status: 'absent' }), readTerminalAttachmentInfo: async () => null });
      let stopAttempts = 0;
      const stopSession: typeof physical = (...args) => { stopAttempts += 1; return physical(...args); };
      const runtimeDescriptorV1 = { v: 1 as const, agentId: 'acme-agent', agent: { providerSessionId: 'provider-parent' } };
      const parentMetadata = projectCurrentAgentSessionView({ runtimeDescriptorV1 }, { agentId: 'acme-agent',
        runtimeDescriptor: runtimeDescriptorV1, nativeResumeIdentity: { v: 1, vendorResumeId: 'provider-parent' } });
      const child = createSessionRecordFixture({ id: sessionId, active: true, machineId });
      const machineReads: string[] = [];
      let archived = false;
      const home = createServer((request, response) => {
        response.setHeader('content-type', 'application/json');
        if (request.url?.startsWith('/v1/machines/')) machineReads.push(request.url);
        if (request.method === 'GET' && request.url === `/v2/sessions/${sessionId}`) {
          response.end(JSON.stringify({ session: { ...child, active: retired.length === 0 } }));
        } else if (request.method === 'POST' && request.url === `/v2/sessions/${sessionId}/archive` && retired.length > 0) {
          archived = true;
          response.end(JSON.stringify({ success: true, archivedAt: 1 }));
        } else { response.statusCode = 404; response.end('{}'); }
      });
      await new Promise<void>(resolve => home.listen(0, '127.0.0.1', resolve));
      const address = home.address();
      if (!address || typeof address === 'string') throw new Error('Expected owned Home listener');
      try {
        await runWithServerHttpBaseUrl(`http://127.0.0.1:${address.port}`, async () => {
          const response = await operations.observeExecution({ actionId: 'session.fork', input: { requestId: 'refused-fork' },
            execute: async operation => {
              const result = await runRequesterSessionLifecycle({ sessionId: 'parent',
                context: { signal: operation.signal, localActionContext: operation }, stopSession,
                spawnSession: async options => {
                  expect(options.projectSetupOperation?.operationAcceptance?.operationId).toBe('refused-fork-startup');
                  // Real external Agent producer -> strict private parser -> recorder -> observer.
                  const request = AgentRuntimeDaemonServiceRequestV1Schema.parse({ v: 1,
                    context: { token: 'a'.repeat(43), sessionId }, operation: { kind: 'session.open.attest',
                      requestId: 'refused-fork-open', phase: 'refused', request: { kind: 'fork', sessionId,
                        cwd: '/project', source: options.nativeForkSource }, providerSessionId: null } });
                  if (request.operation.kind !== 'session.open.attest') throw new Error('Wrong operation');
                  expect(await recordTrackedRunnerAgentSessionOpenAttestation({ tracked: refused, retainedAgent: binding,
                    runner: { ...runner, snapshotIdentity: 'refused-fork-runner' }, ...request.operation,
                    updateMarker: async () => true })).not.toBeNull();
                  return { type: 'success', sessionId };
                },
                awaitAgentSessionOpen: input => awaitTrackedRunnerAgentSessionOpen({ ...input, getTrackedSessions: () => [...tracked.values()] }),
                refused: () => ({ ok: false as const, errorCode: 'requester_unavailable', errorMessage: 'unavailable' }),
                run: ({ spawnSession }) => attemptNativeForkOpen({ credentials: { token: 'test-token', encryption: null },
                  parentSessionId: 'parent', parentMetadata, directory: '/project', forkPoint: { type: 'latest' },
                  targetSeqInclusive: 0, effectiveCutoffSeqInclusive: 0, spawnNonce: 'refused-fork',
                  forkBackendResolution: { ok: true, catalogAgentId: null, agentHintAgentId: 'acme-agent',
                    backendTargetV2: { kind: 'backend', backendId: 'acme-agent' },
                    backendTarget: { kind: 'configuredAcpBackend', backendId: 'acme-agent' }, replayFlavor: 'acme-agent', metadataOverlay: {} },
                  inheritedForkOverrides: { spawn: {}, metadata: {} }, spawnSession, stopSession,
                  awaitAgentSessionOpen: input => awaitTrackedRunnerAgentSessionOpen({ ...input, getTrackedSessions: () => {
                    const observed = [...tracked.values()];
                    if (scenario === 'replacement') queueMicrotask(() => { tracked.clear(); tracked.set(replacement.pid, replacement); });
                    if (scenario === 'changed-birth') queueMicrotask(() => { refused.processStartTimeMs = 2000; });
                    return observed;
                  } }),
                }),
              });
              expect(result, scenario).toMatchObject({ ok: false, errorMessage: 'native_agent_session_mode_unavailable' });
              if (!result || result.ok) throw new Error('Expected native fork refusal');
              return { ok: false, errorCode: result.errorCode, error: result.errorMessage };
            } });
          expect(response).toMatchObject({ ok: false, errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
            error: 'native_agent_session_mode_unavailable' });
          expect(operations.store.get(scope, 'refused-fork-startup')).toMatchObject({ state: 'failed',
            error: { errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED, error: 'native_agent_session_mode_unavailable' } });
          expect(retired, scenario).toEqual(scenario === 'current' ? [refused.pid] : []);
          expect(selected, scenario).toEqual(scenario === 'replacement' || scenario === 'changed-birth' ? [] : [[refused.pid]]);
          expect(exitOperationStates, scenario).toEqual(scenario === 'replacement' || scenario === 'changed-birth' ? [] : ['running']);
          expect(replacement.stopRequestedAtMs, scenario).toBeUndefined();
          if (scenario === 'replacement' || scenario === 'changed-birth') expect(refused.stopRequestedAtMs, scenario).toBeUndefined();
          else expect(refused.stopRequestedAtMs, scenario).toBeTypeOf('number');
          expect(stopAttempts, scenario).toBe(1);
          expect(machineReads, scenario).toEqual([]);
          expect(archived, scenario).toBe(scenario === 'current');
        });
      } finally {
        operations.runner.cancel(scope, 'refused-fork-startup');
        home.closeAllConnections();
        await new Promise<void>((resolve, reject) => home.close(error => error ? reject(error) : resolve()));
      }
  });

  it('keeps native-fork runner exit cleanup inside its own open owner after requester startup', async () => {
    const operations = createHostActionOperationRuntime({ machineId: 'machine', resolveAccountId: async () => 'account',
      generateOperationId: () => 'native-fork-startup', supportsCoreCancellation: () => true });
    const tracked: TrackedSession = { pid: 102, startedBy: 'daemon', happySessionId: 'native-fork-child',
      agentRuntimeDaemonServiceAuthorityFilePath: '/private/native-fork-authority.json' };
    const runtimeDescriptorV1 = { v: 1 as const, agentId: 'acme-agent', agent: { providerSessionId: 'provider-parent' } };
    const parentMetadata = projectCurrentAgentSessionView({ runtimeDescriptorV1 }, { agentId: 'acme-agent',
      runtimeDescriptor: runtimeDescriptorV1, nativeResumeIdentity: { v: 1, vendorResumeId: 'provider-parent' } });
    let stopped = false;
    let archived = false;
    const child = createSessionRecordFixture({ id: 'native-fork-child', active: true, machineId: null });
    // Home HTTP and physical runner launch/Stop are system boundaries; startup,
    // native-fork admission, marker interpretation and cleanup remain real.
    const home = createServer((request, response) => {
      response.setHeader('content-type', 'application/json');
      if (request.method === 'GET' && request.url === '/v2/sessions/native-fork-child') {
        response.end(JSON.stringify({ session: { ...child, active: !stopped } }));
      } else if (request.method === 'POST' && request.url === '/v2/sessions/native-fork-child/archive' && stopped) {
        archived = true;
        response.end(JSON.stringify({ success: true, archivedAt: 1 }));
      } else {
        response.statusCode = 404;
        response.end(JSON.stringify({ error: 'Session not found' }));
      }
    });
    await new Promise<void>(resolve => home.listen(0, '127.0.0.1', resolve));
    const address = home.address();
    if (!address || typeof address === 'string') throw new Error('Expected Home HTTP listener');
    try {
      await runWithServerHttpBaseUrl(`http://127.0.0.1:${address.port}`, async () => {
        const response = await operations.observeExecution({ actionId: 'session.fork', input: { requestId: 'native-fork-original' },
          execute: async operation => {
            const result = await runRequesterSessionLifecycle({ sessionId: 'parent',
              context: { signal: operation.signal, localActionContext: operation },
              spawnSession: async options => {
                expect(options.nativeForkSource).toMatchObject({ sessionId: 'parent', providerSessionId: 'provider-parent' });
                tracked.childProcess = Object.assign(new (await import('node:child_process')).ChildProcess(), { exitCode: 1 });
                return { type: 'success', sessionId: 'native-fork-child' };
              },
              awaitAgentSessionOpen: input => awaitTrackedRunnerAgentSessionOpen({ getTrackedSessions: () => [tracked], ...input }),
              stopSession: async () => { throw new Error('Native fork owns its own retirement'); },
              refused: () => ({ ok: false as const, errorCode: 'requester_unavailable', errorMessage: 'unavailable' }),
              run: ({ spawnSession }) => attemptNativeForkOpen({ credentials: { token: 'test-token', encryption: null },
                parentSessionId: 'parent', parentMetadata, directory: '/project', forkPoint: { type: 'latest' },
                targetSeqInclusive: 0, effectiveCutoffSeqInclusive: 0, spawnNonce: 'native-fork-nonce',
                forkBackendResolution: { ok: true, catalogAgentId: null, agentHintAgentId: 'acme-agent',
                  backendTargetV2: { kind: 'backend', backendId: 'acme-agent' },
                  backendTarget: { kind: 'configuredAcpBackend', backendId: 'acme-agent' }, replayFlavor: 'acme-agent', metadataOverlay: {} },
                inheritedForkOverrides: { spawn: {}, metadata: {} }, spawnSession,
                stopSession: async sessionId => { expect(sessionId).toBe('native-fork-child'); stopped = true; return true; },
                awaitAgentSessionOpen: input => awaitTrackedRunnerAgentSessionOpen({ getTrackedSessions: () => [tracked], ...input }),
              }),
            });
            if (!result) throw new Error('Native fork did not select an open strategy');
            return result.ok ? { ok: true, result } : { ok: false, errorCode: result.errorCode, error: result.errorMessage };
          } });
        expect(response.ok).toBe(false);
        expect(stopped).toBe(true);
        expect(archived).toBe(true);
        expect(operations.store.get({ accountId: 'account', machineId: 'machine' }, 'native-fork-startup'))
          .toMatchObject({ state: 'failed' });
      });
    } finally {
      operations.runner.cancel({ accountId: 'account', machineId: 'machine' }, 'native-fork-startup');
      home.closeAllConnections();
      await new Promise<void>((resolve, reject) => home.close(error => error ? reject(error) : resolve()));
    }
  });

  it('keeps the same original operation for a cold fork child spawned by the requester lifecycle', async () => {
    const operations = createHostActionOperationRuntime({ machineId: 'machine', resolveAccountId: async () => 'account',
      generateOperationId: () => 'fork-startup', supportsCoreCancellation: () => true });
    const tracked: TrackedSession = { pid: 101, startedBy: 'daemon', happySessionId: 'fork-child',
      agentRuntimeDaemonServiceAuthorityFilePath: '/private/fork-authority.json' };
    let captured: SpawnSessionOptions | undefined;
    const response = operations.observeExecution({ actionId: 'session.fork', input: { requestId: 'fork-original' },
      execute: async operation => ({ ok: true, result: await runRequesterSessionLifecycle({ sessionId: 'parent',
        context: { signal: operation.signal, localActionContext: operation },
        spawnSession: async options => { captured = options; return { type: 'success', sessionId: 'fork-child' }; },
        awaitAgentSessionOpen: input => awaitTrackedRunnerAgentSessionOpen({ getTrackedSessions: () => [tracked], ...input }),
        stopSession: async () => { throw new Error('Successful startup must not retire its runner'); },
        refused: (): SpawnSessionResult => ({ type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.DAEMON_RPC_UNAVAILABLE, errorMessage: 'unavailable' }),
        run: ({ spawnSession }) => spawnSession({ directory: '/project' }),
      }) }) });
    try {
      await vi.waitFor(() => expect(captured).toBeDefined());
      expect(captured?.projectSetupOperation?.operationAcceptance?.operationId).toBe('fork-startup');
      expect(operations.store.get({ accountId: 'account', machineId: 'machine' }, 'fork-startup')).toMatchObject({ state: 'running' });
      tracked.agentRuntimeDaemonServiceSessionOpenAttestation = { request: { kind: 'create', sessionId: 'fork-child', cwd: '/project' },
        providerSessionId: 'native-fork' };
      expect(await response).toMatchObject({ ok: true, result: { type: 'success', sessionId: 'fork-child' } });
    } finally { operations.runner.cancel({ accountId: 'account', machineId: 'machine' }, 'fork-startup'); await response.catch(() => undefined); }
  });
  it.each(['open', 'cancel', 'exit'] as const)('retains the original operation after webhook acknowledgement until native startup can %s', async outcome => {
    vi.useFakeTimers();
    const scope = { accountId: 'account', machineId: 'machine' };
    const operations = createHostActionOperationRuntime({ serverId: 'home', machineId: scope.machineId,
      resolveAccountId: async () => scope.accountId, generateOperationId: () => 'original-startup',
      supportsCoreCancellation: () => true });
    const tracked: TrackedSession = { pid: 100, startedBy: 'daemon', happySessionId: 'session-child',
      agentRuntimeDaemonServiceAuthorityFilePath: '/private/authority.json' };
    const trackedSessions = [tracked];
    let captured: SpawnSessionOptions | undefined;
    // Physical runner launch/webhook is the OS boundary. Its later open is
    // observed by the actual tracked-runner startup owner, not a test promise.
    const handler = createSpawnNewSessionLifecycleActionHandler({ spawnSession: async options => {
      captured = options;
      tracked.projectSetupOperation = options.projectSetupOperation;
      tracked.spawnOptions = options;
      return { type: 'success', sessionId: 'session-child' };
    }, stopSession: async () => { throw new Error('Open, cancellation and observed exit do not retire a refused runner'); },
    awaitAgentSessionOpen: input => awaitTrackedRunnerAgentSessionOpen({
      getTrackedSessions: () => trackedSessions, ...input,
    }) });
    try {
      const response = operations.observeExecution({ actionId: 'session.spawn_new',
        input: { creationKey: 'same-creation' }, execute: async operation => {
          try {
            return { ok: true, result: await handler({ directory: '/project',
              agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
            }, { signal: operation.signal, localActionContext: operation }) };
          } catch (error) {
            if (operation.signal.aborted) return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
            throw error;
          }
        } });
      await vi.waitFor(() => expect(captured).toBeDefined());
      const rejoined = operations.observeExecution({ actionId: 'session.spawn_new', input: { creationKey: 'same-creation' },
        execute: async () => { throw new Error('An existing startup must not spawn again'); } });
      expect(captured?.projectSetupOperation?.operationAcceptance?.operationId).toBe('original-startup');
      expect(operations.store.get(scope, 'original-startup')).toMatchObject({ state: 'running' });
      await vi.advanceTimersByTimeAsync(15_100);
      expect(operations.store.get(scope, 'original-startup')).not.toHaveProperty('settledAt');
      if (outcome === 'cancel') {
        expect(operations.runner.cancel(scope, 'original-startup')).toEqual({ kind: 'requested' });
        expect(captured?.projectSetupOperation?.signal.aborted).toBe(true);
      } else if (outcome === 'exit') {
        const successors: SpawnSessionOptions[] = [];
        const recovery = createSessionRunnerRespawnManager({ enabled: true, maxRestarts: 2,
          baseDelayMs: 50, maxDelayMs: 50, jitterMs: 0,
          isSessionAlreadyRunning: () => false, spawnSession: async options => { successors.push(options); return { type: 'success' }; },
          random: () => 0, logDebug: () => {}, logWarn: () => {},
        });
        recovery.handleUnexpectedExit(tracked, { reason: 'process-exit', code: 143, signal: 'SIGTERM' },
          { forceRestart: true, restartReason: 'account_changed' });
        trackedSessions.length = 0;
        await vi.advanceTimersByTimeAsync(1_000);
        expect(successors).toEqual([]);
        expect(recovery.hasPendingIntendedRestarts('session-child')).toBe(false);
      } else {
        tracked.agentRuntimeDaemonServiceSessionOpenAttestation = {
          request: { kind: 'create', sessionId: 'session-child', cwd: '/project' }, providerSessionId: 'native-child',
        };
        await vi.advanceTimersByTimeAsync(25);
      }
      await vi.waitFor(() => expect(operations.store.get(scope, 'original-startup')).toMatchObject({
        state: outcome === 'cancel' ? 'cancelled' : 'succeeded',
      }));
      const settled = await response;
      expect(await rejoined).toEqual(settled);
      if (outcome === 'open') {
        expect(settled).toMatchObject({ ok: true, result: { type: 'success', sessionId: 'session-child' } });
      } else if (outcome === 'cancel') {
        expect(settled).toMatchObject({ ok: false, errorCode: 'cancelled' });
      } else {
        expect(settled).toMatchObject({ ok: true, result: { type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED } });
      }
      if (outcome === 'exit') expect(operations.store.get(scope, 'original-startup')).toMatchObject({
        result: { type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED,
          errorDetail: { kind: 'launch_error', code: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED } },
      });
    } finally { vi.useRealTimers(); }
  });
});
