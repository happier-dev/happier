import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, cp, mkdtemp, mkdir, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ensureWorkspacePackagesBuiltForComponent } from './pm.mjs';
import {
  ensureWorkspacePackagesBuiltForComponent as ensureWorkspacePackagesBuiltForComponentCanonical,
} from '../../../../../scripts/workspaces/ensureWorkspacePackagesBuilt.mjs';
import { buildBundledWorkspaceDependenciesForCli } from '../../../../cli/scripts/buildSharedDeps.mjs';

async function waitForFile(path, { timeoutMs = 5_000 } = {}) {
  const startedAt = Date.now();
  for (;;) {
    try {
      await readFile(path, 'utf-8');
      return;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      if (Date.now() - startedAt > timeoutMs) {
        throw new Error(`Timed out waiting for file: ${path}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

async function writeYarnWorkspaceBuildStub({ binDir, outputPath, lockOutputPath = null, delaySecondsByPackage = {} }) {
  await mkdir(binDir, { recursive: true });
  const yarnPath = join(binDir, 'yarn');
  const delayCliCommon = Number(delaySecondsByPackage?.cliCommon ?? 0);
  const delayProtocol = Number(delaySecondsByPackage?.protocol ?? 0);
  const delayAgents = Number(delaySecondsByPackage?.agents ?? 0);
  await writeFile(
    yarnPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'echo "$(pwd) :: $*" >> "${OUTPUT_PATH:?}"',
      lockOutputPath ? `echo "$(pwd) :: \${HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD:-}" >> ${JSON.stringify(lockOutputPath)}` : '',
      '',
      'if [[ "${1:-}" == "--version" ]]; then',
      '  echo "1.22.22"',
      '  exit 0',
      'fi',
      '',
      '# Simulate `yarn -s build` creating dist outputs for workspace packages.',
      'if [[ "${1:-}" == "-s" && "${2:-}" == "build" ]]; then',
      '  out="${HAPPIER_WORKSPACE_DIST_OUTPUT_DIR:-dist}"',
      '  if [[ "$(pwd)" == */packages/protocol ]]; then',
      delayProtocol > 0 ? `    sleep ${delayProtocol}` : '    true',
      '    mkdir -p "$out"',
      "    printf '%s\\n' 'export const ok = true;' > \"$out/index.js\"",
      "    printf '%s\\n' \"import './machineTransfer/transferStream.js';\" >> \"$out/index.js\"",
      "    printf '%s\\n' 'export const ok = true;' > \"$out/rpcErrors.js\"",
      "    printf '%s\\n' 'export declare const ok: boolean;' > \"$out/index.d.ts\"",
      "    printf '%s\\n' 'export declare const ok: boolean;' > \"$out/rpcErrors.d.ts\"",
      '    mkdir -p "$out/machineTransfer"',
      "    printf '%s\\n' 'export const ok = true;' > \"$out/machineTransfer/transferStream.js\"",
      "    printf '%s\\n' 'export declare const ok: boolean;' > \"$out/machineTransfer/transferStream.d.ts\"",
      '    exit 0',
      '  fi',
      '  if [[ "$(pwd)" == */packages/agents ]]; then',
      delayAgents > 0 ? `    sleep ${delayAgents}` : '    true',
      '    mkdir -p "$out"',
      "    printf '%s\\n' 'export const ok = true;' > \"$out/index.js\"",
      "    printf '%s\\n' 'export declare const ok: boolean;' > \"$out/index.d.ts\"",
      '    exit 0',
      '  fi',
      '  if [[ "$(pwd)" == */packages/cli-common ]]; then',
      delayCliCommon > 0 ? `    sleep ${delayCliCommon}` : '    true',
      '    mkdir -p "$out"',
      "    printf '%s\\n' 'export const ok = true;' > \"$out/index.js\"",
      "    printf '%s\\n' 'export declare const ok: boolean;' > \"$out/index.d.ts\"",
      '    exit 0',
      '  fi',
      '  if [[ "$(pwd)" == */packages/plugins/claude ]]; then',
      '    mkdir -p "$out"',
      "    printf '%s\\n' 'export const ok = true;' > \"$out/index.js\"",
      "    printf '%s\\n' 'export declare const ok: boolean;' > \"$out/index.d.ts\"",
      '    exit 0',
      '  fi',
      'fi',
      '',
      'exit 0',
    ].join('\n') + '\n',
    'utf-8',
  );
  await chmod(yarnPath, 0o755);
  await writeFile(outputPath, '', 'utf-8');
}

async function writeYarnWorkspaceBuildViaTscStub({ binDir, outputPath }) {
  await mkdir(binDir, { recursive: true });
  const yarnPath = join(binDir, 'yarn');
  await writeFile(
    yarnPath,
    [
      '#!/usr/bin/env node',
      "const { appendFileSync, existsSync, mkdirSync, writeFileSync } = require('node:fs');",
      "const { join } = require('node:path');",
      "const { spawnSync } = require('node:child_process');",
      'const args = process.argv.slice(2);',
      'appendFileSync(process.env.OUTPUT_PATH, `${process.cwd()} :: ${args.join(" ")}\\n`, "utf-8");',
      'if (args.includes("--version")) {',
      '  console.log("1.22.22");',
      '  process.exit(0);',
      '}',
      'if (args[0] === "-s" && args[1] === "build") {',
      '  const result = spawnSync("tsc", ["-p", "tsconfig.json"], { cwd: process.cwd(), env: process.env, stdio: "inherit" });',
      '  if (result.error) throw result.error;',
      '  process.exit(result.status ?? 0);',
      '}',
      'process.exit(0);',
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

function captureStderr(t) {
  const chunks = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk, encoding, callback) => {
    const text = typeof chunk === 'string' ? chunk : chunk?.toString?.(encoding) ?? String(chunk ?? '');
    chunks.push(text);
    if (typeof callback === 'function') {
      callback();
    }
    return true;
  });
  t.after(() => {
    process.stderr.write = originalWrite;
  });
  return chunks;
}

async function writeQuietWorkspaceBuildFailurePackageManager({ binDir, name, buildArgs }) {
  await mkdir(binDir, { recursive: true });
  const entrypointPath = join(binDir, `${name}-quiet-workspace-build-failure.cjs`);
  const commandPath = join(binDir, process.platform === 'win32' ? `${name}.cmd` : name);
  await writeFile(
    entrypointPath,
    [
      'const args = process.argv.slice(2);',
      `const expectedBuildArgs = ${JSON.stringify(buildArgs)};`,
      "if (args.length === 1 && args[0] === '--version') { process.stdout.write('quiet-version-output\\n'); process.exit(0); }",
      'if (JSON.stringify(args) !== JSON.stringify(expectedBuildArgs)) process.exit(91);',
      "process.stdout.write('stdout-head\\n' + 'x'.repeat(10_000) + 'stdout-tail\\n');",
      "process.stderr.write('stderr-head\\n' + 'y'.repeat(10_000) + 'stderr-tail\\nHAPPIER_STACK_WORKSPACE_TEST_SECRET=' + process.env.HAPPIER_STACK_WORKSPACE_TEST_SECRET + '\\n');",
      'process.exit(37);',
    ].join('\n') + '\n',
    'utf-8',
  );
  await writeFile(
    commandPath,
    process.platform === 'win32'
      ? `@${JSON.stringify(process.execPath)} ${JSON.stringify(entrypointPath)} %*\r\n`
      : `#!${process.execPath}\nrequire(${JSON.stringify(entrypointPath)});\n`,
    'utf-8',
  );
  await chmod(commandPath, 0o755);
}

async function createQuietWorkspaceBuildFailureFixture(t, { packageManager }) {
  const root = await mkdtemp(join(tmpdir(), `hs-quiet-${packageManager}-workspace-build-failure-`));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  for (const appName of ['ui', 'cli', 'server']) {
    const appDir = join(root, 'apps', appName);
    await mkdir(appDir, { recursive: true });
    await writeJson(join(appDir, 'package.json'), {
      name: `@fixture/${appName}`,
      private: true,
      ...(appName === 'ui' ? {
        dependencies: { '@happier-dev/quiet-workspace-build-failure': '0.0.0' },
      } : {}),
    });
  }
  await writeJson(join(root, 'package.json'), {
    private: true,
    workspaces: ['apps/*', 'packages/*'],
  });

  const packageDir = join(root, 'packages', 'quiet-workspace-build-failure');
  await mkdir(join(packageDir, 'src'), { recursive: true });
  await writeFile(join(packageDir, 'src', 'index.ts'), 'export const value = true;\n', 'utf-8');
  await writeJson(join(packageDir, 'package.json'), {
    name: '@happier-dev/quiet-workspace-build-failure',
    type: 'module',
    main: './dist/index.js',
    scripts: { build: 'fixture-build' },
  });

  const binDir = join(root, 'bin');
  await writeQuietWorkspaceBuildFailurePackageManager({
    binDir,
    name: packageManager,
    buildArgs: packageManager === 'yarn' ? ['-s', 'build'] : ['run', '-s', 'build'],
  });

  const env = {
    ...process.env,
    PATH: binDir,
    HAPPIER_STACK_BINARY_MODE: packageManager === 'npm' ? '1' : '0',
    HAPPIER_STACK_ENV_FILE: '',
    HAPPIER_STACK_WORKSPACE_TEST_SECRET: 'must-not-escape',
  };
  if (packageManager === 'npm') {
    const originalExecPath = process.execPath;
    process.execPath = join(root, 'fake-node-bin', process.platform === 'win32' ? 'node.exe' : 'node');
    t.after(() => {
      process.execPath = originalExecPath;
    });
  }

  return { root, env };
}

async function assertQuietStackWorkspaceBuildFailureDiagnostics(t, packageManager) {
  const { root, env } = await createQuietWorkspaceBuildFailureFixture(t, { packageManager });
  let failure = null;
  await assert.rejects(
    ensureWorkspacePackagesBuiltForComponent(join(root, 'apps', 'ui'), {
      quiet: true,
      env,
    }),
    (error) => {
      failure = error;
      return error?.code === 'EEXIT';
    },
  );

  assert.match(failure?.message ?? '', /failed \(code=37, sig=null\)/);
  assert.match(failure?.message ?? '', /Child output \(tail; earlier output omitted\):/);
  assert.match(failure?.message ?? '', /\[stdout\]\n[\s\S]*stdout-tail/);
  assert.match(failure?.message ?? '', /\[stderr\]\n[\s\S]*stderr-tail/);
  assert.match(failure?.message ?? '', /HAPPIER_STACK_WORKSPACE_TEST_SECRET=<redacted>/);
  assert.doesNotMatch(failure?.message ?? '', /stdout-head|stderr-head|must-not-escape/);
  assert.ok((failure?.message.length ?? 0) < 17_000, 'expected a bounded failure diagnostic');
}

test('Stack Yarn workspace build failures retain bounded child diagnostics', async (t) => {
  await assertQuietStackWorkspaceBuildFailureDiagnostics(t, 'yarn');
});

test('Stack binary npm workspace build failures retain bounded child diagnostics', async (t) => {
  await assertQuietStackWorkspaceBuildFailureDiagnostics(t, 'npm');
});

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
      './runtime': { require: './runtime.cjs', default: './dist/index.js' },
    },
    scripts: { build: 'tsc -p tsconfig.json' },
  });
  await writeFile(join(protocolDir, 'runtime.cjs'), 'module.exports = {};\n', 'utf-8');
  await writeJson(join(protocolDir, 'tsconfig.json'), { compilerOptions: { outDir: 'dist' } });

  const binDir = join(root, 'bin');
  const outputPath = join(root, 'argv.txt');
  await writeYarnWorkspaceBuildStub({ binDir, outputPath });

  applyEnvOverrides(t, {
    PATH: `${binDir}:/usr/bin:/bin`,
    OUTPUT_PATH: outputPath,
    HAPPIER_STACK_ENV_FILE: null,
  });

  await ensureWorkspacePackagesBuiltForComponent(join(root, 'apps', 'ui'), {
    quiet: true,
    env: process.env,
    admitPriorOutputsImmediately: true,
  });

  const out = await readFile(outputPath, 'utf-8');
  assert.match(out, /packages\/protocol :: -s build/);
  assert.equal(Boolean(await readFile(join(protocolDir, 'dist', 'rpcErrors.js'), 'utf-8')), true);
  const preservedOutputTime = new Date(Date.now() - 60_000);
  await utimes(join(protocolDir, 'dist', 'index.d.ts'), preservedOutputTime, preservedOutputTime);

  // A valid output is a read-only admission path. Make the package-lock directory impossible to
  // create so this second call fails if it tries to acquire the mutation lock before checking.
  const workspaceLockDir = join(root, '.project', 'tmp', 'workspace-dist-builds');
  await rm(workspaceLockDir, { recursive: true, force: true });
  await mkdir(join(root, '.project', 'tmp'), { recursive: true });
  await writeFile(workspaceLockDir, 'lock-directory-must-not-be-touched\n', 'utf-8');

  // Second run should be a no-op (no additional build or lock acquisition).
  await ensureWorkspacePackagesBuiltForComponent(join(root, 'apps', 'ui'), { quiet: true, env: process.env });
  const out2 = await readFile(outputPath, 'utf-8');
  const occurrences = out2.split('\n').filter((l) => l.includes('/packages/protocol :: -s build')).length;
  assert.equal(occurrences, 1);

  // Source freshness is part of output validity, not an adapter concern.
  await rm(workspaceLockDir, { force: true });
  await new Promise((resolve) => setTimeout(resolve, 20));
  await mkdir(join(protocolDir, 'src'), { recursive: true });
  await writeFile(join(protocolDir, 'src', 'index.ts'), 'export const changed = true;\n', 'utf-8');
  await ensureWorkspacePackagesBuiltForComponent(join(root, 'apps', 'ui'), { quiet: true, env: process.env });
  const out3 = await readFile(outputPath, 'utf-8');
  const occurrencesAfterSourceChange = out3.split('\n').filter((l) => l.includes('/packages/protocol :: -s build')).length;
  assert.equal(occurrencesAfterSourceChange, 2);

  await new Promise((resolve) => setTimeout(resolve, 20));
  const protocolPackage = JSON.parse(await readFile(join(protocolDir, 'package.json'), 'utf-8'));
  await writeJson(join(protocolDir, 'package.json'), { ...protocolPackage, description: 'changed package input' });
  await ensureWorkspacePackagesBuiltForComponent(join(root, 'apps', 'ui'), { quiet: true, env: process.env });

  await new Promise((resolve) => setTimeout(resolve, 20));
  await writeJson(join(protocolDir, 'tsconfig.json'), { compilerOptions: { outDir: 'dist', strict: true } });
  await ensureWorkspacePackagesBuiltForComponent(join(root, 'apps', 'ui'), { quiet: true, env: process.env });

  await new Promise((resolve) => setTimeout(resolve, 20));
  await writeFile(join(protocolDir, 'src', 'rpc.test.ts'), 'export const testOnly = true;\n', 'utf-8');
  await ensureWorkspacePackagesBuiltForComponent(join(root, 'apps', 'ui'), { quiet: true, env: process.env });
  const finalOut = await readFile(outputPath, 'utf-8');
  const finalOccurrences = finalOut.split('\n').filter((l) => l.includes('/packages/protocol :: -s build')).length;
  assert.equal(finalOccurrences, 4, 'source/config/package changes rebuild, while test-only source does not');
});

