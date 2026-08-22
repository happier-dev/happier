import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

async function workflow(name) {
  const raw = await readFile(join(repoRoot, '.github', 'workflows', name), 'utf8');
  return { raw, parsed: YAML.parse(raw) };
}

test('normal release carries one required project release ID through the canonical v2 notes projection', async () => {
  const { raw, parsed } = await workflow('release.yml');
  const prepare = parsed.jobs.prepare_release_candidate;
  const projection = prepare.steps.find((step) => step.id === 'release_notes');

  assert.deepEqual(parsed.on.workflow_dispatch.inputs.release_notes_id, {
    description: 'Release notes — Exact approved project release ID',
    required: true,
    type: 'string',
  });
  assert.match(raw, /RELEASE_NOTES_ID:\s*\$\{\{ inputs\.release_notes_id \}\}/);
  assert.match(raw, /scripts\/pipeline\/release\/validate-release-dispatch\.mjs/);
  assert.match(projection.run, /--release-id "\$RELEASE_NOTES_ID"/);
  assert.match(projection.run, /--source-sha "\$SOURCE_SHA"/);
  assert.match(projection.run, /--repo-root "\$GITHUB_WORKSPACE\/release-source"/);
  assert.match(projection.run, /--github-output "\$GITHUB_OUTPUT"/);
  assert.match(projection.run, /node "\$GITHUB_WORKSPACE\/scripts\/pipeline\/release\/release-notes\/project-release-notes\.mjs"/);
  assert.doesNotMatch(projection.run, /release-source\/scripts\/pipeline/);
  assert.doesNotMatch(projection.run, /node --input-type=module|bundle\.release/);
  assert.equal(
    parsed.jobs.deploy_ui.with.release_notes_id,
    '${{ inputs.release_notes_id }}',
    'preview and stable UI promotion must consume the unchanged normal-release ID',
  );
});

test('normal release admits canonical v2 notes for the exact authorized source before branch mutation', async () => {
  const { parsed } = await workflow('release.yml');
  const admission = parsed.jobs.release_notes_admission;
  const mutations = [
    parsed.jobs.promote_preview,
    parsed.jobs.promote_main,
  ];

  assert.ok(admission, 'normal release must admit release notes before mutating a branch');
  assert.deepEqual(admission.needs, ['plan']);
  assert.match(String(admission.if), /inputs\.dry_run != true/);

  const checkout = admission.steps.find((step) => step.name === 'Checkout exact authorized release source');
  assert.equal(checkout.with.ref, '${{ inputs.authorized_promotion_source_sha }}');

  const projection = admission.steps.find((step) => step.id === 'release_notes');
  assert.equal(projection.env.RELEASE_NOTES_ID, '${{ inputs.release_notes_id }}');
  assert.equal(projection.env.SOURCE_SHA, '${{ inputs.authorized_promotion_source_sha }}');
  assert.match(projection.run, /project-release-notes\.mjs/);
  assert.match(projection.run, /--release-id "\$RELEASE_NOTES_ID"/);
  assert.match(projection.run, /--source-sha "\$SOURCE_SHA"/);
  assert.match(projection.run, /--repo-root "\$GITHUB_WORKSPACE\/release-source"/);
  assert.match(projection.run, /node "\$GITHUB_WORKSPACE\/scripts\/pipeline\/release\/release-notes\/project-release-notes\.mjs"/);
  assert.doesNotMatch(projection.run, /release-source\/scripts\/pipeline/);
  assert.match(projection.run, /--changelog "\$GITHUB_WORKSPACE\/release-source\/apps\/ui\/CHANGELOG\.md"/);

  for (const mutation of mutations) {
    assert.ok(
      mutation.needs.includes('release_notes_admission'),
      `${Object.entries(parsed.jobs).find(([, job]) => job === mutation)?.[0]} must wait for notes admission`,
    );
    assert.match(String(mutation.if), /needs\.release_notes_admission\.result == 'success'/);
  }
});

test('UI-only callers validate a v2 bundle against their exact source and forward the same release ID', async () => {
  const [promoteUi, tauri, mobile] = await Promise.all([
    workflow('promote-ui.yml'),
    workflow('build-tauri.yml'),
    workflow('build-ui-mobile-local.yml'),
  ]);

  const promoteProjection = promoteUi.parsed.jobs.validate_candidate.steps.find(
    (step) => step.id === 'release_notes',
  );
  assert.equal(promoteUi.parsed.on.workflow_dispatch.inputs.release_notes_id.required, true);
  assert.equal(promoteUi.parsed.on.workflow_call.inputs.release_notes_id.required, true);
  assert.match(promoteProjection.run, /--release-id "\$RELEASE_NOTES_ID"/);
  assert.match(promoteProjection.run, /--source-sha "\$RELEASE_SHA"/);
  assert.match(promoteProjection.run, /--component-version "ui=\$UI_VERSION"/);
  assert.match(promoteProjection.run, /happier\.release-notes\.projection\.v2/);
  for (const child of ['mobile_native', 'mobile_apk_release', 'desktop']) {
    assert.equal(
      promoteUi.parsed.jobs[child].with.release_notes_id,
      '${{ inputs.release_notes_id }}',
      `${child} must receive the UI release ID unchanged`,
    );
  }

  assert.ok(Object.hasOwn(tauri.parsed.on.workflow_dispatch.inputs, 'release_notes_id'));
  assert.ok(Object.hasOwn(tauri.parsed.on.workflow_call.inputs, 'release_notes_id'));
  assert.match(tauri.raw, /--component-version "ui=\$UI_VERSION"/);
  assert.match(tauri.raw, /bundle\.release\?\.sourceSha !== process\.env\.SOURCE_SHA/);
  assert.match(tauri.raw, /release_notes_id is required when release_message is empty/);

  assert.ok(Object.hasOwn(mobile.parsed.on.workflow_dispatch.inputs, 'release_notes_id'));
  assert.ok(Object.hasOwn(mobile.parsed.on.workflow_call.inputs, 'release_notes_id'));
  assert.match(mobile.raw, /--release-id "\$RELEASE_NOTES_ID"/);
  assert.match(mobile.raw, /--source-sha "\$AUTHORIZED_SHA"/);
  assert.match(mobile.raw, /--component-version "ui=\$RETRY_VERSION"/);
  assert.match(mobile.raw, /happier\.release-notes\.projection\.v2/);
});

test('scheduled nightly uses generic release metadata and never selects a human-authored release packet', async () => {
  const { raw, parsed } = await workflow('nightly-dev.yml');
  const candidate = parsed.jobs.prepare_release_candidate;

  assert.equal(candidate.outputs.release_message, '${{ steps.identity.outputs.release_message }}');
  assert.doesNotMatch(JSON.stringify(candidate.steps), /project-release-notes\.mjs/);
  assert.match(raw, /release_message=Automated nightly dev release\./);
  assert.equal(
    parsed.jobs.ui_desktop.with.release_message,
    '${{ needs.prepare_release_candidate.outputs.release_message }}',
  );
  assert.doesNotMatch(raw, /release_notes_id/);
});
