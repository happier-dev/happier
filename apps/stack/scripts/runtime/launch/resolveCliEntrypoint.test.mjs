import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

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

  const resolved = resolveCliEntrypoint({ cliDir, preferSource: true });

  assert.equal(resolved?.kind, 'tsx');
  assert.equal(resolved?.nodeArgs.at(-1), join(cliDir, 'src', 'index.ts'));
  assert.equal(resolved?.distEntrypoint, join(cliDir, 'package-dist', 'index.mjs'));
});

test('resolveCliEntrypoint keeps dist first for packaged/runtime mode', async () => {
  const cliDir = await makeCliFixture('dist-first');

  const resolved = resolveCliEntrypoint({ cliDir, preferSource: false });

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

  const resolved = resolveCliEntrypoint({ cliDir, preferSource: true });

  assert.equal(resolved?.kind, 'tsx');
  assert.equal(await realpath(resolved?.nodeArgs[1]), await realpath(cliTsxLoaderPath));
  assert.equal(resolved?.nodeArgs.at(-1), join(cliDir, 'src', 'index.ts'));
});
