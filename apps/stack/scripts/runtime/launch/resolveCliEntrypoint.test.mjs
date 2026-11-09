import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { withDependencyRefresh } from '../../utils/proc/dependency_refresh.mjs';
import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { writeStubCliDistBuildManifest } from '../../testkit/core/stub_happier_cli_files.mjs';
import { resolveCliEntrypoint } from './resolveCliEntrypoint.mjs';

async function makeCliFixture(name) {
  const checkout = join(tmpdir(), `happier-stack-cli-entrypoint-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const root = join(checkout, 'apps', 'cli');
  await mkdir(join(checkout, 'packages', 'cli-common'), { recursive: true });
  await writeFile(join(checkout, 'packages', 'cli-common', 'registerSourceRuntime.mjs'), 'export {};\n', 'utf8');
  await mkdir(join(root, 'bin'), { recursive: true });
  await mkdir(join(root, 'package-dist'), { recursive: true });
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'bin', 'happier.mjs'), [
    '#!/usr/bin/env node',
    "import '../package-dist/index.mjs';",
    '',
  ].join('\n'), 'utf8');
  await writeFile(join(root, 'package-dist', 'index.mjs'), 'export {};\n', 'utf8');
  writeStubCliDistBuildManifest(root, { entrypointDir: 'package-dist' });
  await writeFile(join(root, 'src', 'index.ts'), 'export {};\n', 'utf8');
  await writeFile(join(root, 'tsconfig.json'), '{"compilerOptions":{}}\n', 'utf8');
  return root;
}

test('resolveCliEntrypoint prefers TSX source when source mode is selected even if dist exists', async () => {
  const cliDir = await makeCliFixture('source-prefers-tsx');

  const resolved = await resolveCliEntrypoint({ cliDir, preferSource: true });

  assert.equal(resolved?.kind, 'tsx');
  assert.equal(resolved?.nodeArgs.at(-1), join(cliDir, 'src', 'index.ts'));
  assert.equal(resolved?.distEntrypoint, join(cliDir, 'package-dist', 'index.mjs'));
});

test('resolveCliEntrypoint keeps dist first for packaged/runtime mode', async () => {
  const cliDir = await makeCliFixture('dist-first');

  const resolved = await resolveCliEntrypoint({ cliDir, preferSource: false });

  assert.equal(resolved?.kind, 'dist');
  assert.deepEqual(resolved?.nodeArgs, [join(cliDir, 'package-dist', 'index.mjs')]);
});

test('resolveCliEntrypoint registers the selected checkout source runtime, not stack-local tooling', async () => {
  const cliDir = await makeCliFixture('source-runtime-from-cli-checkout');

  const resolved = await resolveCliEntrypoint({ cliDir, preferSource: true });

  assert.equal(resolved?.kind, 'tsx');
  assert.equal(await realpath(fileURLToPath(resolved?.nodeArgs[2])),
    await realpath(join(cliDir, '..', '..', 'packages', 'cli-common', 'registerSourceRuntime.mjs')));
  assert.equal(resolved?.nodeArgs.at(-1), join(cliDir, 'src', 'index.ts'));
});

test('source CLI launch consumes authored workspace exports, not compiled dist', async () => {
  // The real checkout CLI: a stale package dist must not shadow its authored
  // source export (HOME-ENROLL: login failed on an export missing from dist).
  const cliDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'cli');
  const resolved = await resolveCliEntrypoint({ cliDir, preferSource: true });
  assert.equal(resolved?.kind, 'tsx');
  const probe = "process.stdout.write(import.meta.resolve('@happier-dev/sync-client'))";
  const result = spawnSync(process.execPath, [...resolved.nodeArgs.slice(0, -1), '--input-type=module', '--eval', probe], {
    cwd: cliDir,
    env: { ...process.env, NODE_OPTIONS: '', TSX_TSCONFIG_PATH: resolved.tsconfigPath },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\/packages\/sync-client\/src\/index\.ts$/);
});

test('source CLI selection waits for an in-progress installation before admitting its source loader', async t => {
  const fixture = await createTempFixture(t, { prefix: 'source-cli-install-wait-' });
  const cliDir = fixture.path('apps/cli');
  await mkdir(join(cliDir, 'src'), { recursive: true });
  await writeFile(join(cliDir, 'src/index.ts'), 'export {};\n');
  await mkdir(fixture.path('packages/cli-common'), { recursive: true });
  await writeFile(fixture.path('packages/cli-common/registerSourceRuntime.mjs'), 'export {};\n');
  await writeFile(fixture.path('package.json'), JSON.stringify({ private: true }));
  for (const component of ['ui', 'cli', 'server']) {
    await mkdir(fixture.path(`apps/${component}`), { recursive: true });
    await writeFile(fixture.path(`apps/${component}/package.json`), JSON.stringify({ private: true }));
  }
  await writeFile(fixture.path('pnpm-lock.yaml'), '# fixture\n');
  await writeFile(fixture.path('pnpm-workspace.yaml'), 'packages: []\n');
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const waiting = Promise.withResolvers();
  const originalWrite = process.stderr.write.bind(process.stderr);
  t.mock.method(process.stderr, 'write', function (chunk, ...args) {
    if (String(chunk).includes('waiting for dependency refresh lock')) waiting.resolve();
    return originalWrite(chunk, ...args);
  });
  const env = { ...process.env, HAPPIER_WORKSPACE_BUILD_NOTICE_AFTER_MS: '0',
    HAPPIER_STACK_SKIP_REFRESH_DEPS: '0', HAPPIER_STACK_DISABLE_REFRESH_DEPS: '0' };
  const writer = withDependencyRefresh({ installDir: fixture.root, env, force: true, signal: t.signal }, async () => {
    entered.resolve(); await release.promise;
    await mkdir(fixture.path('node_modules'), { recursive: true });
  });
  await entered.promise;
  const selected = resolveCliEntrypoint({ cliDir, preferSource: true, env, signal: t.signal });
  try {
    await Promise.race([waiting.promise, Promise.resolve(selected).then(() => {
      assert.fail('source loader admitted while the installation was still rewriting dependencies');
    })]);
  } finally { release.resolve(); await writer; }
  assert.equal((await selected).kind, 'tsx');
});
