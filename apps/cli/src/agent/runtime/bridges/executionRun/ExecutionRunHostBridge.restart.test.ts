import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { isPidPresent } from '@happier-dev/cli-common/process';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { readBackendTargetRefV2 } from '@happier-dev/protocol';
import { configuration, reloadConfiguration } from '@/configuration';
import { readOrCreateDeviceLocalSecretStorage } from '@/daemon/deviceLocalSecretStorage';
import { gcExecutionRunMarkers, readRetainedExecutionRunRecords, removeExecutionRunMarker } from '@/daemon/executionRunRegistry';
import { ExecutionRunHostBridge } from './ExecutionRunHostBridge';
import { finishExecutionRun } from './finishExecutionRun';
import { writeExecutionRunActivityMarker } from './activityMarkers';
import type { ExecutionRunState } from './executionRunTypes';
import type { ExecutionRunController } from '@/agent/executionRuns/controllers/types';
import { ensureExecutionRun } from './ensureExecutionRun';
import { createTestExecutionRunHostRuntime } from './testkit';
import { VoiceAgentManager } from '@/agent/voice/agent/VoiceAgentManager';
import { RetainedExecutionRunRecordSchema, projectExecutionRunHostLoss, projectRetainedExecutionRunState } from './retainedState';
import { buildReviewFindingsV2Payload } from '@/agent/reviews/normalize/buildReviewFindingsV2Payload';

// The observation transport is unavailable after the host has died. All
// retained-state parsing, ownership and fallback selection remain real.
vi.mock('@/session/transport/rpc/sessionRpc', () => ({
  callSessionRpc: async () => { throw new Error('RPC method not available'); },
}));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const { createBundledPluginPublicationFsFixture } = await import('@/plugins/projection/registry/builtIn/locators.testkit');
  return createBundledPluginPublicationFsFixture(actual);
});

let directory: string;
const bridges: ExecutionRunHostBridge[] = [];
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'happier-execution-restart-'));
  vi.stubEnv('HAPPIER_HOME_DIR', directory);
  vi.stubEnv('HAPPIER_PUBLIC_RELEASE_CHANNEL', undefined);
  vi.stubEnv('HAPPIER_RELEASE_RING', undefined);
  vi.stubEnv('HAPPIER_RELEASE_CHANNEL', undefined);
  reloadConfiguration();
});
afterEach(async () => {
  await Promise.all(bridges.splice(0).map((manager) => manager.dispose()));
  vi.unstubAllEnvs();
  reloadConfiguration();
  rmSync(directory, { recursive: true, force: true });
});

function state(sessionId: string | null, retentionPolicy: ExecutionRunState['retentionPolicy']): ExecutionRunState {
  return {
    runId: 'restart-run', callId: 'restart-call', sidechainId: 'restart-side', sessionId, depth: 2,
    intent: 'agent', backendId: 'test.agent', backendTarget: { kind: 'builtInAgent', agentId: 'test.agent' },
    instructions: 'Continue the exact task', permissionMode: 'read_only', retentionPolicy,
    runClass: 'long_lived', ioMode: 'streaming', status: 'running', startedAtMs: 1,
    launch: { cwd: directory, modelId: 'admitted-model' },
    resumeHandle: retentionPolicy === 'resumable'
      ? { kind: 'provider_session.v1', backendTarget: readBackendTargetRefV2({ kind: 'builtInAgent', agentId: 'test.agent' }), providerSessionId: 'exact-thread' }
      : null,
    notifyParentOnCompletion: true,
    inputTurns: { occurrenceId: 'old-occurrence', current: { turnId: 'old-turn', inputIds: ['exact-input'], state: 'active' } },
  };
}

function bridge() {
  const manager = new ExecutionRunHostBridge({ parentProvider: 'test.agent', cwd: directory, sendAcp: async () => {} });
  bridges.push(manager);
  return manager;
}

