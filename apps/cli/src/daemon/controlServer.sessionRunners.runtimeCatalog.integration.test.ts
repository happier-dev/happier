import { describe, expect, it, vi } from 'vitest';

import { createDaemonControlApp } from './controlServer';
import { join, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { AcpBackend } from '@/agent/acp/AcpBackend';
import { createAcpSubprocessEnvScope, createAcpTestTransportHandler } from '@/agent/acp/testkit/subprocessHarness';
import { withTempDir } from '@/testkit/fs/tempDir';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { createRuntimeOverrideSynchronizers } from '@/agent/runtime/createRuntimeOverrideSynchronizers';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { requestDaemonSessionRunnerRestart } from './controlClient';
import { restartSessionRunnerOnCurrentRuntime } from './plannedRunnerRestart/restartSessionRunnerOnCurrentRuntime';
import type { TrackedSession } from './types';
import { readSessionCapabilitySelectionFromMetadataV1, resolveSelectionRestartMarkersForStartupV1, writeSessionCapabilitySelectionToMetadataV1 } from '@happier-dev/protocol/reach/sessionCapabilityMetadataV1';
import { resolveSessionCapabilitiesV1 } from '@happier-dev/protocol/reach/resolveSessionCapabilitiesV1';
import { McpServersSettingsV1Schema } from '@happier-dev/protocol/mcp/servers/settingsV1';
import { RestartSessionRunnerResultV1Schema } from '@happier-dev/protocol/sessions/control/sessionRunnerRestartV1';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { createSessionRunnerRestartAdmission, prepareSessionRunnerRestartAdmission } from '@/agent/runtime/session/input/sessionProviderInputAdmissionRpc';
import { readSessionRunnerRestartAdmissionCurrent } from './plannedRunnerRestart/sessionRunnerRestartAdmission';
import { legacyPidSessionTrackingKey } from '@/daemon/sessions/sessionTrackingKey';

describe('daemon control server: session runner restarts', () => {
  it('resolves a restart hold by its request identity when Sessions share a runner pid', async () => {
    const first: TrackedSession = { startedBy: 'daemon', trackingKey: legacyPidSessionTrackingKey(process.pid), pid: process.pid, happySessionId: 'first' };
    const second: TrackedSession = { startedBy: 'daemon', trackingKey: legacyPidSessionTrackingKey(process.pid + 1), pid: process.pid, happySessionId: 'second' };
    const lifetime = new AbortController();
    const rpc = new RpcHandlerManager({ scopePrefix: 'second', encryptionMode: 'plain', logger: () => {} });
    const admission = createSessionRunnerRestartAdmission(() => rpc);
    const release = await prepareSessionRunnerRestartAdmission({ expectedPid: process.pid, signal: lifetime.signal,
      onHold: attempt => { second.plannedRestartAdmission = attempt; },
      callRpc: (request, signal) => admission(request, signal) });
    expect(release).not.toBeNull();
    const app = createDaemonControlApp({ getChildren: () => [first, second], machineId: 'machine',
      stopSession: async () => ({ status: 'not_found' }), spawnSession: async () => ({ type: 'success', sessionId: 'second' }),
      requestShutdown: () => {}, onHappySessionWebhook: () => {}, controlToken: 'test-token' });
    const readCurrent = async (expectedPid = process.pid, requestId = second.plannedRestartAdmission!.requestId) => {
      const response = await app.inject({ method: 'POST', url: '/session-runners/restart-admission/current',
        headers: { 'x-happier-daemon-token': 'test-token' }, payload: { expectedPid, requestId } });
      expect(response.statusCode).toBe(200);
      return response.json();
    };
    try {
      expect(await readCurrent()).toEqual({ current: true });
      expect(await readCurrent(process.pid + 1)).toEqual({ current: false });
      expect(await readCurrent(process.pid, 'another-request')).toEqual({ current: false });
      lifetime.abort();
      expect(await readCurrent()).toEqual({ current: false });
    } finally { lifetime.abort(); await release?.(); rpc.onSocketDisconnect(); await app.close(); }
  });
  it('reopens creation on demand after a lost cancellation forward using the exact daemon attempt', async () => {
    // The daemon tracks the launcher; the RPC receiver can be its distinct runner.
    const tracked: TrackedSession = { startedBy: 'daemon', trackingKey: legacyPidSessionTrackingKey(process.pid + 1), pid: process.pid + 1, sessionRunnerPid: process.pid, happySessionId: 'session' };
    const app = createDaemonControlApp({ getChildren: () => [tracked], machineId: 'machine',
      stopSession: async () => ({ status: 'not_found' }), spawnSession: async () => ({ type: 'success', sessionId: 'session' }),
      requestShutdown: () => {}, onHappySessionWebhook: () => {}, controlToken: 'test-token' });
    const rpc = new RpcHandlerManager({ scopePrefix: 'session', encryptionMode: 'plain', logger: () => {} });
    rpc.registerHandler(SESSION_RPC_METHODS.EXECUTION_RUN_START, async () => ({ admitted: true }));
    const owner = new AbortController();
    let release: Awaited<ReturnType<typeof prepareSessionRunnerRestartAdmission>> = null;
    let next: Awaited<ReturnType<typeof prepareSessionRunnerRestartAdmission>> = null;
    try {
      await app.listen({ host: '127.0.0.1', port: 0 });
      const address = app.server.address();
      if (!address || typeof address === 'string') throw new Error('Missing test HTTP listener');
      const target = { pid: process.pid, httpPort: address.port, controlToken: 'test-token' };
      const admission = createSessionRunnerRestartAdmission(() => rpc, {
        readHoldCurrent: (request, signal) => readSessionRunnerRestartAdmissionCurrent(request, { target, signal }),
      });
      rpc.registerHandler(SESSION_RPC_METHODS.SESSION_PROVIDER_INPUT_ADMISSION, (request, context) => admission(request, context?.signal));
      release = await prepareSessionRunnerRestartAdmission({ expectedPid: process.pid, signal: owner.signal,
        onHold: attempt => { tracked.plannedRestartAdmission = attempt; },
        callRpc: (request, signal) => {
          // Only the relay cancellation packet is lost; the receiver stays connected.
          const response = rpc.handleRequest({ method: `session:${SESSION_RPC_METHODS.SESSION_PROVIDER_INPUT_ADMISSION}`,
            params: request, requestId: request.action + request.requestId });
          return new Promise((resolve, reject) => {
            response.then(resolve, reject);
            signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
        } });
      expect(release).not.toBeNull();
      await expect(rpc.invokeLocal(SESSION_RPC_METHODS.EXECUTION_RUN_START, {})).resolves.toMatchObject({
        errorCode: 'RPC_CLIENT_NOT_AVAILABLE', details: { executionRunStart: { v: 1, runCreation: 'noRunCreated' } },
      });
      const path = '/session-runners/restart-admission/current';
      const identity = { expectedPid: process.pid, requestId: tracked.plannedRestartAdmission!.requestId };
      expect((await app.inject({ method: 'POST', url: path, payload: identity })).statusCode).toBe(401);
      expect(await readSessionRunnerRestartAdmissionCurrent({ ...identity, requestId: 'older-attempt' }, { target })).toBe(false);
      expect(await readSessionRunnerRestartAdmissionCurrent(identity, { target: { ...target, controlToken: 'wrong' } })).toBeNull();
      owner.abort();
      await release?.();
      await expect(rpc.invokeLocal(SESSION_RPC_METHODS.EXECUTION_RUN_START, {})).resolves.toEqual({ admitted: true });
      next = await prepareSessionRunnerRestartAdmission({ expectedPid: process.pid, signal: new AbortController().signal,
        onHold: attempt => { tracked.plannedRestartAdmission = attempt; },
        callRpc: (request, signal) => rpc.invokeLocal(SESSION_RPC_METHODS.SESSION_PROVIDER_INPUT_ADMISSION, request, { signal }) });
      expect(next).not.toBeNull();
    } finally { owner.abort(); await release?.(); await next?.(); rpc.onSocketDisconnect(); await app.close(); }
  });
  it('resumes an ACP fixture after a mid-turn capability edit with the new MCP set and delivers input queued during restart to the same vendor session', async () => {
    await withTempDir('happier-impl-p2c-u6-acp-', async directory => {
      const env = createAcpSubprocessEnvScope();
      env.patch({ HAPPIER_ACP_CAPTURE_IO: '1', HAPPIER_STACK_TOOL_TRACE_FILE: join(directory, 'trace.jsonl') });
      let metadata = createTestMetadata({ path: directory });
      const catalog = McpServersSettingsV1Schema.parse({ v: 1, strictMode: false,
        servers: [{ id: 'linear', name: 'linear', transport: 'stdio', stdio: { command: 'linear-mcp', args: ['serve'] }, env: {}, createdAt: 1, updatedAt: 1 }],
        bindings: [{ id: 'everywhere', serverId: 'linear', target: { t: 'allMachines' }, enabled: true, createdAt: 1, updatedAt: 1 }] });
      const readMcpServers = () => Object.fromEntries(resolveSessionCapabilitiesV1({
        context: { machineId: 'machine', machinePlatform: 'posix', directory, projectKey: null, agentId: 'claude' },
        mcp: catalog, skills: null, selection: readSessionCapabilitySelectionFromMetadataV1(metadata), agentAcceptsUserMcp: true,
      }).mcp.items.filter(item => item.selected).map(item => [item.name, { command: item.effectiveConfig.stdio!.command,
        args: item.effectiveConfig.stdio!.args ?? [], env: {} }]));
      const openBackend = () => new AcpBackend({ agentName: 'capability-fixture', cwd: directory,
        command: process.execPath, args: [resolve(__dirname, '../../../../packages/tests/fixtures/acp-stub-provider/acp-stub-provider.mjs')],
        mcpServers: readMcpServers(), transportHandler: createAcpTestTransportHandler() });
      let backend = openBackend();
      const output: string[] = [];
      const observeOutput = () => backend.onMessage(message => {
        if (message.type === 'model-output') output.push(message.textDelta ?? message.fullText ?? '');
      });
      observeOutput();
      let vendorId = '';
      const tracked: TrackedSession = { startedBy: 'daemon', trackingKey: legacyPidSessionTrackingKey(process.pid), pid: process.pid, happySessionId: 'session',
        processCommandHash: 'fixture-command', processStartTimeMs: 1,
        processCommand: 'node /tmp/cli/versions/0.3.0/package-dist/index.mjs claude --happy-starting-mode remote --started-by daemon',
        vendorResumeId: vendorId, spawnOptions: { directory, backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' }, resume: vendorId } };
      let settled = false;
      let releaseRestart!: () => void;
      const restartHeld = new Promise<void>(resolve => { releaseRestart = resolve; });
      let restartEntered = false;
      const queue = new MessageQueue2<string, string>(value => value);
      const app = createDaemonControlApp({ getChildren: () => [tracked], machineId: 'machine',
        stopSession: async () => ({ status: 'stopped' }), spawnSession: async () => ({ type: 'success', sessionId: 'session' }),
        requestShutdown: () => {}, onHappySessionWebhook: () => {}, controlToken: 'capability-token',
        handleSessionRunnerRestart: request => restartSessionRunnerOnCurrentRuntime({ request, tracked,
          currentIdentity: { status: 'known', source: 'launch_spec', comparableId: 'version:0.3.0', entrypointVersion: '0.3.0' },
          requestRestart: async input => {
            restartEntered = true;
            await restartHeld;
            expect(await input.canSignal?.()).toBe(true);
            await backend.dispose();
            backend = openBackend(); observeOutput();
            const resumed = await backend.loadSession(tracked.vendorResumeId!);
            expect(resumed.sessionId).toBe(vendorId);
            metadata = resolveSelectionRestartMarkersForStartupV1({ current: metadata,
              applied: readSessionCapabilitySelectionFromMetadataV1(metadata) });
            return { signaled: true, completion: { ok: true } };
          } }),
      });
      let restart: Promise<void> | null = null;
      try {
        const started = await backend.startSession();
        vendorId = started.sessionId;
        tracked.vendorResumeId = vendorId;
        tracked.spawnOptions = { ...tracked.spawnOptions!, resume: vendorId };
        await app.listen({ host: '127.0.0.1', port: 0 });
        const address = app.server.address();
        if (!address || typeof address === 'string') throw new Error('Missing test HTTP listener');
        const session = { sessionId: 'session', getMetadataSnapshot: () => metadata,
          updateMetadataAsCurrentPublisher: async (update: (current: typeof metadata) => typeof metadata) => { metadata = update(metadata); } };
        const sync = createRuntimeOverrideSynchronizers({ agentTargetKey: 'backend:claude', session,
          runtime: { setSessionMode: async () => {}, setSessionConfigOption: async () => {}, setSessionModelSelection: async () => {} },
          isStarted: () => true, capabilitySelection: { session, isStarted: () => true, isSettled: () => settled,
            agent: { vendorResume: 'supported', skillsLiveReload: 'unsupported' },
            requestRestart: async request => RestartSessionRunnerResultV1Schema.parse(await requestDaemonSessionRunnerRestart(request,
              { target: { pid: process.pid, httpPort: address.port, controlToken: 'capability-token' } })),
          } });
        await backend.sendPrompt(vendorId, 'ACP_STUB_PRIMARY=before-change');
        await expect.poll(() => output.join('')).toContain('ACP_STUB_RUNNING');
        metadata = writeSessionCapabilitySelectionToMetadataV1(metadata,
          { mcp: { v: 1, managedServersEnabled: true, forceIncludeServerIds: [], forceExcludeServerIds: ['linear'] } }, { sessionActive: true });
        sync.syncFromMetadata(); await sync.flushAfterSettledTurn?.();
        expect(restartEntered).toBe(false);
        await backend.sendSteerPrompt(vendorId, 'ACP_STUB_STEER=settle');
        await backend.waitForResponseComplete();
        settled = true;
        restart = sync.flushAfterSettledTurn!();
        await expect.poll(() => restartEntered).toBe(true);
        queue.push('ACP_STUB_USAGE_UPDATE=queued-during-restart', 'default');
        expect(queue.size()).toBe(1);
        releaseRestart(); await restart;
        const pending = await queue.waitForMessagesAndGetAsString();
        expect(pending?.message).toBe('ACP_STUB_USAGE_UPDATE=queued-during-restart');
        await backend.sendPrompt(vendorId, pending!.message); await backend.waitForResponseComplete();
        await expect.poll(() => output.join('')).toContain('ACP_STUB_USAGE_UPDATE_DONE queued-during-restart');
        const calls = (await readFile(join(directory, 'acp.stdin.raw'), 'utf8')).split('\n').filter(Boolean)
          .map(line => JSON.parse(line) as { method?: string; params?: { sessionId?: string; mcpServers?: unknown[] } });
        expect(calls.filter(call => call.method === 'session/new')).toHaveLength(1);
        expect(calls.find(call => call.method === 'session/new')?.params?.mcpServers).toMatchObject([{ name: 'linear' }]);
        expect(calls.find(call => call.method === 'session/load')?.params).toMatchObject({ sessionId: vendorId, mcpServers: [] });
        expect(metadata.mcpSelectionRestartRequiredV1).toBeUndefined();
      } finally {
        releaseRestart(); await restart?.catch(() => {});
        queue.close(); await backend.dispose(); await app.close(); env.restore();
      }
    });
  });
  it('preserves a typed incomplete physical stop outcome at the local control boundary', async () => {
    const stopSession = vi.fn(async () => ({
      status: 'incomplete' as const,
      reason: 'runner_exit_timeout' as const,
    }));
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine_local',
      stopSession,
      spawnSession: async () => ({ type: 'success', sessionId: 'sess-1' }),
      requestShutdown: vi.fn(),
      onHappySessionWebhook: () => {},
      controlToken: 'test-token',
    });

    try {
      await app.ready();
      const res = await app.inject({
        method: 'POST',
        url: '/stop-session',
        headers: { 'x-happier-daemon-token': 'test-token' },
        payload: { sessionId: 'sess-1' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: 'incomplete', reason: 'runner_exit_timeout' });
      expect(stopSession).toHaveBeenCalledWith('sess-1', 'explicit_stop', expect.any(AbortSignal));
    } finally {
      await app.close();
    }
  });

  it('rejects unauthenticated restart requests', async () => {
    const handleSessionRunnerRestart = vi.fn();
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine_local',
      stopSession: async () => ({ status: 'stopped' as const }),
      spawnSession: async () => ({ type: 'success', sessionId: 'sess-1' }),
      requestShutdown: vi.fn(),
      onHappySessionWebhook: () => {},
      controlToken: 'test-token',
      handleSessionRunnerRestart,
    });

    try {
      await app.ready();
      const res = await app.inject({
        method: 'POST',
        url: '/session-runners/restart',
        payload: {
          sessionId: 'sess-1',
          reason: 'daemon_restart_session_runners_command',
        },
      });

      expect(res.statusCode).toBe(401);
      expect(handleSessionRunnerRestart).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('validates and forwards single-session restart requests', async () => {
    const handleSessionRunnerRestart = vi.fn(async () => ({
      ok: true as const,
      status: 'dry_run_restartable' as const,
      sessionId: 'sess-1',
    }));
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine_local',
      stopSession: async () => ({ status: 'stopped' as const }),
      spawnSession: async () => ({ type: 'success', sessionId: 'sess-1' }),
      requestShutdown: vi.fn(),
      onHappySessionWebhook: () => {},
      controlToken: 'test-token',
      handleSessionRunnerRestart,
    });

    try {
      await app.ready();
      const res = await app.inject({
        method: 'POST',
        url: '/session-runners/restart',
        headers: { 'x-happier-daemon-token': 'test-token' },
        payload: {
          sessionId: 'sess-1',
          mode: 'if_stale',
          dryRun: true,
          reason: 'daemon_restart_session_runners_command',
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        ok: true,
        status: 'dry_run_restartable',
        sessionId: 'sess-1',
      });
      expect(handleSessionRunnerRestart).toHaveBeenCalledWith({
        sessionId: 'sess-1',
        mode: 'if_stale',
        dryRun: true,
        reason: 'daemon_restart_session_runners_command',
      });
    } finally {
      await app.close();
    }
  });

  it('fails closed for non-dry public V1 rollout requests without calling the generic restart owner', async () => {
    const handleSessionRunnerRestart = vi.fn();
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine_local',
      stopSession: async () => ({ status: 'stopped' as const }),
      spawnSession: async () => ({ type: 'success', sessionId: 'sess-1' }),
      requestShutdown: vi.fn(),
      onHappySessionWebhook: () => {},
      controlToken: 'test-token',
      handleSessionRunnerRestart,
    });

    try {
      await app.ready();
      const res = await app.inject({
        method: 'POST',
        url: '/session-runners/restart',
        headers: { 'x-happier-daemon-token': 'test-token' },
        payload: {
          sessionId: 'sess-1',
          mode: 'force_current_cli',
          reason: 'daemon_dist_generation_rollout',
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        ok: false,
        status: 'ineligible',
        sessionId: 'sess-1',
        reasonCode: 'runner_generation_unattested',
      });
      expect(handleSessionRunnerRestart).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('rejects recovery-only fields on predecessor V1 before effects', async () => {
    const handleSessionRunnerRestart = vi.fn();
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine_local',
      stopSession: async () => ({ status: 'stopped' as const }),
      spawnSession: async () => ({ type: 'success', sessionId: 'sess-1' }),
      requestShutdown: vi.fn(),
      onHappySessionWebhook: () => {},
      controlToken: 'test-token',
      handleSessionRunnerRestart,
    });

    try {
      await app.ready();
      const res = await app.inject({
        method: 'POST',
        url: '/session-runners/restart',
        headers: { 'x-happier-daemon-token': 'test-token' },
        payload: {
          sessionId: 'sess-1',
          mode: 'force_current_cli',
          reason: 'provider_binding_change_recovery',
        },
      });

      expect(res.statusCode).toBe(400);
      expect(handleSessionRunnerRestart).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it.each(['V1', 'V2'] as const)('keeps native interruption consent for %s on the dedicated route through the same restart owner', async version => {
    let signals = 0;
    const tracked = {
      trackingKey: legacyPidSessionTrackingKey(123), startedBy: 'daemon', pid: 123, happySessionId: 'sess-1', processCommandHash: 'hash', processStartTimeMs: 100,
      processCommand: 'node /tmp/versions/0.2.10/package-dist/index.mjs claude --happy-starting-mode remote --started-by daemon',
      vendorResumeId: 'thread', spawnOptions: { directory: '/tmp/project', resume: 'thread',
        backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' } },
    } satisfies TrackedSession;
    const app = createDaemonControlApp({ getChildren: () => [tracked], machineId: 'machine',
      stopSession: async () => ({ status: 'stopped' as const }), spawnSession: async () => ({ type: 'success', sessionId: 'sess-1' }),
      requestShutdown: () => {}, onHappySessionWebhook: () => {}, controlToken: 'test-token',
      handleSessionRunnerRestart: (request, options) => restartSessionRunnerOnCurrentRuntime({ request, tracked,
        currentIdentity: { status: 'known', source: 'launch_spec', comparableId: 'version:0.2.11', entrypointVersion: '0.2.11' },
        ...options, readNativeRuntimeActivity: async () => 'active',
        requestRestart: async () => { signals++; return { signaled: true }; },
      }),
    });
    try {
      await app.ready();
      const payload = version === 'V1'
        ? { sessionId: 'sess-1', mode: 'if_stale', reason: 'ui_stale_runner_banner' }
        : { v: 2, sessionId: 'sess-1', mode: 'force_current_cli', reason: 'provider_binding_change_recovery',
          expectedRunnerPid: tracked.pid, expectedProcessCommandHash: tracked.processCommandHash,
          expectedRunnerEntrypointIdentity: 'version:0.2.10',
          expectedRunnerProcessIdentity: { pid: tracked.pid, processStartTimeMs: tracked.processStartTimeMs } };
      const defaultPath = version === 'V1' ? '/session-runners/restart' : '/session-runners/restart-v2';
      const request = (url: string, body = payload) => app.inject({ method: 'POST', url,
        headers: { 'x-happier-daemon-token': 'test-token' }, payload: body });
      expect((await request(defaultPath)).json()).toMatchObject({ status: 'busy' });
      const confirmed = await request('/session-runners/restart-confirmed-background');
      expect(confirmed.statusCode).toBe(200);
      expect(confirmed.json()).toMatchObject({ status: 'restarted' });
      expect(signals).toBe(1);
      expect((await app.inject({ method: 'POST', url: '/session-runners/restart-confirmed-background', payload })).statusCode).toBe(401);
      const invalid = await app.inject({ method: 'POST', url: '/session-runners/restart',
        headers: { 'x-happier-daemon-token': 'test-token' }, payload: { ...payload, allowNativeBackgroundInterruption: true } });
      expect(invalid.statusCode).toBe(400);
      expect(signals).toBe(1);
    } finally { await app.close(); }
  });

  it('forwards strict process-attested recovery V2 to the canonical restart owner', async () => {
    const handleSessionRunnerRestart = vi.fn(async () => ({
      ok: true as const,
      status: 'restarted' as const,
      sessionId: 'sess-1',
    }));
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine_local',
      stopSession: async () => ({ status: 'stopped' as const }),
      spawnSession: async () => ({ type: 'success', sessionId: 'sess-1' }),
      requestShutdown: vi.fn(),
      onHappySessionWebhook: () => {},
      controlToken: 'test-token',
      handleSessionRunnerRestart,
    });
    const request = {
      v: 2,
      sessionId: 'sess-1',
      mode: 'force_current_cli',
      reason: 'provider_binding_change_recovery',
      expectedRunnerPid: 123,
      expectedProcessCommandHash: 'hash-1',
      expectedRunnerEntrypointIdentity: 'runtime-1',
      expectedRunnerProcessIdentity: {
        pid: 123,
        processStartTimeMs: 1_000,
      },
    } as const;

    try {
      await app.ready();
      const res = await app.inject({
        method: 'POST',
        url: '/session-runners/restart-v2',
        headers: { 'x-happier-daemon-token': 'test-token' },
        payload: request,
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ status: 'restarted' });
      expect(handleSessionRunnerRestart).toHaveBeenCalledWith(request);
    } finally {
      await app.close();
    }
  });

  it('keeps public V1 rollout dry-runs observable without signaling a runner', async () => {
    const handleSessionRunnerRestart = vi.fn(async () => ({
      ok: true as const,
      status: 'dry_run_restartable' as const,
      sessionId: 'sess-1',
    }));
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine_local',
      stopSession: async () => ({ status: 'stopped' as const }),
      spawnSession: async () => ({ type: 'success', sessionId: 'sess-1' }),
      requestShutdown: vi.fn(),
      onHappySessionWebhook: () => {},
      controlToken: 'test-token',
      handleSessionRunnerRestart,
    });

    try {
      await app.ready();
      const res = await app.inject({
        method: 'POST',
        url: '/session-runners/restart',
        headers: { 'x-happier-daemon-token': 'test-token' },
        payload: {
          sessionId: 'sess-1',
          mode: 'force_current_cli',
          dryRun: true,
          reason: 'daemon_dist_generation_rollout',
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ status: 'dry_run_restartable' });
      expect(handleSessionRunnerRestart).toHaveBeenCalledWith({
        sessionId: 'sess-1',
        mode: 'force_current_cli',
        dryRun: true,
        reason: 'daemon_dist_generation_rollout',
      });
    } finally {
      await app.close();
    }
  });

  it('threads bulk dry-run requests to the daemon handler without signalling runners at the endpoint layer', async () => {
    const handleSessionRunnerRestartAll = vi.fn(async () => ({
      ok: false as const,
      mode: 'force_current_cli' as const,
      requestedCount: 1,
      restartedCount: 0,
      skippedCount: 1,
      failedCount: 0,
      results: [{
        ok: true as const,
        status: 'dry_run_restartable' as const,
        sessionId: 'sess-1',
      }],
    }));
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine_local',
      stopSession: async () => ({ status: 'stopped' as const }),
      spawnSession: async () => ({ type: 'success', sessionId: 'sess-1' }),
      requestShutdown: vi.fn(),
      onHappySessionWebhook: () => {},
      controlToken: 'test-token',
      handleSessionRunnerRestartAll,
    });

    try {
      await app.ready();
      const res = await app.inject({
        method: 'POST',
        url: '/session-runners/restart-all',
        headers: { 'x-happier-daemon-token': 'test-token' },
        payload: {
          mode: 'force_current_cli',
          dryRun: true,
          reason: 'daemon_restart_session_runners_command',
        },
      });

      expect(res.statusCode).toBe(200);
      expect(handleSessionRunnerRestartAll).toHaveBeenCalledWith({
        mode: 'force_current_cli',
        dryRun: true,
        reason: 'daemon_restart_session_runners_command',
      });
      expect(res.json().results[0].status).toBe('dry_run_restartable');
    } finally {
      await app.close();
    }
  });

  it('fails closed for non-dry public V1 bulk rollout requests without calling the generic bulk owner', async () => {
    const handleSessionRunnerRestartAll = vi.fn();
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine_local',
      stopSession: async () => ({ status: 'stopped' as const }),
      spawnSession: async () => ({ type: 'success', sessionId: 'sess-1' }),
      requestShutdown: vi.fn(),
      onHappySessionWebhook: () => {},
      controlToken: 'test-token',
      handleSessionRunnerRestartAll,
    });

    try {
      await app.ready();
      const res = await app.inject({
        method: 'POST',
        url: '/session-runners/restart-all',
        headers: { 'x-happier-daemon-token': 'test-token' },
        payload: {
          mode: 'force_current_cli',
          reason: 'daemon_dist_generation_rollout',
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        ok: false,
        mode: 'force_current_cli',
        requestedCount: 0,
        restartedCount: 0,
        skippedCount: 0,
        failedCount: 0,
        results: [],
      });
      expect(handleSessionRunnerRestartAll).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('validates and forwards session-runner status requests', async () => {
    const handleSessionRunnerStatusGet = vi.fn(async () => ({
      v: 1 as const,
      sessionId: 'sess-1',
      machineId: null,
      daemonId: null,
      observedAtMs: 100,
      runner: {
        pid: null,
        runtimeId: null,
        cliVersion: null,
        entrypointVersion: null,
        processCommandHash: null,
        entrypointSource: 'unknown' as const,
        startedBy: 'unknown' as const,
        startingMode: 'unknown' as const,
      },
      daemon: {
        cliVersion: null,
        startedWithCliVersion: null,
        currentEntrypointVersion: null,
        currentEntrypointSource: 'unknown' as const,
      },
      versionState: 'unknown' as const,
      statusSource: 'unknown' as const,
      plannedRestart: {
        supported: false,
        eligible: false,
        disabledReason: 'no_tracked_process' as const,
      },
    }));
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine_local',
      stopSession: async () => ({ status: 'stopped' as const }),
      spawnSession: async () => ({ type: 'success', sessionId: 'sess-1' }),
      requestShutdown: vi.fn(),
      onHappySessionWebhook: () => {},
      controlToken: 'test-token',
      handleSessionRunnerStatusGet,
    });

    try {
      await app.ready();
      const res = await app.inject({
        method: 'POST',
        url: '/session-runners/status',
        headers: { 'x-happier-daemon-token': 'test-token' },
        payload: { sessionId: ' sess-1 ' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        v: 1,
        sessionId: 'sess-1',
        versionState: 'unknown',
      });
      expect(res.json().runner).not.toHaveProperty('processStartTimeMs');
      expect(handleSessionRunnerStatusGet).toHaveBeenCalledWith({ sessionId: 'sess-1' });
    } finally {
      await app.close();
    }
  });

  it('publishes the additive strict V2 status envelope without changing V1', async () => {
    const handleSessionRunnerStatusV2Get = vi.fn(async () => ({
      v: 2 as const,
      state: {
        v: 1 as const,
        sessionId: 'sess-1',
        machineId: 'machine_local',
        daemonId: null,
        observedAtMs: 100,
        runner: {
          pid: 123,
          runtimeId: null,
          cliVersion: null,
          entrypointVersion: null,
          processCommandHash: null,
          entrypointSource: 'unknown' as const,
          startedBy: 'daemon' as const,
          startingMode: 'remote' as const,
        },
        daemon: {
          cliVersion: null,
          startedWithCliVersion: null,
          currentEntrypointVersion: null,
          currentEntrypointSource: 'unknown' as const,
        },
        versionState: 'unknown' as const,
        statusSource: 'daemon_tracking' as const,
        plannedRestart: {
          supported: true,
          eligible: false,
          disabledReason: 'runner_entrypoint_unknown' as const,
        },
      },
      runnerProcessIdentity: {
        pid: 456,
        processStartTimeMs: 1_000,
      },
    }));
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine_local',
      stopSession: async () => ({ status: 'stopped' as const }),
      spawnSession: async () => ({ type: 'success', sessionId: 'sess-1' }),
      requestShutdown: vi.fn(),
      onHappySessionWebhook: () => {},
      controlToken: 'test-token',
      handleSessionRunnerStatusV2Get,
    });

    try {
      await app.ready();
      const res = await app.inject({
        method: 'POST',
        url: '/session-runners/status-v2',
        headers: { 'x-happier-daemon-token': 'test-token' },
        payload: { sessionId: ' sess-1 ' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        v: 2,
        state: { v: 1, sessionId: 'sess-1' },
        runnerProcessIdentity: { pid: 456, processStartTimeMs: 1_000 },
      });
      expect(handleSessionRunnerStatusV2Get).toHaveBeenCalledWith({ sessionId: 'sess-1' });
    } finally {
      await app.close();
    }
  });

});
