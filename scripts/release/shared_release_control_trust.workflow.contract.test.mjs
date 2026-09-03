import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

function workflow(name) {
  return YAML.parse(readFileSync(join(repoRoot, '.github', 'workflows', name), 'utf8'));
}

function step(job, name) {
  const found = job?.steps?.find((candidate) => candidate?.name === name);
  assert.ok(found, `missing step: ${name}`);
  return found;
}

function assertTrustedControl(job, localStepName) {
  const checkouts = job?.steps?.filter((candidate) => candidate?.uses === 'actions/checkout@11d5960a326750d5838078e36cf38b85af677262') ?? [];
  assert.equal(checkouts.length, 1, `${localStepName} job must have exactly one checkout`);
  assert.equal(checkouts[0].with?.repository, '${{ job.workflow_repository }}');
  assert.equal(checkouts[0].with?.ref, '${{ job.workflow_sha }}');
  assert.equal(checkouts[0].with?.['persist-credentials'], false);
  assert.equal(checkouts[0].with?.path, undefined, 'trusted control must own the workspace root');

  const checkoutIndex = job.steps.indexOf(checkouts[0]);
  const localStepIndex = job.steps.findIndex((candidate) => candidate?.name === localStepName);
  assert.ok(checkoutIndex >= 0 && checkoutIndex < localStepIndex, 'trusted checkout must precede local control execution');
}

test('secret-bearing local release control is pinned to the called workflow repository and SHA', () => {
  const promote = workflow('promote-branch.yml').jobs;
  const deploy = workflow('deploy.yml').jobs;
  const publish = workflow('publish-github-release.yml').jobs;

  assertTrustedControl(promote.release_actor_guard, 'Authorize release actor');
  assertTrustedControl(promote.promote, 'Promote branch (pipeline)');
  assertTrustedControl(deploy.release_actor_guard, 'Authorize release actor');
  assertTrustedControl(deploy.deploy, 'Trigger deploy webhook(s)');
  assertTrustedControl(publish.release_actor_guard, 'Authorize release actor');
  assertTrustedControl(publish.publish, 'Publish GitHub release (pipeline)');
});