test('ensureWorkspacePackagesBuiltForComponent builds unscoped internal workspace dependencies', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-ensure-unscoped-workspace-built-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  await writeJson(join(root, 'package.json'), {
    private: true,
    workspaces: ['apps/*', 'packages/*'],
  });
  for (const appName of ['ui', 'cli']) {
    const appDir = join(root, 'apps', appName);
    await mkdir(appDir, { recursive: true });
    await writeJson(join(appDir, 'package.json'), {
      name: `@happier-dev/${appName}`,
      private: true,
    });
  }

  const serverDir = join(root, 'apps', 'server');
  await mkdir(serverDir, { recursive: true });
  await writeJson(join(serverDir, 'package.json'), {
    name: '@happier-dev/server',
    private: true,
    dependencies: {
      'privacy-kit': '^0.0.25',
    },
  });

  const privacyKitDir = join(root, 'packages', 'privacy-kit');
  await mkdir(privacyKitDir, { recursive: true });
  await writeJson(join(privacyKitDir, 'package.json'), {
    name: 'privacy-kit',
    version: '0.0.25',
    type: 'module',
    main: './dist/index.js',
    exports: './dist/index.js',
    scripts: { build: 'fixture-build' },
  });
  await mkdir(join(privacyKitDir, 'src'), { recursive: true });
  await writeFile(join(privacyKitDir, 'src', 'index.ts'), 'export const privacy = true;\n', 'utf-8');

  const buildCalls = [];
  const result = await ensureWorkspacePackagesBuiltForComponentCanonical(serverDir, {
    quiet: true,
    env: process.env,
    workspaceBuildBoundary: {
      prepareEnv: async (_packageDir, env) => ({ ...env }),
      runPackageBuild: async (packageDir, { env }) => {
        buildCalls.push(packageDir);
        const outputDir = env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR;
        assert.ok(outputDir);
        await mkdir(outputDir, { recursive: true });
        await writeFile(join(outputDir, 'index.js'), 'export const privacy = true;\n', 'utf-8');
      },
    },
  });

  assert.deepEqual(buildCalls, [privacyKitDir]);
  assert.deepEqual(result.built, ['privacy-kit']);
  assert.equal(await readFile(join(privacyKitDir, 'dist', 'index.js'), 'utf-8'), 'export const privacy = true;\n');
});

