import { describe, expect, it } from 'vitest';

import {
  startPackedManagedProviderProcessStartCollector,
  type PackedManagedProviderObservedCandidateProcess,
} from '../../plugin-platform/packedManagedProviderComposedRuntime';
import { waitFor } from '../timing';

function processStart(
  pid: number,
  processStartTimeMs: number,
): PackedManagedProviderObservedCandidateProcess {
  return {
    pid,
    processStartTimeMs,
    executablePath: '/candidate/happier-cliproxyapi-managed',
    command: '/candidate/happier-cliproxyapi-managed --config private.yaml',
  };
}

describe('packed managed Provider process-start collector', () => {
  it('retains every distinct post-baseline wrapper start through settlement', async () => {
    const preexisting = processStart(61_000, 1_000);
    const sessionProvider = processStart(61_001, 2_000);
    const duplicateProvider = processStart(61_002, 3_000);
    let current: readonly PackedManagedProviderObservedCandidateProcess[] = [
      preexisting,
      sessionProvider,
    ];
    const collector = await startPackedManagedProviderProcessStartCollector({
      baseline: [preexisting],
      sample: async () => current,
      intervalMs: 1,
    });

    try {
      expect((await collector.observe()).map((entry) => entry.pid))
        .toEqual([sessionProvider.pid]);
      current = [preexisting, sessionProvider, duplicateProvider];
      await waitFor(
        () => collector.snapshot().length === 2,
        {
          timeoutMs: 1_000,
          intervalMs: 1,
          context: 'duplicate Provider process start observation',
        },
      );
      expect((await collector.stop()).map((entry) => entry.pid))
        .toEqual([sessionProvider.pid, duplicateProvider.pid]);
    } finally {
      await collector.stop();
    }
  });
});
