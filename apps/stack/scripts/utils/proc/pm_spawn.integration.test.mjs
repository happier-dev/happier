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

async function writeStubYarnCaptureEnv({ binDir }) {
  await mkdir(binDir, { recursive: true });
  const yarnPath = join(binDir, 'yarn');
  await writeFile(
    yarnPath,
    [
      '#!/usr/bin/env node',
      'const fs = require("fs");',
      'const args = process.argv.slice(2);',
      "if (args.includes('--version')) { console.log('1.22.22'); process.exit(0); }",
      'if (args[0] === "run") {',
      '  const out = process.env.TEST_OUT_FILE || "";',
      '  if (out) {',
      '    fs.writeFileSync(out, JSON.stringify({ TSX_TSCONFIG_PATH: process.env.TSX_TSCONFIG_PATH || "" }), "utf-8");',
      '  }',
      '  process.exit(0);',
      '}',
      'process.exit(0);',
    ].join('\n') + '\n',
    'utf-8'
  );
  await chmod(yarnPath, 0o755);
}

async function writeStubYarnUsesTsx({ binDir }) {
  await mkdir(binDir, { recursive: true });
  const yarnPath = join(binDir, 'yarn');
  await writeFile(
    yarnPath,
    [
      '#!/usr/bin/env node',
      'const { spawnSync } = require("node:child_process");',
      'const args = process.argv.slice(2);',
      "if (args.includes('--version')) { console.log('1.22.22'); process.exit(0); }",
      'if (args[0] === "run") {',
      '  const result = spawnSync("tsx", ["./scripts/dev.light.ts"], { cwd: process.cwd(), env: process.env, stdio: "inherit" });',
      '  if (result.error) throw result.error;',
      '  process.exit(result.status ?? 0);',
      '}',
      'process.exit(0);',
    ].join('\n') + '\n',
    'utf-8'
  );
  await chmod(yarnPath, 0o755);
}

async function writeStubYarnUsesShellTool({ binDir }) {
  await mkdir(binDir, { recursive: true });
  const yarnPath = join(binDir, 'yarn');
  await writeFile(
    yarnPath,
    [
      '#!/usr/bin/env node',
      'const { spawnSync } = require("node:child_process");',
      'const args = process.argv.slice(2);',
      "if (args.includes('--version')) { console.log('1.22.22'); process.exit(0); }",
      'if (args[0] === "run") {',
      '  const result = spawnSync("shell-tool", ["--ping"], { cwd: process.cwd(), env: process.env, stdio: "inherit" });',
      '  if (result.error) throw result.error;',
      '  process.exit(result.status ?? 0);',
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

test('pmSpawnScript treats stack-owned package-manager children as infra even when caller inherited a session kind', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-pm-spawn-kind-session-'));
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
    HAPPIER_STACK_PROCESS_KIND: 'session',
  };
  const child = await pmSpawnScript({ dir: componentDir, label: 'spawn-test', script: 'noop', env, quiet: true, options: { silent: true } });
  const res = await waitExit(child);
  assert.equal(res.code, 0);

  const kind = (await readFile(outFile, 'utf-8')).trim();
  assert.equal(kind, 'infra');
});

test('pmSpawnScript scopes TSX_TSCONFIG_PATH to the component tsconfig', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-pm-spawn-tsx-tsconfig-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const componentDir = join(root, 'component');
  await mkdir(componentDir, { recursive: true });
  await writeJson(join(componentDir, 'package.json'), { name: 'component', version: '0.0.0' });
  await writeFile(join(componentDir, 'yarn.lock'), '# yarn\n', 'utf-8');
  await writeFile(join(componentDir, 'tsconfig.json'), '{ "compilerOptions": {} }\n', 'utf-8');

  const outFile = join(root, 'tsx-env.json');
  const binDir = join(root, 'bin');
  await writeStubYarnCaptureEnv({ binDir });

  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    TEST_OUT_FILE: outFile,
    TSX_TSCONFIG_PATH: '/tmp/foreign-component/tsconfig.json',
  };
  const child = await pmSpawnScript({ dir: componentDir, label: 'spawn-test', script: 'noop', env, quiet: true, options: { silent: true } });
  const res = await waitExit(child);
  assert.equal(res.code, 0);

  const captured = JSON.parse(await readFile(outFile, 'utf-8'));
  assert.equal(captured.TSX_TSCONFIG_PATH, join(componentDir, 'tsconfig.json'));
});

