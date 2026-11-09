import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import YAML from 'yaml';

const repoRoot = resolve(new URL('../..', import.meta.url).pathname);
const DEV_SOURCE_SHA = '1111111111111111111111111111111111111111';
const PREVIEW_SOURCE_SHA = '2222222222222222222222222222222222222222';
const WORKFLOW_CONTROL_SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function executable(path, source) {
  writeFileSync(path, source, { encoding: 'utf8', mode: 0o755 });
  chmodSync(path, 0o755);
}

test('local release delegates an already-materialized exact candidate to hosted execution', () => {
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
if [ "$1" = ls-remote ] && [ "$3" = refs/heads/v0.3 ]; then printf '${DEV_SOURCE_SHA}\trefs/heads/v0.3\n'; exit 0; fi
if [ "$1" = fetch ]; then exit 0; fi
if [ "$1" = cat-file ]; then exit 0; fi
if [ "$1" = rev-parse ] && [ "$2" = FETCH_HEAD ]; then printf '${DEV_SOURCE_SHA}\n'; exit 0; fi
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
      '--source-sha', DEV_SOURCE_SHA,
      '--workflow-control-sha', WORKFLOW_CONTROL_SHA,
      '--operation-id', 'rel_hosted_20260809',
      '--attempt-id', 'attempt_2',
      '--resume-run-id', '31506884258',
      '--release-notes-id', '2026-08-09.1',
      '--plugin-sdk-ready', 'true',
      '--plugin-sdk-api-classification', 'compatible',
      '--plugin-sdk-migration-notes', 'not_required',
      '--sdk-auth-readiness', 'waived',
      '--sdk-auth-waiver', 'preview-auth-review',
      '--sdk-api-classification', 'breaking',
      '--sdk-migration-notes', '2026-08-09.1',
      '--qualified-v4-activation-approval', 'true',
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
    assert.match(commands, /-f validation_profile=integrated/);
    assert.doesNotMatch(commands, /-f checks_profile=/, 'the public validation profile must own check depth');
    assert.doesNotMatch(commands, /git ls-remote origin refs\/heads\/dev/, 'resume must revalidate the approved candidate SHA rather than substitute the advanced branch tip');
    assert.match(commands, new RegExp(`git fetch --no-tags --depth=1 origin ${DEV_SOURCE_SHA}`));
    assert.match(commands, new RegExp(`-f authorized_promotion_source_sha=${DEV_SOURCE_SHA}`));
    assert.match(commands, new RegExp(`-f workflow_control_sha=${WORKFLOW_CONTROL_SHA}`));
    assert.match(commands, /-f hmaint_operation_id=rel_hosted_20260809/);
    assert.match(commands, /-f hmaint_attempt_id=attempt_2/);
    assert.match(commands, /-f resume_run_id=31506884258/);
    assert.match(commands, /-f release_notes_id=2026-08-09\.1/);
    assert.match(commands, /-f qualified_v4_activation_approval=true/);
    assert.match(commands, /-f public_sdk_release_approval=\{"pluginSdk":\{"ready":true,"apiClassification":"compatible","migrationNotes":"not_required"\},"sdk":\{"authReadiness":"waived","authWaiver":"preview-auth-review","apiClassification":"breaking","migrationNotes":"2026-08-09\.1"\}\}/);
    assert.doesNotMatch(commands, /-f (?:plugin_sdk_ready|plugin_sdk_api_classification|plugin_sdk_migration_notes|sdk_auth_readiness|sdk_auth_waiver|sdk_api_classification|sdk_migration_notes)=/);
    assert.doesNotMatch(commands, /release_message=/, 'canonical changelog projection owns release notes');
    assert.match(output, /hosted release workflow/i);
    assert.doesNotMatch(commands, /publish-server-runtime|promote-deploy-branch|release upload/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('local release keeps its script-owned release-control corridor clean even when unrelated edits are allowed', () => {
  const root = mkdtempSync(join(tmpdir(), 'hosted-release-control-dirty-'));
  const bin = join(root, 'bin');
  const log = join(root, 'commands.log');
  mkdirSync(bin);
  writeFileSync(log, '');
  executable(join(bin, 'git'), `#!/bin/sh
set -eu
echo "git $*" >> ${JSON.stringify(log)}
if [ "$1" = rev-parse ] && [ "$2" = --is-inside-work-tree ]; then printf 'true\\n'; exit 0; fi
if [ "$1" = status ] && [ "$2" = --porcelain=v1 ]; then printf '%s\\n' "\${HAPPIER_TEST_GIT_STATUS:-}"; exit 0; fi
if [ "$1" = ls-remote ] && [ "$3" = refs/heads/v0.3 ]; then printf '${DEV_SOURCE_SHA}\\trefs/heads/v0.3\\n'; exit 0; fi
if [ "$1" = fetch ]; then exit 0; fi
if [ "$1" = cat-file ]; then exit 0; fi
if [ "$1" = rev-parse ] && [ "$2" = FETCH_HEAD ]; then printf '${DEV_SOURCE_SHA}\\n'; exit 0; fi
echo "unexpected git call: $*" >&2; exit 2
`);

  const releaseArgs = [
    'scripts/pipeline/run.mjs',
    'release',
    '--confirm', 'release dev to preview',
    '--repository', 'happier-dev/happier',
    '--deploy-environment', 'preview',
    '--deploy-targets', 'server',
    '--source-sha', DEV_SOURCE_SHA,
    '--operation-id', 'rel_dirty_control_01',
    '--release-notes-id', '2026-08-09.1',
    '--allow-dirty', 'true',
    '--dry-run',
    '--json',
  ];
  const defaultDryRunArgs = releaseArgs.filter((value, index, values) => (
    value !== '--allow-dirty' && values[index - 1] !== '--allow-dirty'
  ));

  try {
    const defaultControlDirty = spawnSync(process.execPath, defaultDryRunArgs, {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        HAPPIER_TEST_GIT_STATUS: ' M scripts/pipeline/run.mjs',
      },
      encoding: 'utf8',
    });
    assert.equal(defaultControlDirty.status, 1);
    assert.match(defaultControlDirty.stderr, /RELEASE_CONTROL_WORKTREE_DIRTY/);
    assert.doesNotMatch(readFileSync(log, 'utf8'), /git (ls-remote|fetch) /, 'default dry-run planning must reject dirty control bytes before release-source resolution');

    writeFileSync(log, '');
    const controlDirty = spawnSync(process.execPath, releaseArgs, {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        HAPPIER_TEST_GIT_STATUS: ' M scripts/pipeline/run.mjs',
      },
      encoding: 'utf8',
    });
    assert.equal(controlDirty.status, 1);
    assert.match(controlDirty.stderr, /RELEASE_CONTROL_WORKTREE_DIRTY/);
    assert.match(controlDirty.stderr, /scripts\/pipeline\/run\.mjs/);
    assert.doesNotMatch(readFileSync(log, 'utf8'), /git (ls-remote|fetch) /, 'dirty control bytes must fail before release-source resolution');

    writeFileSync(log, '');
    const unrelatedDirty = spawnSync(process.execPath, releaseArgs, {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        HAPPIER_TEST_GIT_STATUS: ' M packages/sdk/src/connect.ts',
      },
      encoding: 'utf8',
    });
    assert.equal(unrelatedDirty.status, 0, unrelatedDirty.stderr);
    assert.equal(JSON.parse(unrelatedDirty.stdout).authorizedPromotionSourceSha, DEV_SOURCE_SHA);

    writeFileSync(log, '');
    const defaultUnrelatedDirty = spawnSync(process.execPath, defaultDryRunArgs, {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        HAPPIER_TEST_GIT_STATUS: ' M packages/sdk/src/connect.ts',
      },
      encoding: 'utf8',
    });
    assert.equal(defaultUnrelatedDirty.status, 0, defaultUnrelatedDirty.stderr);
    assert.equal(JSON.parse(defaultUnrelatedDirty.stdout).authorizedPromotionSourceSha, DEV_SOURCE_SHA);
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
      const resumeArgs = resumeRunId.startsWith('-')
        ? [`--resume-run-id=${resumeRunId}`]
        : ['--resume-run-id', resumeRunId];
      const result = spawnSync(process.execPath, [
        'scripts/pipeline/run.mjs', 'release',
        '--confirm', 'release dev to preview',
        '--repository', 'happier-dev/happier',
        '--deploy-environment', 'preview',
        '--deploy-targets', 'server',
        ...resumeArgs,
        '--allow-dirty', 'true',
      ], {
        cwd: repoRoot,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
        encoding: 'utf8',
      });
      assert.equal(result.status, 1, `${JSON.stringify(resumeRunId)} must fail closed`);
      assert.match(result.stderr, /--resume-run-id must be a positive GitHub Actions run ID/);
      assert.equal(readFileSync(log, 'utf8'), '', 'invalid resume identity must fail before Git or GitHub access');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('local production release defaults its hosted dispatch to the stable profile', () => {
  const root = mkdtempSync(join(tmpdir(), 'hosted-release-stable-profile-'));
  const bin = join(root, 'bin');
  const log = join(root, 'commands.log');
  mkdirSync(bin);
  writeFileSync(log, '');
  executable(join(bin, 'git'), `#!/bin/sh
set -eu
echo "git $*" >> ${JSON.stringify(log)}
if [ "$1" = diff ] && [ "$2" = --cached ]; then exit 0; fi
if [ "$1" = rev-parse ] && [ "$2" = --abbrev-ref ]; then printf 'dev\n'; exit 0; fi
if [ "$1" = ls-remote ] && [ "$3" = refs/heads/preview ]; then printf '${PREVIEW_SOURCE_SHA}\trefs/heads/preview\n'; exit 0; fi
if [ "$1" = fetch ]; then exit 0; fi
if [ "$1" = cat-file ]; then exit 0; fi
if [ "$1" = rev-parse ] && [ "$2" = FETCH_HEAD ]; then printf '${PREVIEW_SOURCE_SHA}\n'; exit 0; fi
echo "unexpected git call: $*" >&2; exit 2
`);
  executable(join(bin, 'gh'), `#!/bin/sh
set -eu
echo "gh $*" >> ${JSON.stringify(log)}
exit 0
`);
  try {
    execFileSync(process.execPath, [
      'scripts/pipeline/run.mjs',
      'release',
      '--confirm', 'release preview to main',
      '--repository', 'happier-dev/happier',
      '--deploy-environment', 'production',
      '--deploy-targets', 'server',
      '--source-sha', PREVIEW_SOURCE_SHA,
      '--workflow-control-sha', WORKFLOW_CONTROL_SHA,
      '--release-notes-id', '2026-08-09.1',
      '--allow-dirty', 'true',
    ], {
      cwd: repoRoot,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
      encoding: 'utf8',
    });
    assert.match(readFileSync(log, 'utf8'), /-f validation_profile=stable/);
    assert.doesNotMatch(readFileSync(log, 'utf8'), /-f checks_profile=/);
    assert.match(readFileSync(log, 'utf8'), /git ls-remote origin refs\/heads\/preview/);
    assert.match(readFileSync(log, 'utf8'), new RegExp(`-f authorized_promotion_source_sha=${PREVIEW_SOURCE_SHA}`));
    assert.match(readFileSync(log, 'utf8'), new RegExp(`-f workflow_control_sha=${WORKFLOW_CONTROL_SHA}`));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('hosted release rejects a malformed workflow-control SHA before Git or GitHub access', () => {
  const root = mkdtempSync(join(tmpdir(), 'hosted-release-workflow-control-'));
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
    const result = spawnSync(process.execPath, [
      'scripts/pipeline/run.mjs',
      'release',
      '--confirm', 'release dev to preview',
      '--repository', 'happier-dev/happier',
      '--deploy-environment', 'preview',
      '--deploy-targets', 'server',
      '--source-sha', DEV_SOURCE_SHA,
      '--workflow-control-sha', 'not-a-sha',
      '--allow-dirty', 'true',
    ], {
      cwd: repoRoot,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
      encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--workflow-control-sha.*40-character lowercase Git commit SHA/);
    assert.equal(readFileSync(log, 'utf8'), '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('local full release rejects deep before GitHub dispatch', () => {
  const root = mkdtempSync(join(tmpdir(), 'hosted-release-deep-profile-'));
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
    const result = spawnSync(process.execPath, [
      'scripts/pipeline/run.mjs',
      'release',
      '--confirm', 'release dev to preview',
      '--repository', 'happier-dev/happier',
      '--deploy-environment', 'preview',
      '--deploy-targets', 'server',
      '--release-profile', 'deep',
      '--allow-dirty', 'true',
    ], {
      cwd: repoRoot,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
      encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /deep.*normal dispatch/i);
    assert.equal(readFileSync(log, 'utf8'), '');
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


test('detached local dispatch consumes the complete target-owned dry-run transport', () => {
  const confirmChoices = YAML.parse(readFileSync(join(repoRoot, '.github/workflows/release.yml'), 'utf8')).on.workflow_dispatch.inputs.confirm.options;
  const root = mkdtempSync(join(tmpdir(), 'hosted-release-transport-'));
  const bin = join(root, 'bin');
  const capture = join(root, 'dispatch.json');
  mkdirSync(bin);
  executable(join(bin, 'git'), `#!/bin/sh
set -eu
if [ "$1" = rev-parse ] && [ "$2" = --is-inside-work-tree ]; then printf 'true\\n'; exit 0; fi
if [ "$1" = status ] || [ "$1" = diff ]; then exit 0; fi
if [ "$1" = rev-parse ] && [ "$2" = --abbrev-ref ]; then printf 'HEAD\\n'; exit 0; fi
if [ "$1" = ls-remote ]; then printf '%s\\t%s\\n' "\${HAPPIER_TEST_SOURCE_SHA}" "$3"; exit 0; fi
if [ "$1" = fetch ] || [ "$1" = cat-file ]; then exit 0; fi
if [ "$1" = rev-parse ] && [ "$2" = FETCH_HEAD ]; then printf '%s\\n' "\${HAPPIER_TEST_SOURCE_SHA}"; exit 0; fi
exit 2
`);
  executable(join(bin, 'gh'), `#!${process.execPath}
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify(process.argv.slice(2)));
`);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, HAPPIER_TEST_SOURCE_SHA: DEV_SOURCE_SHA };
  try {
    for (const [environment, confirm, sourceBranch] of [
      ['preview', 'release dev to preview', 'v0.3'],
      ['production', 'release preview to main', 'preview'],
      ['production', 'reset main from preview', 'preview'],
      ['production', 'release dev to main', 'v0.3'],
      ['production', 'reset main from dev', 'v0.3'],
      ['preview-and-production', 'release dev to preview and main', 'v0.3'],
    ]) {
      const args = ['scripts/pipeline/run.mjs', 'release', '--confirm', confirm,
        '--repository', 'happier-dev/happier', '--deploy-environment', environment,
        '--deploy-targets', 'ui,server', '--ui-expo-action', 'ota', '--desktop-mode', 'build_and_publish',
        '--source-sha', DEV_SOURCE_SHA, '--workflow-control-sha', WORKFLOW_CONTROL_SHA,
        '--operation-id', 'rel_transport_20261101', '--attempt-id', 'attempt_3',
        '--resume-run-id', '123', '--ci-run-id', '456', '--force-deploy', 'true',
        '--waive-ci', 'true', '--override-reason', 'Approved exact candidate waiver',
        '--release-notes-id', '2026-11-01.1', '--allow-dirty', 'true'];
      const planned = spawnSync(process.execPath, [...args, '--dry-run', '--json'], { cwd: repoRoot, env, encoding: 'utf8' });
      assert.equal(planned.status, 0, planned.stderr);
      const plan = JSON.parse(planned.stdout);
      assert.equal(plan.sourceBranch, sourceBranch);
      assert.ok(confirmChoices.includes(plan.hostedDispatch.inputs.confirm), `release.yml must admit emitted confirmation: ${plan.hostedDispatch.inputs.confirm}`);
      assert.equal(plan.hostedDispatch.ref, 'v0.3');
      assert.equal(plan.hostedDispatch.inputs.workflow_control_sha, WORKFLOW_CONTROL_SHA);
      assert.equal(plan.hostedDispatch.inputs.hmaint_attempt_id, 'attempt_3');
      assert.equal(plan.hostedDispatch.inputs.validation_profile, environment === 'preview' ? 'integrated' : 'stable');
      assert.equal(plan.hostedDispatch.inputs.authorized_promotion_source_sha, DEV_SOURCE_SHA);
      const grantArgs = [...args, '--release-profile', 'integrated',
        '--include-validation-suites', 'binary-smoke', '--waive-validation-suites', 'source-contracts',
        '--approve-public-sdk-release', 'true', '--plugin-sdk-ready', 'true',
        '--plugin-sdk-api-classification', 'compatible', '--plugin-sdk-migration-notes', '2026-11-01.1',
        '--sdk-auth-readiness', 'waived', '--sdk-auth-waiver', 'approved-auth-review',
        '--sdk-api-classification', 'breaking', '--sdk-migration-notes', '2026-11-01.1',
        '--qualified-v4-activation-approval', 'true',];
      const grantResult = spawnSync(process.execPath, [...grantArgs, '--dry-run', '--json'], { cwd: repoRoot, env, encoding: 'utf8' });
      assert.equal(grantResult.status, 0, grantResult.stderr);
      const grantPlan = JSON.parse(grantResult.stdout);
      const replayPath = join(root, 'approved-replay.json');
      const priorGrant = structuredClone(grantPlan);
      priorGrant.hostedDispatch.inputs.ci_run_id = '455';
      writeFileSync(replayPath, JSON.stringify(priorGrant));
      const replayArgs = ['scripts/pipeline/run.mjs', 'release', '--dry-run', '--json',
        '--ci-run-id', '456', '--approved-intent', replayPath];
      const replayed = spawnSync(process.execPath, replayArgs, { cwd: repoRoot, env, encoding: 'utf8' });
      assert.equal(replayed.status, 0, `${confirm}: approved input replay must retain nondefault grants: ${replayed.stderr}`);
      assert.deepEqual(JSON.parse(replayed.stdout), grantPlan, 'approved JSON alone supplies the complete public grant');
      for (const changedArgs of [
        ['--force-deploy', 'false'], ['--workflow-control-sha', 'b'.repeat(40)],
        ['--attempt-id', 'attempt_4'],
        ['--deploy-targets', 'ui,server,website'],
        ['--sdk-auth-readiness', 'ready'],
      ]) {
        const refusedReplay = spawnSync(process.execPath, [...replayArgs, ...changedArgs], { cwd: repoRoot, env, encoding: 'utf8' });
        assert.equal(refusedReplay.status, 1, `explicit ${changedArgs[0]} overrides must refuse grant drift`);
        assert.match(refusedReplay.stderr, /approved release intent/i);
        assert.equal(refusedReplay.stdout, '');
      }
      if (environment === 'preview-and-production') {
        const resumeArgs = [...replayArgs, '--resume-run-id', '124', '--attempt-id', 'attempt_4',
          '--workflow-control-sha', 'b'.repeat(40), '--ci-run-id', '789'];
        const resumed = spawnSync(process.execPath, resumeArgs, { cwd: repoRoot, env, encoding: 'utf8' });
        assert.equal(resumed.status, 0, `resume must retain the approved grant: ${resumed.stderr}`);
        const resumedPlan = structuredClone(grantPlan);
        resumedPlan.resumeRunId = '124';
        Object.assign(resumedPlan.hostedDispatch.inputs, { resume_run_id: '124', hmaint_attempt_id: 'attempt_4',
          workflow_control_sha: 'b'.repeat(40), ci_run_id: '789' });
        assert.deepEqual(JSON.parse(resumed.stdout), resumedPlan, 'only admitted resume bindings and exact CI refresh');
        const skippedAttempt = spawnSync(process.execPath, [...resumeArgs, '--attempt-id', 'attempt_5'], { cwd: repoRoot, env, encoding: 'utf8' });
        assert.equal(skippedAttempt.status, 1, 'only the next attempt can rebind resume control');
        assert.match(skippedAttempt.stderr, /approved release intent/i);
        assert.equal(skippedAttempt.stdout, '');
        const resumedDrift = spawnSync(process.execPath, [...resumeArgs, '--force-deploy', 'false'], { cwd: repoRoot, env, encoding: 'utf8' });
        assert.equal(resumedDrift.status, 1, 'resume must retain all other grant fields');
        assert.match(resumedDrift.stderr, /approved release intent/i);
        assert.equal(resumedDrift.stdout, '');
      }
      if (environment === 'preview') {
        const approvedPath = join(root, 'approved-intent.json');
        const approved = structuredClone(plan);
        approved.hostedDispatch.inputs.ci_run_id = '455';
        writeFileSync(approvedPath, JSON.stringify(approved));
        const finalArgs = [...args, '--dry-run', '--json', '--approved-intent', approvedPath];
        const accepted = spawnSync(process.execPath, finalArgs, { cwd: repoRoot, env, encoding: 'utf8' });
        assert.equal(accepted.status, 0, accepted.stderr);
        assert.deepEqual(JSON.parse(accepted.stdout), plan, 'only the exact child CI binding may refresh');
        for (const [label, changedArgs] of [
          ['scope', ['--deploy-targets', 'ui,server,website']],
          ['control', ['--workflow-control-sha', 'b'.repeat(40)]],
          ['hosted approval', ['--force-deploy', 'false']],
          ['SDK', ['--sdk-auth-readiness', 'ready']],
          ['notes', ['--release-notes-id', 'changed-notes']],
          ['profile', ['--release-profile', 'stable']],
        ]) {
          const refused = spawnSync(process.execPath, [...finalArgs, ...changedArgs], { cwd: repoRoot, env, encoding: 'utf8' });
          assert.equal(refused.status, 1, `${label} grant drift must refuse`);
          assert.match(refused.stderr, /approved release intent/i, label);
          assert.equal(refused.stdout, '', 'a refused grant must not emit dispatch transport');
        }
        const changedSource = structuredClone(approved);
        changedSource.authorizedPromotionSourceSha = '3'.repeat(40);
        writeFileSync(approvedPath, JSON.stringify(changedSource));
        const reboundRefusal = spawnSync(process.execPath, finalArgs, { cwd: repoRoot, env, encoding: 'utf8' });
        assert.equal(reboundRefusal.status, 1, 'the materializer-authorized child must remain bound');
        assert.match(reboundRefusal.stderr, /approved release intent/i);
      }
      const executed = spawnSync(process.execPath, args, { cwd: repoRoot, env, encoding: 'utf8' });
      assert.equal(executed.status, 0, executed.stderr);
      const { repository, workflow, ref, inputs } = plan.hostedDispatch;
      assert.deepEqual(JSON.parse(readFileSync(capture, 'utf8')), [
        'workflow', 'run', workflow, '--repo', repository, '--ref', ref,
        ...Object.entries(inputs).flatMap(([key, value]) => ['-f', `${key}=${value}`]),
      ]);
    }
    const changed = spawnSync(process.execPath, ['scripts/pipeline/run.mjs', 'release',
      '--confirm', 'release dev to preview', '--repository', 'happier-dev/happier',
      '--deploy-environment', 'preview', '--source-sha', DEV_SOURCE_SHA,
      '--release-notes-id', '2026-11-01.1', '--allow-dirty', 'true'], {
      cwd: repoRoot, env: { ...env, HAPPIER_TEST_SOURCE_SHA: PREVIEW_SOURCE_SHA }, encoding: 'utf8',
    });
    assert.equal(changed.status, 1, 'changed approved source must refuse before dispatch');
    assert.match(changed.stderr, /(?:did not match|not an ancestor|does not match)/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
