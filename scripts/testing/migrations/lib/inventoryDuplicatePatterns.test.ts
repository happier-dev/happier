import assert from 'node:assert/strict';
import test from 'node:test';

import { DUPLICATE_PATTERN_RULES, collectDuplicatePatternInventory } from './inventoryDuplicatePatterns.ts';

test('collectDuplicatePatternInventory counts matches deterministically', () => {
  const report = collectDuplicatePatternInventory(
    [
      {
        filePath: 'apps/ui/sources/example.test.tsx',
        content: "vi.mock('expo-router');\nconsole.log('debug');\n",
      },
      {
        filePath: 'apps/ui/sources/example-two.test.tsx',
        content: "vi.mock('expo-router');\n",
      },
    ],
    DUPLICATE_PATTERN_RULES,
  );

  assert.deepEqual(
    report.buckets.map((bucket) => [bucket.ruleId, bucket.count]),
    [
      ['direct-console-calls', 1],
      ['inline-expo-router-mock', 2],
    ],
  );
});

test('collectDuplicatePatternInventory reports raw detached background spawns across test files and testkits', () => {
  const report = collectDuplicatePatternInventory(
    [
      {
        filePath: 'packages/tests/src/testkit/exampleHarness.ts',
        content: `
          import { spawn } from 'node:child_process';
          export function createHarness() {
            return spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
              detached: true,
              stdio: 'ignore',
            });
          }
        `,
      },
      {
        filePath: 'apps/stack/scripts/example.integration.test.mjs',
        content: `
          import { spawn } from 'node:child_process';
          const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
            detached: true,
            stdio: 'ignore',
          });
        `,
      },
    ],
    DUPLICATE_PATTERN_RULES,
  );

  assert.deepEqual(
    report.buckets.map((bucket) => [bucket.ruleId, bucket.count]),
    [
      ['raw-detached-background-test-spawn', 2],
    ],
  );
});

test('collectDuplicatePatternInventory ignores canonical helpers and generated fixture script strings', () => {
  const report = collectDuplicatePatternInventory(
    [
      {
        filePath: 'packages/tests/src/testkit/process/testSpawn.ts',
        content: `
          import { spawn } from 'node:child_process';
          export function spawnDetachedTestProcess(command, args = [], options = {}) {
            return spawn(command, args, {
              detached: true,
              stdio: 'ignore',
              ...options,
            });
          }
        `,
      },
      {
        filePath: 'apps/stack/scripts/example.integration.test.mjs',
        content: `
          const script = \`
            import { spawn } from 'node:child_process';
            const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
              detached: true,
              stdio: 'ignore',
            });
          \`;
        `,
      },
    ],
    DUPLICATE_PATTERN_RULES,
  );

  assert.deepEqual(report.buckets, []);
});

test('collectDuplicatePatternInventory ignores nested generated fixture template strings', () => {
  const report = collectDuplicatePatternInventory(
    [
      {
        filePath: 'apps/stack/scripts/example.integration.test.mjs',
        content: `
          import { spawn } from 'node:child_process';
          const runnerScript = \`
            import { spawn } from 'node:child_process';
            const child = spawn(process.execPath, ['-e', \\\`setInterval(() => {}, 1000)\\\`], {
              detached: true,
              stdio: 'ignore',
            });
            child.unref();
          \`;
        `,
      },
    ],
    DUPLICATE_PATTERN_RULES,
  );

  assert.deepEqual(report.buckets, []);
});
