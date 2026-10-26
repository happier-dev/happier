import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import axios from 'axios';

import { createCodexAppServerExecutionRunBackend } from '@/backends/codex/executionRuns/createCodexAppServerExecutionRunBackend';
import { createCodexAppServerProcessEnv, writeFakeCodexAppServerScript } from '@/backends/codex/appServer/testkit/fakeCodexAppServer';
import { withTempDir } from '@/testkit/fs/tempDir';
import { removeExecutionRunMarker } from '@/daemon/executionRunRegistry';
import { createApiSessionSocketStub, type ApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { createPlainSessionFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { ApiSessionClient } from '@/api/session/sessionClient';
import { reloadConfiguration } from '@/configuration';
import { VoiceAgentManager } from '@/agent/voice/agent/VoiceAgentManager';

import { ExecutionRunManager } from './ExecutionRunManager';

const sockets = vi.hoisted(() => ({ session: null as ApiSessionSocketStub | null, user: null as ApiSessionSocketStub | null }));

vi.mock('@/api/session/sockets', () => ({
  createUserScopedSocket: () => {
    if (!sockets.user) throw new Error('Missing user transport');
    return sockets.user;
  },
}));

vi.mock('@/api/session/connection/createSessionSocketTransport', () => ({
  createSessionSocketTransport: () => {
    if (!sockets.session) throw new Error('Missing session transport');
    return {
      socket: sockets.session,
      transport: {
        connect: async () => {}, disconnect: async () => {}, destroy: async () => {},
        isConnected: () => sockets.session?.connected === true,
        onConnected: () => () => {}, onDisconnected: () => () => {}, onError: () => () => {},
      },
    };
  },
}));

async function writeLifecycleExecutable(root: string, holdResumeAck = false): Promise<string> {
  // Only the external Codex executable is substituted. Manager, adapter, runtime and
  // stdio/process teardown all run through their production owners.
  return writeFakeCodexAppServerScript({
    dir: root,
    importLines: ['import { appendFileSync, existsSync, writeFileSync } from "node:fs";'],
    setupLines: [
      'if (process.argv.includes("--help")) process.exit(0);',
      `const pidPath = process.env.HAPPIER_TEST_PID_PATH ?? ${JSON.stringify(join(root, 'session-child.pid'))};`,
      'writeFileSync(pidPath, String(process.pid));',
      'appendFileSync(pidPath + ".requests", process.pid + " spawn\\n");',
      'let turnCount = 0;',
      'let activeTurnId = null;',
      'const emit = (method, params) => process.stdout.write(JSON.stringify({ method, params }) + "\\n");',
    ],
    bodyLines: [
      'for await (const line of rl) {',
      '  if (!line.trim()) continue;',
      '  const msg = JSON.parse(line);',
      '  appendFileSync(pidPath + ".requests", process.pid + " " + msg.method + "\\n");',
      '  if (msg.id === undefined) continue;',
      '  let result = {};',
      ...(holdResumeAck ? [
        '  if (msg.method === "thread/resume") {',
        '    writeFileSync(pidPath + ".resume-pending", String(process.pid));',
        '    while (!existsSync(pidPath + ".resume-release")) await new Promise((resolve) => setTimeout(resolve, 5));',
        '  }',
      ] : []),
      '  if (msg.method === "thread/start" || msg.method === "thread/resume" || msg.method === "thread/read") result = { thread: { id: "thread-lifecycle", turns: [] } };',
      '  if (msg.method === "model/list" || msg.method === "collaborationMode/list") result = { data: [] };',
      '  if (msg.method === "turn/start") { activeTurnId = "turn-" + (++turnCount); result = { turn: { id: activeTurnId, status: "inProgress" } }; }',
      '  process.stdout.write(JSON.stringify({ id: msg.id, result }) + "\\n");',
      '  if (msg.method === "turn/start") {',
      '    emit("turn/started", { threadId: "thread-lifecycle", turn: { id: activeTurnId, status: "inProgress" } });',
      '    writeFileSync(pidPath + ".active", String(turnCount));',
      '    if (JSON.stringify(msg.params?.input).includes("HOLD_PROCESS_TURN")) continue;',
      '    emit("item/completed", { threadId: "thread-lifecycle", turnId: activeTurnId, item: { id: "answer-" + turnCount, type: "agentMessage", text: JSON.stringify({ summary: JSON.stringify(msg.params?.input).includes("Continue") ? "Continued" : "Complete", deliverables: [] }) } });',
      '    emit("turn/completed", { threadId: "thread-lifecycle", turn: { id: activeTurnId, status: "completed" } });',
      '    writeFileSync(pidPath + ".turns", String(turnCount));',
      '  }',
      '  if (msg.method === "turn/interrupt") emit("turn/interrupted", { threadId: "thread-lifecycle", turn: { id: activeTurnId, status: "interrupted" } });',
      '}',
    ],
  });
}

function createProcessBackend(root: string, executable: string, name: string) {
  const pidPath = join(root, `${name}.pid`);
  const backend = createCodexAppServerExecutionRunBackend({
    cwd: root,
    env: createCodexAppServerProcessEnv(executable, {
      CODEX_HOME: join(root, `${name}-codex-home`),
      HAPPIER_TEST_PID_PATH: pidPath,
    }),
    permissionMode: 'read-only',
  });
  return { backend, readPid: async () => Number(await readFile(pidPath, 'utf8')) };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH') return false;
    throw error;
  }
}

describe('ExecutionRunManager process lifecycle', () => {
  it('releases terminal child processes while parent completion delivery is pending', async () => {
    await withTempDir('happier-execution-run-process-lifecycle-', async (root) => {
      const executable = await writeLifecycleExecutable(root);
      let releaseParentDelivery!: () => void;
      const parentDelivery = new Promise<void>((resolve) => { releaseParentDelivery = resolve; });
      let parentDeliveryStarted = false;
      const previousAdapter = axios.defaults.adapter;
      // Hold only the external Home HTTP acknowledgement. Session input persistence,
      // RPC registration, run lifecycle and native process disposal remain real.
      axios.defaults.adapter = async (config) => {
        if (config.method === 'post' && config.url?.endsWith('/pending')) {
          parentDeliveryStarted = true;
          await parentDelivery;
        }
        return { data: { didWrite: true }, status: 200, statusText: 'OK', headers: {}, config };
      };
      vi.stubEnv('HAPPIER_HOME_DIR', join(root, 'happier-home'));
      vi.stubEnv('HAPPIER_SERVER_URL', 'http://127.0.0.1:1');
      vi.stubEnv('HAPPIER_CODEX_APP_SERVER_BIN', executable);
      vi.stubEnv('HAPPIER_CODEX_EXECUTION_RUN_TRANSPORT', 'appServer');
      vi.stubEnv('HAPPIER_FEATURE_EXECUTION__RUNS__ENABLED', '1');
      reloadConfiguration();
      sockets.session = createApiSessionSocketStub({ id: 'session-parent-delivery', connected: true });
      sockets.user = createApiSessionSocketStub({ id: 'user-parent-delivery', connected: false });
      const client = new ApiSessionClient('test-token', createPlainSessionFixture({
        id: 'parent-process-lifecycle', metadata: createTestMetadata({ path: root }),
      }));
      let runId: string | null = null;
      try {
        const result: unknown = await client.rpcHandlerManager.invokeLocal(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
          intent: 'delegate', backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
          instructions: 'Complete', permissionMode: 'read_only', retentionPolicy: 'ephemeral',
          runClass: 'bounded', ioMode: 'request_response', notifyParentOnCompletion: true,
        });
        expect(result).toMatchObject({ runId: expect.any(String) });
        if (!result || typeof result !== 'object' || !('runId' in result) || typeof result.runId !== 'string') {
          throw new Error('Expected an admitted execution run');
        }
        runId = result.runId;
        await expect.poll(() => parentDeliveryStarted, { timeout: 10_000 }).toBe(true);
        await expect(client.rpcHandlerManager.invokeLocal(SESSION_RPC_METHODS.EXECUTION_RUN_GET, { runId }))
          .resolves.toMatchObject({ run: { status: 'succeeded' } });
        const pid = Number(await readFile(join(root, 'session-child.pid'), 'utf8'));
        expect(Number.isSafeInteger(pid)).toBe(true);
        await expect.poll(() => isProcessAlive(pid), { timeout: 10_000 }).toBe(false);
      } finally {
        releaseParentDelivery();
        await client.close();
        if (runId) await removeExecutionRunMarker(runId);
        axios.defaults.adapter = previousAdapter;
        vi.unstubAllEnvs();
        reloadConfiguration();
        sockets.session = null;
        sockets.user = null;
      }
    });
  });

  it('keeps parked siblings and the primary active turn alive while completed and stopped children exit', async () => {
    await withTempDir('happier-execution-run-process-isolation-', async (root) => {
      const executable = await writeLifecycleExecutable(root);
      const primary = createProcessBackend(root, executable, 'primary');
      const children: ReturnType<typeof createProcessBackend>[] = [];
      const manager = new ExecutionRunManager({
        parentProvider: 'codex', cwd: root, sendAcp: () => {},
        createBackend: () => {
          const child = createProcessBackend(root, executable, `child-${children.length}`);
          children.push(child);
          return child.backend;
        },
      });
      const runs: string[] = [];
      const start = async (params: Readonly<{ runClass: 'bounded' | 'long_lived'; instructions?: string; retentionPolicy?: 'ephemeral' | 'resumable' }>) => {
        const started = await manager.start({
          sessionId: 'parent-process-isolation', intent: 'delegate',
          backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
          permissionMode: 'read_only', ioMode: 'request_response', retentionPolicy: 'ephemeral', ...params,
        });
        runs.push(started.runId);
        return started;
      };
      try {
        const { sessionId } = await primary.backend.startSession();
        await primary.backend.sendPrompt(sessionId, 'HOLD_PROCESS_TURN');
        await expect.poll(async () => (await primary.backend.probeTurnLiveness()).activeProviderTurn).toBe(true);
        const primaryPid = await primary.readPid();

        const parked = await start({ runClass: 'long_lived', retentionPolicy: 'resumable' });
        await expect(manager.send(parked.runId, { message: 'First turn' })).resolves.toEqual({ ok: true });
        await expect.poll(() => manager.getPublic(parked.runId)?.turnInFlight).toBe(false);
        const parkedPid = await children[0]!.readPid();

        const completed = await start({ runClass: 'bounded', instructions: 'Complete' });
        await manager.waitForTerminal(completed.runId);
        await expect.poll(async () => isProcessAlive(await children[1]!.readPid())).toBe(false);
        expect(isProcessAlive(parkedPid)).toBe(true);
        expect(isProcessAlive(primaryPid)).toBe(true);
        expect((await primary.backend.probeTurnLiveness()).activeProviderTurn).toBe(true);
        await expect(manager.send(parked.runId, { message: 'Second turn' })).resolves.toEqual({ ok: true });
        await expect.poll(() => manager.getPublic(parked.runId)?.turnInFlight).toBe(false);
        expect(manager.get(parked.runId)?.turnCount).toBe(2);

        const cancelled = await start({ runClass: 'bounded', instructions: 'HOLD_PROCESS_TURN' });
        await expect.poll(async () => (await children[2]?.backend.probeTurnLiveness())?.activeProviderTurn, { timeout: 10_000 }).toBe(true);
        await expect(manager.stop(cancelled.runId)).resolves.toEqual({ ok: true });
        await expect.poll(async () => isProcessAlive(await children[2]!.readPid())).toBe(false);
        expect(manager.get(cancelled.runId)?.status).toBe('cancelled');
        expect(isProcessAlive(parkedPid)).toBe(true);
        expect((await primary.backend.probeTurnLiveness()).activeProviderTurn).toBe(true);

        await expect(manager.stop(parked.runId)).resolves.toEqual({ ok: true });
        await expect.poll(() => isProcessAlive(parkedPid)).toBe(false);
        expect(isProcessAlive(primaryPid)).toBe(true);
      } finally {
        await Promise.all(runs.map(async (runId) => {
          await manager.stop(runId);
          await manager.waitForTerminal(runId);
          await removeExecutionRunMarker(runId);
        }));
        await Promise.all(children.map(({ backend }) => backend.dispose()));
        await primary.backend.dispose();
      }
    });
  });

  it('resumes a bounded run from its retained thread after its original process exits', async () => {
    await withTempDir('happier-execution-run-process-resume-', async (root) => {
      const executable = await writeLifecycleExecutable(root);
      const children: ReturnType<typeof createProcessBackend>[] = [];
      const messages: string[] = [];
      const manager = new ExecutionRunManager({
        parentProvider: 'claude', cwd: root,
        sendAcp: (_provider, body) => { if (body.type === 'message') messages.push(body.message); },
        createBackend: () => {
          const child = createProcessBackend(root, executable, `child-${children.length}`);
          children.push(child);
          return child.backend;
        },
      });
      const started = await manager.start({
        sessionId: 'parent-process-resume', intent: 'delegate',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        instructions: 'Complete', permissionMode: 'read_only', retentionPolicy: 'resumable',
        runClass: 'bounded', ioMode: 'request_response',
      });
      try {
        await manager.waitForTerminal(started.runId);
        const initialPid = await children[0]!.readPid();
        expect(isProcessAlive(initialPid)).toBe(false);
        expect(manager.get(started.runId)?.resumeHandle).toMatchObject({ vendorSessionId: 'thread-lifecycle' });
        await expect(manager.send(started.runId, { message: 'Continue', resume: true })).resolves.toEqual({ ok: true });
        await expect.poll(() => manager.getPublic(started.runId)?.status).toBe('succeeded');
        await manager.waitForTerminal(started.runId);
        expect(manager.getLatestToolResult(started.runId)).toMatchObject({ status: 'succeeded', summary: 'Continued' });
        await expect.poll(() => messages.some((message) => message.includes('Continued'))).toBe(true);
        const resumedPid = await children[1]!.readPid();
        expect(resumedPid).not.toBe(initialPid);
        expect(isProcessAlive(resumedPid)).toBe(false);
      } finally {
        await manager.stop(started.runId);
        await manager.waitForTerminal(started.runId);
        await Promise.all(children.map(({ backend }) => backend.dispose()));
        await removeExecutionRunMarker(started.runId);
      }
    });
  });

  it.each(['close', 'termination'] as const)('releases retained child processes through Session %s', async (operation) => {
    await withTempDir('happier-session-execution-run-process-', async (root) => {
      const executable = await writeLifecycleExecutable(root);
      vi.stubEnv('HAPPIER_HOME_DIR', join(root, 'happier-home'));
      vi.stubEnv('HAPPIER_SERVER_URL', 'http://127.0.0.1:1');
      vi.stubEnv('HAPPIER_CODEX_APP_SERVER_BIN', executable);
      vi.stubEnv('HAPPIER_CODEX_EXECUTION_RUN_TRANSPORT', 'appServer');
      vi.stubEnv('HAPPIER_FEATURE_EXECUTION__RUNS__ENABLED', '1');
      reloadConfiguration();
      sockets.session = createApiSessionSocketStub({ id: `session-${operation}`, connected: true });
      sockets.user = createApiSessionSocketStub({ id: `user-${operation}`, connected: false });
      const client = new ApiSessionClient('test-token', createPlainSessionFixture({
        id: `process-lifecycle-${operation}`,
        metadata: createTestMetadata({ path: root }),
      }));
      let runId: string | null = null;
      let pid: number | null = null;
      try {
        const request = {
          intent: 'delegate', backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
          instructions: operation === 'termination' ? 'HOLD_PROCESS_TURN' : 'Complete',
          permissionMode: 'read_only', retentionPolicy: 'resumable',
          runClass: 'long_lived', ioMode: 'request_response',
        };
        const result: unknown = await client.rpcHandlerManager.invokeLocal(SESSION_RPC_METHODS.EXECUTION_RUN_START, request);
        expect(result).toMatchObject({ runId: expect.any(String) });
        if (!result || typeof result !== 'object' || !('runId' in result) || typeof result.runId !== 'string') {
          throw new Error('Expected an admitted execution run');
        }
        runId = result.runId;
        const pidPath = join(root, 'session-child.pid');
        const progressPath = `${pidPath}.${operation === 'termination' ? 'active' : 'turns'}`;
        await expect.poll(async () => readFile(progressPath, 'utf8').catch(() => null), { timeout: 10_000 }).toBe('1');
        pid = Number(await readFile(pidPath, 'utf8'));
        expect(isProcessAlive(pid)).toBe(true);

        if (operation === 'termination') client.beginRuntimeTermination();
        else await client.close();

        await expect.poll(() => isProcessAlive(pid!), { timeout: 10_000 }).toBe(false);
        await client.close();
        expect(Number(await readFile(pidPath, 'utf8')), await readFile(`${pidPath}.requests`, 'utf8')).toBe(pid);
        await expect(client.rpcHandlerManager.invokeLocal(SESSION_RPC_METHODS.EXECUTION_RUN_START, request))
          .resolves.toMatchObject({ ok: false });
        expect(Number(await readFile(pidPath, 'utf8'))).toBe(pid);
      } finally {
        if (runId && pid !== null && isProcessAlive(pid)) {
          await client.rpcHandlerManager.invokeLocal(SESSION_RPC_METHODS.EXECUTION_RUN_STOP, { runId });
          await expect.poll(() => isProcessAlive(pid!), { timeout: 10_000 }).toBe(false);
        }
        await client.close();
        if (runId) await removeExecutionRunMarker(runId);
        vi.unstubAllEnvs();
        reloadConfiguration();
        sockets.session = null;
        sockets.user = null;
      }
    });
  });

  it('releases a resumed child before its native load acknowledgement during Session termination', async () => {
    await withTempDir('happier-resuming-child-session-shutdown-', async (root) => {
      const executable = await writeLifecycleExecutable(root, true);
      vi.stubEnv('HAPPIER_HOME_DIR', join(root, 'happier-home'));
      vi.stubEnv('HAPPIER_SERVER_URL', 'http://127.0.0.1:1');
      vi.stubEnv('HAPPIER_CODEX_APP_SERVER_BIN', executable);
      vi.stubEnv('HAPPIER_CODEX_EXECUTION_RUN_TRANSPORT', 'appServer');
      vi.stubEnv('HAPPIER_FEATURE_EXECUTION__RUNS__ENABLED', '1');
      reloadConfiguration();
      sockets.session = createApiSessionSocketStub({ id: 'session-resume-held', connected: true });
      sockets.user = createApiSessionSocketStub({ id: 'user-resume-held', connected: false });
      const client = new ApiSessionClient('test-token', createPlainSessionFixture({
        id: 'parent-resume-held', metadata: createTestMetadata({ path: root }),
      }));
      const pidPath = join(root, 'session-child.pid');
      let runId: string | null = null;
      let resume: Promise<unknown> | null = null;
      try {
        const started: unknown = await client.rpcHandlerManager.invokeLocal(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
          intent: 'delegate', backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
          instructions: 'Complete', permissionMode: 'read_only', retentionPolicy: 'resumable',
          runClass: 'bounded', ioMode: 'request_response',
        });
        if (!started || typeof started !== 'object' || !('runId' in started) || typeof started.runId !== 'string') {
          throw new Error('Expected an admitted execution run');
        }
        runId = started.runId;
        await expect.poll(async () => client.rpcHandlerManager.invokeLocal(SESSION_RPC_METHODS.EXECUTION_RUN_GET, { runId }), { timeout: 10_000 })
          .toMatchObject({ run: { status: 'succeeded' } });
        const originalPid = Number(await readFile(pidPath, 'utf8'));
        await expect.poll(() => isProcessAlive(originalPid), { timeout: 10_000 }).toBe(false);
        resume = client.rpcHandlerManager.invokeLocal(SESSION_RPC_METHODS.EXECUTION_RUN_SEND, {
          runId, message: 'Continue after shutdown', resume: true,
        });
        void resume.catch(() => {});
        await Promise.race([
          expect.poll(async () => readFile(`${pidPath}.resume-pending`, 'utf8').catch(() => null), { timeout: 10_000 })
            .not.toBeNull(),
          resume.then((result) => { throw new Error(`Resume settled before native load: ${JSON.stringify(result)}`); }),
        ]);
        const resumedPid = Number(await readFile(`${pidPath}.resume-pending`, 'utf8'));
        expect(resumedPid).not.toBe(originalPid);
        expect(isProcessAlive(resumedPid)).toBe(true);
        client.beginRuntimeTermination();
        // Native cleanup must not wait for the held external load acknowledgement.
        await expect.poll(() => isProcessAlive(resumedPid), { timeout: 10_000 }).toBe(false);
        await writeFile(`${pidPath}.resume-release`, 'release');
        await expect(resume).resolves.toMatchObject({ ok: false });
        await client.close();
        const requests = await readFile(`${pidPath}.requests`, 'utf8');
        expect(requests).not.toContain(`${resumedPid} turn/start`);
        expect(Number(await readFile(pidPath, 'utf8'))).toBe(resumedPid);
        await expect(client.rpcHandlerManager.invokeLocal(SESSION_RPC_METHODS.EXECUTION_RUN_GET, { runId }))
          .resolves.toMatchObject({ run: { status: 'cancelled' } });
      } finally {
        // Release first so a failing RED cannot strand the test's process adapter.
        await writeFile(`${pidPath}.resume-release`, 'release');
        await resume?.catch(() => {});
        if (runId) await client.rpcHandlerManager.invokeLocal(SESSION_RPC_METHODS.EXECUTION_RUN_STOP, { runId });
        await client.close();
        if (runId) await removeExecutionRunMarker(runId);
        vi.unstubAllEnvs();
        reloadConfiguration();
        sockets.session = null;
        sockets.user = null;
      }
    });
  });

  it('does not re-enter a disposed backend when native-open completes after Session shutdown', async () => {
    await withTempDir('happier-opening-child-process-shutdown-', async (root) => {
      const executable = await writeLifecycleExecutable(root);
      const child = createProcessBackend(root, executable, 'opening');
      let releaseOpen!: () => void;
      const openGate = new Promise<void>((resolve) => { releaseOpen = resolve; });
      let nativeOpened = false;
      let disposed = false;
      let cancellationAfterDisposal = false;
      let cancellationWork: Promise<void> | null = null;
      const manager = new ExecutionRunManager({
        parentProvider: 'codex', cwd: root, sendAcp: () => {},
        createBackend: () => ({
          ...child.backend,
          async startSession() {
            const result = await child.backend.startSession();
            nativeOpened = true;
            await openGate;
            return result;
          },
          cancel(sessionId) {
            cancellationAfterDisposal = disposed;
            cancellationWork = child.backend.cancel(sessionId);
            return cancellationWork;
          },
          async dispose() { disposed = true; await child.backend.dispose(); },
        }),
      });
      const started = await manager.start({
        sessionId: 'parent-opening-process', intent: 'delegate',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'request_response',
      });
      try {
        await expect.poll(() => nativeOpened, { timeout: 10_000 }).toBe(true);
        const pid = await child.readPid();
        await manager.dispose();
        expect(isProcessAlive(pid)).toBe(false);
        releaseOpen();
        // Drain the native-open acknowledgement's promise continuations; a disposed
        // process adapter must not receive a fresh cancellation that can reopen it.
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(cancellationAfterDisposal).toBe(false);
        expect(await child.readPid()).toBe(pid);
      } finally {
        releaseOpen();
        await Promise.allSettled([cancellationWork]);
        await child.backend.dispose();
        await manager.dispose();
        await removeExecutionRunMarker(started.runId);
      }
    });
  });

  it('joins native cleanup from a child whose stop was already acknowledged', async () => {
    await withTempDir('happier-stopped-child-process-shutdown-', async (root) => {
      const executable = await writeLifecycleExecutable(root);
      const child = createProcessBackend(root, executable, 'stopped');
      let releaseDisposal!: () => void;
      const disposalGate = new Promise<void>((resolve) => { releaseDisposal = resolve; });
      const manager = new ExecutionRunManager({
        parentProvider: 'claude', cwd: root, sendAcp: () => {},
        createBackend: () => ({
          ...child.backend,
          // The process-boundary teardown is held; the canonical host stop still settles.
          dispose: async () => { await disposalGate; await child.backend.dispose(); },
        }),
      });
      const started = await manager.start({
        sessionId: 'parent-stopped-process', intent: 'delegate',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'request_response',
      });
      try {
        await expect(manager.send(started.runId, { message: 'Complete' })).resolves.toEqual({ ok: true });
        await expect.poll(() => manager.getPublic(started.runId)?.turnInFlight).toBe(false);
        const pid = await child.readPid();
        await manager.stop(started.runId);
        expect(isProcessAlive(pid)).toBe(true);
        const shutdown = manager.dispose().then(() => { expect(isProcessAlive(pid)).toBe(false); });
        releaseDisposal();
        await shutdown;
      } finally {
        releaseDisposal();
        await manager.dispose();
        await child.backend.dispose();
        await removeExecutionRunMarker(started.runId);
      }
    });
  });

  it.each(['stop', 'dispose'] as const)('releases an active child process during Voice manager %s', async (operation) => {
    await withTempDir('happier-voice-process-shutdown-', async (root) => {
      const executable = await writeLifecycleExecutable(root);
      const child = createProcessBackend(root, executable, 'voice');
      const manager = new VoiceAgentManager({ createBackend: () => child.backend });
      const started = await manager.start({
        agentId: 'codex', chatModelId: 'default', commitModelId: 'default',
        permissionPolicy: 'read_only', idleTtlSeconds: 60, initialContext: '',
      });
      const turn = manager.sendTurn({ voiceAgentId: started.voiceAgentId, userText: 'HOLD_PROCESS_TURN' });
      void turn.catch(() => {});
      try {
        await expect.poll(async () => (await child.backend.probeTurnLiveness()).activeProviderTurn, { timeout: 10_000 }).toBe(true);
        const pid = await child.readPid();
        const disposal = operation === 'dispose' ? manager.dispose() : manager.stop({ voiceAgentId: started.voiceAgentId });
        await expect.poll(() => isProcessAlive(pid), { timeout: 10_000 }).toBe(false);
        await disposal;
      } finally {
        await child.backend.dispose();
        await turn.catch(() => {});
        await manager.dispose();
      }
    });
  });

  it.each(['chat', 'commit'] as const)('releases a Voice %s backend while its native-open acknowledgement is pending', async (phase) => {
    await withTempDir('happier-voice-opening-process-shutdown-', async (root) => {
      const executable = await writeLifecycleExecutable(root);
      const children: ReturnType<typeof createProcessBackend>[] = [];
      let releaseOpen!: () => void;
      const openGate = new Promise<void>((resolve) => { releaseOpen = resolve; });
      let nativeOpened = false;
      const manager = new VoiceAgentManager({
        createBackend: () => {
          const index = children.length;
          const child = createProcessBackend(root, executable, `opening-${index}`);
          children.push(child);
          if ((phase === 'chat' && index === 0) || (phase === 'commit' && index === 1)) {
            return {
              ...child.backend,
              // Hold only the external process-open acknowledgement after native allocation.
              async startSession() {
                const result = await child.backend.startSession();
                nativeOpened = true;
                await openGate;
                return result;
              },
            };
          }
          return child.backend;
        },
      });
      const start = manager.start({
        agentId: 'codex', chatModelId: 'chat', commitModelId: 'commit', commitIsolation: true,
        permissionPolicy: 'read_only', idleTtlSeconds: 60, initialContext: '',
      });
      void start.catch(() => {});
      let pending: Promise<unknown> = start;
      try {
        if (phase === 'commit') {
          const started = await start;
          pending = manager.commit({ voiceAgentId: started.voiceAgentId });
          void pending.catch(() => {});
        }
        await expect.poll(() => nativeOpened, { timeout: 10_000 }).toBe(true);
        const pid = await children[phase === 'chat' ? 0 : 1]!.readPid();
        const disposal = manager.dispose();
        await expect.poll(() => isProcessAlive(pid), { timeout: 10_000 }).toBe(false);
        releaseOpen();
        await expect(pending).rejects.toMatchObject({ code: 'VOICE_AGENT_START_FAILED' });
        await disposal;
      } finally {
        releaseOpen();
        await pending.catch(() => {});
        await Promise.all(children.map(({ backend }) => backend.dispose()));
        await manager.dispose();
      }
    });
  });
});
