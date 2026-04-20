import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { compareStressRuns } from './compareStressRuns';

describe('compareStressRuns', () => {
  it('computes baseline-to-candidate deltas for counts, latencies, and failures', () => {
    const root = mkdtempSync(join(tmpdir(), 'happier-stress-compare-'));
    const baselinePath = join(root, 'baseline.json');
    const candidatePath = join(root, 'candidate.json');

    writeFileSync(
      baselinePath,
      `${JSON.stringify({
        counts: { calls: 100 },
        latencies: { p95Ms: 40, p99Ms: 60 },
        failures: { timeouts: 2 },
        errors: { buckets: { rpc: 3 } },
      })}\n`,
      'utf8',
    );
    writeFileSync(
      candidatePath,
      `${JSON.stringify({
        counts: { calls: 140 },
        latencies: { p95Ms: 55, p99Ms: 70 },
        failures: { timeouts: 1 },
        errors: { buckets: { rpc: 1 } },
      })}\n`,
      'utf8',
    );

    expect(
      compareStressRuns({
        baselineSummaryPath: baselinePath,
        candidateSummaryPath: candidatePath,
      }),
    ).toEqual({
      countsDelta: { calls: 40 },
      latencyDelta: { p95Ms: 15, p99Ms: 10 },
      failureDelta: { timeouts: -1 },
      errorDelta: { rpc: -2 },
    });
  });
});
