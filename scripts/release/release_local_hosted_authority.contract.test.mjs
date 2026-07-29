import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repoRoot = resolve(new URL('../..', import.meta.url).pathname);

function executable(path, source) {
  writeFileSync(path, source, { encoding: 'utf8', mode: 0o755 });
  chmodSync(path, 0o755);
}

test('local full release delegates privileged execution to the hosted workflow', () => {
  const root = mkdtempSync(join(tmpdir(), 'hosted-release-authority-'));
  const bin = join(root, 'bin');
  const log = join(root, 'commands.log');
  mkdirSync(bin);
  writeFileSync(log, '');
  executable(join(bin, 'git'), `#!/bin/sh
set -eu
echo "git $*" >> ${JSON.stringify(log)}
if [ "$1" = diff ] && [ "$2" = --cached ]; then exit 0; fi
if [ "$1" = rev-parse ] && [ "$2" = --abbrev-ref ]; then printf 'dev\n'; exit 0; fi
echo "unexpected git call: $*" >&2; exit 2
`);
  executable(join(bin, 'gh'), `#!/bin/sh
set -eu
echo "gh $*" >> ${JSON.stringify(log)}
exit 0
`);
  try {
    const output = execFileSync(process.execPath, [
      'scripts/pipeline/run.mjs',
      'release',
      '--confirm', 'release dev to preview',
      '--repository', 'happier-dev/happier',
      '--deploy-environment', 'preview',
      '--deploy-targets', 'server,server_runner',
      '--bump', 'patch',
      '--allow-dirty', 'true',
    ], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        MINISIGN_SECRET_KEY: 'must-not-be-loaded',
        RELEASE_BOT_PRIVATE_KEY: 'must-not-be-loaded',
      },
      encoding: 'utf8',
    });
    const commands = readFileSync(log, 'utf8');
    assert.match(commands, /gh workflow run release\.yml/);
    assert.match(commands, /-f environment=preview/);
    assert.match(commands, /-f deploy_targets=server,server_runner/);
    assert.match(output, /hosted release workflow/i);
    assert.doesNotMatch(commands, /publish-server-runtime|promote-deploy-branch|release upload/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('local full release rejects options absent from the hosted workflow before side effects', () => {
  const root = mkdtempSync(join(tmpdir(), 'hosted-release-options-'));
  const bin = join(root, 'bin');
  const log = join(root, 'commands.log');
  mkdirSync(bin);
  writeFileSync(log, '');
  executable(join(bin, 'git'), `#!/bin/sh
set -eu
echo "git $*" >> ${JSON.stringify(log)}
exit 0
`);
  executable(join(bin, 'gh'), `#!/bin/sh
set -eu
echo "gh $*" >> ${JSON.stringify(log)}
exit 0
`);
  try {
    for (const [option, value] of [
      ['--bump-app-override', 'patch'],
      ['--bump-cli-override', 'patch'],
      ['--bump-stack-override', 'patch'],
      ['--sync-dev-from-main', 'false'],
      ['--ui-expo-builder', 'eas_local'],
      ['--ui-expo-profile', 'preview'],
      ['--ui-expo-platform', 'ios'],
      ['--npm-mode', 'pack'],
      ['--npm-run-tests', 'false'],
      ['--npm-server-runner-dir', 'packages/other'],
      ['--secrets-source', 'env'],
      ['--keychain-service', 'custom/service'],
      ['--keychain-account', 'custom-account'],
    ]) {
      writeFileSync(log, '');
      const result = spawnSync(process.execPath, [
        'scripts/pipeline/run.mjs',
        'release',
        '--confirm', 'release dev to preview',
        '--repository', 'happier-dev/happier',
        '--deploy-environment', 'preview',
        '--deploy-targets', 'server',
        '--allow-dirty', 'true',
        option, value,
      ], {
        cwd: repoRoot,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ''}`,
        },
        encoding: 'utf8',
      });
      assert.equal(result.status, 1, `${option} must fail closed`);
      assert.equal(readFileSync(log, 'utf8'), '', `${option} must fail before git or GitHub access`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
