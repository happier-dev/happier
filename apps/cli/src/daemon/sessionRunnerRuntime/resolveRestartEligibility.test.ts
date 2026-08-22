import { describe, expect, it } from 'vitest';

import type { TrackedSession } from '@/daemon/types';

import { resolveSessionRunnerRestartEligibility } from './resolveRestartEligibility';

function trackedRunner(overrides: Partial<TrackedSession> = {}): TrackedSession {
  return {
    pid: 4242,
    happySessionId: 'sess-1',
    startedBy: 'daemon',
    processCommand:
      'node /Users/alice/.happier/cli-dev/versions/0.2.10/package-dist/index.mjs codex --happy-starting-mode remote --started-by daemon',
    processCommandHash: 'command-hash',
    processStartTimeMs: 12_345,
    vendorResumeId: 'vendor-thread-1',
    spawnOptions: {
      directory: '/workspace',
      resume: 'vendor-thread-1',
    },
    ...overrides,
  };
}

describe('resolveSessionRunnerRestartEligibility', () => {
  it.each([
    ['missing command hash', { processCommandHash: undefined }],
    ['blank command hash', { processCommandHash: '   ' }],
    ['predecessor-reattached runner missing process birth', { processStartTimeMs: undefined }],
    ['non-finite process birth', { processStartTimeMs: Number.POSITIVE_INFINITY }],
  ] satisfies ReadonlyArray<readonly [string, Partial<TrackedSession>]>) (
    'fails closed with the existing unsupported reason for %s',
    (_label, overrides) => {
      expect(resolveSessionRunnerRestartEligibility(
        trackedRunner(overrides),
      )).toEqual({
        eligible: false,
        disabledReason: 'non_destructive_refresh_unsupported',
      });
    },
  );
});
