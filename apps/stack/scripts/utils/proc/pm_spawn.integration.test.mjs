import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { pmSpawnBin, pmSpawnScript } from './pm.mjs';

async function writeJson(path, obj) {
  await writeFile(path, JSON.stringify(obj, null, 2) + '\n', 'utf-8');
}

async function waitExit(child) {
  return await new Promise((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });
}

async function writeStubYarn({ binDir }) {
  await mkdir(binDir, { recursive: true });
  const yarnPath = join(binDir, 'yarn');
  await writeFile(
    yarnPath,
    [
      '#!/usr/bin/env node',
      'const args = process.argv.slice(2);',
      // ensureYarnReady calls: yarn --version
      "if (args.includes('--version')) { console.log('1.22.22'); process.exit(0); }",
      // pmSpawn* calls: yarn run <script/bin> ...
      'if (args[0] === "run") process.exit(0);',
      'process.exit(0);',
    ].join('\n') + '\n',
    'utf-8'
  );
  await chmod(yarnPath, 0o755);
}

async function writeStubYarnCaptureKind({ binDir }) {
  await mkdir(binDir, { recursive: true });
  const yarnPath = join(binDir, 'yarn');
  await writeFile(
    yarnPath,
    [
      '#!/usr/bin/env node',
      'const fs = require("fs");',
      'const args = process.argv.slice(2);',
      // ensureYarnReady calls: yarn --version
      "if (args.includes('--version')) { console.log('1.22.22'); process.exit(0); }",
      // pmSpawn* calls: yarn run <script/bin> ...
      'if (args[0] === "run") {',
      '  const out = process.env.TEST_OUT_FILE || "";',
      '  if (out) fs.writeFileSync(out, String(process.env.HAPPIER_STACK_PROCESS_KIND || ""), "utf-8");',
      '  process.exit(0);',
      '}',
      'process.exit(0);',
    ].join('\n') + '\n',
    'utf-8'
  );
  await chmod(yarnPath, 0o755);
}

test('pmSpawnScript does not reference effectiveEnv before initialization', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-pm-spawn-script-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const componentDir = join(root, 'component');
  await mkdir(componentDir, { recursive: true });
  await writeJson(join(componentDir, 'package.json'), { name: 'component', version: '0.0.0' });
  await writeFile(join(componentDir, 'yarn.lock'), '# yarn\n', 'utf-8');

  const binDir = join(root, 'bin');
  await writeStubYarn({ binDir });

  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}` };
  const child = await pmSpawnScript({ dir: componentDir, label: 'spawn-test', script: 'noop', env, quiet: true, options: { silent: true } });
  const res = await waitExit(child);
  assert.equal(res.code, 0);
});

test('pmSpawnBin does not reference effectiveEnv before initialization', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-pm-spawn-bin-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const componentDir = join(root, 'component');
  await mkdir(componentDir, { recursive: true });
  await writeJson(join(componentDir, 'package.json'), { name: 'component', version: '0.0.0' });
  await writeFile(join(componentDir, 'yarn.lock'), '# yarn\n', 'utf-8');

  const binDir = join(root, 'bin');
  await writeStubYarn({ binDir });

  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}` };
  const child = await pmSpawnBin({ dir: componentDir, label: 'spawn-test', bin: 'prisma', args: ['generate'], env, quiet: true, options: { silent: true } });
  const res = await waitExit(child);
  assert.equal(res.code, 0);
});

test('pmSpawnScript marks stack-owned infra processes with HAPPIER_STACK_PROCESS_KIND=infra', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-pm-spawn-kind-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const componentDir = join(root, 'component');
  await mkdir(componentDir, { recursive: true });
  await writeJson(join(componentDir, 'package.json'), { name: 'component', version: '0.0.0' });
  await writeFile(join(componentDir, 'yarn.lock'), '# yarn\n', 'utf-8');

  const outFile = join(root, 'kind.txt');

  const binDir = join(root, 'bin');
  await writeStubYarnCaptureKind({ binDir });

  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    TEST_OUT_FILE: outFile,
    HAPPIER_STACK_STACK: 'k',
    HAPPIER_STACK_ENV_FILE: join(root, 'stack-env'),
  };
  const child = await pmSpawnScript({ dir: componentDir, label: 'spawn-test', script: 'noop', env, quiet: true, options: { silent: true } });
  const res = await waitExit(child);
  assert.equal(res.code, 0);

  const kind = (await readFile(outFile, 'utf-8')).trim();
  assert.equal(kind, 'infra');
});
