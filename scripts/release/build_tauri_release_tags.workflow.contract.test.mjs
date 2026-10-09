import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

async function loadWorkflow(name) {
  return readFile(join(repoRoot, '.github', 'workflows', name), 'utf8');
}

async function loadFile(rel) {
  return readFile(join(repoRoot, rel), 'utf8');
}

async function loadCanonicalUiInstallScope() {
  const easJson = JSON.parse(await loadFile('apps/ui/eas.json'));
  return String(easJson?.build?.base?.env?.HAPPIER_INSTALL_SCOPE ?? '');
}

test('desktop-only recovery binds nightly and release origins through the canonical resolver', async () => {
  const { jobs, on } = YAML.parse(await loadWorkflow('build-tauri.yml'));
  const resolveInputs = (inputs) => Object.fromEntries(Object.entries(jobs.resolve_resume.with).map(([key, value]) => [key,
    typeof value === 'string' && value.startsWith('${{')
      ? Function('inputs', 'format', `return ${value.slice(3, -2)}`)(inputs, (pattern, name) => pattern.replace('{0}', name))
      : value,
  ]));
  const source = 'a'.repeat(40);
  for (const [workflow, environment, operation, artifact] of [
    ['release-preview-and-production.yml', 'production', 'rel_exact', 'happier-release-status'],
    ['nightly-dev.yml', 'dev', '', 'happier-release-status'],
    ['release.yml', 'production', 'rel_exact', 'happier-release-status'],
    ['release-preview-and-production.yml', 'preview', 'rel_exact', 'happier-release-status-preview'],
  ]) {
    assert.deepEqual(resolveInputs({ resume_run_id: '123', resume_workflow: workflow, resume_operation_id: operation, environment, source_ref: source }), {
      origin_run_id: '123', expected_workflow: `.github/workflows/${workflow}`, expected_channel: environment,
      expected_source_sha: source, expected_operation_id: operation, status_artifact_name: artifact,
    });
  }
  assert.equal(resolveInputs({ resume_run_id: '123', environment: 'dev', source_ref: source }).expected_workflow, '.github/workflows/nightly-dev.yml');
  assert.equal(on.workflow_dispatch.inputs.resume_workflow.default, 'nightly-dev.yml');
  assert.deepEqual(on.workflow_dispatch.inputs.resume_workflow.options, ['nightly-dev.yml', 'release.yml', 'release-preview-and-production.yml']);
  assert.equal(jobs.resolve_resume.uses, './.github/workflows/resolve-release-resume.yml');
});

test('desktop publication survives intentionally skipped resume/build ancestors but requires successful inputs', async () => {
  const { jobs } = YAML.parse(await loadWorkflow('build-tauri.yml'));
  // GitHub applies implicit success() across the dependency chain, including skipped
  // optional resume/build jobs. Each downstream gate must override that default
  // without allowing failed finalization or asset preparation to publish.
  for (const [jobId, requiredSuccess] of [
    ['build', ['resolve_source']],
    ['finalize', ['resolve_source']],
    ['prepare_assets', ['resolve_source', 'finalize']],
    ['desktop_setup', ['resolve_source', 'finalize']],
    ['publish_preview', ['resolve_source', 'prepare_assets']],
    ['publish_dev', ['resolve_source', 'prepare_assets']],
    ['publish_stable_release', ['resolve_source', 'prepare_assets', 'desktop_setup']],
    ['promote_stable_feed', ['resolve_source']],
  ]) {
    const condition = String(jobs[jobId].if ?? '');
    assert.match(condition, /!cancelled\(\)/, `${jobId} must tolerate skipped ancestors without running after cancellation`);
    for (const prerequisite of requiredSuccess) {
      assert.ok(condition.includes(`needs.${prerequisite}.result == 'success'`), `${jobId} requires ${prerequisite}`);
    }
  }
});

