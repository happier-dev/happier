import assert from 'node:assert/strict';
import test from 'node:test';

import { runPluginWorkspaceTests } from './runPluginWorkspaceTests.ts';

test('runs every workspace-derived plugin test invocation', async () => {
  const executed: string[] = [];

  const invocations = await runPluginWorkspaceTests({
    discoverReport: async () => ({
      packages: [
        {
          packageName: '@happier-dev/plugins-alpha',
          workspaceDirectory: 'packages/plugins/alpha',
        },
        {
          packageName: '@happier-dev/plugins-beta',
          workspaceDirectory: 'packages/plugins/beta',
        },
      ],
      issues: [],
    }),
    runInvocation: async (invocation) => {
      executed.push(invocation.packageName);
    },
  });

  assert.deepEqual(executed, [
    '@happier-dev/plugins-alpha',
    '@happier-dev/plugins-beta',
  ]);
  assert.deepEqual(invocations.map((invocation) => invocation.args), [
    ['workspace', '@happier-dev/plugins-alpha', 'test'],
    ['workspace', '@happier-dev/plugins-beta', 'test'],
  ]);
});

test('runs every workspace-derived plugin typecheck invocation', async () => {
  const executed: string[] = [];

  const invocations = await runPluginWorkspaceTests({
    scriptName: 'typecheck',
    discoverReport: async () => ({
      packages: [
        {
          packageName: '@happier-dev/plugins-alpha',
          workspaceDirectory: 'packages/plugins/alpha',
        },
      ],
      issues: [],
    }),
    runInvocation: async (invocation) => {
      executed.push(invocation.packageName);
    },
  });

  assert.deepEqual(executed, ['@happier-dev/plugins-alpha']);
  assert.deepEqual(invocations.map((invocation) => invocation.args), [
    ['workspace', '@happier-dev/plugins-alpha', 'typecheck'],
  ]);
});

test('does not silently skip an empty or invalid plugin workspace selection', async () => {
  let invoked = false;

  await assert.rejects(
    runPluginWorkspaceTests({
      discoverReport: async () => ({
        packages: [],
        issues: ['No plugin workspace packages were found from root workspace metadata.'],
      }),
      runInvocation: async () => {
        invoked = true;
      },
    }),
    /No plugin workspace packages were found from root workspace metadata/,
  );

  assert.equal(invoked, false);
});

test('attempts every derived workspace before reporting failed package tests', async () => {
  const executed: string[] = [];

  await assert.rejects(
    runPluginWorkspaceTests({
      discoverReport: async () => ({
        packages: [
          {
            packageName: '@happier-dev/plugins-alpha',
            workspaceDirectory: 'packages/plugins/alpha',
          },
          {
            packageName: '@happier-dev/plugins-beta',
            workspaceDirectory: 'packages/plugins/beta',
          },
        ],
        issues: [],
      }),
      runInvocation: async (invocation) => {
        executed.push(invocation.packageName);
        if (invocation.packageName === '@happier-dev/plugins-alpha') {
          throw new Error('alpha failed');
        }
      },
    }),
    /@happier-dev\/plugins-alpha: alpha failed/,
  );

  assert.deepEqual(executed, [
    '@happier-dev/plugins-alpha',
    '@happier-dev/plugins-beta',
  ]);
});

test('runs independent plugin workspaces with bounded concurrency', async () => {
  let active = 0;
  let maxActive = 0;
  const releases: Array<() => void> = [];

  const run = runPluginWorkspaceTests({
    maxConcurrent: 2,
    discoverReport: async () => ({
      packages: ['alpha', 'beta', 'gamma'].map((id) => ({
        packageName: `@happier-dev/plugins-${id}`,
        workspaceDirectory: `packages/plugins/${id}`,
      })),
      issues: [],
    }),
    runInvocation: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
    },
  });

  while (releases.length < 2) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(active, 2);
  assert.equal(releases.length, 2);
  releases.shift()?.();
  while (releases.length < 2) await new Promise((resolve) => setImmediate(resolve));
  releases.splice(0).forEach((release) => release());
  await run;

  assert.equal(maxActive, 2);
});