test('ensureWorkspacePackagesBuiltForComponent uses inherited Yarn JS entrypoint when PATH has no Yarn shim', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-inherited-yarn-entrypoint-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const uiDir = join(root, 'apps', 'ui');
  const protocolDir = join(root, 'packages', 'protocol');
  await mkdir(uiDir, { recursive: true });
  await mkdir(join(root, 'apps', 'cli'), { recursive: true });
  await mkdir(join(root, 'apps', 'server'), { recursive: true });
  await mkdir(protocolDir, { recursive: true });
  await writeJson(join(root, 'package.json'), {
    private: true,
    workspaces: ['apps/*', 'packages/*'],
  });
  await writeJson(join(uiDir, 'package.json'), {
    name: '@happier-dev/app',
    private: true,
    dependencies: {
      '@happier-dev/protocol': '0.0.0',
    },
  });
  await writeJson(join(root, 'apps', 'cli', 'package.json'), {
    name: '@happier-dev/cli',
    private: true,
  });
  await writeJson(join(root, 'apps', 'server', 'package.json'), {
    name: '@happier-dev/server',
    private: true,
  });
  await writeJson(join(protocolDir, 'package.json'), {
    name: '@happier-dev/protocol',
    version: '0.0.0',
    type: 'module',
    main: './dist/index.js',
    types: './dist/index.d.ts',
    scripts: {
      build: 'unused-by-fake-yarn',
    },
  });

  const binDir = join(root, 'path-without-yarn');
  const corepackMarkerPath = join(root, 'corepack-was-invoked');
  await mkdir(binDir, { recursive: true });
  const corepackTrapPath = join(binDir, process.platform === 'win32' ? 'corepack.cmd' : 'corepack');
  await writeFile(
    corepackTrapPath,
    process.platform === 'win32'
      ? `@echo off\r\n> ${JSON.stringify(corepackMarkerPath)} echo invoked\r\nexit /b 91\r\n`
      : `#!/bin/sh\nprintf invoked > ${JSON.stringify(corepackMarkerPath)}\nexit 91\n`,
    'utf-8',
  );
  await chmod(corepackTrapPath, 0o755);

  const yarnEntrypointDir = join(root, 'inherited package manager');
  const yarnEntrypointPath = join(yarnEntrypointDir, 'yarn entrypoint.cjs');
  const invocationLogPath = join(root, 'yarn-invocations.jsonl');
  await mkdir(yarnEntrypointDir, { recursive: true });
  await writeFile(
    yarnEntrypointPath,
    [
      "const { appendFileSync, mkdirSync, writeFileSync } = require('node:fs');",
      "const { join } = require('node:path');",
      'const args = process.argv.slice(2);',
      'appendFileSync(process.env.YARN_INVOCATION_LOG, `${JSON.stringify(args)}\\n`, "utf-8");',
      'if (args.length === 1 && args[0] === "--version") {',
      '  process.stdout.write("1.22.22\\n");',
      '  process.exit(0);',
      '}',
      'if (args.length === 2 && args[0] === "-s" && args[1] === "build") {',
      '  const outDir = process.env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR || join(process.cwd(), "dist");',
      '  mkdirSync(outDir, { recursive: true });',
      '  writeFileSync(join(outDir, "index.js"), "export const inheritedYarnBuild = true;\\n", "utf-8");',
      '  writeFileSync(join(outDir, "index.d.ts"), "export declare const inheritedYarnBuild: boolean;\\n", "utf-8");',
      '  process.exit(0);',
      '}',
      'process.exit(92);',
    ].join('\n') + '\n',
    'utf-8',
  );

  const env = {
    ...process.env,
    PATH: binDir,
    npm_execpath: yarnEntrypointPath,
    YARN_INVOCATION_LOG: invocationLogPath,
  };
  delete env.HAPPIER_STACK_ENV_FILE;

  const isolatedNodeDir = join(root, 'isolated node runtime');
  const isolatedNodePath = join(isolatedNodeDir, process.platform === 'win32' ? 'node.exe' : 'node');
  await mkdir(isolatedNodeDir, { recursive: true });
  if (process.platform === 'win32') {
    await cp(process.execPath, isolatedNodePath);
    await chmod(isolatedNodePath, 0o755);
  } else {
    // A copied dynamically linked Node binary can lose its loader-relative runtime libraries.
    // A symlink still exercises an executable path containing spaces without breaking the runtime.
    await symlink(process.execPath, isolatedNodePath);
  }
  const pmModuleUrl = new URL('./pm.mjs', import.meta.url).href;
  const result = spawnSync(
    isolatedNodePath,
    [
      '--input-type=module',
      '-e',
      `const { ensureWorkspacePackagesBuiltForComponent } = await import(${JSON.stringify(pmModuleUrl)}); await ensureWorkspacePackagesBuiltForComponent(${JSON.stringify(uiDir)}, { quiet: true, env: process.env });`,
    ],
    {
      cwd: root,
      env,
      encoding: 'utf-8',
      timeout: 15_000,
    },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);

  assert.deepEqual(
    (await readFile(invocationLogPath, 'utf-8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line)),
    [
      ['--version'],
      ['-s', 'build'],
    ],
  );
  assert.equal(
    await readFile(join(protocolDir, 'dist', 'index.js'), 'utf-8'),
    'export const inheritedYarnBuild = true;\n',
  );
  await assert.rejects(readFile(corepackMarkerPath, 'utf-8'), { code: 'ENOENT' });
});

test('ensureWorkspacePackagesBuiltForComponent treats source-exporting workspaces as live source instead of stale build output', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-ensure-source-workspace-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  await mkdir(join(root, 'apps', 'ui'), { recursive: true });
  await mkdir(join(root, 'apps', 'cli'), { recursive: true });
  await mkdir(join(root, 'apps', 'server'), { recursive: true });
  await writeJson(join(root, 'package.json'), {
    private: true,
    workspaces: ['apps/*', 'packages/*'],
  });
  await writeJson(join(root, 'apps', 'ui', 'package.json'), {
    name: '@happier-dev/app',
    private: true,
    dependencies: { '@happier-dev/audio-stream-native': '0.0.0' },
  });
  await writeJson(join(root, 'apps', 'cli', 'package.json'), { name: '@happier-dev/cli', private: true });
  await writeJson(join(root, 'apps', 'server', 'package.json'), { name: '@happier-dev/server', private: true });

  const audioDir = join(root, 'packages', 'audio-stream-native');
  await mkdir(join(audioDir, 'src'), { recursive: true });
  await writeJson(join(audioDir, 'package.json'), {
    name: '@happier-dev/audio-stream-native',
    version: '0.0.0',
    main: './src/index.ts',
    types: './src/index.ts',
  });
  await writeFile(join(audioDir, 'src', 'index.ts'), "export * from './runtime';\n", 'utf-8');
  await new Promise((resolve) => setTimeout(resolve, 20));
  await writeFile(join(audioDir, 'src', 'runtime.ts'), 'export const current = true;\n', 'utf-8');

  const binDir = join(root, 'bin');
  const outputPath = join(root, 'argv.txt');
  await writeYarnWorkspaceBuildStub({ binDir, outputPath });
  applyEnvOverrides(t, {
    PATH: `${binDir}:/usr/bin:/bin`,
    OUTPUT_PATH: outputPath,
    HAPPIER_STACK_ENV_FILE: null,
  });

  await assert.doesNotReject(
    ensureWorkspacePackagesBuiltForComponent(join(root, 'apps', 'ui'), { quiet: true, env: process.env }),
  );
  assert.doesNotMatch(await readFile(outputPath, 'utf-8'), /packages\/audio-stream-native :: -s build/);
});