test('desktop finalized recovery restores digest-bound assets without entering signing and preserves canonical verification', async () => {
  const { on, jobs } = YAML.parse(await loadWorkflow('build-tauri.yml'));
  for (const name of ['resume_desktop_artifacts', 'resume_desktop_finalized_artifacts', 'resume_desktop_run_number', 'resume_source_sha']) {
    assert.equal(on.workflow_call.inputs[name]?.type, 'string');
    assert.equal(on.workflow_dispatch.inputs[name], undefined, 'manual recovery still uses canonical origin admission');
  }
  const planner = jobs.resolve_source.steps.find((step) => step.id === 'plan');
  assert.match(planner.env.RESUME_FINALIZED_ARTIFACTS, /inputs\.resume_desktop_finalized_artifacts/);
  assert.match(planner.run, /--resume-finalized-artifacts-json "\$RESUME_FINALIZED_ARTIFACTS"/);
  assert.match(jobs.finalize.if, /finalize_needed == 'true'/);
  const reused = jobs.reuse_finalized;
  assert.equal(reused['timeout-minutes'], jobs.desktop_setup['timeout-minutes'], 'restoration inherits the existing desktop artifact-consumer lifecycle budget');
  assert.match(reused.if, /reuse_needed == 'true'/);
  assert.equal(reused.environment, undefined);
  assert.deepEqual(reused.permissions, { contents: 'read', actions: 'read' });
  assert.doesNotMatch(JSON.stringify(reused), /secrets\.|tauri-sign|notarize/);
  assert.equal(reused.strategy.matrix, '${{ fromJSON(needs.resolve_source.outputs.reuse_matrix) }}');
  const checkout = reused.steps.find((step) => String(step.uses ?? '').startsWith('actions/checkout@'));
  assert.equal(checkout.with.ref, '${{ job.workflow_sha }}');
  assert.equal(checkout.with.repository, '${{ job.workflow_repository }}');
  const download = reused.steps.find((step) => /--mode download/.test(step.run ?? ''));
  assert.equal(download.env.ARTIFACT_ID, '${{ matrix.artifact_id }}');
  assert.equal(download.env.ARTIFACT_DIGEST, '${{ matrix.artifact_digest }}');
  assert.match(download.run, /--artifact-digest "\$ARTIFACT_DIGEST"/);
  assert.match(download.run, /unzip.*"\$ARCHIVE_PATH".*"\$ARTIFACT_DIR"/);
  const uploaded = reused.steps.find((step) => String(step.uses ?? '').startsWith('actions/upload-artifact@'));
  assert.equal(uploaded.with.name, jobs.finalize.steps.find((step) => String(step.uses ?? '').startsWith('actions/upload-artifact@')).with.name);
  assert.ok(jobs.prepare_assets.needs.includes('reuse_finalized'));
  const admitsPrepare = (finalizeNeeded, finalizeResult, reuseNeeded, reuseResult, preparationOnly = false) => Function('needs', 'cancelled', 'inputs',
    `return ${jobs.prepare_assets.if.slice(3, -2)}`)({
      resolve_source: { result: 'success', outputs: { finalize_needed: finalizeNeeded, reuse_needed: reuseNeeded } },
      finalize: { result: finalizeResult }, reuse_finalized: { result: reuseResult },
    }, () => false, { preparation_only: preparationOnly });
  assert.equal(admitsPrepare('true', 'success', 'false', 'skipped'), true);
  assert.equal(admitsPrepare('false', 'skipped', 'true', 'success'), true);
  assert.equal(admitsPrepare('true', 'success', 'true', 'success'), true);
  assert.equal(admitsPrepare('true', 'success', 'false', 'skipped', true), false);
  for (const failed of ['failure', 'cancelled', 'skipped']) {
    assert.equal(admitsPrepare('true', failed, 'true', 'success'), false);
    assert.equal(admitsPrepare('true', 'success', 'true', failed), false);
  }
  const generate = jobs.prepare_assets.steps.find((step) => step.name === 'Generate latest.json');
  assert.equal(generate.env.GITHUB_RUN_NUMBER, '${{ needs.resolve_source.outputs.release_run_number }}');
  const verify = jobs.prepare_assets.steps.findIndex((step) => /verify-updater-manifest\.mjs/.test(step.run ?? ''));
  const publishUpload = jobs.prepare_assets.steps.findIndex((step) => String(step.uses ?? '').startsWith('actions/upload-artifact@'));
  assert.ok(verify >= 0 && verify < publishUpload);
});

