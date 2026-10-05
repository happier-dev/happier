import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { AgentExecutionRunRuntimeContextV1 } from '@happier-dev/plugin-sdk/agents/runtime';

import { createCodexAgentRuntime } from '../../../../../../../packages/plugins/codex/src/agent/runtime/engine';
import { createStablePluginExecService } from '@/plugins/runtime/invocation/services/exec';
import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';
import type { ExecutionRunController } from '@/agent/executionRuns/controllers/types';
import { reloadConfiguration } from '@/configuration';
import { VoiceAgentManager } from '@/agent/voice/agent/VoiceAgentManager';
import { createNativeAgentExecutionRunHostRuntime } from './nativeAgentExecutionRun';
import { executeBoundedBackendRun } from './bounded/loop';
import { finishExecutionRun } from './finishExecutionRun';
import { resumeBackendControllerForResumableRun } from './resumeBackendController';
import { stopExecutionRun } from './executionRunStop';
import { startExecutionRun } from './startExecutionRun';
import type { ExecutionRunState } from './executionRunTypes';

const fixturePath = fileURLToPath(new URL('./testkit/codexAppServerTeardown.fixture.cjs', import.meta.url));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const { createBundledPluginPublicationFsFixture } = await import('@/plugins/projection/registry/builtIn/locators.testkit');
  return createBundledPluginPublicationFsFixture(actual);
});

