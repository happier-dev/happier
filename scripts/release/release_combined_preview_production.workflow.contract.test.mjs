import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { resolveNormalReleaseProfile } from '../pipeline/release-validation/resolve-profile.mjs';
import { admitRelease } from '../pipeline/release/admit-release.mjs';
import { parse } from 'yaml';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

async function workflow(name) {
  return parse(await readFile(join(repoRoot, '.github', 'workflows', name), 'utf8'));
}

test('the top-level release authority owns combined dispatch and one shared source validation', async () => {
  const release = await workflow('release.yml');
  assert.ok(release.on.workflow_dispatch.inputs.environment.options.includes('preview-and-production'));
  const preview = release.jobs.release_preview;
  const production = release.jobs.release_production;
  assert.equal(preview.uses, './.github/workflows/release-channel.yml');
  assert.equal(production.uses, './.github/workflows/release-channel.yml');
  assert.equal(preview.with.confirm, 'release dev to preview');
  assert.equal(production.with.confirm, 'release dev to main');
  assert.equal(preview.with.authorized_promotion_source_sha, '${{ inputs.authorized_promotion_source_sha }}');
  assert.equal(production.with.authorized_promotion_source_sha, '${{ inputs.authorized_promotion_source_sha }}');
  assert.equal(release.jobs.source_validation.with.base_refs, "${{ inputs.environment == 'preview-and-production' && 'preview,main' || inputs.environment == 'preview' && 'preview' || 'main' }}");
  const advance = release.jobs.advance_release_issues;
  assert.match(advance.if, /needs\.release_preview\.outputs\.release_complete == 'true' \|\| needs\.release_production\.outputs\.release_complete == 'true'/u);
  assert.doesNotMatch(advance.if, /needs\.release_(?:preview|production)\.result/u);
  assert.ok(release.jobs.snapshot_release_issues.outputs.preview_issues_json);
  const snapshotStep = release.jobs.snapshot_release_issues.steps.find(step => step.id === 'snapshot');
  assert.equal(snapshotStep.env.CANDIDATE_SHA, '${{ needs.release_preflight.outputs.source_sha }}');
  for (const line of snapshotStep.run.split('\n').filter(line => line.includes('reconcile-issue-stage.mjs snapshot'))) {
    assert.match(line, /--candidate-sha "\$CANDIDATE_SHA"/u);
  }
  assert.equal(release.jobs.release_single.uses, './.github/workflows/release-channel.yml');
});

test('channel publication consumes shared source evidence without duplicating source gates', async () => {
  const [release, channel, sourceValidation] = await Promise.all([
    workflow('release.yml'), workflow('release-channel.yml'), workflow('release-source-validation.yml'),
  ]);
  assert.equal(channel.on.workflow_dispatch, undefined);
  assert.ok(channel.on.workflow_call);
  assert.equal(channel.concurrency.group, 'release-channel-${{ inputs.environment }}');
  for (const owner of [release, channel]) {
    for (const job of ['mysql_db_contract', 'platform_service_validation', 'trust_root_validation']) assert.equal(owner.jobs[job], undefined);
    assert.doesNotMatch(JSON.stringify(owner.jobs.release_preflight), /verify-existing-ci\.mjs/u);
  }
  assert.equal(release.jobs.source_validation.uses, './.github/workflows/release-source-validation.yml');
  assert.equal(release.jobs.source_validation.with.source_sha, '${{ needs.release_preflight.outputs.source_sha }}');
  assert.equal(release.jobs.release_preflight.steps.find(step => step.id === 'source').env.SOURCE_SHA, '${{ inputs.authorized_promotion_source_sha }}');
  assert.equal(sourceValidation.on.workflow_call.inputs.base_refs.type, 'string');
  for (const job of ['release_single', 'release_preview', 'release_production']) {
    assert.ok(release.jobs[job].needs.includes('source_validation'));
    for (const field of ['sha', 'ci_result', 'mysql_result', 'platform_result', 'trust_roots_result']) {
      const input = field === 'sha' ? 'shared_source_validation_sha' : 'shared_' + field;
      const output = field === 'sha' ? 'source_sha' : field;
      assert.equal(release.jobs[job].with[input], '${{ needs.source_validation.outputs.' + output + ' }}');
    }
  }
  assert.equal(release.on.workflow_dispatch.inputs.validation_profile.default, 'auto');
  assert.match(release.jobs.resolve_validation_profile.steps.find(step => step.id === 'resolve').env.VALIDATION_PROFILE, /preview-and-production.*stable.*integrated/u);
  const advance = release.jobs.advance_release_issues;
  const reconcile = advance.steps.find(step => step.env?.TO_STAGE);
  assert.equal(reconcile.env.TO_STAGE, "${{ needs.release_production.outputs.release_complete == 'true' && 'stage:stable' || 'stage:preview' }}");
  const evaluate = (expression, needs, dryRun = false) => Function('needs', 'inputs', 'always',
    `return ${expression.slice(3, -2).trim()};`)(needs, { dry_run: dryRun, environment: 'preview-and-production' }, () => true);
  for (const [previewComplete, productionComplete, expectedStage] of [
    ['false', 'false', null], ['true', 'false', 'stage:preview'],
    ['false', 'true', 'stage:stable'], ['true', 'true', 'stage:stable'],
  ]) {
    const needs = {
      snapshot_release_issues: { outputs: { eligible: 'true' } },
      release_preview: { result: previewComplete === 'true' ? 'success' : 'failure', outputs: { release_complete: previewComplete } },
      release_production: { result: productionComplete === 'true' ? 'success' : 'failure', outputs: { release_complete: productionComplete } },
    };
    assert.equal(evaluate(advance.if, needs), expectedStage !== null);
    assert.equal(evaluate(advance.if, needs, true), false, 'dry runs never advance even when channel evidence is complete');
    if (expectedStage) assert.equal(evaluate(reconcile.env.TO_STAGE, needs), expectedStage);
  }
  assert.match(reconcile.run, /--from-stage "stage:source"[\s\S]*--to-stage "\$TO_STAGE"/u);
  assert.match(reconcile.run, /--from-stage "stage:dev"[\s\S]*--to-stage "\$TO_STAGE"/u);
  assert.match(reconcile.run, /if \[ "\$TO_STAGE" = "stage:stable" \]; then[\s\S]*--from-stage "stage:preview"[\s\S]*--to-stage "\$TO_STAGE"/u);
  await assert.rejects(readFile(join(repoRoot, '.github/workflows/release-preview-and-production.yml')), { code: 'ENOENT' });
});

