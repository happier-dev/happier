import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { writeStressRunSummary } from './writeStressRunSummary';

describe('writeStressRunSummary', () => {
  it('writes the canonical stress summary json with final status and resolved config', () => {
    const testDir = mkdtempSync(join(tmpdir(), 'happier-stress-summary-'));
    const mirroredSummaryPath = join(testDir, 'mirrored-summary.json');
    const summaryPath = writeStressRunSummary({
      testDir,
      scenarioName: 'rpc.multiReplica',
      targetMode: 'full-compose',
      baseUrl: 'http://127.0.0.1:43080',
      seed: 1234,
      status: 'failed',
      startedAt: '2026-04-18T12:00:00.000Z',
      endedAt: '2026-04-18T12:00:03.250Z',
      durationMs: 3250,
      resolvedConfig: {
        targetMode: 'full-compose',
        duration: {
          durationMs: 3000,
        },
      },
      counts: {
        users: 25,
        sessions: 25,
      },
      latencies: {
        p50Ms: 12,
        p95Ms: 48,
        p99Ms: 60,
        maxMs: 73,
      },
      failures: {
        timeouts: 0,
        methodNotAvailable: 0,
      },
      errors: {
        buckets: {
          connection: 1,
          rpc: 2,
        },
        details: {
          rpc: {
            methodNotAvailable: 2,
          },
        },
      },
      summaryOutputPath: mirroredSummaryPath,
    });

    const written = JSON.parse(readFileSync(summaryPath, 'utf8'));

    expect(written).toMatchObject({
      scenarioName: 'rpc.multiReplica',
      targetMode: 'full-compose',
      baseUrl: 'http://127.0.0.1:43080',
      seed: 1234,
      status: 'failed',
      startedAt: '2026-04-18T12:00:00.000Z',
      endedAt: '2026-04-18T12:00:03.250Z',
      durationMs: 3250,
      resolvedConfig: {
        targetMode: 'full-compose',
      },
      counts: {
        users: 25,
      },
      latencies: {
        p95Ms: 48,
        p99Ms: 60,
        maxMs: 73,
      },
      errors: {
        buckets: {
          connection: 1,
          rpc: 2,
        },
      },
    });
    expect(JSON.parse(readFileSync(mirroredSummaryPath, 'utf8'))).toEqual(written);
  });

  it('fills in the canonical latency keys even when a scenario did not measure latencies', () => {
    const testDir = mkdtempSync(join(tmpdir(), 'happier-stress-summary-'));

    const summaryPath = writeStressRunSummary({
      testDir,
      scenarioName: 'presence.workerCrashReclaim',
      targetMode: 'full-compose',
      baseUrl: 'http://127.0.0.1:43080',
      status: 'passed',
      startedAt: '2026-04-18T12:00:00.000Z',
      endedAt: '2026-04-18T12:00:01.000Z',
      durationMs: 1000,
      resolvedConfig: {},
      counts: {},
    });

    expect(JSON.parse(readFileSync(summaryPath, 'utf8')).latencies).toEqual({
      p50Ms: 0,
      p95Ms: 0,
      p99Ms: 0,
      maxMs: 0,
    });
  });
});
