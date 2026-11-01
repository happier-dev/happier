import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { DaemonExecutionRunMarkerSchema } from '@happier-dev/protocol/daemon/executionRuns';
import { reloadConfiguration } from '@/configuration';
import { createManagedActivityInventory } from './lifecycle/managedActivity';
import { projectMachineWorkSummary } from './machines/machineWorkSummary';
import type { RequesterWorkAttributionV1 } from './lifecycle/requesterWorkAttribution';
import { logger } from '@/ui/logger';

const markerEntry = (runId: string) => `run-${createHash('sha256').update(JSON.stringify([runId])).digest('hex')}.json`;

const filesystemBoundary = vi.hoisted(() => ({
  afterRead: null as null | ((path: unknown) => Promise<void>),
  afterProtectedRead: null as null | ((path: unknown) => Promise<void>),
  writeFileSpy: vi.fn<(...args: Parameters<typeof import('node:fs/promises')['writeFile']>) => void>(),
  openSpy: vi.fn<(...args: Parameters<typeof import('node:fs/promises')['open']>) => void>(),
  readdirSpy: vi.fn<(...args: Parameters<typeof import('node:fs/promises')['readdir']>) => void>(),
  watchers: new Set<import('node:fs').FSWatcher>(),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, watch: (...args: Parameters<typeof actual.watch>) => {
    const watcher = actual.watch(...args);
    filesystemBoundary.watchers.add(watcher);
    watcher.on('close', () => filesystemBoundary.watchers.delete(watcher));
    return watcher;
  } };
});

// Keep the real filesystem and owner modules loaded; individual tests control only OS interleavings.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readdir: async (...args: Parameters<typeof actual.readdir>) => {
      filesystemBoundary.readdirSpy(...args);
      return actual.readdir(...args);
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      filesystemBoundary.openSpy(...args);
      const handle = await actual.open(...args);
      const close = handle.close.bind(handle);
      vi.spyOn(handle, 'close').mockImplementation(async () => {
        await close();
        await filesystemBoundary.afterProtectedRead?.(args[0]);
      });
      return handle;
    },
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      const contents = await actual.readFile(...args);
      await filesystemBoundary.afterRead?.(args[0]);
      return contents;
    },
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      filesystemBoundary.writeFileSpy(...args);
      return actual.writeFile(...args);
    },
  };
});