test('ensureWorkspacePackagesBuiltForComponent walks the full internal workspace dependency closure before building', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-ensure-workspaces-built-closure-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  await mkdir(join(root, 'apps', 'ui'), { recursive: true });
  await mkdir(join(root, 'apps', 'cli'), { recursive: true });
  await mkdir(join(root, 'apps', 'server'), { recursive: true });
  await writeJson(join(root, 'apps', 'ui', 'package.json'), {
    name: '@happier-dev/app',
    private: true,
    dependencies: {
      '@happier-dev/cli-common': '0.0.0',
    },
  });
  await writeJson(join(root, 'apps', 'cli', 'package.json'), { name: '@happier-dev/cli', private: true });
  await writeJson(join(root, 'apps', 'server', 'package.json'), { name: '@happier-dev/server', private: true });

  const cliCommonDir = join(root, 'packages', 'cli-common');
  const agentsDir = join(root, 'packages', 'agents');
  const protocolDir = join(root, 'packages', 'protocol');
  for (const dir of [cliCommonDir, agentsDir, protocolDir]) {
    await mkdir(dir, { recursive: true });
  }

  await writeJson(join(cliCommonDir, 'package.json'), {
    name: '@happier-dev/cli-common',
    version: '0.0.0',
    type: 'module',
    main: './dist/index.js',
    types: './dist/index.d.ts',
    exports: { '.': { default: './dist/index.js', types: './dist/index.d.ts' } },
    dependencies: {
      '@happier-dev/agents': '0.0.0',
    },
    scripts: { build: 'tsc -p tsconfig.json' },
  });
  await writeJson(join(agentsDir, 'package.json'), {
    name: '@happier-dev/agents',
    version: '0.0.0',
    type: 'module',
    main: './dist/index.js',
    types: './dist/index.d.ts',
    exports: { '.': { default: './dist/index.js', types: './dist/index.d.ts' } },
    dependencies: {
      '@happier-dev/protocol': '0.0.0',
    },
    scripts: { build: 'tsc -p tsconfig.json' },
  });
  await writeJson(join(protocolDir, 'package.json'), {
    name: '@happier-dev/protocol',
    version: '0.0.0',
    type: 'module',
    main: './dist/index.js',
    types: './dist/index.d.ts',
    exports: { '.': { default: './dist/index.js', types: './dist/index.d.ts' } },
    scripts: { build: 'tsc -p tsconfig.json' },
  });

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
  const orderedPackages = out
    .split('\n')
    .filter(Boolean)
    .filter((line) => line.includes(' :: -s build'))
    .map((line) => line.slice(line.indexOf('packages/')));

  assert.deepEqual(orderedPackages, [
    'packages/protocol :: -s build',
    'packages/agents :: -s build',
    'packages/cli-common :: -s build',
  ]);
  assert.equal(Boolean(await readFile(join(protocolDir, 'dist', 'index.js'), 'utf-8')), true);
  assert.equal(Boolean(await readFile(join(agentsDir, 'dist', 'index.js'), 'utf-8')), true);
  assert.equal(Boolean(await readFile(join(cliCommonDir, 'dist', 'index.js'), 'utf-8')), true);
});

