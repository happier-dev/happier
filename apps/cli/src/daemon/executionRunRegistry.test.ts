import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('executionRunRegistry', () => {
  const originalHappyHomeDir = process.env.HAPPIER_HOME_DIR;
  let happyHomeDir: string;

  beforeEach(() => {
    happyHomeDir = join(tmpdir(), `happier-cli-exec-run-registry-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    process.env.HAPPIER_HOME_DIR = happyHomeDir;
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
  });

  it('writes and lists execution run markers', async () => {
    const { configuration } = await import('@/configuration');
    const { listExecutionRunMarkers, writeExecutionRunMarker } = await import('./executionRunRegistry');

    await writeExecutionRunMarker({
      pid: 123,
      happySessionId: 'sess-1',
      runId: 'run_1',
      callId: 'call_1',
      sidechainId: 'call_1',
      intent: 'review',
      backendId: 'claude',
      runClass: 'bounded',
      ioMode: 'request_response',
      retentionPolicy: 'ephemeral',
      status: 'running',
      startedAtMs: 1,
      updatedAtMs: 1,
    });

    const markers = await listExecutionRunMarkers();
    expect(markers).toHaveLength(1);
    expect(markers[0].pid).toBe(123);
    expect(markers[0].happySessionId).toBe('sess-1');
    expect(markers[0].runId).toBe('run_1');
    expect(markers[0].intent).toBe('review');
    expect(markers[0].backendId).toBe('claude');

    // Disk shape includes happyHomeDir filtering key.
    const filePath = join(configuration.happyHomeDir, 'tmp', 'daemon-execution-runs', 'run-run_1.json');
    const raw = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed.happyHomeDir).toBe(configuration.happyHomeDir);
    expect(parsed.runId).toBe('run_1');
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
      backendId: 'claude',
      runClass: 'bounded',
      ioMode: 'request_response',
      retentionPolicy: 'ephemeral',
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
      backendId: 'claude',
      runClass: 'bounded',
      ioMode: 'request_response',
      retentionPolicy: 'ephemeral',
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
      backendId: 'claude',
      runClass: 'bounded',
      ioMode: 'request_response',
      retentionPolicy: 'ephemeral',
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
      backendId: 'claude',
      runClass: 'bounded',
      ioMode: 'request_response',
      retentionPolicy: 'ephemeral',
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

  it('gcExecutionRunMarkers removes stale terminal markers and markers for dead pids', async () => {
    const { listExecutionRunMarkers, writeExecutionRunMarker, gcExecutionRunMarkers } = await import('./executionRunRegistry');

    const nowMs = Date.now();
    await writeExecutionRunMarker({
      pid: 111,
      happySessionId: 'sess-1',
      runId: 'run_keep_running',
      callId: 'call_1',
      sidechainId: 'side_1',
      intent: 'review',
      backendId: 'claude',
      runClass: 'bounded',
      ioMode: 'request_response',
      retentionPolicy: 'ephemeral',
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
      backendId: 'claude',
      runClass: 'bounded',
      ioMode: 'request_response',
      retentionPolicy: 'ephemeral',
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
      backendId: 'claude',
      runClass: 'bounded',
      ioMode: 'request_response',
      retentionPolicy: 'ephemeral',
      status: 'running',
      startedAtMs: nowMs - 10_000,
      updatedAtMs: nowMs - 9_000,
    });

    await gcExecutionRunMarkers({
      nowMs,
      terminalTtlMs: 10_000,
      isPidAlive: (pid: number) => pid !== 333,
      isPidSafeHappyProcess: (pid: number) => pid === 111 || pid === 222 || pid === 333,
    });

    const markers = await listExecutionRunMarkers();
    const ids = markers.map((m) => m.runId).sort();
    expect(ids).toEqual(['run_keep_running']);
  });
});
