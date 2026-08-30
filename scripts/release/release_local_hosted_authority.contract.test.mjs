import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repoRoot = resolve(new URL('../..', import.meta.url).pathname);
const AUTHORIZED_DEV_SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function executable(path, source) {
  writeFileSync(path, source, { encoding: 'utf8', mode: 0o755 });
  chmodSync(path, 0o755);
}

test('the local release command delegates all privileged execution to the hosted release workflow', () => {
  const root = mkdtempSync(join(tmpdir(), 'hosted-release-authority-'));
  const bin = join(root, 'bin');
  const log = join(root, 'commands.log');
  mkdirSync(bin);
  writeFileSync(log, '');
  executable(
    join(bin, 'git'),
    `#!/bin/sh
set -eu
echo "git $*" >> ${JSON.stringify(log)}
if [ "$1" = "diff" ] && [ "$2" = "--cached" ]; then exit 0; fi
if [ "$1" = "rev-parse" ] && [ "$2" = "--abbrev-ref" ]; then printf 'dev\\n'; exit 0; fi
if [ "$1" = "rev-parse" ] && [ "$2" = "FETCH_HEAD" ]; then printf '${AUTHORIZED_DEV_SHA}\\n'; exit 0; fi
if [ "$1" = "fetch" ]; then exit 0; fi
if [ "$1" = "ls-remote" ] && [ "$3" = "refs/heads/dev" ]; then printf '${AUTHORIZED_DEV_SHA}\\trefs/heads/dev\\n'; exit 0; fi
if [ "$1" = "ls-remote" ] && [ "$3" = "refs/tags/dev^{}" ]; then exit 0; fi
if [ "$1" = "ls-remote" ] && [ "$3" = "refs/tags/dev" ]; then exit 0; fi
echo "unexpected git call: $*" >&2
exit 2
`,
  );
  executable(
    join(bin, 'gh'),
    `#!/bin/sh
set -eu
echo "gh $*" >> ${JSON.stringify(log)}
exit 0
`,
  );

  try {
    const output = execFileSync(
      process.execPath,
      [
        'scripts/pipeline/run.mjs',
        'release',
        '--confirm', 'release dev to preview',
        '--repository', 'happier-dev/happier',
        '--deploy-environment', 'preview',
        '--deploy-targets', 'server,server_runner',
        '--source-sha', AUTHORIZED_DEV_SHA,
        '--workflow-control-sha', AUTHORIZED_DEV_SHA,
        '--resume-run-id', '31506884258',
        '--release-profile', 'stable',
        '--release-notes-id', '2026-08-09.1',
        '--allow-dirty', 'true',
      ],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ''}`,
          MINISIGN_SECRET_KEY: 'must-not-be-loaded',
          RELEASE_BOT_PRIVATE_KEY: 'must-not-be-loaded',
        },
        encoding: 'utf8',
      },
    );
    const commands = readFileSync(log, 'utf8');
    assert.match(commands, /gh workflow run release\.yml/);
    assert.match(commands, /-f environment=preview/);
    assert.match(commands, /-f deploy_targets=server,server_runner/);
    assert.doesNotMatch(commands, /-f checks_profile=/, 'the hosted workflow must resolve checks from the public profile itself');
    assert.match(commands, /-f validation_profile=stable/);
    assert.match(commands, new RegExp(`-f authorized_promotion_source_sha=${AUTHORIZED_DEV_SHA}`));
    assert.match(commands, new RegExp(`-f workflow_control_sha=${AUTHORIZED_DEV_SHA}`));
    assert.match(commands, /-f resume_run_id=31506884258/);
    assert.doesNotMatch(commands, /-f release_message=/);
    assert.match(output, /release profile=stable/);
    assert.match(output, /hosted release workflow/i);
    assert.doesNotMatch(commands, /publish-server-runtime|promote-deploy-branch|release upload/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the local release command rejects malformed resume run identities before external access', () => {
  const root = mkdtempSync(join(tmpdir(), 'hosted-release-resume-id-'));
  const bin = join(root, 'bin');
  const log = join(root, 'commands.log');
  mkdirSync(bin);
  writeFileSync(log, '');
  executable(join(bin, 'git'), `#!/bin/sh\necho "git $*" >> ${JSON.stringify(log)}\nexit 0\n`);
  executable(join(bin, 'gh'), `#!/bin/sh\necho "gh $*" >> ${JSON.stringify(log)}\nexit 0\n`);

  try {
    for (const resumeRunId of ['0', '-1', '1.5', 'abc', ' 123', '123 ']) {
      writeFileSync(log, '');
      const resumeRunIdArgs = resumeRunId.startsWith('-')
        ? [`--resume-run-id=${resumeRunId}`]
        : ['--resume-run-id', resumeRunId];
      const result = spawnSync(
        process.execPath,
        [
          'scripts/pipeline/run.mjs',
          'release',
          '--confirm', 'release dev to preview',
          '--repository', 'happier-dev/happier',
          '--deploy-environment', 'preview',
          '--deploy-targets', 'server',
          '--release-notes-id', '2026-08-09.1',
          ...resumeRunIdArgs,
          '--allow-dirty', 'true',
        ],
        {
          cwd: repoRoot,
          env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
          encoding: 'utf8',
        },
      );
      assert.equal(result.status, 1, `${JSON.stringify(resumeRunId)} must fail closed`);
      assert.match(result.stderr, /--resume-run-id must be a positive GitHub Actions run ID/);
      assert.equal(readFileSync(log, 'utf8'), '', 'invalid resume identity must fail before Git or GitHub access');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an explicit allow-dirty release dispatch does not reject staged local work', () => {
  const root = mkdtempSync(join(tmpdir(), 'hosted-release-allow-dirty-'));
  const bin = join(root, 'bin');
  const log = join(root, 'commands.log');
  mkdirSync(bin);
  writeFileSync(log, '');
  executable(
    join(bin, 'git'),
    `#!/bin/sh
set -eu
echo "git $*" >> ${JSON.stringify(log)}
if [ "$1" = "diff" ] && [ "$2" = "--cached" ]; then exit 1; fi
if [ "$1" = "rev-parse" ] && [ "$2" = "--abbrev-ref" ]; then printf 'dev\\n'; exit 0; fi
if [ "$1" = "rev-parse" ] && [ "$2" = "FETCH_HEAD" ]; then printf '${AUTHORIZED_DEV_SHA}\\n'; exit 0; fi
if [ "$1" = "fetch" ]; then exit 0; fi
if [ "$1" = "ls-remote" ] && [ "$3" = "refs/heads/dev" ]; then printf '${AUTHORIZED_DEV_SHA}\\trefs/heads/dev\\n'; exit 0; fi
echo "unexpected git call: $*" >&2
exit 2
`,
  );
  executable(join(bin, 'gh'), `#!/bin/sh\nset -eu\necho "gh $*" >> ${JSON.stringify(log)}\n`);

  try {
    const result = spawnSync(
      process.execPath,
      [
        'scripts/pipeline/run.mjs',
        'release',
        '--confirm', 'release dev to preview',
        '--repository', 'happier-dev/happier',
        '--deploy-environment', 'preview',
        '--deploy-targets', 'server',
        '--source-sha', AUTHORIZED_DEV_SHA,
        '--release-notes-id', '2026-08-09.1',
        '--allow-dirty', 'true',
      ],
      {
        cwd: repoRoot,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
        encoding: 'utf8',
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(readFileSync(log, 'utf8'), /gh workflow run release\.yml/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the local release command rejects high-level options that the hosted workflow does not accept', () => {
  const root = mkdtempSync(join(tmpdir(), 'hosted-release-options-'));
  const bin = join(root, 'bin');
  const log = join(root, 'commands.log');
  mkdirSync(bin);
  writeFileSync(log, '');
  executable(
    join(bin, 'git'),
    `#!/bin/sh
set -eu
echo "git $*" >> ${JSON.stringify(log)}
exit 0
`,
  );
  executable(
    join(bin, 'gh'),
    `#!/bin/sh
set -eu
echo "gh $*" >> ${JSON.stringify(log)}
exit 0
`,
  );

  try {
    for (const [option, value] of [
      ['--bump-app-override', 'patch'],
      ['--bump-cli-override', 'patch'],
      ['--bump-stack-override', 'patch'],
      ['--ui-expo-android-release-status', 'completed'],
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
      ['--release-message', 'operator-authored copy'],
    ]) {
      writeFileSync(log, '');
      const result = spawnSync(
        process.execPath,
        [
          'scripts/pipeline/run.mjs',
          'release',
          '--confirm', 'release dev to preview',
          '--repository', 'happier-dev/happier',
          '--deploy-environment', 'preview',
          '--deploy-targets', 'server',
          '--allow-dirty', 'true',
          option, value,
        ],
        {
          cwd: repoRoot,
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH ?? ''}`,
          },
          encoding: 'utf8',
        },
      );
      assert.equal(result.status, 1, `${option} must fail closed`);
      assert.equal(readFileSync(log, 'utf8'), '', `${option} must fail before git or GitHub access`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the local release command rejects the removed bump option before any release mutation or source lookup', () => {
  const root = mkdtempSync(join(tmpdir(), 'hosted-release-bump-admission-'));
  const bin = join(root, 'bin');
  const log = join(root, 'commands.log');
  mkdirSync(bin);
  writeFileSync(log, '');
  executable(join(bin, 'git'), `#!/bin/sh\necho "git $*" >> ${JSON.stringify(log)}\nexit 0\n`);
  executable(join(bin, 'gh'), `#!/bin/sh\necho "gh $*" >> ${JSON.stringify(log)}\nexit 0\n`);

  try {
    const result = spawnSync(
      process.execPath,
      [
        'scripts/pipeline/run.mjs',
        'release',
        '--confirm', 'release dev to preview',
        '--repository', 'happier-dev/happier',
        '--deploy-environment', 'preview',
        '--deploy-targets', 'server',
        '--bump', 'patch',
      ],
      {
        cwd: repoRoot,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
        encoding: 'utf8',
      },
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unknown option '--bump'/);
    assert.equal(readFileSync(log, 'utf8'), '', 'the removed bump option must fail before external commands');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
