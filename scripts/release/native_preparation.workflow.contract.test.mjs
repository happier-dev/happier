import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const workflow = (name) => YAML.parse(readFileSync(resolve(root, `.github/workflows/${name}.yml`), 'utf8'));

function prerequisites(jobs, name, seen = new Set()) {
  for (const dependency of jobs[name]?.needs ?? []) {
    if (seen.has(dependency)) continue;
    seen.add(dependency);
    prerequisites(jobs, dependency, seen);
  }
  return seen;
}

test('native preparation overlaps immutable component verification while credential-bearing consumers retain admission', () => {
  for (const [name, preparationJobs, publicationJobs, gate, sourceGate] of [
    ['nightly-dev', ['prepare_ui_mobile', 'prepare_ui_desktop'], ['ui_mobile', 'ui_desktop'], 'release_verify', 'verify_source_ci'],
    ['release-channel', ['prepare_ui'], ['deploy_ui'], 'verify_release_candidates', 'release_admission'],
  ]) {
    const { jobs } = workflow(name);
    for (const job of preparationJobs) {
      assert.ok(jobs[job], `${name} must expose credential-free preparation`);
      assert.equal(jobs[job].with.preparation_only, true);
      const dependencies = prerequisites(jobs, job);
      assert.ok(dependencies.has(sourceGate), `${name}/${job} must retain exact-source admission`);
      assert.ok(!dependencies.has(gate), `${name}/${job} must not wait for unrelated components`);
      assert.match(jobs[job].with.source_ref, /prepare_release_candidate.outputs.source_sha/);
    }
    for (const job of publicationJobs) {
      const dependencies = prerequisites(jobs, job);
      const publicationGate = name === 'nightly-dev' ? gate : sourceGate;
      assert.ok(dependencies.has(publicationGate), `${name}/${job} must retain publication admission`);
      if (name === 'release-channel') {
        assert.ok(!dependencies.has(gate), `${name}/${job} must not wait for unrelated components`);
        for (const promotion of ['promote_preview', 'promote_main']) {
          assert.ok(!dependencies.has(promotion), `${name}/${job} publishes before channel promotion`);
          assert.ok(prerequisites(jobs, promotion).has(job), `${name}/${promotion} waits for ${job}`);
        }
      }
      const preparation = name === 'nightly-dev' ? `prepare_${job}` : 'prepare_ui';
      assert.ok(dependencies.has(preparation));
      assert.equal(jobs[job].with.use_prepared, name === 'release-channel' ? "${{ needs.prepare_ui.result == 'success' }}" : true);
      if (name === 'release-channel') assert.match(jobs[job].if, /needs.prepare_ui.result == 'success'/);
    }
  }
});

test('web-only UI release keeps one preparation while OTA and desktop select the early phase', () => {
  const release = workflow('release-channel');
  const needs = Object.fromEntries(release.jobs.prepare_ui.needs.map((name) => [name, { result: 'success', outputs: {} }]));
  needs.deploy_plan.outputs = { deploy_ui_resume_complete: 'false', deploy_ui_requested: 'true',
    deploy_ui_desktop_mode: 'none', deploy_ui_expo_action: 'none' };
  const admits = (job) => Function('needs', 'inputs', 'always', `return ${job.if}`)(needs, { environment: 'preview', dry_run: false }, () => true);
  assert.equal(admits(release.jobs.prepare_ui), false, 'web-only has no early native preparation');
  needs.deploy_plan.outputs.deploy_ui_expo_action = 'ota';
  assert.equal(admits(release.jobs.prepare_ui), true);
  needs.deploy_plan.outputs.deploy_ui_expo_action = 'none';
  needs.deploy_plan.outputs.deploy_ui_desktop_mode = 'build_and_publish';
  assert.equal(admits(release.jobs.prepare_ui), true);
  const ui = workflow('promote-ui');
  for (const name of ['Enable Corepack', 'Install candidate dependencies', 'Verify generated Mermaid WebView bundle', 'Generate release notes manifest', 'Build release notes assets']) {
    assert.match(ui.jobs.validate_candidate.steps.find((step) => step.name === name).if, /!inputs.use_prepared/, `${name} already ran against the same exact candidate`);
  }
});