test('ensureWorkspacePackagesBuiltForComponent resolves plugin workspaces from the root workspace manifest', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-ensure-workspaces-built-extensions-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  await mkdir(join(root, 'apps', 'ui'), { recursive: true });
  await mkdir(join(root, 'apps', 'cli'), { recursive: true });
  await mkdir(join(root, 'apps', 'server'), { recursive: true });
  await writeJson(join(root, 'package.json'), {
    name: 'repo',
    private: true,
    workspaces: {
      packages: [
        'apps/ui',
        'apps/cli',
        'apps/server',
        'packages/protocol',
        'packages/plugins/[a-z]*',
      ],
    },
  });
  await writeJson(join(root, 'apps', 'ui', 'package.json'), { name: '@happier-dev/app', private: true });
  await writeJson(join(root, 'apps', 'cli', 'package.json'), {
    name: '@happier-dev/cli',
    private: true,
    dependencies: {
      '@happier-dev/plugins-claude': '0.0.0',
    },
  });
  await writeJson(join(root, 'apps', 'server', 'package.json'), { name: '@happier-dev/server', private: true });

  const protocolDir = join(root, 'packages', 'protocol');
  const extensionDir = join(root, 'packages', 'plugins', 'claude');
  await mkdir(protocolDir, { recursive: true });
  await mkdir(extensionDir, { recursive: true });

  await writeJson(join(protocolDir, 'package.json'), {
    name: '@happier-dev/protocol',
    version: '0.0.0',
    type: 'module',
    main: './dist/index.js',
    types: './dist/index.d.ts',
    exports: { '.': { default: './dist/index.js', types: './dist/index.d.ts' } },
    scripts: { build: 'tsc -p tsconfig.json' },
  });
  await writeJson(join(extensionDir, 'package.json'), {
    name: '@happier-dev/plugins-claude',
    version: '0.0.0',
    type: 'module',
    main: './dist/index.js',
    types: './dist/index.d.ts',
    exports: { '.': { default: './dist/index.js', types: './dist/index.d.ts' } },
    dependencies: {
      '@happier-dev/protocol': '0.0.0',
    },
    scripts: { build: 'tsc -p tsconfig.json' },
  });

  const binDir = join(root, 'bin');
  const outputPath = join(root, 'argv.txt');
  await writeYarnWorkspaceBuildStub({ binDir, outputPath });

  applyEnvOverrides(t, {
    PATH: `${binDir}:/usr/bin:/bin`,
    OUTPUT_PATH: outputPath,
    HAPPIER_STACK_ENV_FILE: null,
  });

  await ensureWorkspacePackagesBuiltForComponent(join(root, 'apps', 'cli'), { quiet: true, env: process.env });

  const out = await readFile(outputPath, 'utf-8');
  const orderedPackages = out
    .split('\n')
    .filter(Boolean)
    .filter((line) => line.includes(' :: -s build'))
    .map((line) => line.slice(line.indexOf('packages/')));

  assert.deepEqual(orderedPackages, [
    'packages/protocol :: -s build',
    'packages/plugins/claude :: -s build',
  ]);
});

test('ensureWorkspacePackagesBuiltForComponent resolves TypeScript bin shims when repo root node_modules/.bin is missing', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-ensure-workspaces-built-tsc-shim-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  await mkdir(join(root, 'apps', 'ui'), { recursive: true });
  await mkdir(join(root, 'apps', 'cli'), { recursive: true });
  await mkdir(join(root, 'apps', 'server'), { recursive: true });
  await writeJson(join(root, 'package.json'), { name: 'repo', private: true });
  await writeFile(join(root, 'yarn.lock'), '# yarn\n', 'utf-8');
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
  await mkdir(join(protocolDir, 'dist'), { recursive: true });
  await writeJson(join(protocolDir, 'package.json'), {
    name: '@happier-dev/protocol',
    version: '0.0.0',
    type: 'module',
    main: './dist/index.js',
    types: './dist/index.d.ts',
    exports: {
      '.': { default: './dist/index.js', types: './dist/index.d.ts' },
    },
    scripts: { build: 'tsc -p tsconfig.json' },
  });
  await writeJson(join(protocolDir, 'tsconfig.json'), { compilerOptions: { outDir: 'dist' } });

  const repoTypescriptDir = join(root, 'node_modules', 'typescript');
  await mkdir(join(repoTypescriptDir, 'bin'), { recursive: true });
  await writeJson(join(repoTypescriptDir, 'package.json'), {
    name: 'typescript',
    version: '5.9.3',
    bin: {
      tsc: './bin/tsc.js',
    },
  });
  await writeFile(
    join(repoTypescriptDir, 'bin', 'tsc.js'),
    [
      '#!/usr/bin/env node',
      "const { mkdirSync, writeFileSync } = require('node:fs');",
      "const { join } = require('node:path');",
      'const out = process.env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR || join(process.cwd(), "dist");',
      'mkdirSync(out, { recursive: true });',
      'writeFileSync(join(out, "index.js"), "export const ok = true;\\n", "utf-8");',
      'writeFileSync(join(out, "index.d.ts"), "export declare const ok: boolean;\\n", "utf-8");',
    ].join('\n') + '\n',
    'utf-8',
  );
  await chmod(join(repoTypescriptDir, 'bin', 'tsc.js'), 0o755);

  const binDir = join(root, 'bin');
  const outputPath = join(root, 'argv.txt');
  await writeYarnWorkspaceBuildViaTscStub({ binDir, outputPath });

  applyEnvOverrides(t, {
    PATH: `${binDir}:/usr/bin:/bin`,
    OUTPUT_PATH: outputPath,
    HAPPIER_STACK_ENV_FILE: null,
  });

  await ensureWorkspacePackagesBuiltForComponent(join(root, 'apps', 'ui'), {
    quiet: true,
    env: process.env,
    admitPriorOutputsImmediately: true,
  });

  const out = await readFile(outputPath, 'utf-8');
  assert.match(out, /packages\/protocol :: -s build/);
  assert.equal(Boolean(await readFile(join(protocolDir, 'dist', 'index.js'), 'utf-8')), true);
});

