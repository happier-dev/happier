import assert from 'node:assert/strict';
import test from 'node:test';

import { runDocsBuild } from './build.mjs';

const noContentProblems = () => ({ links: [], labels: [], generated: [] });

test('writes the redirects file and typechecks before invoking the local Next build CLI', async () => {
  const calls = [];

  await runDocsBuild({
    packageRoot: '/repo/apps/docs',
    processExecPath: '/managed/node',
    runContentChecksImpl: noContentProblems,
    renderRedirectsImpl: () => '/old /new 301\n',
    relocateMdxSourcesImpl(options) {
      calls.push({ kind: 'relocate', options });
    },
    writeFileImpl(path, contents) {
      calls.push({ kind: 'write', path, contents });
    },
    execYarnImpl(args, options) {
      calls.push({ kind: 'yarn', args, options });
    },
    resolveNextCliPathImpl: () => '/repo/node_modules/next/dist/bin/next',
    spawnSyncImpl(command, args, options) {
      calls.push({ kind: 'next', command, args, options });
      return { status: 0 };
    },
  });

  // Order is the point, not just presence. `next build` copies public/ into
  // out/, so a _redirects written afterwards ships an export with every old
  // URL dead and a green build to go with it.
  assert.deepEqual(calls, [
    {
      kind: 'write',
      path: '/repo/apps/docs/public/_redirects',
      contents: '/old /new 301\n',
    },
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
    // AFTER the build, not before: it rearranges what the export produced.
    { kind: 'relocate', options: { outDir: '/repo/apps/docs/out' } },
  ]);
});

test('fails the build when the local Next CLI exits unsuccessfully', async () => {
  await assert.rejects(
    () => runDocsBuild({
      packageRoot: '/repo/apps/docs',
      processExecPath: '/managed/node',
      runContentChecksImpl: noContentProblems,
      renderRedirectsImpl: () => '',
      writeFileImpl() {},
      relocateMdxSourcesImpl() {},
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