describe('execution lifecycle restart recovery', () => {
  it('retains an already published review at retirement without repeating comment materialization', async () => {
    const run = { ...state('parent-session', 'resumable'), intent: 'review' as const };
    const structuredMeta = { kind: 'review_findings.v2', payload: buildReviewFindingsV2Payload({
      ...run, summary: 'Published review', generatedAtMs: 2,
      findings: [{ id: 'f1', title: 'Check authorization', category: 'correctness', severity: 'high', summary: 'The condition changed.',
        comment: { id: 'persisted-comment', state: 'dismissed', serverRevision: 2, sessionId: run.sessionId!,
          workspace: { machineId: 'fixture-machine', path: directory } } }],
    }) };
    const output = { summary: 'Published review', commentIds: ['persisted-comment'] };
    const runs = new Map([[run.runId, { ...run, structuredMeta, latestToolResult: output }]]);
    await finishExecutionRun({ runId: run.runId, next: { status: 'succeeded', finishedAtMs: 3 },
      toolResult: { output }, structuredMeta, runs, controllers: new Map(), budgetRegistry: null,
      parentProvider: 'test.agent', sendAcp: async () => {}, enqueueMarkerWrite: async (_id, write) => { await write(); },
      terminalMarkerWritePromises: new Map() });
    // Publication already persisted the findings. Retirement must not need the
    // withdrawn Home writer or re-raise a comment dismissed since publication.
    expect(runs.get(run.runId)).toMatchObject({ status: 'succeeded', latestToolResult: output, structuredMeta });
    const restarted = bridge();
    await restarted.recoverRetainedRuns();
    expect(restarted.get(run.runId)).toMatchObject({ status: 'succeeded', latestToolResult: output, structuredMeta });
  });

  it('redelivers one loss but distinguishes a later resumed host lifetime', () => {
    const retained = projectRetainedExecutionRunState(state('parent-session', 'resumable'));
    const first = projectExecutionRunHostLoss({ ownerPid: 123, ownerProcessStartTimeMs: 10, state: retained }, 30);
    expect(projectExecutionRunHostLoss(first, 40)).toEqual(first);
    const resumedLoss = projectExecutionRunHostLoss({ ownerPid: 123, ownerProcessStartTimeMs: 20, state: retained }, 50);
    expect(resumedLoss.terminalEventId).not.toBe(first.terminalEventId);
  });

  describe('real retained host fixture', () => {
    let observer: ExecutionRunHostBridge;
    let child: ReturnType<typeof fork> | undefined;
    let phase: string;
    let completed: boolean;
    let stderr = '';

    const waitForHostMessage = (phase: string) => new Promise<unknown>((resolve, reject) => {
      child!.once('message', resolve);
      child!.once('error', reject);
      child!.once('exit', (code) => reject(new Error(`Retained host exited before ${phase} (${code}): ${stderr}`)));
    });

    afterEach(async () => {
      if (child && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill('SIGKILL');
        await exited;
      }
    });

    it.each(['ephemeral', 'resumable'] as const)('reconciles actual process death after an earlier empty baseline (%s)', async (retentionPolicy) => {
      // Readiness and process death share the original unit-test allowance.
      phase = 'recovering empty baseline';
      completed = false;
      stderr = '';
      child = undefined;
      onTestFinished(() => {
        if (!completed) console.error('Actual retained host failure phase', phase);
      });
      observer = bridge();
      await observer.recoverRetainedRuns();
      phase = 'child readiness';
      child = fork(fileURLToPath(new URL('./testkit/retainedRunHost.fixture.ts', import.meta.url)), {
        execArgv: ['--import', fileURLToPath(new URL('../../../../../../../packages/cli-common/registerSourceRuntime.mjs', import.meta.url))],
        env: { ...process.env, TSX_TSCONFIG_PATH: fileURLToPath(new URL('../../../../../tsconfig.runtime.json', import.meta.url)) },
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      });
      child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      expect(await waitForHostMessage('readiness')).toBe('ready');
      const host = child!;
      phase = 'retaining child state';
      const retained = waitForHostMessage('retaining state');
      host.send(state('parent-session', retentionPolicy));
      expect(await retained).toBe('retained');
      phase = 'recognizing live child';
      // The daemon's boolean process-recognition adapter collapses an
      // unreadable process to false. It is not proof of owner death/reuse.
      await gcExecutionRunMarkers({
        nowMs: Date.now(), terminalTtlMs: 100,
        isPidAlive: isPidPresent, isPidSafeHappyProcess: () => false,
      });
      await observer.recoverRetainedRuns();
      expect(observer.get('restart-run')).toBeNull(); // No local authority over a live foreign host.
      const exited = once(host, 'exit');
      host.kill('SIGKILL');
      await exited;
      phase = 'observing child host loss';
      await observer.waitForTerminal('restart-run');
      expect(observer.getPublic('restart-run')).toMatchObject({
        status: 'failed', error: { code: 'execution_run_host_lost' },
        lifecycle: { state: retentionPolicy === 'resumable' ? 'recoverable' : 'unavailable' },
      });
      expect(await observer.waitForInputTurn('restart-run', 'exact-input')).toMatchObject({
        occurrenceId: 'old-occurrence', turn: { state: 'failed', inputIds: ['exact-input'] },
      });
      expect((await observer.takeWorkerUpdate('parent-session', new AbortController().signal))?.update)
        .toMatchObject({ ownerState: 'failed', transcriptPointer: { runId: 'restart-run' } });
      completed = true;
    });
  });

  it.each([null, 'parent-session'])('restores resumable control state independently of marker visibility (%s)', async (sessionId) => {
    const run = { ...state(sessionId, 'resumable'), requesterWorkAttributionV1: {
      serverId: 'home', accountId: 'owner', machineId: 'machine', installationId: 'installation',
    } };
    const runs = new Map([[run.runId, run]]);
    await finishExecutionRun({
      runId: run.runId, next: { status: 'succeeded', finishedAtMs: 2 }, toolResult: { output: 'Finished text' },
      runs, controllers: new Map(), budgetRegistry: null, parentProvider: 'test.agent', sendAcp: async () => {},
      enqueueMarkerWrite: async (_id, write) => { await write(); }, terminalMarkerWritePromises: new Map(),
    });
    await removeExecutionRunMarker(run.runId);
    const storage = await readOrCreateDeviceLocalSecretStorage({ path: configuration.deviceLocalSecretKeyFile });
    const path = join(directory, 'tmp', 'daemon-execution-runs', `state-${createHash('sha256').update(JSON.stringify([run.runId])).digest('hex')}.sealed`);
    const record = RetainedExecutionRunRecordSchema.parse(storage.openJson({ purpose: 'execution_run_state', ciphertext: readFileSync(path, 'utf8') }));
    writeFileSync(path, storage.sealJson({ purpose: 'execution_run_state', value: { ...record, future: true,
      state: { ...record.state, future: true, launch: { ...record.state.launch, future: true },
        resumeHandle: { ...record.state.resumeHandle, future: true } },
    } }));
    const restarted = bridge();
    await restarted.waitForTerminal(run.runId);
    expect(restarted.get(run.runId)).toMatchObject({
      sessionId, status: 'succeeded', depth: 2, instructions: run.instructions,
      launch: run.launch, resumeHandle: run.resumeHandle, latestToolResult: 'Finished text',
    });
    expect(restarted.getPublic(run.runId)?.lifecycle).toEqual({ v: 1, state: 'recoverable' });
    expect(JSON.stringify(restarted.get(run.runId))).not.toContain('future');
    expect(restarted.listPublicForRequest({}, sessionId, run.requesterWorkAttributionV1)?.map((item) => item.runId)).toEqual([run.runId]);
    const restored = restarted.get(run.runId);
    if (!restored) throw new Error('Expected restored control state');
    let resumedThread: string | undefined;
    const runtime = createTestExecutionRunHostRuntime({
      resumeSupported: true, replayResumeSupported: true,
      onProvisionRuntime: (input) => { resumedThread = input?.resumeRuntimeId; },
    });
    const resumedRuns = new Map([[run.runId, restored]]);
    const controllers = new Map<string, ExecutionRunController>();
    const voiceAgentManager = new VoiceAgentManager({
      createRuntime: () => runtime,
      resolvePromptPreparation: async () => ({ systemAppendBlocks: [], memoryRecallGuidanceEnabled: false, disabledActionIds: [] }),
      responseTimeoutMs: 1_000,
    });
    expect(await ensureExecutionRun({
      runId: run.runId, params: { resume: true }, runs: resumedRuns, controllers,
      budgetRegistry: null, createRuntime: () => runtime, sendAcp: async () => {},
      parentProvider: 'test.agent', streamedTranscriptSession: null, getNowMs: () => 3,
      writeActivityMarker: async () => {}, voiceAgentManager,
    })).toEqual({ ok: true });
    expect(resumedThread).toBe('exact-thread');
    expect(resumedRuns.get(run.runId)).toMatchObject({ runId: run.runId, status: 'running', resumeHandle: run.resumeHandle });
    await runtime.dispose();
    await voiceAgentManager.dispose();
  });

  it('isolates corrupted known fields in a real sealed retained record and keeps the bridge usable', async () => {
    const run = state('parent-session', 'resumable');
    await writeExecutionRunActivityMarker({ runId: run.runId, nowMs: 10, opts: { force: true },
      runs: new Map([[run.runId, run]]), controllers: new Map(), enqueueMarkerWrite: async (_id, write) => { await write(); } });
    const storage = await readOrCreateDeviceLocalSecretStorage({ path: configuration.deviceLocalSecretKeyFile });
    const path = join(directory, 'tmp', 'daemon-execution-runs', `state-${createHash('sha256').update(JSON.stringify([run.runId])).digest('hex')}.sealed`);
    const record = RetainedExecutionRunRecordSchema.parse(storage.openJson({ purpose: 'execution_run_state', ciphertext: readFileSync(path, 'utf8') }));
    const corrupt = storage.sealJson({ purpose: 'execution_run_state', value: { ...record,
      state: { ...record.state, depth: -1 },
    } });
    writeFileSync(path, corrupt);
    await expect(readRetainedExecutionRunRecords()).resolves.toEqual([]);
    const restarted = bridge();
    await expect(restarted.recoverRetainedRuns()).resolves.toBeUndefined();
    expect(restarted.get(run.runId)).toBeNull();
    expect(readFileSync(path, 'utf8')).toBe(corrupt);
  });

  it.each(['ephemeral', 'resumable'] as const)('records abrupt host loss and exact input failure (%s)', async (retentionPolicy) => {
    const run = state('parent-session', retentionPolicy);
    await writeExecutionRunActivityMarker({
      runId: run.runId, nowMs: 10, opts: { force: true }, runs: new Map([[run.runId, run]]), controllers: new Map(),
      enqueueMarkerWrite: async (_id, write) => { await write(); },
    });
    await gcExecutionRunMarkers({ nowMs: 20, terminalTtlMs: 100, isPidAlive: () => false, isPidSafeHappyProcess: () => false });
    const restarted = bridge();
    await restarted.waitForTerminal(run.runId);
    expect(restarted.getPublic(run.runId)).toMatchObject({
      status: 'failed', error: { code: 'execution_run_host_lost' },
      lifecycle: { state: retentionPolicy === 'resumable' ? 'recoverable' : 'unavailable' },
    });
    expect(await restarted.waitForInputTurn(run.runId, 'exact-input')).toMatchObject({
      occurrenceId: 'old-occurrence', turn: { turnId: 'old-turn', state: 'failed', inputIds: ['exact-input'] },
    });
    const pending = await restarted.takeWorkerUpdate('parent-session', new AbortController().signal);
    expect(pending?.update).toMatchObject({ ownerState: 'failed', transcriptPointer: { kind: 'execution_run', runId: run.runId } });
    expect(pending?.update.result).toContain('lost');
    const nextRestart = bridge();
    expect((await nextRestart.takeWorkerUpdate('parent-session', new AbortController().signal))?.localId).toBe(pending?.localId);
    pending?.acknowledgeAccepted();
    expect(await restarted.takeWorkerUpdate('parent-session', new AbortController().signal)).toBeNull();
    expect(await bridge().takeWorkerUpdate('parent-session', new AbortController().signal)).toBeNull();
    const { getExecutionRun } = await import('@/session/services/executionRuns');
    const read = await getExecutionRun({
      token: 'unused', sessionId: 'parent-session', request: { runId: run.runId },
      mode: 'plain', ctx: null,
    });
    expect(read).toMatchObject({ ok: true, data: { run: { status: 'failed', error: { code: 'execution_run_host_lost' } } } });
    await gcExecutionRunMarkers({ nowMs: 1_000, terminalTtlMs: 100, isPidAlive: () => false, isPidSafeHappyProcess: () => false });
    // Reuse the existing terminal visibility lifetime for ephemeral state;
    // resumable control survives it, independently of marker collection.
    expect((await readRetainedExecutionRunRecords()).some((record) => record.state.runId === run.runId))
      .toBe(retentionPolicy === 'resumable');
  });
});
