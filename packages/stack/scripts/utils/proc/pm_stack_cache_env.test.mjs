import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { ensureDepsInstalled, pmExecBin } from './pm.mjs';

async function writeYarnEnvDumpStub({ binDir, outputPath }) {
  await mkdir(binDir, { recursive: true });
  const yarnPath = join(binDir, 'yarn');
  await writeFile(
    yarnPath,
    [
      '#!/usr/bin/env node',
      "const { writeFileSync } = require('node:fs');",
      "const out = {",
      '  XDG_CACHE_HOME: process.env.XDG_CACHE_HOME ?? null,',
      '  YARN_CACHE_FOLDER: process.env.YARN_CACHE_FOLDER ?? null,',
      '  npm_config_cache: process.env.npm_config_cache ?? null,',
      '};',
      "writeFileSync(process.env.OUTPUT_PATH, JSON.stringify(out, null, 2) + '\\n');",
      'process.exit(0);',
    ].join('\n') + '\n',
    'utf-8'
  );
  await chmod(yarnPath, 0o755);
  await writeFile(outputPath, '', 'utf-8');
}

async function writeYarnArgDumpStub({ binDir, outputPath }) {
  await mkdir(binDir, { recursive: true });
  const yarnPath = join(binDir, 'yarn');
  await writeFile(
    yarnPath,
    [
      '#!/usr/bin/env sh',
      'set -euo pipefail',
      'echo "$*" >> "${OUTPUT_PATH:?}"',
    ].join('\n') + '\n',
    'utf-8'
  );
  await chmod(yarnPath, 0o755);
  await writeFile(outputPath, '', 'utf-8');
}

function expectedCacheEnv({ envPath }) {
  const base = join(dirname(envPath), 'cache');
  return {
    xdg: join(base, 'xdg'),
    yarn: join(base, 'yarn'),
    npm: join(base, 'npm'),
  };
}

async function withEnv(vars, fn) {
  const old = {};
  for (const k of Object.keys(vars)) old[k] = process.env[k];
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v == null) delete process.env[k];
      else process.env[k] = String(v);
    }
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(old)) {
      if (v == null) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('ensureDepsInstalled sets stack-scoped cache env vars for yarn installs', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-pm-stack-cache-install-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const stackDir = join(root, 'stacks', 'exp1');
  const envPath = join(stackDir, 'env');
  await mkdir(dirname(envPath), { recursive: true });
  await writeFile(envPath, 'HAPPY_STACKS_STACK=exp1\n', 'utf-8');

  const componentDir = join(root, 'component');
  await mkdir(componentDir, { recursive: true });
  await writeFile(join(componentDir, 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(componentDir, 'yarn.lock'), '# yarn\n', 'utf-8');

  const binDir = join(root, 'bin');
  const outputPath = join(root, 'env.json');
  await writeYarnEnvDumpStub({ binDir, outputPath });

  const exp = expectedCacheEnv({ envPath });
  const oldPath = process.env.PATH;

  await withEnv(
    {
      PATH: `${binDir}:${oldPath ?? ''}`,
      OUTPUT_PATH: outputPath,
      HAPPY_STACKS_ENV_FILE: envPath,
      HAPPY_LOCAL_ENV_FILE: envPath,
      XDG_CACHE_HOME: null,
      YARN_CACHE_FOLDER: null,
      npm_config_cache: null,
    },
    async () => {
      await ensureDepsInstalled(componentDir, 'test-component', { quiet: true });
      const parsed = JSON.parse(await readFile(outputPath, 'utf-8'));
      assert.equal(parsed.XDG_CACHE_HOME, exp.xdg);
      assert.equal(parsed.YARN_CACHE_FOLDER, exp.yarn);
      assert.equal(parsed.npm_config_cache, exp.npm);
    }
  );
});

test('ensureDepsInstalled prefers yarn when component is inside the Happy monorepo (packages/ layout)', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-pm-happy-monorepo-yarn-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  // Create the minimum Happy monorepo markers (packages/ layout) + root yarn.lock.
  await mkdir(join(root, 'packages', 'happy-app'), { recursive: true });
  await mkdir(join(root, 'packages', 'happy-cli'), { recursive: true });
  await mkdir(join(root, 'packages', 'happy-server'), { recursive: true });
  await writeFile(join(root, 'packages', 'happy-app', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(root, 'packages', 'happy-cli', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(root, 'packages', 'happy-server', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(root, 'package.json'), '{ "name": "monorepo", "private": true }\n', 'utf-8');
  await writeFile(join(root, 'yarn.lock'), '# yarn\n', 'utf-8');

  const componentDir = join(root, 'packages', 'happy-server');

  const binDir = join(root, 'bin');
  const outputPath = join(root, 'argv.txt');
  await writeYarnArgDumpStub({ binDir, outputPath });

  await withEnv(
    {
      // Avoid leaking `pnpm` into PATH so the test fails loudly when pnpm is selected.
      PATH: `${binDir}:/usr/bin:/bin`,
      OUTPUT_PATH: outputPath,
      HAPPY_STACKS_ENV_FILE: null,
      HAPPY_LOCAL_ENV_FILE: null,
    },
    async () => {
      await ensureDepsInstalled(componentDir, 'happy-server', { quiet: true });
      const out = await readFile(outputPath, 'utf-8');
      assert.ok(out.includes('install') || out.includes('--version'));
    }
  );
});

test('pmExecBin sets stack-scoped cache env vars for yarn runs', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-pm-stack-cache-exec-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const stackDir = join(root, 'stacks', 'exp1');
  const envPath = join(stackDir, 'env');
  await mkdir(dirname(envPath), { recursive: true });
  await writeFile(envPath, 'HAPPY_STACKS_STACK=exp1\n', 'utf-8');

  const componentDir = join(root, 'component');
  await mkdir(componentDir, { recursive: true });
  await writeFile(join(componentDir, 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(componentDir, 'yarn.lock'), '# yarn\n', 'utf-8');

  const binDir = join(root, 'bin');
  const outputPath = join(root, 'env.json');
  await writeYarnEnvDumpStub({ binDir, outputPath });

  const exp = expectedCacheEnv({ envPath });
  const oldPath = process.env.PATH;

  await withEnv(
    {
      PATH: `${binDir}:${oldPath ?? ''}`,
      OUTPUT_PATH: outputPath,
      HAPPY_STACKS_ENV_FILE: envPath,
      HAPPY_LOCAL_ENV_FILE: envPath,
      XDG_CACHE_HOME: null,
      YARN_CACHE_FOLDER: null,
      npm_config_cache: null,
    },
    async () => {
      await pmExecBin({ dir: componentDir, bin: 'prisma', args: ['generate'], env: process.env, quiet: true });
      const parsed = JSON.parse(await readFile(outputPath, 'utf-8'));
      assert.equal(parsed.XDG_CACHE_HOME, exp.xdg);
      assert.equal(parsed.YARN_CACHE_FOLDER, exp.yarn);
      assert.equal(parsed.npm_config_cache, exp.npm);
    }
  );
});
