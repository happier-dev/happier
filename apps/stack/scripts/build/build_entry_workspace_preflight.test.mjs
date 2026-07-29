import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runNodeCapture } from '../testkit/core/run_node_capture.mjs';

const buildDir = dirname(fileURLToPath(import.meta.url));
const stackDir = resolve(buildDir, '..', '..');
const buildScriptPath = resolve(stackDir, 'scripts', 'build.mjs');

test('direct Stack artifact builds refresh bundled workspaces before loading artifact builders', async () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), 'hstack-build-workspace-preflight-'));
  const workspaceBuildMarkerPath = join(fixtureDir, 'workspace-build-complete');
  const markerPath = join(fixtureDir, 'preflight-complete');
  const runtimeLockMarkerPath = join(fixtureDir, 'runtime-lock-held');
  const packageManagerStubPath = join(fixtureDir, 'package-manager.stub.mjs');
  const preflightStubPath = join(fixtureDir, 'preflight.stub.mjs');
  const artifactBuilderStubPath = join(fixtureDir, 'build-stack-artifacts.stub.mjs');
  const runtimeBuildLockStubPath = join(fixtureDir, 'runtime-build-lock.stub.mjs');
  const loaderPath = join(fixtureDir, 'loader.mjs');

  writeFileSync(
    packageManagerStubPath,
    [
      "import { existsSync, writeFileSync } from 'node:fs';",
      'export async function ensureWorkspacePackagesBuiltForComponent() {',
      `  if (!existsSync(${JSON.stringify(runtimeLockMarkerPath)})) {`,
      "    throw new Error('workspace dependency builds ran outside the runtime build lock');",
      '  }',
      `  writeFileSync(${JSON.stringify(workspaceBuildMarkerPath)}, 'ready\\n', 'utf8');`,
      "  return { ok: true, built: ['@happier-dev/cli-common'], skipped: [] };",
      '}',
      'export async function ensureDepsInstalled() {}',
      'export async function pmExecBin() {}',
      'export async function requireDir() {}',
      '',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(
    preflightStubPath,
    [
      "import { existsSync, writeFileSync } from 'node:fs';",
      'export async function refreshLocalBundledWorkspacePackages() {',
      `  if (!existsSync(${JSON.stringify(runtimeLockMarkerPath)})) {`,
      "    throw new Error('bundled workspace preflight ran outside the runtime build lock');",
      '  }',
      `  if (!existsSync(${JSON.stringify(workspaceBuildMarkerPath)})) {`,
      "    throw new Error('bundled workspace preflight ran before workspace dependency builds');",
      '  }',
      `  writeFileSync(${JSON.stringify(markerPath)}, 'ready\\n', 'utf8');`,
      '}',
      '',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(
    artifactBuilderStubPath,
    [
      "import { existsSync } from 'node:fs';",
      'export async function buildStackArtifacts() {',
      `  if (!existsSync(${JSON.stringify(runtimeLockMarkerPath)})) {`,
      "    throw new Error('artifact build ran outside the runtime build lock');",
      '  }',
      "  return { ok: true, stackName: 'entry-preflight', source: {}, artifacts: {}, runtime: null };",
      '}',
      '',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(
    runtimeBuildLockStubPath,
    [
      "import { rmSync, writeFileSync } from 'node:fs';",
      'export async function acquireRuntimeBuildLock() {',
      `  writeFileSync(${JSON.stringify(runtimeLockMarkerPath)}, 'held\\n', 'utf8');`,
      '  return async function releaseRuntimeBuildLock() {',
      `    rmSync(${JSON.stringify(runtimeLockMarkerPath)}, { force: true });`,
      '  };',
      '}',
      '',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(
    loaderPath,
    [
      "import { existsSync } from 'node:fs';",
      "import { pathToFileURL } from 'node:url';",
      '',
      'export async function resolve(specifier, context, defaultResolve) {',
      "  if (specifier === './utils/proc/pm.mjs') {",
      `    return { url: pathToFileURL(${JSON.stringify(packageManagerStubPath)}).href, shortCircuit: true };`,
      '  }',
      "  if (specifier === '../bin/localBundledWorkspacePreflight.mjs') {",
      `    return { url: pathToFileURL(${JSON.stringify(preflightStubPath)}).href, shortCircuit: true };`,
      '  }',
      "  if (specifier === './build/build_stack_artifacts.mjs') {",
      `    if (!existsSync(${JSON.stringify(markerPath)})) {`,
      "      throw new Error('artifact builders loaded before bundled workspace preflight');",
      '    }',
      `    return { url: pathToFileURL(${JSON.stringify(artifactBuilderStubPath)}).href, shortCircuit: true };`,
      '  }',
      "  if (specifier === './build/runtime_build_lock.mjs') {",
      `    return { url: pathToFileURL(${JSON.stringify(runtimeBuildLockStubPath)}).href, shortCircuit: true };`,
      '  }',
      '  return defaultResolve(specifier, context, defaultResolve);',
      '}',
      '',
    ].join('\n'),
    'utf8',
  );

  try {
    const existingNodeOptions = String(process.env.NODE_OPTIONS ?? '').trim();
    const loaderOption = `--experimental-loader=${loaderPath}`;
    const result = await runNodeCapture([buildScriptPath, '--server', '--json'], {
      cwd: stackDir,
      env: {
        ...process.env,
        HAPPIER_STACK_CLI_ROOT_DISABLE: '1',
        HAPPIER_STACK_STACK: 'entry-preflight',
        HAPPIER_STACK_UPDATE_CHECK: '0',
        NODE_OPTIONS: existingNodeOptions ? `${existingNodeOptions} ${loaderOption}` : loaderOption,
      },
    });

    assert.equal(
      result.code,
      0,
      `expected direct artifact build to load after preflight\nstderr:\n${result.stderr}\nstdout:\n${result.stdout}`,
    );
    assert.equal(existsSync(workspaceBuildMarkerPath), true);
    assert.equal(existsSync(markerPath), true);
    assert.equal(existsSync(runtimeLockMarkerPath), false, 'runtime build lock should be released after the build');
    assert.equal(JSON.parse(result.stdout).ok, true);
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});
