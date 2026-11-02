import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

async function workflow(name) {
  return parse(await readFile(join(repoRoot, '.github', 'workflows', name), 'utf8'));
}

test('combined preview and production release reuses the canonical channel workflow concurrently', async () => {
  const [combined, release] = await Promise.all([
    workflow('release.yml'),
    workflow('release-channel.yml'),
  ]);
  await assert.rejects(readFile(join(repoRoot, '.github/workflows/release-preview-and-production.yml')), { code: 'ENOENT' });
  assert.ok(combined.on.workflow_dispatch.inputs.environment.options.includes('preview-and-production'));
  assert.equal(combined.jobs.source_validation.uses, './.github/workflows/release-source-validation.yml');
  assert.equal(combined.jobs.source_validation.with.base_refs, "${{ inputs.environment == 'preview-and-production' && 'preview,main' || inputs.environment == 'preview' && 'preview' || 'main' }}");
  for (const name of ['release_single', 'release_preview', 'release_production']) {
    const channel = combined.jobs[name];
    assert.ok(channel.needs.includes('source_validation'));
    assert.equal(channel.with.shared_source_validation_sha, '${{ needs.source_validation.outputs.source_sha }}');
  }
  for (const name of ['ci', 'mysql_db_contract', 'platform_service_validation', 'trust_root_validation']) assert.equal(release.jobs[name], undefined);

  assert.ok(release.on.workflow_call, 'the canonical channel workflow must be reusable');
  assert.equal(release.on.workflow_call.inputs.combined_preview_production.default, false);
  assert.equal(release.concurrency.group, 'release-channel-${{ inputs.environment }}');
  assert.equal(release.concurrency['cancel-in-progress'], false);

  const preview = combined.jobs.release_preview;
  const production = combined.jobs.release_production;
  assert.equal(preview.uses, './.github/workflows/release-channel.yml');
  assert.equal(production.uses, './.github/workflows/release-channel.yml');
  assert.ok(preview.needs.includes('snapshot_release_issues'));
  assert.ok(production.needs.includes('snapshot_release_issues'));
  assert.notEqual(preview.needs, 'release_production', 'preview must not wait for the production channel');
  assert.notEqual(production.needs, 'release_preview', 'production must not wait for the preview channel');
  assert.equal(preview.with.environment, 'preview');
  assert.equal(preview.with.confirm, 'release dev to preview');
  assert.equal(production.with.environment, 'production');
  assert.equal(combined.on.workflow_dispatch.inputs.qualified_v4_activation_approval, undefined);
  assert.equal(preview.with.qualified_v4_activation_approval, undefined);
  assert.equal(production.with.qualified_v4_activation_approval, undefined);
  assert.equal(production.with.confirm, 'release dev to main');
  assert.equal(preview.with.authorized_promotion_source_sha, '${{ needs.release_preflight.outputs.source_sha }}');
  assert.equal(production.with.authorized_promotion_source_sha, '${{ needs.release_preflight.outputs.source_sha }}');
  assert.equal(preview.with.ci_run_id, '${{ inputs.ci_run_id }}');
  assert.equal(production.with.ci_run_id, '${{ inputs.ci_run_id }}');
  assert.equal(preview.with.combined_preview_production, true);
  assert.equal(production.with.combined_preview_production, true);

  const advance = combined.jobs.advance_release_issues;
  assert.deepEqual(advance.needs, ['snapshot_release_issues', 'release_preview', 'release_production']);
  assert.match(String(advance.if), /always\(\)/u);
  assert.match(String(advance.if), /needs\.release_preview\.outputs\.release_complete == 'true' \|\| needs\.release_production\.outputs\.release_complete == 'true'/u);
  assert.doesNotMatch(String(advance.if), /needs\.release_(?:preview|production)\.result/u, 'availability follows verified terminal channel completion even when the other channel fails');
  const reconcile = advance.steps.find((step) => step.env?.TO_STAGE);
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
  assert.ok(combined.jobs.snapshot_release_issues.outputs.preview_issues_json, 'a later recovery must include already-preview issues');

  for (const forbiddenJob of ['plan', 'publish_cli_binaries', 'publish_server_runtime', 'deploy_ui']) {
    assert.equal(combined.jobs[forbiddenJob], undefined, `combined workflow must not copy the canonical ${forbiddenJob} job`);
  }
});


test('the reusable channel retains the canonical top-level OIDC caller identity', async () => {
  const [root, channel] = await Promise.all([workflow('release.yml'), workflow('release-channel.yml')]);
  assert.equal(root.permissions['id-token'], 'write');
  for (const name of ['release_single', 'release_preview', 'release_production']) assert.equal(root.jobs[name].permissions['id-token'], 'write');
  const env = { ...process.env, CALLER_REPOSITORY: 'happier-dev/happier', WORKFLOW_REPOSITORY: 'happier-dev/happier',
    WORKFLOW_REF: 'happier-dev/happier/.github/workflows/release-channel.yml@refs/heads/dev',
    CALLER_WORKFLOW_REF: 'happier-dev/happier/.github/workflows/release.yml@refs/heads/dev' };
  const guard = channel.jobs.trusted_ref_guard.steps[0].run;
  const run = overrides => spawnSync('bash', ['-c', guard], { env: { ...env, ...overrides }, encoding: 'utf8' });
  assert.equal(run({}).status, 0);
  for (const caller of ['release-channel.yml', 'release-preview-and-production.yml']) {
    assert.notEqual(run({ CALLER_WORKFLOW_REF: `happier-dev/happier/.github/workflows/${caller}@refs/heads/dev` }).status, 0);
  }
  assert.notEqual(run({ WORKFLOW_REF: env.WORKFLOW_REF.replace('heads/dev', 'heads/topic/untrusted') }).status, 0);
});


test('canonical source admission and channel publication have a schedulable dependency graph', async () => {
  for (const name of ['release.yml', 'release-channel.yml']) {
    const { jobs } = await workflow(name);
    const active = new Set();
    const completed = new Set();
    const visit = name => {
      assert.ok(jobs[name], `dependency ${name} must exist`);
      assert.ok(!active.has(name), `dependency cycle reaches ${name}`);
      if (completed.has(name)) return;
      active.add(name);
      const needs = jobs[name].needs;
      for (const dependency of Array.isArray(needs) ? needs : needs ? [needs] : []) visit(dependency);
      active.delete(name);
      completed.add(name);
    };
    for (const name of Object.keys(jobs)) visit(name);
  }
});
