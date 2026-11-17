import { Session } from 'node:inspector';
import { describe, expect, it } from 'vitest';

import { readAgentCatalogSnapshot } from '@/agent/catalog/snapshot';
import { preloadSessionRunner } from './sessionRunnerPreload';

type Coverage = { result: Array<{ functions: Array<{ functionName: string; ranges: Array<{ count: number }> }> }> };

// Precise coverage resets its counters on every take: a take before and after counts the run.
async function countBuiltInRegistryBuilds(run: () => unknown): Promise<number> {
  const inspector = new Session();
  const post = <R>(method: string, params?: Record<string, unknown>) => new Promise<R>((resolve, reject) => {
    inspector.post(method, params ?? {}, (error, result) => error ? reject(error) : resolve(result as R));
  });
  inspector.connect();
  try {
    await post('Profiler.enable');
    await post('Profiler.startPreciseCoverage', { callCount: true, detailed: false });
    await post('Profiler.takePreciseCoverage');
    await run();
    const coverage = await post<Coverage>('Profiler.takePreciseCoverage');
    return coverage.result.flatMap(script => script.functions)
      .filter(fn => fn.functionName === 'resolveBuiltInContributions')
      .reduce((sum, fn) => sum + (fn.ranges[0]?.count ?? 0), 0);
  } finally {
    await new Promise<void>(resolve => inspector.post('Profiler.stopPreciseCoverage', () => resolve()));
    inspector.disconnect();
  }
}

describe('session host runner preload (New Session intent hold)', () => {
  // A new host's first Session reads the Agent catalog before Claude starts (coding prompt plan,
  // request coverage, follow facts): building the built-in registry there cost 2.3-3.8 s of the
  // first word (P03-ADEMARK-2 §7.6). The hold already runs during the person's think time.
  it('builds the built-in registry during the hold, so the Session\'s first catalog read builds nothing', async () => {
    expect(await countBuiltInRegistryBuilds(() => preloadSessionRunner())).toBe(1);
    expect(await countBuiltInRegistryBuilds(() => readAgentCatalogSnapshot())).toBe(0);
  }, 120_000);
});