describe('native Codex bounded backend process lifetime', () => {
  it.each(['ephemeral', 'resumable'] as const)(
    'releases success, failure and cancellation children with %s retention, and cold-resumes retained identity',
    async (retentionPolicy) => {
      const directory = await mkdtemp(join(tmpdir(), 'happier-run-teardown-'));
      const statePath = join(directory, 'native-state');
      const requestsPath = join(directory, 'requests.jsonl');
      vi.stubEnv('HAPPIER_HOME_DIR', directory);
      reloadConfiguration();
      const controllers = new Map<string, ExecutionRunController>();
      const runs = new Map<string, ExecutionRunState>();
      const terminalMarkerWritePromises = new Map<string, Promise<void>>();
      const lifetimes: AbortController[] = [];
      const voiceAgentManager = new VoiceAgentManager({ createRuntime: () => { throw new Error('Voice is outside this native Codex flow'); } });
      const services = { ...createUnavailablePluginServices(), logger: {
        debug() {}, info() {}, warn() {}, error() {}, diagnostic() {},
      } };
      const runtime = await createCodexAgentRuntime({} as never);
      const createRuntime = (runId: string) => {
        const lifetime = new AbortController();
        lifetimes.push(lifetime);
        // Substitute only the external executable. SDK process supervision,
        // JSON-RPC, Codex runtime and host lifecycle all remain real.
        const launch = { kind: 'binary' as const, executablePath: process.execPath, args: [fixturePath, statePath, requestsPath] };
        const exec = createStablePluginExecService({
          allowedExecutables: [{ kind: 'systemTool', id: 'codex-cli' }],
          allowedCwdScopes: [{ root: 'workspace', pathPrefix: '', access: ['read'] }],
          signal: lifetime.signal,
          isOccurrenceCurrent: () => true,
          resolveExecutable: async () => ({ command: launch.executablePath, args: launch.args }),
          resolvePath: async () => directory,
          systemTools: { resolve: async () => ({ grantId: 'fixture-codex', toolId: 'codex-cli', displayName: 'Codex fixture',
            source: 'system', executablePath: launch.executablePath, launch }) },
        });
        return createNativeAgentExecutionRunHostRuntime({
          runtime,
          executionRunContextV1: runtime.sessions!.executionRunContextV1!,
          lease: { pluginId: 'happier.codex', pluginVersion: '1.0.0', agentId: 'codex', localAgentId: 'codex', occurrenceId: runId, isCurrent: () => true },
          options: { cwd: directory, runId, scope: 'detached', backendId: 'codex', permissionMode: 'read_only', start: { intent: 'delegate' } },
          supportsResume: true,
          services: Promise.resolve({ ...services, exec }),
          createExecutionRunContext: ({ signal }) => ({
            // Unavailable services are external host boundaries; this flow only
            // reaches Exec. Keep every internal runtime implementation real.
            context: {
              signal, services: { ...services, exec },
              scope: { kind: 'execution_run', executionRunId: runId },
              executionRun: { id: runId, services: {} },
            } as unknown as AgentExecutionRunRuntimeContextV1,
            dispose: async () => { lifetime.abort(); },
          }),
        });
      };
      const finishRun: Parameters<typeof executeBoundedBackendRun>[0]['finishRun'] = async (runId, next, toolResult, structuredMeta) => {
        await finishExecutionRun({ runId, next, toolResult, structuredMeta, runs, controllers,
          budgetRegistry: null, parentProvider: 'codex', sendAcp: async () => {},
          enqueueMarkerWrite: async (_id, write) => { await write(); }, terminalMarkerWritePromises });
      };
      const requests = async (): Promise<Array<{ method: string; pid: number; params: { threadId?: string } }>> =>
        (await readFile(requestsPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
      const expectChildrenGone = async () => {
        const pids = new Set((await requests()).map((request) => request.pid));
        await vi.waitFor(() => {
          for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
        }, { timeout: 5_000 });
      };
      try {
        for (const outcome of ['success', 'failure', 'cancel'] as const) {
          const previousTurns = outcome === 'success' ? 0 : (await requests()).filter((r) => r.method === 'turn/start').length;
          const instructions = outcome === 'failure' ? 'fail-this-turn' : outcome === 'cancel' ? 'hold-for-cancel' : 'complete';
          const params = { sessionId: 'fixture-parent', intent: 'delegate' as const,
            backendTarget: { kind: 'builtInAgent' as const, agentId: 'codex' as const },
            instructions, permissionMode: 'read_only', retentionPolicy, runClass: 'bounded' as const, ioMode: 'request_response' as const };
          const execute = (run: ExecutionRunState) => executeBoundedBackendRun({ runId: run.runId, callId: run.callId, sidechainId: run.sidechainId,
            startedAtMs: run.startedAtMs, params, controllers, runs, sendAcp: async () => {},
            parentProvider: 'codex', getNowMs: Date.now, boundedTimeoutMs: null, finishRun });
          let running: Promise<void> | undefined;
          let initialResumeHandle: ExecutionRunState['resumeHandle'];
          const started = await startExecutionRun({
            params, parentProvider: 'codex', sendAcp: async () => {}, streamedTranscriptSession: null,
            createRuntime: ({ runId }) => createRuntime(runId!), getNowMs: Date.now, budgetRegistry: null,
            runs, controllers, enqueueMarkerWrite: async (_id, write) => { await write(); },
            writeActivityMarker: async () => {}, finishRun,
            executeBoundedRun: ({ runId }) => {
              const run = runs.get(runId)!;
              initialResumeHandle = run.resumeHandle;
              running = execute(run);
              return running;
            },
            send: async () => ({ ok: true }), voiceAgentManager,
          });
          const runId = started.runId;
          await vi.waitFor(() => expect(running).toBeDefined(), { timeout: 5_000 });
          if (retentionPolicy === 'resumable') expect(initialResumeHandle).toBeFalsy();
          if (outcome === 'cancel') {
            await vi.waitFor(async () => expect((await requests()).filter((r) => r.method === 'turn/start').length).toBe(previousTurns + 1), { timeout: 5_000 });
            await stopExecutionRun({ runId, runs, controllers,
              voiceAgentManager,
              getNowMs: Date.now, finishRun });
          }
          await running;
          expect(runs.get(runId)?.status).toBe(outcome === 'success' ? 'succeeded' : outcome === 'failure' ? 'failed' : 'cancelled');
          expect(controllers.has(runId)).toBe(false);
          await expectChildrenGone();
          if (outcome === 'success' && retentionPolicy === 'resumable') {
            const retained = runs.get(runId)!;
            expect(retained.resumeHandle).toMatchObject({ providerSessionId: 'thread-teardown' });
            const originalPid = (await requests()).find((r) => r.method === 'turn/start')!.pid;
            const resumed = await resumeBackendControllerForResumableRun({ runId, run: retained, runs, controllers,
              budgetRegistry: null, createRuntime: () => createRuntime(runId), sendAcp: async () => {}, parentProvider: 'codex',
              streamedTranscriptSession: null, writeActivityMarker: async () => {}, getNowMs: Date.now });
            expect(resumed).toMatchObject({ ok: true });
            expect(runs.get(runId)?.resumeHandle).toMatchObject({ providerSessionId: 'thread-teardown' });
            expect((await requests()).find((r) => r.method === 'thread/resume')).toMatchObject({ params: { threadId: 'thread-teardown' } });
            expect((await requests()).find((r) => r.method === 'thread/resume')!.pid).not.toBe(originalPid);
            await execute(runs.get(runId)!);
            expect(runs.get(runId)?.status).toBe('succeeded');
            expect(runs.get(runId)?.resumeHandle).toMatchObject({ providerSessionId: 'thread-teardown' });
            await expectChildrenGone();
          }
        }
      } finally {
        for (const lifetime of lifetimes) lifetime.abort();
        await Promise.all([...controllers.values()].map((controller) => controller.kind === 'backend' ? controller.backend.dispose() : undefined));
        await voiceAgentManager.dispose();
        vi.unstubAllEnvs();
        reloadConfiguration();
        await rm(directory, { recursive: true, force: true });
      }
    }, 30_000,
  );
});