test('ensureWorkspacePackagesBuiltForComponent does not run concurrent builds for the same workspace package', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-ensure-workspaces-built-concurrency-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  await mkdir(join(root, 'apps', 'ui'), { recursive: true });
  await mkdir(join(root, 'apps', 'cli'), { recursive: true });
  await mkdir(join(root, 'apps', 'server'), { recursive: true });
  await writeJson(join(root, 'apps', 'ui', 'package.json'), {
    name: '@happier-dev/app',
    private: true,
    dependencies: {
      '@happier-dev/cli-common': '0.0.0',
    },
  });
  await writeJson(join(root, 'apps', 'cli', 'package.json'), { name: '@happier-dev/cli', private: true });
  await writeJson(join(root, 'apps', 'server', 'package.json'), { name: '@happier-dev/server', private: true });

  const cliCommonDir = join(root, 'packages', 'cli-common');
  await mkdir(cliCommonDir, { recursive: true });
  await writeJson(join(cliCommonDir, 'package.json'), {
    name: '@happier-dev/cli-common',
    version: '0.0.0',
    type: 'module',
    main: './dist/index.js',
    types: './dist/index.d.ts',
    exports: { '.': { default: './dist/index.js', types: './dist/index.d.ts' } },
    scripts: { build: 'tsc -p tsconfig.json' },
  });
  await writeJson(join(cliCommonDir, 'tsconfig.json'), { compilerOptions: { outDir: 'dist' } });

  const binDir = join(root, 'bin');
  const outputPath = join(root, 'argv.txt');
  const lockOutputPath = join(root, 'lock-env.txt');
  await writeYarnWorkspaceBuildStub({
    binDir,
    outputPath,
    lockOutputPath,
    // Make the build slow enough that two concurrent callers would otherwise both decide to rebuild.
    delaySecondsByPackage: { cliCommon: 1 },
  });

  const stderrChunks = captureStderr(t);
  applyEnvOverrides(t, {
    PATH: `${binDir}:/usr/bin:/bin`,
    OUTPUT_PATH: outputPath,
    HAPPIER_STACK_ENV_FILE: null,
    HAPPIER_WORKSPACE_BUILD_NOTICE_AFTER_MS: '0',
    HAPPIER_WORKSPACE_BUILD_NOTICE_EVERY_MS: '999999',
  });

  await Promise.all([
    ensureWorkspacePackagesBuiltForComponent(join(root, 'apps', 'ui'), { quiet: true, env: process.env }),
    ensureWorkspacePackagesBuiltForComponent(join(root, 'apps', 'ui'), { quiet: true, env: process.env }),
  ]);

  const out = await readFile(outputPath, 'utf-8');
  const occurrences = out.split('\n').filter((l) => l.includes('/packages/cli-common :: -s build')).length;
  assert.equal(occurrences, 1);
  assert.match(stderrChunks.join(''), /waiting for @happier-dev\/cli-common dist build lock/);

  const lockOut = await readFile(lockOutputPath, 'utf-8');
  assert.match(lockOut, /packages\/cli-common :: .*\/\.project\/tmp\/workspace-dist-builds\/happier-dev-cli-common\.lock/);
});

