import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DaemonExecutionRunMarkerSchema } from '@happier-dev/protocol';

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
    vi.resetModules();
  });

  afterEach(() => {
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

    const filePath = join(configuration.happyHomeDir, 'tmp', 'daemon-execution-runs', 'run-run_1.json');
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

    const filePath = join(configuration.happyHomeDir, 'tmp', 'daemon-execution-runs', 'run-run_bounded_marker.json');
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
    vi.resetModules();

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

    const filePath = join(configuration.happyHomeDir, 'tmp', 'daemon-execution-runs.dev', 'run-run_dev_scoped.json');
    expect(existsSync(filePath)).toBe(true);
  });

  it('uses a unique temp file per marker write to avoid cross-write corruption', async () => {
    const writeFileSpy = vi.fn();
    vi.doMock('node:fs/promises', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs/promises')>();
      return {
        ...actual,
        writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
          writeFileSpy(...args);
          return actual.writeFile(...args);
        },
      };
    });
    vi.resetModules();

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

  it('does not allow a late running marker to overwrite a terminal marker', async () => {
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
      updatedAtMs: 3,
    });

    const filePath = join(configuration.happyHomeDir, 'tmp', 'daemon-execution-runs', 'run-run_terminal_wins.json');
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8'));
    expect(parsed.status).toBe('succeeded');
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
    const tempPath = join(dir, 'run-run_tmp_cleanup.json.tmp-123');
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

    await removeExecutionRunMarker('run_tmp_cleanup');
    expect(existsSync(tempPath)).toBe(false);
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
