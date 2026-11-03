import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { withDependencyRefresh } from '../../utils/proc/dependency_refresh.mjs';
import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { writeStubCliDistBuildManifest } from '../../testkit/core/stub_happier_cli_files.mjs';
import { resolveCliEntrypoint } from './resolveCliEntrypoint.mjs';

async function makeCliFixture(name) {
  const root = join(tmpdir(), `happier-stack-cli-entrypoint-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
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

test('resolveCliEntrypoint resolves TSX from the selected CLI checkout before stack-local tooling', async () => {
  const cliDir = await makeCliFixture('source-tsx-from-cli-dir');
  const cliTsxLoaderPath = join(cliDir, 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs');
  await mkdir(join(cliDir, 'node_modules', 'tsx', 'dist', 'esm'), { recursive: true });
  await writeFile(
    join(cliDir, 'node_modules', 'tsx', 'package.json'),
    JSON.stringify({ name: 'tsx', version: '0.0.0-fixture' }, null, 2) + '\n',
    'utf8',
  );
  await writeFile(cliTsxLoaderPath, 'export {};\n', 'utf8');

  const resolved = await resolveCliEntrypoint({ cliDir, preferSource: true });

  assert.equal(resolved?.kind, 'tsx');
  assert.equal(await realpath(resolved?.nodeArgs[1]), await realpath(cliTsxLoaderPath));
  assert.equal(resolved?.nodeArgs.at(-1), join(cliDir, 'src', 'index.ts'));
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
