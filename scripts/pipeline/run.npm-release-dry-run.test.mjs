import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import test from 'node:test';

const repositoryRoot = new URL('../..', import.meta.url);

async function writeGitStatusFixture(root) {
  const gitPath = join(root, 'git');
  await writeFile(gitPath, `#!/bin/sh
set -eu
if [ "$1" = rev-parse ] && [ "$2" = --is-inside-work-tree ]; then
  printf 'true\\n'
  exit 0
fi
if [ "$1" = rev-parse ] && [ "$2" = HEAD ]; then
  printf '%s\\n' "\${HAPPIER_TEST_GIT_HEAD:-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa}"
  exit 0
fi
if [ "$1" = status ] && [ "$2" = --porcelain=v1 ]; then
  printf '%s\\n' "\${HAPPIER_TEST_GIT_STATUS:-}"
  exit 0
fi
printf 'unexpected git invocation: %s\\n' "$*" >&2
exit 2
`, { mode: 0o755 });
  return gitPath;
}

async function writePipelineEnvAccessTrap(root) {
  const trapPath = join(root, 'pipeline-env-access-trap.cjs');
  const invokedPath = join(root, 'pipeline-env-invoked');
  await writeFile(trapPath, `const fs = require('node:fs');
const { syncBuiltinESMExports } = require('node:module');
const originalExistsSync = fs.existsSync;
fs.existsSync = function existsSync(pathLike) {
  if (String(pathLike).endsWith('.env.pipeline.local')) {
    fs.writeFileSync(${JSON.stringify(invokedPath)}, 'invoked');
    throw new Error('TEST_PIPELINE_ENV_LOADED');
  }
  return originalExistsSync.call(this, pathLike);
};
syncBuiltinESMExports();
`);
  return { trapPath, invokedPath };
}

