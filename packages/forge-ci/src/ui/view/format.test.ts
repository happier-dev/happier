import { expect, it } from 'vitest';
import { createForgeCiConformanceVectorsV1 } from '@happier-dev/triage-protocol/ci/testing/v1';
import { readForgeCiElapsedMsV1 } from './format.js';

it('uses a completed run update as its duration endpoint, never as a fabricated completion fact', () => {
  const run = { ...createForgeCiConformanceVectorsV1().github.run, startedAtMs: 1000, updatedAtMs: 19000 };
  expect(readForgeCiElapsedMsV1(run, 50000)).toBe(18000);
  expect(readForgeCiElapsedMsV1({ ...run, completedAtMs: 4000 }, 50000)).toBe(3000);
  expect(readForgeCiElapsedMsV1({ ...run, updatedAtMs: 999 }, 50000)).toBeNull();
  expect(readForgeCiElapsedMsV1({ ...run, startedAtMs: undefined }, 50000)).toBeNull();
});

it('keeps unfinished run and native job timing semantics independent of run updates', () => {
  const native = createForgeCiConformanceVectorsV1().github;
  const run = { ...native.run, startedAtMs: 1000, updatedAtMs: 19000 };
  expect(readForgeCiElapsedMsV1({ ...run, state: { phase: 'waiting', outcome: null, nativeLabel: 'waiting', outcomeBucket: 'pending' } }, 50000)).toBeNull();
  expect(readForgeCiElapsedMsV1({ ...run, state: { phase: 'running', outcome: null, nativeLabel: 'in_progress', outcomeBucket: 'pending' } }, 50000)).toBe(49000);
  expect(readForgeCiElapsedMsV1({ ...native.job, startedAtMs: 1000, completedAtMs: 4000 }, 50000)).toBe(3000);
  expect(readForgeCiElapsedMsV1({ ...native.job, startedAtMs: 1000 }, 50000)).toBeNull();
});
