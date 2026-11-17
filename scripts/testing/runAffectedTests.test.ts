import assert from 'node:assert/strict';
import test from 'node:test';

import { planAffectedTestCommands } from './runAffectedTests.ts';

test('selected journey tests run under the runner that owns their suite', () => {
  const commands = planAffectedTestCommands({
    journeyFiles: [
      'packages/tests/suites/core-e2e/session.open.e2e.test.ts',
      'packages/tests/suites/core-e2e/session.handoff.slow.e2e.test.ts',
      'packages/tests/suites/ui-e2e/session.subroutes.spec.ts',
      'packages/tests/suites/contracts/actions.test.ts',
    ],
    unitFiles: [],
  });

  assert.deepEqual(commands.map(({ id, args }) => [id, args]), [
    ['core-e2e fast', ['--dir', 'packages/tests', 'run', 'test:core:fast',
      'suites/contracts/actions.test.ts', 'suites/core-e2e/session.open.e2e.test.ts']],
    ['core-e2e slow', ['--dir', 'packages/tests', 'exec', 'node', 'scripts/run-vitest-with-heartbeat.mjs',
      '--config', 'vitest.core.slow.config.ts', 'suites/core-e2e/session.handoff.slow.e2e.test.ts']],
    ['ui-e2e', ['--dir', 'packages/tests', 'run', 'test:ui:e2e', 'suites/ui-e2e/session.subroutes.spec.ts']],
  ]);
});

test('owner unit tests go through the root unit lane and an empty selection runs nothing', () => {
  assert.deepEqual(planAffectedTestCommands({ journeyFiles: [], unitFiles: [] }), []);
  const [unit] = planAffectedTestCommands({ journeyFiles: [], unitFiles: ['apps/server/sources/a.spec.ts'] });
  assert.deepEqual(unit, { id: 'owner unit', rootUnitFiles: ['apps/server/sources/a.spec.ts'], args: [] });
});