describe('executionRunRegistry', () => {
  const originalHappyHomeDir = process.env.HAPPIER_HOME_DIR;
  const originalPublicReleaseChannel = process.env.HAPPIER_PUBLIC_RELEASE_CHANNEL;
  const originalReleaseRing = process.env.HAPPIER_RELEASE_RING;
  const originalReleaseChannel = process.env.HAPPIER_RELEASE_CHANNEL;
  let happyHomeDir: string;

  beforeEach(() => {
    happyHomeDir = join(tmpdir(), `happier-cli-exec-run-registry-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    process.env.HAPPIER_HOME_DIR = happyHomeDir;
    delete process.env.HAPPIER_PUBLIC_RELEASE_CHANNEL;
    delete process.env.HAPPIER_RELEASE_RING;
    delete process.env.HAPPIER_RELEASE_CHANNEL;
    filesystemBoundary.afterRead = null;
    filesystemBoundary.afterProtectedRead = null;
    filesystemBoundary.writeFileSpy.mockClear();
    filesystemBoundary.openSpy.mockClear();
    filesystemBoundary.readdirSpy.mockClear();
    // Reload the real live configuration instead of rebuilding the entire Protocol/CLI graph.
    reloadConfiguration();
  });

  afterEach(() => {
    for (const watcher of filesystemBoundary.watchers) watcher.close();
    filesystemBoundary.watchers.clear();
    if (existsSync(happyHomeDir)) {
      rmSync(happyHomeDir, { recursive: true, force: true });
    }
    if (originalHappyHomeDir === undefined) {
      delete process.env.HAPPIER_HOME_DIR;
    } else {
      process.env.HAPPIER_HOME_DIR = originalHappyHomeDir;
    }
    if (originalPublicReleaseChannel === undefined) {
      delete process.env.HAPPIER_PUBLIC_RELEASE_CHANNEL;
    } else {
      process.env.HAPPIER_PUBLIC_RELEASE_CHANNEL = originalPublicReleaseChannel;
    }
    if (originalReleaseRing === undefined) {
      delete process.env.HAPPIER_RELEASE_RING;
    } else {
      process.env.HAPPIER_RELEASE_RING = originalReleaseRing;
    }
    if (originalReleaseChannel === undefined) {
      delete process.env.HAPPIER_RELEASE_CHANNEL;
    } else {
      process.env.HAPPIER_RELEASE_CHANNEL = originalReleaseChannel;
    }
    filesystemBoundary.afterRead = null;
    filesystemBoundary.afterProtectedRead = null;
    reloadConfiguration();
  });

  it('writes and lists execution run markers', async () => {
    const { configuration } = await import('@/configuration');
    const { listExecutionRunMarkers, writeExecutionRunMarker } = await import('./executionRunRegistry');

    const marker = {
      pid: 123,
      happySessionId: 'sess-1',
      runId: 'run_1',
      callId: 'call_1',
      sidechainId: 'call_1',
      intent: 'review',
      backendTarget: { kind: 'backend' as const, backendId: 'claude' },
      permissionMode: 'read_only',
      runClass: 'bounded',
      ioMode: 'request_response',
      retentionPolicy: 'ephemeral',
      status: 'running',
      startedAtMs: 1,
      updatedAtMs: 1,
    } satisfies Parameters<typeof writeExecutionRunMarker>[0];
    await writeExecutionRunMarker(marker);

    const markers = await listExecutionRunMarkers();
    expect(markers).toHaveLength(1);
    expect(markers[0].pid).toBe(123);
    expect(markers[0].happySessionId).toBe('sess-1');
    expect(markers[0].runId).toBe('run_1');
    expect(markers[0].intent).toBe('review');
    expect(markers[0].backendTarget).toEqual({ kind: 'backend', backendId: 'claude' });
    expect(markers[0]).not.toHaveProperty('backendId');

    const filePath = join(configuration.happyHomeDir, 'tmp', 'daemon-execution-runs', markerEntry('run_1'));
    const raw = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed).toEqual({
      pid: 123,
      happySessionId: 'sess-1',
      runId: 'run_1',
      callId: 'call_1',
      sidechainId: 'call_1',
      intent: 'review',
      backendTarget: { kind: 'backend', backendId: 'claude' },
      permissionMode: 'read_only',
      runClass: 'bounded',
      ioMode: 'request_response',
      retentionPolicy: 'ephemeral',
      status: 'running',
      startedAtMs: 1,
      updatedAtMs: 1,
    });
    expect(raw).not.toContain(configuration.happyHomeDir);
  });

  it('retains long worker identities with immutable publication and exact acceptance', async () => {
    const registry = await import('./executionRunRegistry');
    const pending: import('./executionRunRegistry').RetainedExecutionRunWorkerUpdate = {
      sessionId: 'session', localId: `execution-run-worker-update:${'identity/雪:'.repeat(100)}`, update: {
        v: 1, workerKind: 'execution_run', workerId: 'run_long_delivery',
        ownerState: 'failed', wake: 'finished', headline: 'Host lost', result: 'Partial output', canInspect: true,
      },
    };
    await Promise.all([registry.retainExecutionRunWorkerUpdate(pending), registry.retainExecutionRunWorkerUpdate(pending)]);
    await expect(registry.retainExecutionRunWorkerUpdate({ ...pending, update: { ...pending.update, result: 'Conflicting output' } }))
      .rejects.toThrow('custody conflicts');
    const neighbor = { ...pending, localId: `${pending.localId}:next` };
    await registry.retainExecutionRunWorkerUpdate(neighbor);
    expect(await registry.readPendingExecutionRunWorkerUpdates()).toEqual(expect.arrayContaining([pending, neighbor]));
    expect(await registry.acknowledgeExecutionRunWorkerUpdate({ ...pending, sessionId: 'foreign-session' })).toBe(false);
    expect(await registry.acknowledgeExecutionRunWorkerUpdate(pending)).toBe(true);
    expect(await registry.readPendingExecutionRunWorkerUpdates()).toEqual([neighbor]);
  });

  it('retains and lists state and visibility markers for long Run identities', async () => {
    const registry = await import('./executionRunRegistry');
    const runId = `run_${'x'.repeat(220)}`;
    // An exact absent identity has no discovery consumer, even when its former
    // basename would exceed the filesystem's per-component limit.
    expect(await registry.readRetainedExecutionRunRecord(runId)).toBeNull();
    expect(filesystemBoundary.readdirSpy).not.toHaveBeenCalled();
    await registry.retainExecutionRunState({ runId, callId: 'call', sidechainId: 'side', sessionId: null, depth: 0,
      intent: 'review', backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, backendId: 'codex', instructions: 'Review',
      permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'bounded', ioMode: 'request_response',
      status: 'succeeded', startedAtMs: 1, finishedAtMs: 2,
    });
    expect((await registry.readRetainedExecutionRunRecord(runId))?.state.runId).toBe(runId);
    expect((await registry.readRetainedExecutionRunRecords()).map(record => record.state.runId)).toEqual([runId]);
    await registry.writeExecutionRunMarker({ runId, pid: process.pid, happySessionId: null, callId: 'call', sidechainId: 'side',
      intent: 'review', backendTarget: { kind: 'backend', backendId: 'codex' }, status: 'succeeded',
      startedAtMs: 1, finishedAtMs: 2, updatedAtMs: 2,
    });
    expect((await registry.listExecutionRunMarkers()).map(marker => marker.runId)).toEqual([runId]);
    await registry.removeExecutionRunMarker(runId);
    expect(await registry.listExecutionRunMarkers()).toEqual([]);
  });

  it('reopens the typed terminal issue from sealed Run custody', async () => {
    const registry = await import('./executionRunRegistry');
    const { classifyPrimarySessionRuntimeIssue } = await import('@/agent/runtime/session/errors/classifyPrimarySessionRuntimeIssue');
    const runtimeIssueV1 = classifyPrimarySessionRuntimeIssue({ cause: 'session_error', occurredAt: 20,
      error: { code: 'provider_usage_exhausted', severity: 'error', details: { runtimeAuthClassification: {
        kind: 'usage_limit', serviceId: 'openai-codex', source: 'structured_provider_error', resetsAtMs: 42_000,
      } } },
    });
    const error = { code: 'provider_usage_exhausted', runtimeIssueV1 };
    await registry.retainExecutionRunState({ runId: 'run-limit', callId: 'call', sidechainId: 'side', sessionId: null, depth: 0,
      intent: 'agent', backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, backendId: 'codex', instructions: 'Work',
      permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'bounded', ioMode: 'request_response',
      status: 'failed', startedAtMs: 1, finishedAtMs: 20, error,
    }, 'terminal-limit');
    expect((await registry.readRetainedExecutionRunRecord('run-limit'))?.state.error).toEqual(error);
    expect(await registry.readRetainedExecutionRunRecords()).toMatchObject([{ terminalEventId: 'terminal-limit', state: { error } }]);
  });

  it('notifies Follow from the retained terminal original and from recovered host loss', async () => {
    const registry = await import('./executionRunRegistry');
    const { SessionFollowOccurrenceNotificationSchema } = await import('./sessions/sessionActivityChangedContract');
    const transport = await import('./controlHttp');
    const post = vi.spyOn(transport, 'daemonPost').mockResolvedValue({ ok: true });
    const state = { runId: 'follow-source', callId: 'call', sidechainId: 'side', sessionId: 'c111111111111111111111111', depth: 0,
      intent: 'review', backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, backendId: 'codex', instructions: 'Review',
      permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'bounded', ioMode: 'request_response',
      status: 'succeeded', startedAtMs: 1, finishedAtMs: 2, terminalOccurrenceId: 'terminal-source',
    } as const;
    try {
      await registry.retainExecutionRunState(state);
      const terminal = post.mock.calls.find(([path]) => path === '/session-activity-changed')?.[1];
      expect(terminal).toMatchObject({ sessionId: state.sessionId, followOccurrence: {
        original: { source: { kind: 'execution_run', sessionId: state.sessionId, runId: state.runId }, terminalEventId: 'terminal-source' },
        event: { kind: 'finished' },
      } });
      if (!terminal || typeof terminal !== 'object' || !('followOccurrence' in terminal)) throw new Error('Missing original notification');
      expect(SessionFollowOccurrenceNotificationSchema.safeParse(terminal.followOccurrence).success).toBe(true);
      post.mockClear();
      await registry.retainExecutionRunState({ ...state, runId: 'lost-follow-source', status: 'running',
        terminalOccurrenceId: undefined, finishedAtMs: undefined });
      await registry.reconcileRetainedExecutionRunRecords({ nowMs: 3, isPidAlive: () => false });
      const recovered = await registry.readRetainedExecutionRunRecord('lost-follow-source');
      expect(post.mock.calls).toContainEqual(['/session-activity-changed', {
        sessionId: state.sessionId, followOccurrence: {
          original: { source: { kind: 'execution_run', sessionId: state.sessionId, runId: 'lost-follow-source' },
            terminalEventId: recovered?.state.terminalOccurrenceId }, event: { kind: 'failed_or_stopped' },
        },
      }]);
    } finally { post.mockRestore(); }
  });

  it('projects running and settled execution markers while retaining material delivery custody', async () => {
    const { createExecutionRunLiveWorkProducer, writeExecutionRunMarker, removeExecutionRunMarker } = await import('./executionRunRegistry');
    mkdirSync(join(happyHomeDir, 'tmp', 'daemon-execution-runs'), { recursive: true });
    const producer = createExecutionRunLiveWorkProducer();
    const unsubscribe = producer.subscribe(() => {});
    try {
      const marker = { pid: 123, runId: 'live-run', happySessionId: 'session', callId: 'call', sidechainId: 'side', intent: 'review',
        backendTarget: { kind: 'backend' as const, backendId: 'codex' }, status: 'running', startedAtMs: 1, updatedAtMs: 1 } satisfies Parameters<typeof writeExecutionRunMarker>[0];
      await writeExecutionRunMarker(marker);
      expect(await producer.read()).toEqual({ coverage: 'complete', items: [
        { category: 'execution_run', ownerRef: 'live-run', attribution: { kind: 'unknown' }, state: 'active' },
      ] });
      await writeExecutionRunMarker({ ...marker, status: 'succeeded', finishedAtMs: 2, updatedAtMs: 2 });
      expect(await producer.read()).toMatchObject({ coverage: 'complete', items: [{ ownerRef: 'live-run', state: 'settled' }] });
      const { retainExecutionRunWorkerUpdate, acknowledgeExecutionRunWorkerUpdate } = await import('./executionRunRegistry');
      const pending: import('./executionRunRegistry').RetainedExecutionRunWorkerUpdate = {
        sessionId: 'session', localId: 'completion', update: {
          v: 1, workerKind: 'execution_run', workerId: marker.runId, ownerState: 'succeeded', wake: 'finished',
          headline: 'Run completed', result: 'Result', canInspect: true,
        },
      };
      await retainExecutionRunWorkerUpdate(pending);
      expect(await producer.read()).toMatchObject({ items: [{ ownerRef: 'live-run', state: 'active' }] });
      expect(await acknowledgeExecutionRunWorkerUpdate(pending)).toBe(true);
      expect(await producer.read()).toMatchObject({ items: [{ ownerRef: 'live-run', state: 'settled' }] });
      await removeExecutionRunMarker('live-run');
      expect(await producer.read()).toEqual({ coverage: 'complete', items: [] });
    } finally { unsubscribe(); }
  });

  it('retains admitted marker attribution for the sole inventory but strips it from public Run listings', async () => {
    const { createExecutionRunLiveWorkProducer, writeExecutionRunMarker, listExecutionRunMarkers,
      listExecutionRunMarkersForRehydration, removeExecutionRunMarker } = await import('./executionRunRegistry');
    const target = { serverId: 'home', machineId: 'machine', installationId: 'installation' };
    const requesterWorkAttributionV1 = { ...target, accountId: 'bob' };
    mkdirSync(join(happyHomeDir, 'tmp', 'daemon-execution-runs'), { recursive: true });
    const marker = { pid: 123, runId: 'attributed-run', happySessionId: null, callId: 'call', sidechainId: 'side',
      intent: 'review' as const, backendTarget: { kind: 'backend' as const, backendId: 'codex' },
      status: 'running' as const, startedAtMs: 1, updatedAtMs: 1, requesterWorkAttributionV1 };
    const inventory = createManagedActivityInventory({ producers: [createExecutionRunLiveWorkProducer()] });
    try {
      await writeExecutionRunMarker(marker);
      expect(await listExecutionRunMarkersForRehydration()).toEqual([expect.objectContaining({ requesterWorkAttributionV1 })]);
      const observed = await inventory.read();
      expect(observed).toEqual({ coverage: 'complete', items: [
        { category: 'execution_run', ownerRef: marker.runId, attribution: requesterWorkAttributionV1, state: 'active' },
      ] });
      expect(await inventory.readDecision()).toEqual({ kind: 'busy', reasons: ['execution_run'] });
      const project = async () => projectMachineWorkSummary({ inventory: await inventory.read(), target,
        custodianAccountId: 'alice', requesterIdentities: new Map([['bob', { accountId: 'bob', displayName: 'Bob' }]]) });
      expect(await project()).toEqual({ kind: 'current', requesters: [
        { accountId: 'bob', displayName: 'Bob', sessions: 0, tasks: 1, terminals: 0 },
      ] });
      expect((await listExecutionRunMarkers())[0]).not.toHaveProperty('requesterWorkAttributionV1');
      await writeExecutionRunMarker({ ...marker, status: 'succeeded', updatedAtMs: 2, finishedAtMs: 2 });
      // A native watcher edge during an inventory read is deliberately unknown;
      // observe the owner's next coherent settled read rather than bypassing it.
      await vi.waitFor(async () => expect(await project()).toEqual({ kind: 'current', requesters: [] }));
      await removeExecutionRunMarker(marker.runId);
    } finally { inventory.dispose(); }
  });

  it('preserves admitted attribution through private retained Run state and pending delivery after its marker is absent', async () => {
    const { createExecutionRunLiveWorkProducer, retainExecutionRunState, retainExecutionRunWorkerUpdate,
      acknowledgeExecutionRunWorkerUpdate, readRetainedExecutionRunRecords } = await import('./executionRunRegistry');
    const target = { serverId: 'home', machineId: 'machine', installationId: 'installation' };
    const attribution = { ...target, accountId: 'bob' };
    mkdirSync(join(happyHomeDir, 'tmp', 'daemon-execution-runs'), { recursive: true });
    const state = { runId: 'private-retained-run', callId: 'call', sidechainId: 'side', sessionId: null, depth: 0, intent: 'review',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, backendId: 'codex', instructions: 'Private instructions',
      permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'bounded', ioMode: 'request_response',
      status: 'running', startedAtMs: 1,
    } satisfies import('@/agent/runtime/bridges/executionRun/executionRunTypes').ExecutionRunState;
    const retain: (run: Parameters<typeof retainExecutionRunState>[0], terminalEventId?: string,
      requesterWorkAttributionV1?: RequesterWorkAttributionV1) => Promise<void> = retainExecutionRunState;
    const inventory = createManagedActivityInventory({ producers: [createExecutionRunLiveWorkProducer()] });
    const project = async () => projectMachineWorkSummary({ inventory: await inventory.read(), target,
      custodianAccountId: 'alice', requesterIdentities: new Map([['bob', { accountId: 'bob', displayName: 'Bob' }]]) });
    try {
      await retain(state, undefined, attribution);
      expect(await readRetainedExecutionRunRecords()).toEqual([expect.objectContaining({ requesterWorkAttributionV1: attribution })]);
      expect((await inventory.read()).items).toEqual([
        { category: 'execution_run', ownerRef: state.runId, attribution, state: 'active' },
      ]);
      expect(await project()).toEqual({ kind: 'current', requesters: [
        { accountId: 'bob', displayName: 'Bob', sessions: 0, tasks: 1, terminals: 0 },
      ] });
      await retain({ ...state, status: 'succeeded', finishedAtMs: 2 });
      expect(await project()).toEqual({ kind: 'current', requesters: [] });
      const delivery = { sessionId: 'origin-session', localId: 'completion', requesterWorkAttributionV1: attribution,
        update: { v: 1 as const, workerKind: 'execution_run' as const, workerId: state.runId,
          ownerState: 'succeeded' as const, wake: 'finished' as const,
          headline: 'Private headline', result: 'Private result', canInspect: true } };
      await retainExecutionRunWorkerUpdate(delivery);
      expect((await inventory.read()).items).toEqual([
        { category: 'execution_run', ownerRef: state.runId, attribution, state: 'active' },
      ]);
      expect(await project()).toEqual({ kind: 'current', requesters: [
        { accountId: 'bob', displayName: 'Bob', sessions: 0, tasks: 1, terminals: 0 },
      ] });
      expect(JSON.stringify(await project())).not.toMatch(/Private|origin-session|private-retained-run|completion/);
      expect(await acknowledgeExecutionRunWorkerUpdate(delivery)).toBe(true);
      expect(await project()).toEqual({ kind: 'current', requesters: [] });
    } finally { inventory.dispose(); }
  });

  it.each(['legacy', 'conflicting'] as const)('does not hide %s active custody behind an attributed duplicate Run', async (duplicate) => {
    const { createExecutionRunLiveWorkProducer, retainExecutionRunState, writeExecutionRunMarker } = await import('./executionRunRegistry');
    const target = { serverId: 'home', machineId: 'machine', installationId: 'installation' };
    const attribution = { ...target, accountId: 'bob' };
    const state = { runId: 'duplicated-run', callId: 'call', sidechainId: 'side', sessionId: null, depth: 0, intent: 'review',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, backendId: 'codex', instructions: '',
      permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'bounded', ioMode: 'request_response',
      status: 'running', startedAtMs: 1,
    } satisfies import('@/agent/runtime/bridges/executionRun/executionRunTypes').ExecutionRunState;
    mkdirSync(join(happyHomeDir, 'tmp', 'daemon-execution-runs'), { recursive: true });
    const inventory = createManagedActivityInventory({ producers: [createExecutionRunLiveWorkProducer()] });
    try {
      await retainExecutionRunState(state, undefined, attribution);
      await writeExecutionRunMarker({ pid: process.pid, runId: state.runId, callId: state.callId, sidechainId: state.sidechainId,
        happySessionId: null, intent: 'review', backendTarget: { kind: 'backend', backendId: 'codex' },
        status: 'running', startedAtMs: 1, updatedAtMs: 1,
        ...(duplicate === 'conflicting' ? { requesterWorkAttributionV1: { ...attribution, accountId: 'alice' } } : {}),
      });
      const observed = await inventory.read();
      expect(observed).toEqual({ coverage: 'complete', items: [
        { category: 'execution_run', ownerRef: state.runId, attribution: { kind: 'unknown' }, state: 'active' },
      ] });
      expect(projectMachineWorkSummary({ inventory: observed, target, custodianAccountId: 'alice',
        requesterIdentities: new Map([['bob', { accountId: 'bob', displayName: 'Bob' }]]) }))
        .toEqual({ kind: 'unavailable' });
      expect(await inventory.readDecision()).toEqual({ kind: 'busy', reasons: ['execution_run'] });
    } finally { inventory.dispose(); }
  });

  it('observes external marker writes and fails coverage closed after native watcher failure or corrupt markers', async () => {
    const { createExecutionRunLiveWorkProducer } = await import('./executionRunRegistry');
    const directory = join(happyHomeDir, 'tmp', 'daemon-execution-runs');
    mkdirSync(directory, { recursive: true });
    const producer = createExecutionRunLiveWorkProducer();
    let changed!: () => void;
    const externalChange = new Promise<void>(resolve => { changed = resolve; });
    const unsubscribe = producer.subscribe(changed);
    try {
      expect(await producer.read()).toEqual({ coverage: 'complete', items: [] });
      const marker = { pid: 123, happySessionId: 'session', runId: 'external-run', callId: 'call', sidechainId: 'side', intent: 'review',
        backendTarget: { kind: 'backend', backendId: 'codex' }, status: 'running', startedAtMs: 1, updatedAtMs: 1 };
      writeFileSync(join(directory, 'run-external-run.json'), JSON.stringify(marker));
      await externalChange;
      expect(await producer.read()).toMatchObject({ coverage: 'complete', items: [{ ownerRef: marker.runId, state: 'active' }] });
      writeFileSync(join(directory, 'run-corrupt.json'), '{invalid');
      expect(await producer.read()).toMatchObject({ coverage: 'unknown', items: [{ ownerRef: marker.runId, state: 'active' }] });
      unlinkSync(join(directory, 'run-corrupt.json'));
      expect(await producer.read()).toMatchObject({ coverage: 'complete' });
      filesystemBoundary.watchers.values().next().value!.emit('error', new Error('Native watcher unavailable'));
      expect(await producer.read()).toMatchObject({ coverage: 'unknown' });
    } finally { unsubscribe(); }
    expect(await producer.read()).toMatchObject({ coverage: 'unknown' });
  });

  it('cannot prove an absent watch idle and still exposes retained running work without a visibility marker', async () => {
    const { createExecutionRunLiveWorkProducer, retainExecutionRunState } = await import('./executionRunRegistry');
    const producer = createExecutionRunLiveWorkProducer();
    let armed!: () => void;
    const watchEstablished = new Promise<void>(resolve => { armed = resolve; });
    const unsubscribe = producer.subscribe(armed);
    try {
      expect(await producer.read()).toEqual({ coverage: 'unknown', items: [] });
      await watchEstablished;
      // The incumbent marker read has now established its directory. A new
      // observation arms the native edge source before scanning canonical state.
      expect(await producer.read()).toEqual({ coverage: 'complete', items: [] });
      const state = { runId: 'retained-only', callId: 'call', sidechainId: 'side', sessionId: null, depth: 0, intent: 'review',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, backendId: 'codex', instructions: 'Private input', permissionMode: 'read_only',
        retentionPolicy: 'resumable', runClass: 'bounded', ioMode: 'request_response', status: 'running', startedAtMs: 1,
      } satisfies import('@/agent/runtime/bridges/executionRun/executionRunTypes').ExecutionRunState;
      await retainExecutionRunState(state);
      expect(await producer.read()).toEqual({ coverage: 'complete', items: [
        { category: 'execution_run', ownerRef: state.runId, attribution: { kind: 'unknown' }, state: 'active' },
      ] });
      await retainExecutionRunState({ ...state, status: 'succeeded', finishedAtMs: 2 });
      expect(await producer.read()).toMatchObject({ items: [{ ownerRef: state.runId, state: 'settled' }] });
    } finally { unsubscribe(); }
  });

  it('does not certify a replaced canonical directory through the watcher still attached to its former inode', async () => {
    const { createExecutionRunLiveWorkProducer } = await import('./executionRunRegistry');
    const directory = join(happyHomeDir, 'tmp', 'daemon-execution-runs');
    mkdirSync(directory, { recursive: true });
    const producer = createExecutionRunLiveWorkProducer();
    const unsubscribe = producer.subscribe(() => {});
    try {
      expect(await producer.read()).toEqual({ coverage: 'complete', items: [] });
      renameSync(directory, `${directory}-moved`);
      mkdirSync(directory);
      expect(await producer.read()).toEqual({ coverage: 'unknown', items: [] });
      expect(await producer.read()).toEqual({ coverage: 'complete', items: [] });
    } finally { unsubscribe(); }
  });

  it('opens additive persisted marker fields but refuses corrupt known facts', async () => {
    const { configuration } = await import('@/configuration');
    const { listExecutionRunMarkers, listExecutionRunMarkersForRehydration } = await import('./executionRunRegistry');
    const directory = join(configuration.happyHomeDir, 'tmp', 'daemon-execution-runs');
    mkdirSync(directory, { recursive: true });
    const file = join(directory, 'run-run_stored.json');
    const marker = { pid: 123, happySessionId: 'session', runId: 'run_stored', callId: 'call', sidechainId: 'side',
      intent: 'review', backendTarget: { kind: 'backend', backendId: 'codex' }, status: 'running',
      startedAtMs: 1, updatedAtMs: 2, future: true,
      executionRunBrokerAuthorityV1: { occurrenceId: 'occurrence', turnState: 'active_turn', future: true } };
    writeFileSync(file, JSON.stringify(marker));
    expect(await listExecutionRunMarkersForRehydration()).toEqual([expect.objectContaining({ runId: 'run_stored',
      executionRunBrokerAuthorityV1: { occurrenceId: 'occurrence', turnState: 'active_turn' } })]);
    const publicMarker = (await listExecutionRunMarkers())[0];
    expect(publicMarker).toHaveProperty('runId', 'run_stored');
    expect(publicMarker).not.toHaveProperty('future');
    expect(publicMarker).not.toHaveProperty('executionRunBrokerAuthorityV1');
    writeFileSync(file, JSON.stringify({ ...marker, executionRunBrokerAuthorityV1: { ...marker.executionRunBrokerAuthorityV1, turnState: 'invalid' } }));
    expect(await listExecutionRunMarkers()).toEqual([]);
  });

  it('opens additive stored fields and isolates mismatched or corrupt retained records without discarding custody', async () => {
    const { configuration } = await import('@/configuration');
    const { readRetainedExecutionRunRecords, readRetainedExecutionRunHomeKeys, createExecutionRunLiveWorkProducer,
      gcExecutionRunMarkers } = await import('./executionRunRegistry');
    const { readOrCreateDeviceLocalSecretStorage } = await import('./deviceLocalSecretStorage');
    const { RetainedExecutionRunRecordSchema } = await import('@/agent/runtime/bridges/executionRun/retainedState');
    const { writeProtectedLocalStateFileAtomic } = await import('@/utils/fs/protectedLocalState');
    const directory = join(configuration.happyHomeDir, 'tmp', 'daemon-execution-runs');
    const runId = 'run_stored_binding';
    const file = join(directory, `state-${createHash('sha256').update(JSON.stringify([runId])).digest('hex')}.sealed`);
    const storage = await readOrCreateDeviceLocalSecretStorage({ path: configuration.deviceLocalSecretKeyFile });
    const record = {
      ownerPid: 123, future: true,
      state: {
        runId, callId: 'call', sidechainId: 'side', sessionId: null, depth: 0,
        intent: 'review', backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, backendId: 'codex', instructions: 'Review',
        permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'bounded', ioMode: 'request_response',
        status: 'failed', startedAtMs: 1, finishedAtMs: 2,
        launch: { secretReferenceOverlay: { v: 1, future: true, bindings: {
          API_KEY: { ref: 'happier:shared-secret:v1:resource', revision: 7, future: { value: true } },
        } } },
      },
    };
    await writeProtectedLocalStateFileAtomic(file, storage.sealJson({ purpose: 'execution_run_state', value: record }));
    const [opened] = await readRetainedExecutionRunRecords();
    expect(opened.state.launch?.secretReferenceOverlay).toEqual({ v: 1, bindings: {
      API_KEY: { ref: 'happier:shared-secret:v1:resource', revision: 7 },
    } });
    expect(opened).not.toHaveProperty('future');
    expect(RetainedExecutionRunRecordSchema.safeParse(record).success).toBe(false);
    const oldFile = join(directory, `state-${Buffer.from('another-run').toString('base64url')}.sealed`);
    const oldBytes = storage.sealJson({ purpose: 'execution_run_state', value: record });
    await writeProtectedLocalStateFileAtomic(oldFile, oldBytes);
    const diagnostic = vi.spyOn(logger, 'warn');
    try {
      await expect(readRetainedExecutionRunRecords()).resolves.toEqual([opened]);
      expect(diagnostic).toHaveBeenCalledWith(expect.any(String), {
        code: 'execution_run_state_unavailable', entry: `state-${Buffer.from('another-run').toString('base64url')}.sealed`,
        reason: 'identity_mismatch',
      });
    } finally { diagnostic.mockRestore(); }
    await expect(readRetainedExecutionRunHomeKeys()).rejects.toMatchObject({ code: 'execution_run_home_retention_unavailable' });
    const producer = createExecutionRunLiveWorkProducer();
    const unsubscribe = producer.subscribe(() => {});
    try { expect((await producer.read()).coverage).toBe('unknown'); } finally { unsubscribe(); }
    expect(readFileSync(oldFile, 'utf8')).toBe(oldBytes);
    record.state.launch.secretReferenceOverlay.bindings.API_KEY.revision = 0;
    await writeProtectedLocalStateFileAtomic(file, storage.sealJson({ purpose: 'execution_run_state', value: record }));
    await expect(readRetainedExecutionRunRecords()).resolves.toEqual([]);
    await expect(gcExecutionRunMarkers({ nowMs: 100, terminalTtlMs: 1,
      isPidAlive: () => false, isPidSafeHappyProcess: () => false })).resolves.toEqual({ removedRunIds: [] });
    expect(readFileSync(oldFile, 'utf8')).toBe(oldBytes);
    expect(existsSync(file)).toBe(true);
  });

  it('reports an unchanged unavailable retained entry once while keeping inventory fail-closed and recovering repaired state', async () => {
    const registry = await import('./executionRunRegistry');
    const { configuration } = await import('@/configuration');
    const { readdir } = await import('node:fs/promises');
    const state = { runId: 'unavailable-entry', callId: 'call', sidechainId: 'side', sessionId: null, depth: 0,
      intent: 'review', backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, backendId: 'codex', instructions: '',
      permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'bounded', ioMode: 'request_response',
      status: 'running', startedAtMs: 1,
    } satisfies import('@/agent/runtime/bridges/executionRun/executionRunTypes').ExecutionRunState;
    await registry.retainExecutionRunState(state);
    const directory = join(configuration.happyHomeDir, 'tmp', 'daemon-execution-runs');
    const entry = (await readdir(directory)).find(name => name.startsWith('state-'))!;
    const path = join(directory, entry);
    const goodBytes = readFileSync(path, 'utf8');
    writeFileSync(path, 'unreadable retained state');
    const diagnostic = vi.spyOn(logger, 'warn');
    filesystemBoundary.openSpy.mockClear();
    const inventory = createManagedActivityInventory({ producers: [registry.createExecutionRunLiveWorkProducer()] });
    try {
      for (let read = 0; read < 3; read += 1) {
        expect(await inventory.readDecision()).toEqual({ kind: 'unknown', reasons: ['coverage_unknown'] });
        await expect(registry.readRetainedExecutionRunHomeKeys()).rejects.toMatchObject({ code: 'execution_run_home_retention_unavailable' });
      }
      const unavailableReports = diagnostic.mock.calls.filter(([, detail]) =>
        typeof detail === 'object' && detail !== null && 'code' in detail && detail.code === 'execution_run_state_unavailable');
      expect(unavailableReports).toHaveLength(1);
      expect(filesystemBoundary.openSpy.mock.calls.filter(([openedPath]) => openedPath === path)).toHaveLength(1);
      expect(readFileSync(path, 'utf8')).toBe('unreadable retained state');
      unlinkSync(path);
      expect(await registry.readRetainedExecutionRunRecords()).toEqual([]);
      writeFileSync(path, 'unreadable retained state', { mode: 0o600 });
      const unavailable = vi.fn();
      expect(await registry.readRetainedExecutionRunRecords(unavailable)).toEqual([]);
      expect(unavailable).toHaveBeenCalled();
      expect(diagnostic.mock.calls.filter(([, detail]) => typeof detail === 'object' && detail !== null
        && 'code' in detail && detail.code === 'execution_run_state_unavailable')).toHaveLength(2);
      const active = new Promise<void>(resolve => {
        inventory.subscribe(decision => { if (decision.kind === 'busy') resolve(); });
      });
      writeFileSync(path, goodBytes);
      await active;
      expect(await inventory.readDecision()).toEqual({ kind: 'busy', reasons: ['execution_run'] });
      expect(await registry.readRetainedExecutionRunHomeKeys()).toEqual([state.runId]);
    } finally { inventory.dispose(); diagnostic.mockRestore(); }
  });

  it('recovers the prior retained basename into the current owner without reviving a terminal event after acceptance', async () => {
    const registry = await import('./executionRunRegistry');
    const { configuration } = await import('@/configuration');
    const state = { runId: 'prior-retained-entry', callId: 'call', sidechainId: 'side', sessionId: 'parent-session', depth: 0,
      intent: 'review', backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, backendId: 'codex', instructions: '',
      permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'bounded', ioMode: 'request_response',
      status: 'failed', startedAtMs: 1, finishedAtMs: 2, notifyParentOnCompletion: true,
    } satisfies import('@/agent/runtime/bridges/executionRun/executionRunTypes').ExecutionRunState;
    await registry.retainExecutionRunState(state, 'prior-terminal');
    const directory = join(configuration.happyHomeDir, 'tmp', 'daemon-execution-runs');
    const currentPath = join(directory, `state-${createHash('sha256').update(JSON.stringify([state.runId])).digest('hex')}.sealed`);
    const priorPath = join(directory, `state-${Buffer.from(state.runId).toString('base64url')}.sealed`);
    renameSync(currentPath, priorPath);
    const priorBytes = readFileSync(priorPath, 'utf8');
    expect(await registry.readRetainedExecutionRunRecord(state.runId))
      .toMatchObject({ terminalEventId: 'prior-terminal', state: { runId: state.runId } });
    const [recovered] = await registry.readRetainedExecutionRunRecords();
    expect(recovered).toMatchObject({ terminalEventId: 'prior-terminal', state: { runId: state.runId } });
    expect(await registry.readRetainedExecutionRunRecord(state.runId)).toEqual(recovered);
    expect(existsSync(priorPath)).toBe(false);
    await registry.reconcileRetainedExecutionRunRecords({ nowMs: 3 });
    const [pending] = await registry.readPendingExecutionRunWorkerUpdates();
    expect(pending.localId).toBe('execution-run-worker-update:prior-terminal');
    expect(await registry.acknowledgeExecutionRunWorkerUpdate(pending)).toBe(true);
    // A stale former copy cannot override the current acceptance checkpoint.
    writeFileSync(priorPath, priorBytes, { mode: 0o600 });
    await registry.reconcileRetainedExecutionRunRecords({ nowMs: 4 });
    expect(await registry.readPendingExecutionRunWorkerUpdates()).toEqual([]);
    expect(await registry.readRetainedExecutionRunRecords()).toEqual([expect.not.objectContaining({ terminalEventId: expect.anything() })]);
  });

  it('recovers prior worker-update custody into the current basename and accepts it exactly once', async () => {
    const registry = await import('./executionRunRegistry');
    const { configuration } = await import('@/configuration');
    const pending: import('./executionRunRegistry').RetainedExecutionRunWorkerUpdate = {
      sessionId: 'parent', localId: 'execution-run-worker-update:prior-worker-terminal', update: {
        v: 1, workerKind: 'execution_run', workerId: 'prior-worker-run', ownerState: 'failed',
        wake: 'finished', headline: 'Failed run', result: 'Retained output', canInspect: true,
      },
    };
    await registry.retainExecutionRunWorkerUpdate(pending);
    const directory = join(configuration.happyHomeDir, 'tmp', 'daemon-execution-runs');
    const identity = JSON.stringify([pending.update.workerId, pending.localId]);
    const currentPath = join(directory, `worker-update-${createHash('sha256').update(identity).digest('hex')}.sealed`);
    const priorPath = join(directory, `worker-update-${Buffer.from(identity).toString('base64url')}.sealed`);
    renameSync(currentPath, priorPath);
    expect(await registry.readPendingExecutionRunWorkerUpdates()).toEqual([pending]);
    expect(existsSync(currentPath)).toBe(true);
    expect(existsSync(priorPath)).toBe(false);
    expect(await registry.acknowledgeExecutionRunWorkerUpdate(pending)).toBe(true);
    expect(await registry.acknowledgeExecutionRunWorkerUpdate(pending)).toBe(true);
    expect(await registry.readPendingExecutionRunWorkerUpdates()).toEqual([]);
  });

  it('does not republish accepted worker custody from an older overlapping basename scan', async () => {
    const registry = await import('./executionRunRegistry');
    const { configuration } = await import('@/configuration');
    const pending: import('./executionRunRegistry').RetainedExecutionRunWorkerUpdate = {
      sessionId: 'parent', localId: 'execution-run-worker-update:overlap-terminal', update: {
        v: 1, workerKind: 'execution_run', workerId: 'overlap-worker-run', ownerState: 'failed',
        wake: 'finished', headline: 'Failed run', result: 'Retained output', canInspect: true,
      },
    };
    await registry.retainExecutionRunWorkerUpdate(pending);
    const directory = join(configuration.happyHomeDir, 'tmp', 'daemon-execution-runs');
    const identity = JSON.stringify([pending.update.workerId, pending.localId]);
    const currentPath = join(directory, `worker-update-${createHash('sha256').update(identity).digest('hex')}.sealed`);
    const priorPath = join(directory, `worker-update-${Buffer.from(identity).toString('base64url')}.sealed`);
    writeFileSync(priorPath, readFileSync(currentPath), { mode: 0o600 });
    let release!: () => void;
    let captured!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const observed = new Promise<void>(resolve => { captured = resolve; });
    filesystemBoundary.afterProtectedRead = async path => {
      if (path !== priorPath) return;
      filesystemBoundary.afterProtectedRead = null;
      captured();
      await hold;
    };
    const older = registry.readPendingExecutionRunWorkerUpdates();
    try {
      await observed;
      await registry.acknowledgeExecutionRunWorkerUpdate(pending);
    } finally { release(); }
    await older;
    expect(await registry.readPendingExecutionRunWorkerUpdates()).toEqual([]);
    expect(existsSync(currentPath)).toBe(false);
    expect(existsSync(priorPath)).toBe(false);
  });

  it('strips raw output summaries and diagnostics before marker persistence', async () => {
    const { configuration } = await import('@/configuration');
    const { listExecutionRunMarkers, writeExecutionRunMarker } = await import('./executionRunRegistry');
    const marker = DaemonExecutionRunMarkerSchema.parse({
      pid: 123,
      happySessionId: null,
      runId: 'run_bounded_marker',
      callId: 'call_bounded_marker',
      sidechainId: 'side_bounded_marker',
      intent: 'memory_hints' as const,
      backendTarget: { kind: 'builtInAgent' as const, agentId: 'codex' as const },
      permissionMode: 'full_access',
      runClass: 'bounded' as const,
      ioMode: 'request_response' as const,
      retentionPolicy: 'ephemeral' as const,
      status: 'failed' as const,
      startedAtMs: 1,
      updatedAtMs: 2,
      finishedAtMs: 2,
      errorCode: 'execution_run_output_limit_exceeded',
      resultSizeBytes: 1024,
      summary: 'raw task output must not persist',
      diagnostics: { rawOutput: 'must-not-persist' },
    });

    await writeExecutionRunMarker(marker);

    const filePath = join(configuration.happyHomeDir, 'tmp', 'daemon-execution-runs', markerEntry('run_bounded_marker'));
    const persisted = JSON.parse(readFileSync(filePath, 'utf-8'));
    expect(persisted).toMatchObject({
      permissionMode: 'full_access',
      runClass: 'bounded',
      ioMode: 'request_response',
      retentionPolicy: 'ephemeral',
      status: 'failed',
      errorCode: 'execution_run_output_limit_exceeded',
      resultSizeBytes: 1024,
    });
    expect(persisted).not.toHaveProperty('summary');
    expect(persisted).not.toHaveProperty('diagnostics');
    expect(persisted).not.toHaveProperty('happyHomeDir');
    expect(persisted).not.toHaveProperty('resumeHandle');

    const outward = await listExecutionRunMarkers();
    expect(outward[0]).toMatchObject({
      runId: 'run_bounded_marker',
      resultSizeBytes: 1024,
    });
    expect(outward[0]).not.toHaveProperty('summary');
    expect(outward[0]).not.toHaveProperty('diagnostics');
  });

  it('keeps predecessor launch evidence owner-local and omits it from outward marker lists', async () => {
    const { configuration } = await import('@/configuration');
    const {
      listExecutionRunMarkers,
      listExecutionRunMarkersForRehydration,
    } = await import('./executionRunRegistry');
    const runId = 'run_22222222-2222-4222-8222-222222222222';
    const markerDir = join(configuration.happyHomeDir, 'tmp', 'daemon-execution-runs');
    mkdirSync(markerDir, { recursive: true });
    writeFileSync(join(markerDir, `run-${runId}.json`), JSON.stringify({
      happyHomeDir: configuration.happyHomeDir,
      pid: 123,
      happySessionId: 'session-1',
      runId,
      callId: 'call-1',
      sidechainId: 'side-1',
      intent: 'review',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      runClass: 'bounded',
      ioMode: 'request_response',
      retentionPolicy: 'resumable',
      status: 'running',
      startedAtMs: 1,
      updatedAtMs: 1,
      executionRunConnectedServicesLaunchV1: {
        v: 1,
        runKey: 'execution_run:11111111-1111-4111-8111-111111111111',
        agentId: 'codex',
        connectedServicesBindings: {
          v: 1,
          bindingsByServiceId: {
            'openai-codex': {
              source: 'connected',
              selection: 'profile',
              profileId: 'team',
            },
          },
        },
        brokerSelectionIdentity: 'sk-must-not-leave-owner',
        runtimeAccountIdentitySelections: [{
          serviceId: 'openai-codex',
          profileId: 'team',
          groupId: null,
          groupGeneration: null,
          providerAccountId: 'ghp_must_not_leave_owner',
          accountLabel: 'Bearer must-not-leave-owner',
          source: 'spawn_selection',
        }],
        connectedServiceSelectionsJson: JSON.stringify([{
          kind: 'profile',
          serviceId: 'openai-codex',
          profileId: 'team',
        }]),
        sessionDirectory: '/workspace',
        materializedRoot: null,
      },
    }));

    const ownerLocal = await listExecutionRunMarkersForRehydration();
    expect(ownerLocal[0]?.executionRunConnectedServicesLaunchV1).toMatchObject({
      brokerSelectionIdentity: 'sk-must-not-leave-owner',
      runtimeAccountIdentitySelections: [{
        providerAccountId: 'ghp_must_not_leave_owner',
        accountLabel: 'Bearer must-not-leave-owner',
      }],
    });

    const outward = await listExecutionRunMarkers();
    expect(outward).toHaveLength(1);
    expect(outward[0]).not.toHaveProperty('executionRunConnectedServicesLaunchV1');
    expect(JSON.stringify(outward)).not.toContain('must-not-leave-owner');
  });

  it('persists terminal cleanup custody owner-locally and omits it from outward marker lists', async () => {
    const {
      listExecutionRunMarkers,
      listExecutionRunMarkersForRehydration,
      writeExecutionRunMarker,
      clearExecutionRunConnectedServicesCleanupReceipt,
    } = await import('./executionRunRegistry');
    const runId = 'run_terminal_cleanup_receipt';
    const receipt = {
      v: 1 as const,
      activationId: '55555555-5555-4555-8555-555555555555',
      runKey: runId,
      agentId: 'codex',
    };

    await writeExecutionRunMarker({
      pid: 123,
      happySessionId: 'session-1',
      runId,
      callId: 'call-1',
      sidechainId: 'side-1',
      intent: 'review',
      backendTarget: { kind: 'backend', backendId: 'codex' },
      runClass: 'bounded',
      ioMode: 'request_response',
      retentionPolicy: 'resumable',
      status: 'succeeded',
      startedAtMs: 1,
      updatedAtMs: 2,
      finishedAtMs: 2,
      executionRunConnectedServicesCleanupReceiptV1: receipt,
    });

    expect((await listExecutionRunMarkersForRehydration())[0])
      .toHaveProperty('executionRunConnectedServicesCleanupReceiptV1', receipt);
    expect((await listExecutionRunMarkers())[0])
      .not.toHaveProperty('executionRunConnectedServicesCleanupReceiptV1');
    await clearExecutionRunConnectedServicesCleanupReceipt(runId);
    expect((await listExecutionRunMarkersForRehydration())[0])
      .not.toHaveProperty('executionRunConnectedServicesCleanupReceiptV1');
  });

  it('writes markers into a channel-scoped tmp dir for the dev public ring', async () => {
    process.env.HAPPIER_RELEASE_RING = 'dev';
    reloadConfiguration();

    const { configuration } = await import('@/configuration');
    const { writeExecutionRunMarker } = await import('./executionRunRegistry');

    await writeExecutionRunMarker({
      pid: 123,
      happySessionId: 'sess-1',
      runId: 'run_dev_scoped',
      callId: 'call_1',
      sidechainId: 'call_1',
      intent: 'review',
      backendTarget: { kind: 'backend', backendId: 'claude' },
      status: 'running',
      startedAtMs: 1,
      updatedAtMs: 1,
    });

    const filePath = join(configuration.happyHomeDir, 'tmp', 'daemon-execution-runs.dev', markerEntry('run_dev_scoped'));
    expect(existsSync(filePath)).toBe(true);
  });

  it('does not resurrect accepted completion custody when cleanup publishes a stale marker', async () => {
    let pauseCleanupRead = false;
    let cleanupReadReached!: () => void;
    let releaseCleanupRead!: () => void;
    const reached = new Promise<void>((resolve) => { cleanupReadReached = resolve; });
    const released = new Promise<void>((resolve) => { releaseCleanupRead = resolve; });
    const markerPath = join(happyHomeDir, 'tmp', 'daemon-execution-runs', markerEntry('run_ack_cleanup'));
    // The filesystem is the competing daemon/process boundary; registry logic stays real.
    filesystemBoundary.afterRead = async (path) => {
      if (pauseCleanupRead && path === markerPath) {
        pauseCleanupRead = false;
        cleanupReadReached();
        await released;
      }
    };
    try {
      const registry = await import('./executionRunRegistry');
      const pending: import('./executionRunRegistry').RetainedExecutionRunWorkerUpdate = {
        sessionId: 'session-1', localId: 'completion-1', update: {
          v: 1, workerKind: 'execution_run', workerId: 'run_ack_cleanup',
          ownerState: 'succeeded', wake: 'finished', headline: 'Run completed', result: 'First result', canInspect: true,
        },
      };
      await registry.retainExecutionRunWorkerUpdate(pending);
      await registry.writeExecutionRunMarker({
        pid: 123, happySessionId: pending.sessionId, runId: pending.update.workerId,
        callId: 'call-1', sidechainId: 'side-1', intent: 'agent',
        backendTarget: { kind: 'backend', backendId: 'codex' },
        status: 'succeeded', startedAtMs: 1, updatedAtMs: 2, finishedAtMs: 2,
        executionRunConnectedServicesCleanupReceiptV1: {
          v: 1, activationId: '55555555-5555-4555-8555-555555555555', runKey: pending.update.workerId, agentId: 'codex',
        },
      });
      pauseCleanupRead = true;
      const cleanup = registry.clearExecutionRunConnectedServicesCleanupReceipt(pending.update.workerId);
      await reached;
      expect(await registry.acknowledgeExecutionRunWorkerUpdate({ ...pending, sessionId: 'different-session' })).toBe(false);
      expect(await registry.readPendingExecutionRunWorkerUpdates()).toEqual([pending]);
      expect(await registry.acknowledgeExecutionRunWorkerUpdate(pending)).toBe(true);
      releaseCleanupRead();
      await cleanup;
      expect(await registry.readPendingExecutionRunWorkerUpdates()).toEqual([]);
      expect(await registry.gcExecutionRunMarkers({
        nowMs: 100, terminalTtlMs: 0, isPidAlive: () => false, isPidSafeHappyProcess: () => false,
      })).toEqual({ removedRunIds: [pending.update.workerId] });
    } finally {
      releaseCleanupRead();
      filesystemBoundary.afterRead = null;
    }
  });

  it('uses a unique temp file per marker write to avoid cross-write corruption', async () => {
    const writeFileSpy = filesystemBoundary.writeFileSpy;

    const { writeExecutionRunMarker } = await import('./executionRunRegistry');

    await writeExecutionRunMarker({
      pid: 123,
      happySessionId: 'sess-1',
      runId: 'run_unique_tmp',
      callId: 'call_1',
      sidechainId: 'call_1',
      intent: 'review',
      backendTarget: { kind: 'backend', backendId: 'claude' },
      status: 'running',
      startedAtMs: 1,
      updatedAtMs: 1,
    });

    await writeExecutionRunMarker({
      pid: 123,
      happySessionId: 'sess-1',
      runId: 'run_unique_tmp',
      callId: 'call_1',
      sidechainId: 'call_1',
      intent: 'review',
      backendTarget: { kind: 'backend', backendId: 'claude' },
      status: 'succeeded',
      startedAtMs: 1,
      updatedAtMs: 2,
      finishedAtMs: 2,
    });

    const tmpPaths = writeFileSpy.mock.calls.map((call) => call[0]).filter((p) => typeof p === 'string') as string[];
    expect(tmpPaths.length).toBeGreaterThanOrEqual(2);
    expect(tmpPaths[tmpPaths.length - 1]).not.toEqual(tmpPaths[tmpPaths.length - 2]);
  });

  it('allows an admitted successful resume marker to replace the prior terminal marker without clock inference', async () => {
    const { configuration } = await import('@/configuration');
    const { writeExecutionRunMarker } = await import('./executionRunRegistry');

    await writeExecutionRunMarker({
      pid: 123,
      happySessionId: 'sess-1',
      runId: 'run_terminal_wins',
      callId: 'call_1',
      sidechainId: 'call_1',
      intent: 'review',
      backendTarget: { kind: 'backend', backendId: 'claude' },
      status: 'succeeded',
      startedAtMs: 1,
      updatedAtMs: 2,
      finishedAtMs: 2,
    });

    await writeExecutionRunMarker({
      pid: 123,
      happySessionId: 'sess-1',
      runId: 'run_terminal_wins',
      callId: 'call_1',
      sidechainId: 'call_1',
      intent: 'review',
      backendTarget: { kind: 'backend', backendId: 'claude' },
      status: 'running',
      startedAtMs: 1,
      updatedAtMs: 2,
    }, { allowTerminalToRunning: true });

    const filePath = join(configuration.happyHomeDir, 'tmp', 'daemon-execution-runs', markerEntry('run_terminal_wins'));
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8'));
    expect(parsed.status).toBe('running');
    expect(parsed.updatedAtMs).toBe(2);
  });

  it('does not allow ordinary late running markers to overwrite a terminal marker even with a newer clock', async () => {
    const { configuration } = await import('@/configuration');
    const { writeExecutionRunMarker } = await import('./executionRunRegistry');

    const base = {
      pid: 123,
      happySessionId: 'sess-1',
      runId: 'run_terminal_stays_current',
      callId: 'call_1',
      sidechainId: 'call_1',
      intent: 'review' as const,
      backendTarget: { kind: 'backend' as const, backendId: 'claude' },
      startedAtMs: 1,
    };
    await writeExecutionRunMarker({
      ...base,
      status: 'succeeded',
      updatedAtMs: 3,
      finishedAtMs: 3,
    });
    await writeExecutionRunMarker({ ...base, status: 'running', updatedAtMs: 2 });
    await writeExecutionRunMarker({ ...base, status: 'running', updatedAtMs: 4 });

    const filePath = join(configuration.happyHomeDir, 'tmp', 'daemon-execution-runs', markerEntry('run_terminal_stays_current'));
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8'));
    expect(parsed.status).toBe('succeeded');
    expect(parsed.updatedAtMs).toBe(3);
  });

  it('removeExecutionRunMarker should not throw if the marker does not exist', async () => {
    const { removeExecutionRunMarker } = await import('./executionRunRegistry');
    await expect(removeExecutionRunMarker('run_missing')).resolves.toBeUndefined();
  });

  it('ignores markers with wrong happyHomeDir and tolerates invalid JSON', async () => {
    const { configuration } = await import('@/configuration');
    const { listExecutionRunMarkers } = await import('./executionRunRegistry');

    const dir = join(configuration.happyHomeDir, 'tmp', 'daemon-execution-runs');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'run-wrong.json'),
      JSON.stringify({ happyHomeDir: '/other', runId: 'x', pid: 1 }, null, 2),
      'utf-8',
    );
    writeFileSync(join(dir, 'run-bad.json'), '{', 'utf-8');

    const markers = await listExecutionRunMarkers();
    expect(markers).toEqual([]);
  });

  it('recovers a valid orphan temp marker when the final marker file is missing', async () => {
    const { configuration } = await import('@/configuration');
    const { listExecutionRunMarkers } = await import('./executionRunRegistry');

    const dir = join(configuration.happyHomeDir, 'tmp', 'daemon-execution-runs');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'run-run_tmp_only.json.tmp-123'),
      JSON.stringify({
        happyHomeDir: configuration.happyHomeDir,
        pid: 123,
        happySessionId: 'sess-1',
        runId: 'run_tmp_only',
        callId: 'call_1',
        sidechainId: 'side_1',
        intent: 'delegate',
        backendTarget: { kind: 'builtInAgent', agentId: 'opencode' },
        permissionMode: 'workspace_write',
        runClass: 'long_lived',
        ioMode: 'request_response',
        retentionPolicy: 'resumable',
        status: 'running',
        startedAtMs: 1,
        updatedAtMs: 2,
      }),
      'utf-8',
    );

    const markers = await listExecutionRunMarkers();
    expect(markers.map((marker) => marker.runId)).toEqual(['run_tmp_only']);
  });

  it('removeExecutionRunMarker also removes orphan temp marker files for the run', async () => {
    const { configuration } = await import('@/configuration');
    const { removeExecutionRunMarker } = await import('./executionRunRegistry');

    const dir = join(configuration.happyHomeDir, 'tmp', 'daemon-execution-runs');
    mkdirSync(dir, { recursive: true });
    const tempPath = join(dir, `${markerEntry('run_tmp_cleanup')}.tmp-123`);
    writeFileSync(
      tempPath,
      JSON.stringify({
        happyHomeDir: configuration.happyHomeDir,
        pid: 123,
        happySessionId: 'sess-1',
        runId: 'run_tmp_cleanup',
        callId: 'call_1',
        sidechainId: 'side_1',
        intent: 'delegate',
        backendTarget: { kind: 'builtInAgent', agentId: 'opencode' },
        permissionMode: 'workspace_write',
        runClass: 'long_lived',
        ioMode: 'request_response',
        retentionPolicy: 'resumable',
        status: 'running',
        startedAtMs: 1,
        updatedAtMs: 2,
      }),
      'utf-8',
    );

    const predecessorPath = join(dir, 'run-run_tmp_cleanup.json.tmp-predecessor');
    writeFileSync(predecessorPath, readFileSync(tempPath));
    const incompletePath = join(dir, `${markerEntry('run_tmp_cleanup')}.tmp-incomplete`);
    writeFileSync(incompletePath, '{');
    await removeExecutionRunMarker('run_tmp_cleanup');
    expect(existsSync(tempPath)).toBe(false);
    expect(existsSync(predecessorPath)).toBe(false);
    expect(existsSync(incompletePath)).toBe(false);
  });

  it('gcExecutionRunMarkers removes stale terminal markers and markers for dead pids', async () => {
    const {
      clearExecutionRunConnectedServicesCleanupReceipt,
      gcExecutionRunMarkers,
      listExecutionRunMarkers,
      writeExecutionRunMarker,
    } = await import('./executionRunRegistry');

    const nowMs = Date.now();
    await writeExecutionRunMarker({
      pid: 111,
      happySessionId: 'sess-1',
      runId: 'run_keep_running',
      callId: 'call_1',
      sidechainId: 'side_1',
      intent: 'review',
      backendTarget: { kind: 'backend', backendId: 'claude' },
      status: 'running',
      startedAtMs: nowMs - 10_000,
      updatedAtMs: nowMs - 5_000,
    });

    await writeExecutionRunMarker({
      pid: 222,
      happySessionId: 'sess-2',
      runId: 'run_remove_terminal',
      callId: 'call_2',
      sidechainId: 'side_2',
      intent: 'review',
      backendTarget: { kind: 'backend', backendId: 'claude' },
      status: 'succeeded',
      startedAtMs: nowMs - 50_000,
      updatedAtMs: nowMs - 40_000,
      finishedAtMs: nowMs - 30_000,
    });

    await writeExecutionRunMarker({
      pid: 333,
      happySessionId: 'sess-3',
      runId: 'run_remove_dead_pid',
      callId: 'call_3',
      sidechainId: 'side_3',
      intent: 'review',
      backendTarget: { kind: 'backend', backendId: 'claude' },
      status: 'running',
      startedAtMs: nowMs - 10_000,
      updatedAtMs: nowMs - 9_000,
    });

    await writeExecutionRunMarker({
      pid: 444,
      happySessionId: 'sess-4',
      runId: 'run_keep_cleanup_receipt',
      callId: 'call_4',
      sidechainId: 'side_4',
      intent: 'review',
      backendTarget: { kind: 'backend', backendId: 'codex' },
      status: 'succeeded',
      startedAtMs: nowMs - 50_000,
      updatedAtMs: nowMs - 40_000,
      finishedAtMs: nowMs - 30_000,
      executionRunConnectedServicesCleanupReceiptV1: {
        v: 1,
        activationId: '77777777-7777-4777-8777-777777777777',
        runKey: 'run_keep_cleanup_receipt',
        agentId: 'codex',
      },
    });

    await gcExecutionRunMarkers({
      nowMs,
      terminalTtlMs: 10_000,
      isPidAlive: (pid: number) => pid !== 333,
      isPidSafeHappyProcess: (pid: number) => pid === 111 || pid === 222 || pid === 333 || pid === 444,
    });

    const markers = await listExecutionRunMarkers();
    const ids = markers.map((m) => m.runId).sort();
    expect(ids).toEqual(['run_keep_cleanup_receipt', 'run_keep_running']);

    await clearExecutionRunConnectedServicesCleanupReceipt(
      'run_keep_cleanup_receipt',
    );
    await gcExecutionRunMarkers({
      nowMs,
      terminalTtlMs: 10_000,
      isPidAlive: () => true,
      isPidSafeHappyProcess: () => true,
    });
    expect((await listExecutionRunMarkers()).map((marker) => marker.runId))
      .toEqual(['run_keep_running']);
  });
});