test('same-run preparation rejects moving refs, source mutation and conflicting phases before consuming artifacts', () => {
  const ui = workflow('promote-ui').jobs.resolve_source.steps.find((step) => step.name === 'Resolve source ref');
  const dev = workflow('publish-ui-mobile-dev').jobs.release_actor_guard.steps.find((step) => step.name === 'Validate same-run OTA preparation input');
  const run = (step, overrides) => spawnSync('bash', ['-c', step.run], {
    env: { ...process.env, SOURCE_REF: 'a'.repeat(40), DEPLOY_ENVIRONMENT: 'preview', ALLOW_CROSS_PROMOTE: 'true',
      BUMP: 'none', PREPARATION_ONLY: 'true', USE_PREPARED: 'false', GITHUB_OUTPUT: '/dev/null', ...overrides },
    encoding: 'utf8',
  });
  for (const step of [ui, dev]) {
    assert.equal(run(step, {}).status, 0);
    assert.equal(run(step, { PREPARATION_ONLY: 'false', USE_PREPARED: 'true' }).status, 0);
    assert.notEqual(run(step, { SOURCE_REF: 'dev' }).status, 0);
    assert.notEqual(run(step, { USE_PREPARED: 'true' }).status, 0);
  }
  assert.notEqual(run(ui, { BUMP: 'patch' }).status, 0);
});

test('two-phase desktop preparation uses the existing same-run candidate without signing or compiling twice', () => {
  const desktop = workflow('build-tauri');
  for (const input of ['preparation_only', 'use_prepared']) assert.equal(desktop.on.workflow_call.inputs[input]?.default, false);
  assert.match(desktop.jobs.build.if, /!inputs.use_prepared/);
  for (const job of ['finalize', 'reuse_finalized', 'prepare_assets', 'desktop_setup', 'publish_preview', 'publish_dev', 'publish_stable_release', 'promote_stable_feed']) assert.match(desktop.jobs[job].if, /!inputs.preparation_only/);
  assert.equal(desktop.jobs.build.permissions.contents, 'read');
  assert.equal(desktop.jobs.build.environment, undefined);
  assert.doesNotMatch(JSON.stringify(desktop.jobs.build), /secrets\./);
  const upload = desktop.jobs.build.steps.find((step) => step.name === 'Upload desktop candidate');
  const download = desktop.jobs.finalize.steps.find((step) => step.name === 'Download desktop candidate');
  assert.equal(download.with.name, upload.with.name);
  assert.equal(download.with['run-id'], undefined);
  const materialize = desktop.jobs.finalize.steps.find((step) => step.name === 'Validate and materialize desktop candidate');
  for (const field of ['source-sha', 'environment', 'ui-version', 'build-version']) assert.match(materialize.run, new RegExp(`--expected-${field}`));
});

test('OTA preparation is consumed once and native credential-bearing builds remain behind promotion', () => {
  const dev = workflow('publish-ui-mobile-dev');
  for (const input of ['preparation_only', 'use_prepared']) assert.equal(dev.on.workflow_call.inputs[input]?.default, false);
  assert.match(dev.jobs.prepare_ota.if, /!inputs.use_prepared/);
  for (const job of ['publish_ota', 'publish']) assert.match(dev.jobs[job].if, /!inputs.preparation_only/);
  assert.doesNotMatch(JSON.stringify(dev.jobs.prepare_ota), /secrets\.|environment.*release-shared/);
  assert.match(JSON.stringify(dev.jobs.publish_ota), /expected-source-sha/);
  const ui = workflow('promote-ui');
  assert.match(ui.jobs.promote.if, /!inputs.preparation_only/);
  for (const name of ['Prepare Android OTA artifact without credentials', 'Prepare iOS OTA artifact without credentials', 'Upload prepared OTA artifacts', 'Upload release notes assets']) {
    assert.match(ui.jobs.validate_candidate.steps.find((step) => step.name === name).if, /!inputs.use_prepared/);
  }
  for (const name of ['mobile_native', 'mobile_apk_release']) assert.deepEqual(ui.jobs[name].needs, ['promote']);
  assert.match(ui.jobs.desktop.if, /needs.validate_candidate.result == 'success'/);
  assert.match(ui.jobs.desktop.if, /needs.promote.result == 'success'/);
  assert.equal(ui.jobs.desktop.with.preparation_only, '${{ inputs.preparation_only }}');
  assert.equal(ui.jobs.desktop.with.use_prepared, '${{ inputs.use_prepared }}');
});