test('CLI shared dependency preparation waits for the canonical workspace package publication owner', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-ensure-workspaces-built-cli-owner-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  await mkdir(join(root, 'apps', 'cli'), { recursive: true });
  await mkdir(join(root, 'apps', 'ui'), { recursive: true });
  await mkdir(join(root, 'apps', 'server'), { recursive: true });
  await writeJson(join(root, 'package.json'), {
    private: true,
    workspaces: ['apps/*', 'packages/*'],
  });
  await writeFile(join(root, 'yarn.lock'), '# yarn\n', 'utf-8');
  await writeJson(join(root, 'apps', 'cli', 'package.json'), {
    name: '@happier-dev/cli',
    private: true,
    dependencies: { '@happier-dev/protocol': '0.0.0' },
  });
  await writeJson(join(root, 'apps', 'ui', 'package.json'), { name: '@happier-dev/app', private: true });
  await writeJson(join(root, 'apps', 'server', 'package.json'), { name: '@happier-dev/server', private: true });

  const protocolDir = join(root, 'packages', 'protocol');
  await mkdir(join(protocolDir, 'src'), { recursive: true });
  await mkdir(join(protocolDir, 'dist'), { recursive: true });
  await writeJson(join(protocolDir, 'package.json'), {
    name: '@happier-dev/protocol',
    version: '0.0.0',
    type: 'module',
    exports: { '.': { default: './dist/index.js', types: './dist/index.d.ts' } },
    scripts: { build: 'tsc -p tsconfig.json' },
  });
  await writeFile(join(protocolDir, 'src', 'index.ts'), 'export const next = true;\n', 'utf-8');
  await writeFile(join(protocolDir, 'dist', 'index.js'), "import './missing.js';\n", 'utf-8');
  await writeFile(join(protocolDir, 'dist', 'index.d.ts'), 'export declare const previous: boolean;\n', 'utf-8');

  const binDir = join(root, 'bin');
  const outputPath = join(root, 'argv.txt');
  const buildStartedPath = join(root, 'build-started');
  const buildReleasePath = join(root, 'build-release');
  await mkdir(binDir, { recursive: true });
  await writeFile(
    join(binDir, 'yarn'),
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'echo "$(pwd) :: $*" >> "${OUTPUT_PATH:?}"',
      'if [[ "${1:-}" == "--version" ]]; then echo "1.22.22"; exit 0; fi',
      'if [[ "${1:-}" == "-s" && "${2:-}" == "build" && "$(pwd)" == */packages/protocol ]]; then',
      '  touch "${BUILD_STARTED_PATH:?}"',
      '  while [[ ! -f "${BUILD_RELEASE_PATH:?}" ]]; do sleep 0.02; done',
      '  out="${HAPPIER_WORKSPACE_DIST_OUTPUT_DIR:-dist}"',
      '  mkdir -p "$out"',
      "  printf '%s\\n' 'export const built = true;' > \"$out/index.js\"",
      "  printf '%s\\n' 'export declare const built: boolean;' > \"$out/index.d.ts\"",
      'fi',
      'exit 0',
    ].join('\n') + '\n',
    'utf-8',
  );
  await chmod(join(binDir, 'yarn'), 0o755);
  await writeFile(outputPath, '', 'utf-8');

  applyEnvOverrides(t, {
    PATH: `${binDir}:/usr/bin:/bin`,
    OUTPUT_PATH: outputPath,
    BUILD_STARTED_PATH: buildStartedPath,
    BUILD_RELEASE_PATH: buildReleasePath,
    HAPPIER_STACK_ENV_FILE: null,
  });

  const canonicalBuild = ensureWorkspacePackagesBuiltForComponent(join(root, 'apps', 'cli'), {
    quiet: true,
    env: process.env,
  });
  let bypassCompileStarted = false;
  let cliPreparation;
  let assertionError = null;
  try {
    await waitForFile(buildStartedPath);
    cliPreparation = buildBundledWorkspaceDependenciesForCli({
      repoRoot: root,
      workspaceNames: ['protocol'],
      runWorkspaceArtifactBuildImpl: () => false,
      runTscImpl: () => {
        bypassCompileStarted = true;
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(
      bypassCompileStarted,
      false,
      'CLI must not bypass the canonical per-package owner with its own direct compiler writer',
    );
  } catch (error) {
    assertionError = error;
  } finally {
    await writeFile(buildReleasePath, 'release\n', 'utf-8');
    await Promise.allSettled([canonicalBuild, cliPreparation]);
  }
  if (assertionError) throw assertionError;

  const output = await readFile(outputPath, 'utf-8');
  assert.equal(
    output.split('\n').filter((line) => line.includes('/packages/protocol :: -s build')).length,
    1,
  );
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

  await ensureWorkspacePackagesBuiltForComponent(join(root, 'apps', 'ui'), {
    quiet: true,
    env: process.env,
    admitPriorOutputsImmediately: true,
  });

  const out = await readFile(outputPath, 'utf-8');
  assert.match(out, /packages\/protocol :: -s build/);
  assert.equal(Boolean(await readFile(join(protocolDir, 'dist', 'machineTransfer', 'transferStream.js'), 'utf-8')), true);
});

test('ensureWorkspacePackagesBuiltForComponent admits structurally runnable prior outputs before refreshing stale inputs', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-ensure-workspaces-built-prior-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  await mkdir(join(root, 'apps', 'ui'), { recursive: true });
  await mkdir(join(root, 'apps', 'cli'), { recursive: true });
  await mkdir(join(root, 'apps', 'server'), { recursive: true });
  await writeJson(join(root, 'apps', 'ui', 'package.json'), {
    name: '@happier-dev/app',
    private: true,
    dependencies: { '@happier-dev/protocol': '0.0.0' },
  });
  await writeJson(join(root, 'apps', 'cli', 'package.json'), { name: '@happier-dev/cli', private: true });
  await writeJson(join(root, 'apps', 'server', 'package.json'), { name: '@happier-dev/server', private: true });

  const protocolDir = join(root, 'packages', 'protocol');
  await mkdir(join(protocolDir, 'src'), { recursive: true });
  await mkdir(join(protocolDir, 'dist'), { recursive: true });
  await writeJson(join(protocolDir, 'package.json'), {
    name: '@happier-dev/protocol',
    version: '0.0.0',
    type: 'module',
    exports: { '.': { default: './dist/index.js', types: './dist/index.d.ts' } },
    scripts: { build: 'tsc -p tsconfig.json' },
  });
  await writeFile(join(protocolDir, 'dist', 'index.js'), 'export const prior = true;\n', 'utf-8');
  await writeFile(join(protocolDir, 'dist', 'index.d.ts'), 'export declare const prior: boolean;\n', 'utf-8');
  await writeFile(join(protocolDir, 'src', 'index.ts'), 'export const current = true;\n', 'utf-8');
  const baseTime = Date.now();
  await utimes(join(protocolDir, 'dist', 'index.js'), new Date(baseTime - 20_000), new Date(baseTime - 20_000));
  await utimes(join(protocolDir, 'dist', 'index.d.ts'), new Date(baseTime - 20_000), new Date(baseTime - 20_000));
  await utimes(join(protocolDir, 'src', 'index.ts'), new Date(baseTime), new Date(baseTime));

  const binDir = join(root, 'bin');
  const outputPath = join(root, 'argv.txt');
  await writeYarnWorkspaceBuildStub({ binDir, outputPath });
  applyEnvOverrides(t, {
    PATH: `${binDir}:/usr/bin:/bin`,
    OUTPUT_PATH: outputPath,
    HAPPIER_STACK_ENV_FILE: null,
  });

  const admitted = await ensureWorkspacePackagesBuiltForComponentCanonical(
    join(root, 'apps', 'ui'),
    {
      quiet: true,
      env: process.env,
      admitPriorOutputsImmediately: true,
    },
  );

  assert.deepEqual(admitted.built, []);
  assert.equal(await readFile(join(protocolDir, 'dist', 'index.js'), 'utf-8'), 'export const prior = true;\n');
  assert.doesNotMatch(await readFile(outputPath, 'utf-8'), /packages\/protocol :: -s build/);
});