test('build-tauri publishes desktop releases under ui-desktop-* tags', async () => {
  const raw = await loadWorkflow('build-tauri.yml');

  assert.match(raw, /tag:\s*ui-desktop-preview\b/);
  assert.match(raw, /tag:\s*ui-desktop-dev\b/);
  assert.match(raw, /tag:\s*ui-desktop-v\$\{\{\s*needs\.prepare_assets\.outputs\.ui_version\s*\}\}/);
  assert.match(raw, /--rolling-tag\s+ui-desktop-stable\b/);

  assert.doesNotMatch(raw, /tag:\s*ui-preview\b/);
  assert.doesNotMatch(raw, /tag:\s*ui-stable\b/);
  assert.doesNotMatch(raw, /tag:\s*ui-v\$\{\{/);
});

test('build-tauri keeps the public manual workflow surface on dev while retaining internal dev release tags', async () => {
  const raw = await loadWorkflow('build-tauri.yml');

  assert.match(raw, /Environment — Controls config \(preview\|dev\|production\)/);
  assert.match(raw, /options:\s*\n(?:\s+- .*\n)*\s+- dev\b/);
  assert.doesNotMatch(raw, /Environment — Controls config \(preview\|publicdev\|production\)/);
  assert.doesNotMatch(raw, /^\s+- publicdev$/m);

  assert.match(raw, /publish_dev:/);
  assert.doesNotMatch(raw, /publish_publicdev:/);
  assert.match(raw, /tag:\s*ui-desktop-dev\b/);
  assert.doesNotMatch(raw, /inputs\.environment\s*==\s*'publicdev'/);
});

test('build-tauri enables Expo Router web modal support for desktop UI builds', async () => {
  const raw = await loadWorkflow('build-tauri.yml');

  assert.match(raw, /EXPO_UNSTABLE_WEB_MODAL:\s*"1"/);
});

test('build-tauri latest.json generator uses ui-desktop-* release tags and publish assets are namespaced', async () => {
  const raw = await loadWorkflow('build-tauri.yml');
  const expectedScope = await loadCanonicalUiInstallScope();

  assert.match(raw, /node scripts\/pipeline\/run\.mjs tauri-prepare-assets/);
  const scopeMatches = [...raw.matchAll(/HAPPIER_INSTALL_SCOPE:\s*"([^"]+)"/g)];
  assert.ok(scopeMatches.length > 0, 'build-tauri.yml should define HAPPIER_INSTALL_SCOPE');
  for (const [, scope = ''] of scopeMatches) {
    assert.equal(scope, expectedScope);
  }

  const script = await loadFile('scripts/pipeline/tauri/prepare-publish-assets.mjs');
  assert.match(script, /ui-desktop-preview/);
  assert.match(script, /ui-desktop-dev/);
  assert.match(script, /ui-desktop-v\$\{uiVersion\}/);

  assert.match(script, /dist\/tauri\/publish/);
  assert.match(script, /ui-desktop-preview/);
  assert.match(script, /ui-desktop-dev/);
  assert.match(script, /ui-desktop-v/);
  assert.match(script, /createSignedReleaseAssetEnvelope/);

  assert.doesNotMatch(raw, /dist\/tauri\/publish\/ui-preview\b/);
  assert.doesNotMatch(raw, /dist\/tauri\/publish\/ui-v\b/);
  assert.doesNotMatch(raw, /dist\/tauri\/publish\/ui-stable\b/);

  assert.match(raw, /assets_dir:\s*dist\/ui-desktop-assets\/ui-desktop-preview/);
  assert.match(raw, /assets_dir:\s*dist\/ui-desktop-assets\/ui-desktop-dev/);
  assert.match(raw, /assets_dir:\s*dist\/ui-desktop-assets\/ui-desktop-v/);
  assert.doesNotMatch(raw, /assets_dir:\s*dist\/ui-desktop-assets\/ui-desktop-stable/);
});

test('build-tauri publishes the immutable production desktop envelope before the staged stable projection', async () => {
  const raw = await loadWorkflow('build-tauri.yml');

  assert.match(
    raw,
    /publish_stable_release:\n(?:.*\n){0,18}\s+rolling_tag:\s*false\b/,
  );
  assert.match(raw, /publish_stable_release:\n(?:.*\n){0,24}\s+clobber:\s*false\b/);
  assert.match(raw, /promote_stable_feed:/);
  assert.match(raw, /node scripts\/pipeline\/github\/promote-rolling-release\.mjs/);
  assert.match(raw, /SOURCE_TAG:\s*ui-desktop-v\$\{\{[^\n]+\}\}/);
  assert.match(raw, /--source-tag\s+"\$SOURCE_TAG"/);
  assert.match(raw, /--expected-product\s+ui-desktop\b/);
  assert.match(raw, /--expected-version\s+"\$SOURCE_VERSION"/);
  assert.match(raw, /--rolling-tag\s+ui-desktop-stable\b/);
  assert.doesNotMatch(raw, /publish_stable_feed:/);
});

test('build-tauri uses approved candidate notes instead of generated GitHub notes', async () => {
  const raw = await loadWorkflow('build-tauri.yml');

  assert.match(raw, /release_message:/);
  assert.match(raw, /release_notes_github_markdown/);
  assert.match(raw, /publish_preview:[\s\S]*?needs:\s*\[prepare_assets,\s*resolve_source\]/);
  assert.match(raw, /publish_dev:[\s\S]*?needs:\s*\[prepare_assets,\s*resolve_source\]/);
  assert.match(raw, /publish_stable_release:[\s\S]*?generate_notes:\s*false/);
  assert.match(raw, /publish_stable_release:[\s\S]*?notes:\s*\$\{\{\s*needs\.resolve_source\.outputs\.release_notes_github_markdown\s*\}\}/);
  assert.match(raw, /promote-rolling-release\.mjs[\s\S]*?RELEASE_MESSAGE/);
  assert.equal(
    raw.includes('appendFileSync(process.env.GITHUB_OUTPUT, `release_notes_github_markdown<<${delimiter}\\n${value}\\n${delimiter}\\n`);'),
    true,
  );
  assert.equal(
    raw.includes('appendFileSync(process.env.GITHUB_OUTPUT, `release_notes_github_markdown<<${delimiter}\\\\n${value}\\\\n${delimiter}\\\\n`);'),
    false,
  );
});

test('build-tauri can reproject an exact immutable production version without running a new build', async () => {
  const raw = await loadWorkflow('build-tauri.yml');

  assert.match(raw, /retry_version:/);
  assert.match(raw, /RETRY_VERSION:\s*\$\{\{\s*inputs\.retry_version\s*\}\}/);
  assert.match(raw, /needs\.resolve_source\.outputs\.retry_version/);
  const { jobs } = YAML.parse(raw);
  assert.ok(jobs.build.if.includes("needs.resolve_source.outputs.retry_version == ''"));
  assert.ok(jobs.build.if.includes("needs.resolve_source.outputs.build_needed == 'true'"));
  assert.match(raw, /SOURCE_TAG:\s*ui-desktop-v\$\{\{\s*needs\.resolve_source\.outputs\.retry_version/);
  assert.match(raw, /SOURCE_VERSION:\s*\$\{\{\s*needs\.resolve_source\.outputs\.retry_version/);
  assert.doesNotMatch(raw, /retry_version must match apps\/ui\/package\.json version/);
  assert.match(raw, /inputs\.retry_version != ''[\s\S]*?ui-desktop-v/);
});
