import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { runDocsBuild } from './build.mjs';

const noContentProblems = () => ({ links: [], labels: [], generated: [] });

test('makes explicit Fumadocs generation authoritative after Next route type generation', async () => {
  const packageJsonPath = fileURLToPath(new URL('../package.json', import.meta.url));
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));

  assert.deepEqual(packageJson.scripts['types:check'].split(' && '), [
    'next typegen',
    'fumadocs-mdx',
    'node ../../scripts/workspaces/runTypeScriptCli.mjs --noEmit',
  ]);
});

test('runs the native typecheck before invoking the local Next build CLI', async () => {
  const calls = [];
  await runDocsBuild({
    runContentChecksImpl: noContentProblems,
    packageRoot: '/repo/apps/docs',
    processExecPath: '/managed/node',
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
    { kind: 'yarn', args: ['-s', 'types:check'], options: { cwd: '/repo/apps/docs', stdio: 'inherit' } },
    {
      kind: 'next',
      command: '/managed/node',
      args: ['/repo/node_modules/next/dist/bin/next', 'build', '--webpack'],
      options: { cwd: '/repo/apps/docs', env: process.env, stdio: 'inherit' },
    },
  ]);
});

test('fails when the local Next CLI exits unsuccessfully', async () => {
  await assert.rejects(
    () => runDocsBuild({
      runContentChecksImpl: noContentProblems,
      packageRoot: '/repo/apps/docs',
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
        links: [{ at: 'a.mdx:1', target: '/gone', reason: 'no page at this route' }],
        labels: [],
        generated: [],
      }),
      execYarnImpl() { calls.push('yarn'); },
      resolveNextCliPathImpl: () => '/repo/node_modules/next/dist/bin/next',
      spawnSyncImpl() { calls.push('next'); return { status: 0 }; },
    }),
    /Docs content checks failed with 1 problem/,
  );

  // The point of checking first is not spending a Next build to find out.
  assert.deepEqual(calls, []);
});
