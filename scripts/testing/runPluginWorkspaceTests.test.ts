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
