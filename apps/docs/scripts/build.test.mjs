import assert from 'node:assert/strict';
import test from 'node:test';

import { runDocsBuild } from './build.mjs';

const noContentProblems = () => ({ links: [], labels: [], generated: [] });

test('runs the native typecheck before invoking the local Next build CLI', async () => {
  const calls = [];

  await runDocsBuild({
    packageRoot: '/repo/apps/docs',
    processExecPath: '/managed/node',
    runContentChecksImpl: noContentProblems,
    execYarnImpl(args, options) {
      calls.push({ kind: 'yarn', args, options });
    },
    resolveNextCliPathImpl: () => '/repo/node_modules/next/dist/bin/next',
    spawnSyncImpl(command, args, options) {
      calls.push({ kind: 'next', command, args, options });
      return { status: 0 };
    },
  });

  assert.deepEqual(calls, [
    {
      kind: 'yarn',
      args: ['-s', 'types:check'],
      options: { cwd: '/repo/apps/docs', stdio: 'inherit' },
    },
    {
      kind: 'next',
      command: '/managed/node',
      args: ['/repo/node_modules/next/dist/bin/next', 'build', '--webpack'],
      options: {
        cwd: '/repo/apps/docs',
        env: process.env,
        stdio: 'inherit',
      },
    },
  ]);
});

test('fails the build when the local Next CLI exits unsuccessfully', async () => {
  await assert.rejects(
    () => runDocsBuild({
      packageRoot: '/repo/apps/docs',
      processExecPath: '/managed/node',
      runContentChecksImpl: noContentProblems,
      execYarnImpl() {},
      resolveNextCliPathImpl: () => '/repo/node_modules/next/dist/bin/next',
      spawnSyncImpl: () => ({ status: 2 }),
    }),
    /Next build failed with code 2/,
  );
});

test('refuses to build when a documented link or UI label is wrong', async () => {
  const calls = [];

  await assert.rejects(
    () => runDocsBuild({
      packageRoot: '/repo/apps/docs',
      processExecPath: '/managed/node',
      runContentChecksImpl: () => ({
        links: [{ at: 'features/index.mdx:8', target: './git', reason: 'relative link' }],
        labels: [{ at: 'providers/index.mdx:29', label: 'AI provider settings', reason: 'no such string' }],
        generated: [],
      }),
      execYarnImpl() { calls.push('yarn'); },
      resolveNextCliPathImpl: () => '/repo/node_modules/next/dist/bin/next',
      spawnSyncImpl: () => { calls.push('next'); return { status: 0 }; },
    }),
    /Docs content checks failed with 2 problems/,
  );

  // The point is to fail before spending a build on content that is already wrong.
  assert.deepEqual(calls, []);
});