test('npm-release dry-run validates all publication arguments before it can load Keychain secrets', async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'happier-npm-release-dry-run-'));
  const securityPath = join(temporaryRoot, 'security');
  const invokedPath = join(temporaryRoot, 'security-invoked');
  try {
    await writeFile(securityPath, `#!/bin/sh\nprintf invoked > ${JSON.stringify(invokedPath)}\nexit 0\n`, { mode: 0o755 });
    await writeGitStatusFixture(temporaryRoot);

    const result = spawnSync(process.execPath, [
      'scripts/pipeline/run.mjs',
      'npm-release',
      '--channel', 'preview',
      '--publish-cli', 'not-a-boolean',
      '--dry-run',
      '--secrets-source', 'keychain',
      '--keychain-service', 'test-only-no-secret',
    ], {
      cwd: repositoryRoot,
      env: { ...process.env, PATH: `${temporaryRoot}:${process.env.PATH ?? ''}` },
      encoding: 'utf8',
    });

    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /--publish-cli must be 'true' or 'false'/);
    await assert.rejects(readFile(invokedPath, 'utf8'), /ENOENT/u);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('npm-release rejects a real publication without an admitted candidate before it loads Keychain secrets', async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'happier-npm-release-admission-'));
  const securityPath = join(temporaryRoot, 'security');
  const invokedPath = join(temporaryRoot, 'security-invoked');
  try {
    await writeFile(securityPath, `#!/bin/sh\nprintf invoked > ${JSON.stringify(invokedPath)}\nexit 0\n`, { mode: 0o755 });

    const result = spawnSync(process.execPath, [
      'scripts/pipeline/run.mjs',
      'npm-release',
      '--channel', 'preview',
      '--publish-plugin-sdk', 'true',
      '--mode', 'pack+publish',
      '--secrets-source', 'keychain',
      '--keychain-service', 'test-only-no-secret',
    ], {
      cwd: repositoryRoot,
      env: { ...process.env, PATH: `${temporaryRoot}:${process.env.PATH ?? ''}` },
      encoding: 'utf8',
    });

    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /release-admitted exact source SHA/);
    await assert.rejects(readFile(invokedPath, 'utf8'), /ENOENT/u);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('npm-release rejects an ordinarily dirty real pack+publish before pipeline-env or Keychain access', async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'happier-npm-release-default-dirty-publication-'));
  const securityPath = join(temporaryRoot, 'security');
  const securityInvokedPath = join(temporaryRoot, 'security-invoked');
  const admittedSha = 'a'.repeat(40);
  try {
    const { trapPath, invokedPath: pipelineEnvInvokedPath } = await writePipelineEnvAccessTrap(temporaryRoot);
    await writeGitStatusFixture(temporaryRoot);
    await writeFile(securityPath, `#!/bin/sh\nprintf invoked > ${JSON.stringify(securityInvokedPath)}\nexit 0\n`, { mode: 0o755 });

    const realPublication = spawnSync(process.execPath, [
      '--require', trapPath,
      'scripts/pipeline/run.mjs',
      'npm-release',
      '--channel', 'preview',
      '--publish-cli', 'true',
      '--mode', 'pack+publish',
      '--authorized-sha', admittedSha,
      '--secrets-source', 'keychain',
      '--keychain-service', 'test-only-no-secret',
    ], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        PATH: `${temporaryRoot}:${process.env.PATH ?? ''}`,
        HAPPIER_TEST_GIT_HEAD: admittedSha,
        HAPPIER_TEST_GIT_STATUS: ' M packages/sdk/src/connect.ts',
      },
      encoding: 'utf8',
    });

    const output = `${realPublication.stdout}\n${realPublication.stderr}`;
    assert.notEqual(realPublication.status, 0);
    assert.match(output, /git worktree is dirty/);
    assert.doesNotMatch(output, /TEST_PIPELINE_ENV_LOADED/);
    await assert.rejects(readFile(pipelineEnvInvokedPath, 'utf8'), /ENOENT/u);
    await assert.rejects(readFile(securityInvokedPath, 'utf8'), /ENOENT/u);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('npm-release rejects dirty real pack+publish before secrets', async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'happier-npm-release-dirty-publication-'));
  const securityPath = join(temporaryRoot, 'security');
  const invokedPath = join(temporaryRoot, 'security-invoked');
  const checkoutSha = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  }).trim();
  try {
    await writeFile(securityPath, `#!/bin/sh\nprintf invoked > ${JSON.stringify(invokedPath)}\nexit 0\n`, { mode: 0o755 });

    const realPublication = spawnSync(process.execPath, [
      'scripts/pipeline/run.mjs',
      'npm-release',
      '--channel', 'preview',
      '--publish-cli', 'true',
      '--mode', 'pack+publish',
      '--authorized-sha', checkoutSha,
      '--allow-dirty', 'true',
      '--secrets-source', 'keychain',
      '--keychain-service', 'test-only-no-secret',
    ], {
      cwd: repositoryRoot,
      env: { ...process.env, PATH: `${temporaryRoot}:${process.env.PATH ?? ''}` },
      encoding: 'utf8',
    });

    assert.notEqual(realPublication.status, 0);
    assert.match(`${realPublication.stdout}\n${realPublication.stderr}`, /DIRTY_NPM_RELEASE_PUBLICATION_DISABLED/);
    await assert.rejects(readFile(invokedPath, 'utf8'), /ENOENT/u);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('npm-release keeps release-control clean for dry-run and dirty-tolerant pack-only planning', async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'happier-npm-release-control-dirty-'));
  try {
    await writeGitStatusFixture(temporaryRoot);

    const invoke = (args, gitStatus) => spawnSync(process.execPath, [
      'scripts/pipeline/run.mjs',
      'npm-release',
      '--channel', 'preview',
      '--publish-cli', 'not-a-boolean',
      ...args,
    ], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        PATH: `${temporaryRoot}:${process.env.PATH ?? ''}`,
        HAPPIER_TEST_GIT_STATUS: gitStatus,
      },
      encoding: 'utf8',
    });

    for (const [label, args] of [
      ['default dry-run', ['--dry-run']],
      ['dirty-tolerant dry-run', ['--dry-run', '--allow-dirty', 'true']],
      ['dirty-tolerant pack-only', ['--mode', 'pack', '--allow-dirty', 'true', '--secrets-source', 'env']],
    ]) {
      const result = invoke(args, ' M scripts/pipeline/run.mjs');
      assert.notEqual(result.status, 0, `${label} must reject dirty release-control bytes`);
      assert.match(`${result.stdout}\n${result.stderr}`, /RELEASE_CONTROL_WORKTREE_DIRTY/);
      assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /--publish-cli must be 'true' or 'false'/);
    }

    for (const [label, args] of [
      ['dirty-tolerant dry-run', ['--dry-run', '--allow-dirty', 'true']],
      ['dirty-tolerant pack-only', ['--mode', 'pack', '--allow-dirty', 'true', '--secrets-source', 'env']],
    ]) {
      const result = invoke(args, ' M packages/sdk/src/connect.ts');
      assert.notEqual(result.status, 0, `${label} must reach the package owner for unrelated dirt`);
      assert.match(`${result.stdout}\n${result.stderr}`, /--publish-cli must be 'true' or 'false'/);
      assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /RELEASE_CONTROL_WORKTREE_DIRTY/);
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
