import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ensureWorkspacePackagesBuiltForComponent } from './pm.mjs';

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

async function writeYarnWorkspaceBuildStub({ binDir, outputPath }) {
  await mkdir(binDir, { recursive: true });
  const yarnPath = join(binDir, 'yarn');
  await writeFile(
    yarnPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'echo "$(pwd) :: $*" >> "${OUTPUT_PATH:?}"',
      '',
      'if [[ "${1:-}" == "--version" ]]; then',
      '  echo "1.22.22"',
      '  exit 0',
      'fi',
      '',
      '# Simulate `yarn -s build` creating dist outputs for protocol.',
      'if [[ "${1:-}" == "-s" && "${2:-}" == "build" && "$(pwd)" == */packages/protocol ]]; then',
      '  mkdir -p dist',
      "  printf '%s\\n' 'export const ok = true;' > dist/index.js",
      "  printf '%s\\n' \"import './machineTransfer/transferStream.js';\" >> dist/index.js",
      "  printf '%s\\n' 'export const ok = true;' > dist/rpcErrors.js",
      "  printf '%s\\n' 'export declare const ok: boolean;' > dist/index.d.ts",
      "  printf '%s\\n' 'export declare const ok: boolean;' > dist/rpcErrors.d.ts",
      '  mkdir -p dist/machineTransfer',
      "  printf '%s\\n' 'export const ok = true;' > dist/machineTransfer/transferStream.js",
      "  printf '%s\\n' 'export declare const ok: boolean;' > dist/machineTransfer/transferStream.d.ts",
      '  exit 0',
      'fi',
      '',
      'exit 0',
    ].join('\n') + '\n',
    'utf-8',
  );
  await chmod(yarnPath, 0o755);
  await writeFile(outputPath, '', 'utf-8');
}

function applyEnvOverrides(t, vars) {
  const previous = {};
  for (const key of Object.keys(vars)) {
    previous[key] = process.env[key];
  }
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  });
  for (const [key, value] of Object.entries(vars)) {
    if (value == null) delete process.env[key];
    else process.env[key] = String(value);
  }
}

test('ensureWorkspacePackagesBuiltForComponent builds internal dist-based workspaces when export targets are missing', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-ensure-workspaces-built-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  // Minimal Happy monorepo markers.
  await mkdir(join(root, 'apps', 'ui'), { recursive: true });
  await mkdir(join(root, 'apps', 'cli'), { recursive: true });
  await mkdir(join(root, 'apps', 'server'), { recursive: true });
  await writeJson(join(root, 'apps', 'ui', 'package.json'), {
    name: '@happier-dev/app',
    private: true,
    dependencies: {
      '@happier-dev/protocol': '0.0.0',
    },
  });
  await writeJson(join(root, 'apps', 'cli', 'package.json'), { name: '@happier-dev/cli', private: true });
  await writeJson(join(root, 'apps', 'server', 'package.json'), { name: '@happier-dev/server', private: true });

  const protocolDir = join(root, 'packages', 'protocol');
  await mkdir(protocolDir, { recursive: true });
  await writeJson(join(protocolDir, 'package.json'), {
    name: '@happier-dev/protocol',
    version: '0.0.0',
    type: 'module',
    main: './dist/index.js',
    types: './dist/index.d.ts',
    exports: {
      '.': { default: './dist/index.js', types: './dist/index.d.ts' },
      './rpcErrors': { default: './dist/rpcErrors.js', types: './dist/rpcErrors.d.ts' },
    },
    scripts: { build: 'tsc -p tsconfig.json' },
  });
  await writeJson(join(protocolDir, 'tsconfig.json'), { compilerOptions: { outDir: 'dist' } });

  const binDir = join(root, 'bin');
  const outputPath = join(root, 'argv.txt');
  await writeYarnWorkspaceBuildStub({ binDir, outputPath });

  applyEnvOverrides(t, {
    PATH: `${binDir}:/usr/bin:/bin`,
    OUTPUT_PATH: outputPath,
    HAPPIER_STACK_ENV_FILE: null,
  });

  await ensureWorkspacePackagesBuiltForComponent(join(root, 'apps', 'ui'), { quiet: true, env: process.env });

  const out = await readFile(outputPath, 'utf-8');
  assert.match(out, /packages\/protocol :: -s build/);
  assert.equal(Boolean(await readFile(join(protocolDir, 'dist', 'rpcErrors.js'), 'utf-8')), true);

  // Second run should be a no-op (no additional build).
  await ensureWorkspacePackagesBuiltForComponent(join(root, 'apps', 'ui'), { quiet: true, env: process.env });
  const out2 = await readFile(outputPath, 'utf-8');
  const occurrences = out2.split('\n').filter((l) => l.includes('/packages/protocol :: -s build')).length;
  assert.equal(occurrences, 1);
});