test('ensureWorkspacePackagesBuiltForComponent tolerates transient missing local imports while another local build finishes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-ensure-workspaces-built-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

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
  await mkdir(join(protocolDir, 'dist'), { recursive: true });
  await writeJson(join(protocolDir, 'package.json'), {
    name: '@happier-dev/protocol',
    version: '0.0.0',
    type: 'module',
    main: './dist/index.js',
    types: './dist/index.d.ts',
    exports: {
      '.': { default: './dist/index.js', types: './dist/index.d.ts' },
    },
    scripts: { build: 'tsc -p tsconfig.json' },
  });
  await writeJson(join(protocolDir, 'tsconfig.json'), { compilerOptions: { outDir: 'dist' } });
  await writeFile(
    join(protocolDir, 'dist', 'index.js'),
    "export * from './machineTransfer/transferStream.js';\n",
    'utf-8',
  );
  await writeFile(join(protocolDir, 'dist', 'index.d.ts'), "export declare const ok: boolean;\n", 'utf-8');

  const binDir = join(root, 'bin');
  const outputPath = join(root, 'argv.txt');
  await writeYarnWorkspaceBuildStub({ binDir, outputPath });

  const stderrChunks = captureStderr(t);
  applyEnvOverrides(t, {
    PATH: `${binDir}:/usr/bin:/bin`,
    OUTPUT_PATH: outputPath,
    HAPPIER_STACK_ENV_FILE: null,
    HAPPIER_WORKSPACE_DIST_IMPORT_VALIDATION_RETRY_ATTEMPTS: '8',
    HAPPIER_WORKSPACE_DIST_IMPORT_VALIDATION_RETRY_DELAY_MS: '25',
    HAPPIER_WORKSPACE_BUILD_NOTICE_AFTER_MS: '0',
    HAPPIER_WORKSPACE_BUILD_NOTICE_EVERY_MS: '999999',
  });

  const transientBuild = setTimeout(async () => {
    await mkdir(join(protocolDir, 'dist', 'machineTransfer'), { recursive: true });
    await writeFile(join(protocolDir, 'dist', 'machineTransfer', 'transferStream.js'), 'export const ok = true;\n', 'utf-8');
  }, 40);
  t.after(() => clearTimeout(transientBuild));

  await ensureWorkspacePackagesBuiltForComponent(join(root, 'apps', 'ui'), { quiet: true, env: process.env });

  const out = await readFile(outputPath, 'utf-8');
  assert.doesNotMatch(out, /packages\/protocol :: -s build/);
  assert.equal(Boolean(await readFile(join(protocolDir, 'dist', 'machineTransfer', 'transferStream.js'), 'utf-8')), true);
  if (stderrChunks.length > 0) {
    assert.match(stderrChunks.join(''), /waiting for @happier-dev\/protocol dist build local imports to settle/);
  }
});

test('ensureWorkspacePackagesBuiltForComponent keeps previous dist readable while rebuilding a workspace package', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-ensure-workspaces-built-live-dist-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  await mkdir(join(root, 'apps', 'cli'), { recursive: true });
  await mkdir(join(root, 'apps', 'ui'), { recursive: true });
  await mkdir(join(root, 'apps', 'server'), { recursive: true });
  await writeJson(join(root, 'apps', 'cli', 'package.json'), {
    name: '@happier-dev/cli',
    private: true,
    dependencies: {
      '@happier-dev/protocol': '0.0.0',
    },
  });
  await writeJson(join(root, 'apps', 'ui', 'package.json'), { name: '@happier-dev/app', private: true });
  await writeJson(join(root, 'apps', 'server', 'package.json'), { name: '@happier-dev/server', private: true });

  const protocolDir = join(root, 'packages', 'protocol');
  await mkdir(join(protocolDir, 'dist'), { recursive: true });
  await writeJson(join(protocolDir, 'package.json'), {
    name: '@happier-dev/protocol',
    version: '0.0.0',
    type: 'module',
    exports: { '.': { default: './dist/index.js', types: './dist/index.d.ts' } },
    scripts: { build: 'tsc -p tsconfig.json' },
  });
  await writeJson(join(protocolDir, 'tsconfig.json'), { compilerOptions: { outDir: 'dist' } });
  await writeFile(
    join(protocolDir, 'dist', 'index.js'),
    "export const stable = true;\nimport './missing.js';\n",
    'utf-8',
  );
  await writeFile(join(protocolDir, 'dist', 'index.d.ts'), 'export declare const stable: boolean;\n', 'utf-8');

  const binDir = join(root, 'bin');
  const outputPath = join(root, 'argv.txt');
  const markerPath = join(root, 'build-started');
  const releasePath = join(root, 'release-build');
  await mkdir(binDir, { recursive: true });
  await writeFile(
    join(binDir, 'yarn'),
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'echo "$(pwd) :: $* :: out=${HAPPIER_WORKSPACE_DIST_OUTPUT_DIR:-dist}" >> "${OUTPUT_PATH:?}"',
      'if [[ "${1:-}" == "--version" ]]; then echo "1.22.22"; exit 0; fi',
      'if [[ "${1:-}" == "-s" && "${2:-}" == "build" && "$(pwd)" == */packages/protocol ]]; then',
      '  out="${HAPPIER_WORKSPACE_DIST_OUTPUT_DIR:-dist}"',
      '  rm -rf "$out"',
      `  printf started > ${JSON.stringify(markerPath)}`,
      `  while [[ ! -f ${JSON.stringify(releasePath)} ]]; do sleep 0.02; done`,
      '  mkdir -p "$out"',
      "  printf '%s\\n' 'export const built = true;' > \"$out/index.js\"",
      "  printf '%s\\n' 'export declare const built: boolean;' > \"$out/index.d.ts\"",
      '  exit 0',
      'fi',
      'exit 0',
    ].join('\n') + '\n',
    'utf-8',
  );
  await chmod(join(binDir, 'yarn'), 0o755);
  await writeFile(outputPath, '', 'utf-8');

  applyEnvOverrides(t, {
    PATH: `${binDir}:/usr/bin:/bin`,
    OUTPUT_PATH: outputPath,
    HAPPIER_STACK_ENV_FILE: null,
  });

  const buildPromise = ensureWorkspacePackagesBuiltForComponent(join(root, 'apps', 'cli'), {
    quiet: true,
    env: process.env,
  });

  let assertionError = null;
  try {
    await waitForFile(markerPath, { timeoutMs: 12_000 });
    assert.equal(
      await readFile(join(protocolDir, 'dist', 'index.js'), 'utf-8'),
      "export const stable = true;\nimport './missing.js';\n",
    );
  } catch (error) {
    assertionError = error;
  } finally {
    await writeFile(releasePath, '1', 'utf-8');
    await buildPromise.catch(() => {});
  }
  if (assertionError) throw assertionError;

  await buildPromise;
  assert.equal(await readFile(join(protocolDir, 'dist', 'index.js'), 'utf-8'), 'export const built = true;\n');
  const buildLine = (await readFile(outputPath, 'utf-8'))
    .split('\n')
    .find((line) => line.includes('/packages/protocol :: -s build'));
  assert.ok(buildLine, 'expected the protocol package build to run');
  assert.match(buildLine, /out=.*\/packages\/protocol\/\.tmp\./);
  assert.doesNotMatch(buildLine, /out=dist(?:\s|$)/);
});
