import assert from 'node:assert/strict';
import test from 'node:test';

import { formatNightlyPosts, parseFailingJourneyFiles } from './postNightlyJourneyFailures.mjs';

test('failing core-e2e and ui-e2e files are read from the failed-job log, once each', () => {
  const log = [
    'Core E2E (fast)\tRun core e2e suite\t2026-11-17T01:50:01Z  FAIL  suites/core-e2e/session.open.e2e.test.ts > opens',
    'Core E2E (fast)\tRun core e2e suite\t2026-11-17T01:50:02Z  FAIL  suites/core-e2e/session.open.e2e.test.ts > reopens',
    'Core E2E (slow)\tRun core e2e suite (slow)\t2026-11-17T02:10:00Z  ❯ suites/core-e2e/handoff.slow.e2e.test.ts (3 tests | 1 failed) 912ms',
    'UI E2E / shard 4/18\tRun UI E2E\t2026-11-17T02:20:00Z   1) [chromium] › suites/ui-e2e/session.subroutes.spec.ts:40:3 › opens subroutes',
    'UI E2E / shard 4/18\tRun UI E2E\t2026-11-17T02:20:00Z  ✓  suites/ui-e2e/session.ok.spec.ts:10:3 › passes',
  ].join('\n');
  assert.deepEqual(parseFailingJourneyFiles(log), [
    'packages/tests/suites/core-e2e/handoff.slow.e2e.test.ts',
    'packages/tests/suites/core-e2e/session.open.e2e.test.ts',
    'packages/tests/suites/ui-e2e/session.subroutes.spec.ts',
  ]);
});

test('one post per owning lane; unattributed files go to the program that owns the suites', () => {
  const posts = formatNightlyPosts({
    at: new Date('2026-11-17T06:00:00Z'), runUrl: 'https://example.test/run/1', fallbackLane: 'P03 ORCH',
    attributions: [
      { file: 'packages/tests/suites/a.e2e.test.ts', lane: 'TH', basis: 'x at 1234567' },
      { file: 'packages/tests/suites/b.e2e.test.ts', lane: 'TH', basis: 'y at 7654321' },
      { file: 'packages/tests/suites/c.spec.ts', lane: null, basis: null },
    ],
  });
  assert.equal(posts.length, 2);
  assert.match(posts[0], /^### 2026-11-17 06:00 UTC — NIGHTLY-JOURNEYS → TH — ASK — 2 nightly v0.3 journey failure/m);
  assert.match(posts[1], /→ P03 ORCH — ASK — 1 nightly v0.3 journey failure/);
});