test('ensureWorkspacePackagesBuiltForComponent rebuilds internal workspaces when exported entrypoints have missing local imports', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-ensure-workspaces-built-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  // Minimal Happy monorepo markers.
  await mkdir(join(root, 'apps', 'ui'), { recursive: true });
  await mkdir(join(root, 'apps', 'cli'), { recursive: true });
  await mkdir(join(root, 'apps', 'server'), { recursive: true });
  await writeJson(join(root, 'apps', 'ui', 'package.json'), {
    name: '@happier-dev/app',
    private: true,
    dependencies: {
      '@happier-dev/protocol': '0.0.0',
    },
  });
  await writeJson(join(root, 'apps', 'cli', 'package.json'), { name: '@happier-dev/cli', private: true });
  await writeJson(join(root, 'apps', 'server', 'package.json'), { name: '@happier-dev/server', private: true });

  const protocolDir = join(root, 'packages', 'protocol');
  await mkdir(protocolDir, { recursive: true });
  await writeJson(join(protocolDir, 'package.json'), {
    name: '@happier-dev/protocol',
    version: '0.0.0',
    type: 'module',
    main: './dist/index.js',
    types: './dist/index.d.ts',
    exports: {
      '.': { default: './dist/index.js', types: './dist/index.d.ts' },
      './rpcErrors': { default: './dist/rpcErrors.js', types: './dist/rpcErrors.d.ts' },
    },
    scripts: { build: 'tsc -p tsconfig.json' },
  });
  await writeJson(join(protocolDir, 'tsconfig.json'), { compilerOptions: { outDir: 'dist' } });

  // Pre-create "complete" export targets, but with a missing local import inside dist/index.js.
  await mkdir(join(protocolDir, 'dist'), { recursive: true });
  await writeFile(
    join(protocolDir, 'dist', 'index.js'),
    ["export const ok = true;", "import './machineTransfer/transferStream.js';"].join('\n') + '\n',
    'utf-8',
  );
  await writeFile(join(protocolDir, 'dist', 'rpcErrors.js'), "export const ok = true;\n", 'utf-8');
  await writeFile(join(protocolDir, 'dist', 'index.d.ts'), "export declare const ok: boolean;\n", 'utf-8');
  await writeFile(join(protocolDir, 'dist', 'rpcErrors.d.ts'), "export declare const ok: boolean;\n", 'utf-8');

  const binDir = join(root, 'bin');
  const outputPath = join(root, 'argv.txt');
  await writeYarnWorkspaceBuildStub({ binDir, outputPath });

  applyEnvOverrides(t, {
    PATH: `${binDir}:/usr/bin:/bin`,
    OUTPUT_PATH: outputPath,
    HAPPIER_STACK_ENV_FILE: null,
  });

  await ensureWorkspacePackagesBuiltForComponent(join(root, 'apps', 'ui'), { quiet: true, env: process.env });

  const out = await readFile(outputPath, 'utf-8');
  assert.match(out, /packages\/protocol :: -s build/);
  assert.equal(Boolean(await readFile(join(protocolDir, 'dist', 'machineTransfer', 'transferStream.js'), 'utf-8')), true);
});