test('release shell steps receive GitHub inputs and outputs only through environment variables', () => {
  for (const name of ['promote-branch.yml', 'deploy.yml', 'publish-github-release.yml']) {
    const parsed = workflow(name);
    for (const [jobName, job] of Object.entries(parsed.jobs ?? {})) {
      for (const candidate of job?.steps ?? []) {
        if (typeof candidate?.run !== 'string') continue;
        assert.doesNotMatch(
          candidate.run,
          /\$\{\{/,
          `${name} ${jobName}/${candidate.name} must not interpolate GitHub expressions into shell source`,
        );
      }
    }
  }
});

test('top-level release planning keeps dispatch data out of shell source and uses read-only permissions', () => {
  const release = workflow('release.yml');
  assert.deepEqual(release.jobs?.release_actor_guard?.needs, ['trusted_ref_guard', 'release_preflight']);
  assert.doesNotMatch(JSON.stringify(release.jobs?.trusted_ref_guard), /secrets\.|environment/);
  assert.match(JSON.stringify(release.jobs?.trusted_ref_guard), /job\.workflow_ref/);
  const plan = release.jobs?.plan;
  assert.ok(plan, 'missing release plan job');
  assert.equal(plan.permissions?.contents, 'read');

  for (const candidate of plan.steps ?? []) {
    if (typeof candidate?.run !== 'string') continue;
    assert.doesNotMatch(
      candidate.run,
      /\$\{\{\s*(?:inputs\.|steps\.[^.]+\.outputs\.)/,
      `release.yml plan/${candidate.name} must transport dispatch and step-output data through env`,
    );
  }
});

test('publish artifact data cannot overwrite trusted release control', () => {
  const publishJob = workflow('publish-github-release.yml').jobs.publish;
  const validate = step(publishJob, 'Validate publish inputs');
  const download = step(publishJob, 'Download release assets artifact');
  const publisher = step(publishJob, 'Publish GitHub release (pipeline)');

  assert.ok(publishJob.steps.indexOf(validate) < publishJob.steps.indexOf(download));
  assert.ok(publishJob.steps.indexOf(download) < publishJob.steps.indexOf(publisher));
  assert.equal(validate.env?.INPUT_ASSETS_ARTIFACT_PATH, '${{ inputs.assets_artifact_path }}');
  assert.match(validate.run, /dist\/\*/);
  assert.match(validate.run, /git check-ref-format/);
});

function renderExpressions(run, replacements) {
  let rendered = run;
  for (const [expression, value] of Object.entries(replacements)) {
    rendered = rendered.replaceAll(`\${{ ${expression} }}`, value);
  }
  return rendered;
}

function assertMaliciousInputRemainsData({ run, replacements, env }) {
  const scratch = mkdtempSync(join(tmpdir(), 'happier-release-shell-trust-'));
  const marker = join(scratch, 'injected');
  const fakeNode = join(scratch, 'node');
  writeFileSync(fakeNode, '#!/bin/sh\nexit 0\n');
  chmodSync(fakeNode, 0o755);

  try {
    const rendered = renderExpressions(run, replacements);
    const result = spawnSync('/bin/bash', ['-c', rendered], {
      cwd: repoRoot,
      env: {
        ...process.env,
        ...env,
        PATH: `${scratch}:${process.env.PATH ?? ''}`,
        INJECTION_MARKER: marker,
      },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(existsSync(marker), false, 'caller-controlled input executed as shell source');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function runValidation(run, env) {
  const scratch = mkdtempSync(join(tmpdir(), 'happier-release-input-validation-'));
  const marker = join(scratch, 'injected');
  try {
    const result = spawnSync('/bin/bash', ['-c', run], {
      cwd: repoRoot,
      env: {
        ...process.env,
        ...env,
        GITHUB_OUTPUT: join(scratch, 'output'),
        GITHUB_STEP_SUMMARY: join(scratch, 'summary'),
        INJECTION_MARKER: marker,
      },
      encoding: 'utf8',
    });
    assert.equal(existsSync(marker), false, 'validation input executed as shell source');
    return result;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

test('workflow boundaries reject malicious refs, release metadata, and deploy targets', () => {
  const injection = 'safe"; printf injected > "$INJECTION_MARKER"; #';

  const promoteValidation = step(workflow('promote-branch.yml').jobs.promote, 'Validate inputs').run;
  const validPromoteResult = runValidation(promoteValidation, {
    INPUT_SOURCE: 'dev',
    INPUT_SOURCE_SHA: '',
    INPUT_TARGET: 'main',
    INPUT_MODE: 'fast_forward',
    INPUT_DRY_RUN: 'true',
    INPUT_ALLOW_RESET: 'false',
    INPUT_CONFIRM: 'promote main from dev',
  });
  assert.equal(validPromoteResult.status, 0, validPromoteResult.stderr);
  const promoteResult = runValidation(promoteValidation, {
    INPUT_SOURCE: injection,
    INPUT_SOURCE_SHA: '',
    INPUT_TARGET: 'main',
    INPUT_MODE: 'fast_forward',
    INPUT_DRY_RUN: 'true',
    INPUT_ALLOW_RESET: 'false',
    INPUT_CONFIRM: `promote main from ${injection}`,
  });
  assert.notEqual(promoteResult.status, 0, 'malicious source ref must be rejected');

  const publishValidation = step(workflow('publish-github-release.yml').jobs.publish, 'Validate publish inputs').run;
  const publishBaseEnv = {
    INPUT_TAG: 'ui-desktop-preview',
    INPUT_TITLE: 'Release title',
    INPUT_TARGET_SHA: '0123456789abcdef0123456789abcdef01234567',
    INPUT_PRERELEASE: 'true',
    INPUT_ROLLING_TAG: 'true',
    INPUT_GENERATE_NOTES: 'false',
    INPUT_CLOBBER: 'true',
    INPUT_PRUNE_ASSETS: 'true',
    INPUT_ASSETS: '',
    INPUT_ASSETS_DIR: 'dist/release-assets',
    INPUT_ASSETS_ARTIFACT: 'release-assets',
    INPUT_ASSETS_ARTIFACT_PATH: 'dist/release-assets',
  };
  const validPublishResult = runValidation(publishValidation, publishBaseEnv);
  assert.equal(validPublishResult.status, 0, validPublishResult.stderr);
  const maliciousTagResult = runValidation(publishValidation, {
    ...publishBaseEnv,
    INPUT_TAG: injection,
  });
  assert.notEqual(maliciousTagResult.status, 0, 'malicious release tag must be rejected');
  const traversalResult = runValidation(publishValidation, {
    ...publishBaseEnv,
    INPUT_ASSETS_ARTIFACT_PATH: 'dist/../scripts',
  });
  assert.notEqual(traversalResult.status, 0, 'artifact traversal into trusted control must be rejected');

  const deployValidation = step(workflow('deploy.yml').jobs.deploy, 'Resolve target (env + component)').run;
  const validDeployResult = runValidation(deployValidation, {
    EVENT_NAME: 'workflow_call',
    INPUT_ENV: 'production',
    INPUT_COMPONENT: 'ui',
    INPUT_CONFIRM: 'deploy production ui',
    GITHUB_REF_NAME: 'main',
  });
  assert.equal(validDeployResult.status, 0, validDeployResult.stderr);
  const deployResult = runValidation(deployValidation, {
    EVENT_NAME: 'workflow_call',
    INPUT_ENV: 'production',
    INPUT_COMPONENT: injection,
    INPUT_CONFIRM: `deploy production ${injection}`,
    GITHUB_REF_NAME: 'main',
  });
  assert.notEqual(deployResult.status, 0, 'malicious deploy component must be rejected');
});

test('malicious branch and release inputs remain opaque publisher arguments', () => {
  const injection = 'safe"; printf injected > "$INJECTION_MARKER"; #';
  const promoteRun = step(workflow('promote-branch.yml').jobs.promote, 'Promote branch (pipeline)').run;
  assertMaliciousInputRemainsData({
    run: promoteRun,
    replacements: {
      'inputs.source': injection,
      'inputs.target': 'main',
      'inputs.mode': 'fast_forward',
      'inputs.allow_reset': 'false',
      'inputs.confirm': 'promote main from safe',
      "inputs.dry_run && '--dry-run' || ''": '--dry-run',
    },
    env: {
      INPUT_SOURCE: injection,
      INPUT_SOURCE_SHA: '',
      INPUT_TARGET: 'main',
      INPUT_MODE: 'fast_forward',
      INPUT_ALLOW_RESET: 'false',
      INPUT_CONFIRM: 'promote main from safe',
      INPUT_DRY_RUN: 'true',
      GITHUB_STEP_SUMMARY: join(tmpdir(), 'unused-release-summary'),
    },
  });

  const publishRun = step(workflow('publish-github-release.yml').jobs.publish, 'Publish GitHub release (pipeline)').run;
  assertMaliciousInputRemainsData({
    run: publishRun,
    replacements: {
      'inputs.tag': injection,
      'inputs.title': 'Release title',
      'inputs.target_sha': '0123456789abcdef0123456789abcdef01234567',
      'inputs.prerelease': 'true',
      'inputs.rolling_tag': 'true',
      'inputs.generate_notes': 'false',
      'inputs.clobber': 'true',
      'inputs.prune_assets': 'true',
    },
    env: {
      INPUT_TAG: injection,
      INPUT_TITLE: 'Release title',
      INPUT_TARGET_SHA: '0123456789abcdef0123456789abcdef01234567',
      INPUT_PRERELEASE: 'true',
      INPUT_ROLLING_TAG: 'true',
      INPUT_GENERATE_NOTES: 'false',
      INPUT_CLOBBER: 'true',
      INPUT_PRUNE_ASSETS: 'true',
      NOTES: 'notes',
      ASSETS: '',
      assets_dir: '',
      release_message: '',
    },
  });
});
