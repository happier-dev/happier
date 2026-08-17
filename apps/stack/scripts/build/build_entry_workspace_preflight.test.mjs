import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { runNodeCapture } from '../testkit/core/run_node_capture.mjs';

const buildDir = dirname(fileURLToPath(import.meta.url));
const stackDir = resolve(buildDir, '..', '..');
const buildScriptPath = resolve(stackDir, 'scripts', 'build.mjs');

test('direct Stack artifact entry delegates runtime locking to the canonical artifact owner', async () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), 'hstack-build-entry-owner-'));
  const artifactBuilderStubPath = join(fixtureDir, 'build-stack-artifacts.stub.mjs');
  const lockStubPath = join(fixtureDir, 'workspace-lock.stub.mjs');
  const loaderPath = join(fixtureDir, 'loader.mjs');

  writeFileSync(
    artifactBuilderStubPath,
    [
      'export async function buildStackArtifacts() {',
      '  return {',
      '    ok: true,',
      "    stackName: 'entry-owner',",
      "    consumerStackName: 'entry-owner',",
      "    producerStackName: 'repo-producer',",
      '    artifacts: {},',
      '    runtime: null,',
      '  };',
      '}',
      '',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(
    lockStubPath,
    "throw new Error('the command entry must not own the runtime snapshot lock');\n",
    'utf8',
  );
  writeFileSync(
    loaderPath,
    [
      'export async function resolve(specifier, context, defaultResolve) {',
      "  if (specifier === './build/build_stack_artifacts.mjs') {",
      `    return { url: ${JSON.stringify(pathToFileURL(artifactBuilderStubPath).href)}, shortCircuit: true };`,
      '  }',
      "  if (specifier === '@happier-dev/cli-common/workspaceBundleLock') {",
      `    return { url: ${JSON.stringify(pathToFileURL(lockStubPath).href)}, shortCircuit: true };`,
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
        HAPPIER_STACK_STACK: 'entry-owner',
        HAPPIER_STACK_STORAGE_DIR: join(fixtureDir, 'stacks'),
        HAPPIER_STACK_RUNTIME_BUILD_AUTHORITY_STACK: 'repo-producer',
        HAPPIER_STACK_UPDATE_CHECK: '0',
        NODE_OPTIONS: existingNodeOptions ? `${existingNodeOptions} ${loaderOption}` : loaderOption,
      },
    });

    assert.equal(result.code, 0, `expected canonical build delegation\nstderr:\n${result.stderr}`);
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: true,
      stackName: 'entry-owner',
      consumerStackName: 'entry-owner',
      producerStackName: 'repo-producer',
      artifacts: {},
      runtime: null,
    });
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});