test('trusted channel control admits the top-level OIDC caller and rejects a leaf or obsolete caller', async () => {
  const [root, channel, npm] = await Promise.all([
    workflow('release.yml'), workflow('release-channel.yml'), workflow('release-npm.yml'),
  ]);
  // GitHub's reusable-workflow OIDC contract keeps caller workflow_ref distinct
  // from the called job_workflow_ref; npm validates the calling workflow name.
  const env = {
    ...process.env,
    CALLER_REPOSITORY: 'happier-dev/happier', WORKFLOW_REPOSITORY: 'happier-dev/happier',
    CALLER_WORKFLOW_REF: 'happier-dev/happier/.github/workflows/release.yml@refs/heads/dev',
    WORKFLOW_REF: 'happier-dev/happier/.github/workflows/release-channel.yml@refs/heads/dev',
  };
  const guard = channel.jobs.trusted_ref_guard.steps[0].run;
  const run = overrides => spawnSync('bash', ['-c', guard], { env: { ...env, ...overrides }, encoding: 'utf8' });
  assert.equal(run({}).status, 0);
  assert.notEqual(run({ CALLER_WORKFLOW_REF: env.WORKFLOW_REF }).status, 0);
  assert.notEqual(run({ CALLER_WORKFLOW_REF: 'happier-dev/happier/.github/workflows/release-preview-and-production.yml@refs/heads/dev' }).status, 0);
  assert.notEqual(run({ CALLER_REPOSITORY: 'fork/happier' }).status, 0);
  assert.equal(root.permissions['id-token'], 'write');
  for (const name of ['release_single', 'release_preview', 'release_production']) assert.equal(root.jobs[name].permissions['id-token'], 'write');
  assert.equal(channel.jobs.publish_npm.permissions['id-token'], 'write');
  assert.equal(channel.jobs.publish_npm.uses, './.github/workflows/release-npm.yml');
  assert.ok(Object.values(npm.jobs).some(job => job.permissions?.['id-token'] === 'write'));
  // Characterized GitHub limit: https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#onworkflow_dispatchinputs
  assert.ok(Object.keys(root.on.workflow_dispatch.inputs).length <= 25);
});

test('combined confirmation and automatic profile reach production admission through the existing owners', async () => {
  const root = await workflow('release.yml');
  const sourceSha = 'a'.repeat(40);
  const step = root.jobs.trusted_ref_guard.steps.find(entry => entry.name === 'Bind combined release to one explicit approved dev candidate');
  const env = { ...process.env, ENVIRONMENT: 'preview-and-production', CONFIRM: 'release dev to preview and main', SOURCE_SHA: sourceSha, CANDIDATE_RUN_ID: '' };
  assert.equal(spawnSync('bash', ['-c', step.run], { env }).status, 0);
  assert.notEqual(spawnSync('bash', ['-c', step.run], { env: { ...env, CONFIRM: 'release dev to preview' } }).status, 0);
  assert.notEqual(spawnSync('bash', ['-c', step.run], { env: { ...env, SOURCE_SHA: '' } }).status, 0);
  const expression = root.jobs.resolve_validation_profile.steps.find(entry => entry.id === 'resolve').env.VALIDATION_PROFILE;
  const evaluate = inputs => Function('inputs', `return ${expression.replace(/^\$\{\{\s*|\s*\}\}$/gu, '')};`)(inputs);
  assert.deepEqual(resolveNormalReleaseProfile(evaluate({ environment: 'preview', validation_profile: 'auto' })), { profile: 'integrated', checksProfile: 'fast' });
  const profile = resolveNormalReleaseProfile(evaluate({ environment: env.ENVIRONMENT, validation_profile: 'auto' }));
  assert.deepEqual(profile, { profile: 'stable', checksProfile: 'full' });
  assert.deepEqual(admitRelease({
    checksProfile: profile.checksProfile, environment: 'production', plannedSourceSha: sourceSha, validatedSourceSha: sourceSha,
    ciResult: 'success', publishServerRuntimeNeeded: false, publishCliBinariesNeeded: false,
    risks: { mysqlContract: false, platformServices: false, trustRoots: false },
    gates: { mysql: 'skipped', platform: 'skipped', trustRoots: 'skipped', mutagenEngine: 'success' },
  }), { admitted: true });
});