test('pmSpawnScript resolves tsx package bins when repo root node_modules/.bin is missing', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-pm-spawn-tsx-shim-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const componentDir = join(root, 'apps', 'server');
  await mkdir(join(componentDir, 'scripts'), { recursive: true });
  await writeJson(join(root, 'package.json'), { name: 'repo', private: true });
  await writeFile(join(root, 'yarn.lock'), '# yarn\n', 'utf-8');
  await writeJson(join(componentDir, 'package.json'), { name: '@happier-dev/server', version: '0.0.0' });
  await writeFile(join(componentDir, 'scripts', 'dev.light.ts'), 'export {};\n', 'utf-8');

  const tsxDir = join(root, 'node_modules', 'tsx');
  await mkdir(join(tsxDir, 'dist'), { recursive: true });
  await writeJson(join(tsxDir, 'package.json'), {
    name: 'tsx',
    version: '4.20.4',
    bin: {
      tsx: './dist/cli.mjs',
    },
  });
  await writeFile(
    join(tsxDir, 'dist', 'cli.mjs'),
    [
      '#!/usr/bin/env node',
      'process.exit(0);',
    ].join('\n') + '\n',
    'utf-8',
  );
  await chmod(join(tsxDir, 'dist', 'cli.mjs'), 0o755);

  const binDir = join(root, 'bin');
  await writeStubYarnUsesTsx({ binDir });

  const env = {
    ...process.env,
    PATH: `${binDir}:/usr/bin:/bin`,
    HAPPIER_STACK_ENV_FILE: null,
  };
  const child = await pmSpawnScript({ dir: componentDir, label: 'spawn-test', script: 'dev:light', env, quiet: true, options: { silent: true } });
  const res = await waitExit(child);
  assert.equal(res.code, 0);
});

test('pmSpawnScript resolves shell-script package bins without forcing them through node', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-pm-spawn-shell-tool-shim-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const componentDir = join(root, 'apps', 'server');
  await mkdir(join(componentDir, 'scripts'), { recursive: true });
  await writeJson(join(root, 'package.json'), { name: 'repo', private: true });
  await writeFile(join(root, 'yarn.lock'), '# yarn\n', 'utf-8');
  await writeJson(join(componentDir, 'package.json'), {
    name: '@happier-dev/server',
    version: '0.0.0',
    dependencies: {
      'shell-tool-package': '1.0.0',
    },
  });
  await writeFile(join(componentDir, 'scripts', 'dev.light.ts'), 'export {};\n', 'utf-8');

  const shellToolDir = join(root, 'node_modules', 'shell-tool-package');
  await mkdir(join(shellToolDir, 'dist'), { recursive: true });
  await writeJson(join(shellToolDir, 'package.json'), {
    name: 'shell-tool-package',
    version: '1.0.0',
    bin: {
      'shell-tool': './dist/cli.sh',
    },
  });
  await writeFile(
    join(shellToolDir, 'dist', 'cli.sh'),
    [
      '#!/bin/sh',
      'exit 0',
    ].join('\n') + '\n',
    'utf-8',
  );
  await chmod(join(shellToolDir, 'dist', 'cli.sh'), 0o755);

  const binDir = join(root, 'bin');
  await writeStubYarnUsesShellTool({ binDir });

  const env = {
    ...process.env,
    PATH: `${binDir}:/usr/bin:/bin`,
    HAPPIER_STACK_ENV_FILE: null,
  };
  const child = await pmSpawnScript({ dir: componentDir, label: 'spawn-test', script: 'dev:light', env, quiet: true, options: { silent: true } });
  const res = await waitExit(child);
  assert.equal(res.code, 0);
});
