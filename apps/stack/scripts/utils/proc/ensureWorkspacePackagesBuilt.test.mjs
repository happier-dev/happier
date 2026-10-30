import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, cp, mkdtemp, mkdir, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { ensureWorkspacePackagesBuiltForComponent } from './pm.mjs';
import {
  ensureWorkspacePackagesBuiltForComponent as ensureWorkspacePackagesBuiltForComponentCanonical,
} from '../../../../../scripts/workspaces/ensureWorkspacePackagesBuilt.mjs';
import { buildBundledWorkspaceDependenciesForCli } from '../../../../cli/scripts/buildSharedDeps.mjs';
import { installWorkspaceAdmissionProcessFixture } from '../../testkit/core/native_admission_fixture.mjs';
import { runWorkspaceBuildAdmission } from './workspace_build_admission.mjs';
import { withPatchedProcessEnv } from '../../testkit/core/env_scope.mjs';

test('native workspace fixture routes serialized foreground custody to its isolated admission owner',
  { skip: process.platform !== 'linux' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'hs-native-custody-routing-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const childProcess = createRequire(import.meta.url)('node:child_process');
  const originalFork = childProcess.fork;
  const procPath = fileURLToPath(new URL('./proc.mjs', import.meta.url));
  const canonicalLauncher = fileURLToPath(new URL('../../../bin/hstack-exec', import.meta.url));
  let fixtureLauncher;
  // This is the real OS launch boundary. Refuse a wrong-host request before
  // it can enter the containing suite's admission domain.
  childProcess.fork = (modulePath, args, options) => {
    if (modulePath === procPath && args[0] === '--happier-foreground-custody') {
      const invocation = JSON.parse(args[1]);
      if (invocation.args.includes(canonicalLauncher) || invocation.args.includes(fixtureLauncher)) {
        assert.ok(invocation.args.includes(fixtureLauncher), 'foreground custody escaped the fixture admission owner');
      }
    }
    return originalFork(modulePath, args, options);
  };
  syncBuiltinESMExports();
  const guardPath = join(root, 'guard-native-domain.mjs');
  await writeFile(guardPath, `
    import {createRequire,syncBuiltinESMExports} from 'node:module';
    const cp=createRequire(import.meta.url)('node:child_process'), fork=cp.fork;
    cp.fork=(modulePath,args,options)=>{
      if(modulePath===${JSON.stringify(procPath)} && args[0]==='--happier-foreground-custody') {
        const invocation=JSON.parse(args[1]);
        if(invocation.args.includes(${JSON.stringify(canonicalLauncher)}))
          throw new Error('child foreground custody escaped fixture admission');
      }
      return fork(modulePath,args,options);
    };
    syncBuiltinESMExports();
    globalThis.fixtureGuardLoaded = true;
  `);
  withPatchedProcessEnv(t, { NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${pathToFileURL(guardPath).href}`.trim() });
  const native = await installWorkspaceAdmissionProcessFixture(t, root);
  fixtureLauncher = native.launcher;
  t.after(() => { childProcess.fork = originalFork; syncBuiltinESMExports(); });
  const result = await runWorkspaceBuildAdmission({ command: process.execPath,
    args: ['-e', 'process.stdout.write(process.env.HAPPIER_HEAVYWEIGHT_ADMISSION_ROOT)'],
    env: native.env, stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, native.admissionRoot);
  const nested = await runWorkspaceBuildAdmission({ command: process.execPath,
    args: ['--input-type=module', '-e', `
      import {runWorkspaceBuildAdmission} from ${JSON.stringify(new URL('./workspace_build_admission.mjs', import.meta.url).href)};
      if(!globalThis.fixtureGuardLoaded) throw new Error('existing NODE_OPTIONS preload was lost');
      const result=await runWorkspaceBuildAdmission({command:process.execPath,
        args:['-e','process.stdout.write(process.env.HAPPIER_HEAVYWEIGHT_ADMISSION_ROOT)'],
        env:process.env,stdio:['ignore','pipe','pipe']});
      if(result.status!==0) throw new Error(result.stderr || result.error?.message || 'nested admission failed');
      process.stdout.write(result.stdout);
    `], env: native.env,
    stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(nested.status, 0, nested.stderr);
  assert.equal(nested.stdout, native.admissionRoot);
});

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

async function writePnpmWorkspace(root, { workspaces = ['apps/*', 'packages/*'], ...manifest } = {}) {
  await writeJson(join(root, 'package.json'), { private: true, ...manifest,
    packageManager: JSON.parse(await readFile(new URL('../../../../../package.json', import.meta.url), 'utf8')).packageManager });
  await writeFile(join(root, 'pnpm-workspace.yaml'), `packages:\n${workspaces.map(pattern => `  - ${JSON.stringify(pattern)}`).join('\n')}\n`);
}

async function writePnpmWorkspaceBuildStub({ binDir, outputPath, lockOutputPath = null, delaySecondsByPackage = {} }) {
  await mkdir(binDir, { recursive: true });
  const pnpmPath = join(binDir, 'pnpm');
  const delayCliCommon = Number(delaySecondsByPackage?.cliCommon ?? 0);
  const delayProtocol = Number(delaySecondsByPackage?.protocol ?? 0);
  const delayAgents = Number(delaySecondsByPackage?.agents ?? 0);
  await writeFile(
    pnpmPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'echo "$(pwd) :: $*" >> "${OUTPUT_PATH:?}"',
      lockOutputPath ? `echo "$(pwd) :: \${HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD:-}" >> ${JSON.stringify(lockOutputPath)}` : '',
      '',
      'if [[ "${1:-}" == "--version" ]]; then',
      '  echo "12.14.0"',
      '  exit 0',
      'fi',
      '',
      '# Simulate `pnpm run --silent build` creating dist outputs for workspace packages.',
      'if [[ "${1:-}" == "run" && "${2:-}" == "--silent" && "${3:-}" == "build" ]]; then',
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
  await chmod(pnpmPath, 0o755);
  await writeFile(outputPath, '', 'utf-8');
}

async function writePnpmWorkspaceBuildViaTscStub({ binDir, outputPath }) {
  await mkdir(binDir, { recursive: true });
  const pnpmPath = join(binDir, 'pnpm');
  await writeFile(
    pnpmPath,
    [
      '#!/usr/bin/env node',
      "const { appendFileSync, existsSync, mkdirSync, writeFileSync } = require('node:fs');",
      "const { join } = require('node:path');",
      "const { spawnSync } = require('node:child_process');",
      'const args = process.argv.slice(2);',
      'appendFileSync(process.env.OUTPUT_PATH, `${process.cwd()} :: ${args.join(" ")}\\n`, "utf-8");',
      'if (args.includes("--version")) {',
      '  console.log("12.14.0");',
      '  process.exit(0);',
      '}',
      'if (args[0] === "run" && args[1] === "--silent" && args[2] === "build") {',
      '  const result = spawnSync("tsc", ["-p", "tsconfig.json"], { cwd: process.cwd(), env: process.env, stdio: "inherit" });',
      '  if (result.error) throw result.error;',
      '  process.exit(result.status ?? 0);',
      '}',
      'process.exit(0);',
    ].join('\n') + '\n',
    'utf-8',
  );
  await chmod(pnpmPath, 0o755);
  await writeFile(outputPath, '', 'utf-8');
}

async function applyEnvOverrides(t, root, vars) {
  try {
    await readFile(join(root, 'pnpm-workspace.yaml'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await writePnpmWorkspace(root);
  }
  const native = await installWorkspaceAdmissionProcessFixture(t, root);
  const removed = Object.fromEntries(Object.keys(process.env).filter(key => !(key in native.env)).map(key => [key, null]));
  vars = { ...removed, ...native.env, npm_execpath: '', npm_node_execpath: '', ...vars,
    PATH: native.launcher ? `${native.binDir}${delimiter}${vars.PATH}` : vars.PATH };
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

async function linkNativeWorkspaceTools(binDir) {
  if (process.platform === 'win32') return;
  const tools = process.platform === 'linux'
    ? ['uname', 'mkdir', 'stat', 'id', 'sed', 'awk', 'mktemp', 'mkfifo', 'rm', 'rmdir', 'flock', 'date', 'sleep', 'df', 'ps', 'tr', 'cat', 'du', 'node']
    : ['uname', 'node'];
  for (const tool of tools) {
    const resolved = tool === 'node' ? { status: 0, stdout: process.execPath }
      : spawnSync('/bin/sh', ['-c', 'command -v "$1"', 'fixture-tool', tool], { encoding: 'utf8', env: process.env });
    assert.equal(resolved.status, 0, `native fixture tool is unavailable: ${tool}`);
    await symlink(resolved.stdout.trim(), join(binDir, tool));
  }
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
  await writePnpmWorkspace(root, {
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
    buildArgs: ['run', '--silent', 'build'],
  });

  const native = await installWorkspaceAdmissionProcessFixture(t, root);
  await linkNativeWorkspaceTools(binDir);
  const env = {
    ...native.env,
    PATH: native.launcher ? `${native.binDir}${delimiter}${binDir}` : binDir,
    HAPPIER_STACK_BINARY_MODE: packageManager === 'npm' ? '1' : '0',
    HAPPIER_STACK_ENV_FILE: '',
    HAPPIER_STACK_WORKSPACE_TEST_SECRET: 'must-not-escape',
    npm_execpath: '',
    npm_node_execpath: '',
  };
  if (packageManager === 'npm') {
    // Isolate sibling package-manager discovery without inventing a missing
    // executable: the synthetic runtime directory still contains real Node.
    const originalExecPath = process.execPath;
    const fixtureExecPath = join(root, 'fixture-node-bin', process.platform === 'win32' ? 'node.exe' : 'node');
    await mkdir(join(fixtureExecPath, '..'), { recursive: true });
    if (process.platform === 'win32') await cp(originalExecPath, fixtureExecPath);
    else {
      await symlink(originalExecPath, fixtureExecPath);
    }
    process.execPath = fixtureExecPath;
    t.after(() => { process.execPath = originalExecPath; });
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

test('Stack Pnpm workspace build failures retain bounded child diagnostics', async (t) => {
  await assertQuietStackWorkspaceBuildFailureDiagnostics(t, 'pnpm');
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
  await writePnpmWorkspaceBuildStub({ binDir, outputPath });

  await applyEnvOverrides(t, root, {
    PATH: `${binDir}:/usr/bin:/bin`,
    OUTPUT_PATH: outputPath,
    HAPPIER_STACK_ENV_FILE: null,
  });

  await ensureWorkspacePackagesBuiltForComponent(join(root, 'apps', 'ui'), {
    quiet: true,
    env: process.env,
  });

  const out = await readFile(outputPath, 'utf-8');
  assert.match(out, /packages\/protocol :: run --silent build/);
  assert.equal(Boolean(await readFile(join(protocolDir, 'dist', 'rpcErrors.js'), 'utf-8')), true);
  const preservedOutputTime = new Date(Date.now() - 60_000);
  await utimes(join(protocolDir, 'dist', 'index.d.ts'), preservedOutputTime, preservedOutputTime);

  // Currentness is content-based: aging unchanged bytes does not rebuild them.
  await ensureWorkspacePackagesBuiltForComponent(join(root, 'apps', 'ui'), { quiet: true, env: process.env });
  const out2 = await readFile(outputPath, 'utf-8');
  const occurrences = out2.split('\n').filter((l) => l.includes('/packages/protocol :: run --silent build')).length;
  assert.equal(occurrences, 1);

  // Source freshness is part of output validity, not an adapter concern.
  await new Promise((resolve) => setTimeout(resolve, 20));
  await mkdir(join(protocolDir, 'src'), { recursive: true });
  await writeFile(join(protocolDir, 'src', 'index.ts'), 'export const changed = true;\n', 'utf-8');
  await ensureWorkspacePackagesBuiltForComponent(join(root, 'apps', 'ui'), { quiet: true, env: process.env });
  const out3 = await readFile(outputPath, 'utf-8');
  const occurrencesAfterSourceChange = out3.split('\n').filter((l) => l.includes('/packages/protocol :: run --silent build')).length;
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
  const finalOccurrences = finalOut.split('\n').filter((l) => l.includes('/packages/protocol :: run --silent build')).length;
  assert.equal(finalOccurrences, 4, 'source/config/package changes rebuild, while unchanged output timestamps and test-only source do not');
});

test('ensureWorkspacePackagesBuiltForComponent builds unscoped internal workspace dependencies', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-ensure-unscoped-workspace-built-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  await writePnpmWorkspace(root, {
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
        buildCalls.push(JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf-8')).name);
        const outputDir = env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR;
        assert.ok(outputDir);
        await mkdir(outputDir, { recursive: true });
        await writeFile(join(outputDir, 'index.js'), 'export const privacy = true;\n', 'utf-8');
      },
    },
  });

  assert.deepEqual(buildCalls, ['privacy-kit']);
  assert.deepEqual(result.built, ['privacy-kit']);
  assert.equal(await readFile(join(privacyKitDir, 'dist', 'index.js'), 'utf-8'), 'export const privacy = true;\n');
});

test('ensureWorkspacePackagesBuiltForComponent uses inherited Pnpm JS entrypoint when PATH has no Pnpm shim', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-inherited-pnpm-entrypoint-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const uiDir = join(root, 'apps', 'ui');
  const protocolDir = join(root, 'packages', 'protocol');
  await mkdir(uiDir, { recursive: true });
  await mkdir(join(root, 'apps', 'cli'), { recursive: true });
  await mkdir(join(root, 'apps', 'server'), { recursive: true });
  await mkdir(protocolDir, { recursive: true });
  await writePnpmWorkspace(root, {
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
      build: 'unused-by-fake-pnpm',
    },
  });

  const binDir = join(root, 'path-without-pnpm');
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

  const pnpmEntrypointDir = join(root, 'inherited package manager');
  const pnpmEntrypointPath = join(pnpmEntrypointDir, 'pnpm entrypoint.cjs');
  const invocationLogPath = join(root, 'pnpm-invocations.jsonl');
  await mkdir(pnpmEntrypointDir, { recursive: true });
  await writeFile(
    pnpmEntrypointPath,
    [
      "const { appendFileSync, mkdirSync, writeFileSync } = require('node:fs');",
      "const { join } = require('node:path');",
      'const args = process.argv.slice(2);',
      'appendFileSync(process.env.PNPM_INVOCATION_LOG, `${JSON.stringify(args)}\\n`, "utf-8");',
      'if (args.length === 1 && args[0] === "--version") {',
      '  process.stdout.write("12.14.0\\n");',
      '  process.exit(0);',
      '}',
      'if (args.length === 3 && args[0] === "run" && args[1] === "--silent" && args[2] === "build") {',
      '  const outDir = process.env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR || join(process.cwd(), "dist");',
      '  mkdirSync(outDir, { recursive: true });',
      '  writeFileSync(join(outDir, "index.js"), "export const inheritedPnpmBuild = true;\\n", "utf-8");',
      '  writeFileSync(join(outDir, "index.d.ts"), "export declare const inheritedPnpmBuild: boolean;\\n", "utf-8");',
      '  process.exit(0);',
      '}',
      'process.exit(92);',
    ].join('\n') + '\n',
    'utf-8',
  );

  const native = await installWorkspaceAdmissionProcessFixture(t, root);
  await linkNativeWorkspaceTools(binDir);
  const env = {
    ...native.env,
    PATH: native.launcher ? `${native.binDir}${delimiter}${binDir}` : binDir,
    npm_execpath: pnpmEntrypointPath,
    PNPM_INVOCATION_LOG: invocationLogPath,
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
      ['run', '--silent', 'build'],
    ],
  );
  assert.equal(
    await readFile(join(protocolDir, 'dist', 'index.js'), 'utf-8'),
    'export const inheritedPnpmBuild = true;\n',
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
  await writePnpmWorkspace(root, {
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
  await writePnpmWorkspaceBuildStub({ binDir, outputPath });
  await applyEnvOverrides(t, root, {
    PATH: `${binDir}:/usr/bin:/bin`,
    OUTPUT_PATH: outputPath,
    HAPPIER_STACK_ENV_FILE: null,
  });

  await assert.doesNotReject(
    ensureWorkspacePackagesBuiltForComponent(join(root, 'apps', 'ui'), { quiet: true, env: process.env }),
  );
  assert.doesNotMatch(await readFile(outputPath, 'utf-8'), /packages\/audio-stream-native :: run --silent build/);
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
  await writePnpmWorkspaceBuildStub({ binDir, outputPath });

  await applyEnvOverrides(t, root, {
    PATH: `${binDir}:/usr/bin:/bin`,
    OUTPUT_PATH: outputPath,
    HAPPIER_STACK_ENV_FILE: null,
  });

  await ensureWorkspacePackagesBuiltForComponent(join(root, 'apps', 'ui'), { quiet: true, env: process.env });

  const out = await readFile(outputPath, 'utf-8');
  const orderedPackages = out
    .split('\n')
    .filter(Boolean)
    .filter((line) => line.includes(' :: run --silent build'))
    .map((line) => line.slice(line.indexOf('packages/')));

  assert.deepEqual(orderedPackages, [
    'packages/protocol :: run --silent build',
    'packages/agents :: run --silent build',
    'packages/cli-common :: run --silent build',
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
  await writePnpmWorkspace(root, {
    name: 'repo',
    private: true,
    workspaces: [
        'apps/ui',
        'apps/cli',
        'apps/server',
        'packages/protocol',
        'packages/plugins/[a-z]*',
    ],
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
  await writePnpmWorkspaceBuildStub({ binDir, outputPath });

  await applyEnvOverrides(t, root, {
    PATH: `${binDir}:/usr/bin:/bin`,
    OUTPUT_PATH: outputPath,
    HAPPIER_STACK_ENV_FILE: null,
  });

  await ensureWorkspacePackagesBuiltForComponent(join(root, 'apps', 'cli'), { quiet: true, env: process.env });

  const out = await readFile(outputPath, 'utf-8');
  const orderedPackages = out
    .split('\n')
    .filter(Boolean)
    .filter((line) => line.includes(' :: run --silent build'))
    .map((line) => line.slice(line.indexOf('packages/')));

  assert.deepEqual(orderedPackages, [
    'packages/protocol :: run --silent build',
    'packages/plugins/claude :: run --silent build',
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
  await writePnpmWorkspace(root, { name: 'repo', private: true });
  await writeFile(join(root, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n", 'utf-8');
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
  await writePnpmWorkspaceBuildViaTscStub({ binDir, outputPath });

  await applyEnvOverrides(t, root, {
    PATH: `${binDir}:/usr/bin:/bin`,
    OUTPUT_PATH: outputPath,
    HAPPIER_STACK_ENV_FILE: null,
  });

  await ensureWorkspacePackagesBuiltForComponent(join(root, 'apps', 'ui'), {
    quiet: true,
    env: process.env,
  });

  const out = await readFile(outputPath, 'utf-8');
  assert.match(out, /packages\/protocol :: run --silent build/);
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
  await writePnpmWorkspaceBuildStub({
    binDir,
    outputPath,
    lockOutputPath,
    // Make the build slow enough that two concurrent callers would otherwise both decide to rebuild.
    delaySecondsByPackage: { cliCommon: 1 },
  });

  await applyEnvOverrides(t, root, {
    PATH: `${binDir}:/usr/bin:/bin`,
    OUTPUT_PATH: outputPath,
    HAPPIER_STACK_ENV_FILE: null,
    HAPPIER_WORKSPACE_BUILD_NOTICE_AFTER_MS: '0',
    HAPPIER_WORKSPACE_BUILD_NOTICE_EVERY_MS: '999999',
  });

  const env = process.env;
  const publicationResults = [];
  const options = { quiet: true, env, onPackageBuildResult: result => { publicationResults.push(result); } };
  const builds = [
    ensureWorkspacePackagesBuiltForComponent(join(root, 'apps', 'ui'), options),
    ensureWorkspacePackagesBuiltForComponent(join(root, 'apps', 'ui'), options),
  ];
  try {
    await Promise.all(builds);
  } finally {
    await Promise.allSettled(builds);
  }

  const out = await readFile(outputPath, 'utf-8');
  const occurrences = out.split('\n').filter((l) => l.includes('/packages/cli-common :: run --silent build')).length;
  assert.equal(occurrences, 1);
  assert.ok(publicationResults.some(result => result.packageName === '@happier-dev/cli-common'
    && result.reason === 'concurrent_build_already_completed'),
    'the second preparer must observe the completed canonical publication after waiting');

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
  await writePnpmWorkspace(root, {
    private: true,
    workspaces: ['apps/*', 'packages/*'],
  });
  await writeFile(join(root, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n", 'utf-8');
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
    join(binDir, 'pnpm'),
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'echo "$(pwd) :: $*" >> "${OUTPUT_PATH:?}"',
      'if [[ "${1:-}" == "--version" ]]; then echo "12.14.0"; exit 0; fi',
      'if [[ "${1:-}" == "run" && "${2:-}" == "--silent" && "${3:-}" == "build" && "$(pwd)" == */packages/protocol ]]; then',
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
  await chmod(join(binDir, 'pnpm'), 0o755);
  await writeFile(outputPath, '', 'utf-8');

  await applyEnvOverrides(t, root, {
    PATH: `${binDir}:/usr/bin:/bin`,
    OUTPUT_PATH: outputPath,
    BUILD_STARTED_PATH: buildStartedPath,
    BUILD_RELEASE_PATH: buildReleasePath,
    HAPPIER_STACK_ENV_FILE: null,
  });

  const env = process.env;
  const canonicalBuild = ensureWorkspacePackagesBuiltForComponent(join(root, 'apps', 'cli'), {
    quiet: true,
    env,
  });
  // The fixture releases this producer in finally, after observing its start.
  // Observe early failures now, then propagate every terminal failure below.
  void canonicalBuild.catch(() => {});
  let bypassCompileStarted = false;
  let cliPreparation;
  let assertionError = null;
  try {
    await waitForFile(buildStartedPath);
    cliPreparation = buildBundledWorkspaceDependenciesForCli({
      repoRoot: root,
      env,
      workspaceNames: ['protocol'],
      runWorkspaceArtifactBuildImpl: () => false,
      runTscImpl: () => {
        bypassCompileStarted = true;
      },
    });
    void cliPreparation.catch(() => {});
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
    const results = await Promise.allSettled([canonicalBuild, cliPreparation]);
    for (const result of results) {
      if (result.status === 'rejected') assertionError ??= result.reason;
    }
  }
  if (assertionError) throw assertionError;

  const output = await readFile(outputPath, 'utf-8');
  assert.equal(
    output.split('\n').filter((line) => line.includes('/packages/protocol :: run --silent build')).length,
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
  await writePnpmWorkspaceBuildStub({ binDir, outputPath });

  await applyEnvOverrides(t, root, {
    PATH: `${binDir}:/usr/bin:/bin`,
    OUTPUT_PATH: outputPath,
    HAPPIER_STACK_ENV_FILE: null,
  });

  await ensureWorkspacePackagesBuiltForComponent(join(root, 'apps', 'ui'), {
    quiet: true,
    env: process.env,
  });

  const out = await readFile(outputPath, 'utf-8');
  assert.match(out, /packages\/protocol :: run --silent build/);
  assert.equal(Boolean(await readFile(join(protocolDir, 'dist', 'machineTransfer', 'transferStream.js'), 'utf-8')), true);
});

test('ensureWorkspacePackagesBuiltForComponent rebuilds prior outputs without a matching input record', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-ensure-workspaces-built-prior-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  await mkdir(join(root, 'apps', 'ui'), { recursive: true });
  await mkdir(join(root, 'apps', 'cli'), { recursive: true });
  await mkdir(join(root, 'apps', 'server'), { recursive: true });
  await writePnpmWorkspace(root);
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

  const admitted = await ensureWorkspacePackagesBuiltForComponentCanonical(
    join(root, 'apps', 'ui'),
    {
      quiet: true,
      workspaceBuildBoundary: {
        async prepareEnv(_packageDir, env) { return env; },
        async runPackageBuild(_packageDir, { env }) {
          await mkdir(env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR, { recursive: true });
          await writeFile(join(env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR, 'index.js'), 'export const current = true;\n');
          await writeFile(join(env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR, 'index.d.ts'), 'export declare const current: boolean;\n');
        },
      },
    },
  );

  assert.deepEqual(admitted.built, ['@happier-dev/protocol']);
  assert.equal(await readFile(join(protocolDir, 'dist', 'index.js'), 'utf-8'), 'export const current = true;\n');
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
    join(binDir, 'pnpm'),
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'echo "$(pwd) :: $* :: out=${HAPPIER_WORKSPACE_DIST_OUTPUT_DIR:-dist}" >> "${OUTPUT_PATH:?}"',
      'if [[ "${1:-}" == "--version" ]]; then echo "12.14.0"; exit 0; fi',
      'if [[ "${1:-}" == "run" && "${2:-}" == "--silent" && "${3:-}" == "build" && "$(pwd)" == */packages/protocol ]]; then',
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
  await chmod(join(binDir, 'pnpm'), 0o755);
  await writeFile(outputPath, '', 'utf-8');

  await applyEnvOverrides(t, root, {
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
    .find((line) => line.includes('/packages/protocol :: run --silent build'));
  assert.ok(buildLine, 'expected the protocol package build to run');
  assert.match(buildLine, /out=.*\/packages\/protocol\/\.tmp\./);
  assert.doesNotMatch(buildLine, /out=dist(?:\s|$)/);
});
