import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import test from 'node:test';

import { runDocsBuild } from './build.mjs';

const noContentProblems = () => ({ links: [], labels: [], generated: [] });

test('typechecks complete MDX output after Next exits during its background regeneration', () => {
  const root = mkdtempSync(join(tmpdir(), 'docs-typecheck-'));
  const docsRoot = join(root, 'apps', 'docs');
  const bin = join(root, 'bin');
  const compiler = join(root, 'scripts', 'workspaces', 'runTypeScriptCli.mjs');
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  try {
    mkdirSync(docsRoot, { recursive: true });
    mkdirSync(bin);
    mkdirSync(dirname(compiler), { recursive: true });
    // These external CLI boundaries reproduce Next 16's forced exit during
    // Fumadocs 14's unawaited write, followed by an awaited standalone generator.
    for (const [command, source] of Object.entries({
      next: "writeFileSync('.source/server.mjs', ''); process.exit(0);",
      'fumadocs-mdx': "writeFileSync('.source/server.mjs', 'export const docs = { ready: true };');",
    })) {
      const script = join(bin, `${command}.cjs`);
      writeFileSync(script, [
        '#!/usr/bin/env node',
        "const { mkdirSync, writeFileSync } = require('node:fs');",
        "mkdirSync('.source', { recursive: true });",
        source,
      ].join('\n'), { mode: 0o755 });
      if (process.platform === 'win32') {
        writeFileSync(join(bin, `${command}.cmd`), `@"${process.execPath}" "${script}" %*\r\n`);
      } else {
        writeFileSync(join(bin, command), readFileSync(script), { mode: 0o755 });
      }
    }
    writeFileSync(compiler, [
      "import assert from 'node:assert/strict';",
      "import { writeFileSync } from 'node:fs';",
      "import { pathToFileURL } from 'node:url';",
      "import { resolve } from 'node:path';",
      "const generated = await import(pathToFileURL(resolve('.source/server.mjs')));",
      'assert.equal(generated.docs?.ready, true);',
      "writeFileSync('typecheck-completed', 'complete');",
    ].join('\n'));
    const result = spawnSync(manifest.scripts['types:check'], {
      cwd: docsRoot,
      shell: true,
      encoding: 'utf8',
      env: { ...process.env, PATH: [bin, dirname(process.execPath), process.env.PATH].join(delimiter) },
    });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    assert.equal(readFileSync(join(docsRoot, 'typecheck-completed'), 'utf8'), 'complete');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('writes the redirects file and typechecks before invoking the local Next build CLI', async () => {
  const calls = [];
  const env = { NEXT_PUBLIC_POSTHOG_KEY: 'phc_test' };

  await runDocsBuild({
    env,
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
        env,
        stdio: 'inherit',
      },
    },
    // AFTER the build, not before: it rearranges what the export produced.
    { kind: 'relocate', options: { outDir: '/repo/apps/docs/out' } },
  ]);
});

test('refuses to build a production docs bundle without an explicit PostHog key', async () => {
  const calls = [];

  await assert.rejects(
    () => runDocsBuild({
      env: {},
      runContentChecksImpl() {
        calls.push('content');
        return noContentProblems();
      },
      renderRedirectsImpl: () => '',
      writeFileImpl() {},
      relocateMdxSourcesImpl() {},
      execYarnImpl() { calls.push('yarn'); },
      resolveNextCliPathImpl: () => '/repo/node_modules/next/dist/bin/next',
      spawnSyncImpl() { calls.push('next'); return { status: 0 }; },
    }),
    /NEXT_PUBLIC_POSTHOG_KEY is not set/,
  );

  assert.deepEqual(calls, []);
});

test('fails the build when the local Next CLI exits unsuccessfully', async () => {
  await assert.rejects(
    () => runDocsBuild({
      env: { NEXT_PUBLIC_POSTHOG_KEY: 'phc_test' },
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
      env: { NEXT_PUBLIC_POSTHOG_KEY: 'phc_test' },
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
