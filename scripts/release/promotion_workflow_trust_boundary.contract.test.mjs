import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const promotionWorkflows = ['promote-ui.yml', 'promote-website.yml', 'promote-docs.yml'];

async function loadWorkflow(name) {
  const raw = await readFile(join(repoRoot, '.github', 'workflows', name), 'utf8');
  return { raw, parsed: parse(raw) };
}

function assertTrustedCheckout(step, label) {
  assert.equal(step?.uses, 'actions/checkout@11d5960a326750d5838078e36cf38b85af677262', `${label} must use actions/checkout`);
  assert.equal(step?.with?.repository, '${{ job.workflow_repository }}', `${label} must checkout the workflow repository`);
  assert.equal(step?.with?.ref, '${{ job.workflow_sha }}', `${label} must checkout the immutable workflow SHA`);
  assert.equal(step?.with?.['persist-credentials'], false, `${label} must not persist checkout credentials`);
}

test('promotion release actor guards load only immutable workflow control before App secrets', async () => {
  for (const file of promotionWorkflows) {
    const { parsed } = await loadWorkflow(file);
    const guard = parsed?.jobs?.release_actor_guard;
    const checkouts = guard?.steps?.filter((step) => step?.uses === 'actions/checkout@11d5960a326750d5838078e36cf38b85af677262') ?? [];
    assert.equal(checkouts.length, 1, `${file} guard must have one checkout`);
    assertTrustedCheckout(checkouts[0], `${file} guard checkout`);
    const checkoutIndex = guard.steps.indexOf(checkouts[0]);
    const guardIndex = guard.steps.findIndex((step) => step?.uses === './.github/actions/release-actor-guard');
    assert.ok(checkoutIndex >= 0 && checkoutIndex < guardIndex, `${file} trusted checkout must precede the local guard`);
  }
});

test('promotion candidates execute only in secret-free validation jobs and privileged jobs keep trusted control at root', async () => {
  for (const file of promotionWorkflows) {
    const { parsed } = await loadWorkflow(file);
    const validateCandidate = parsed?.jobs?.validate_candidate;
    const promote = parsed?.jobs?.promote;
    assert.ok(parsed?.jobs?.resolve_source, `${file} resolve_source job`);
    assert.ok(validateCandidate, `${file} validate_candidate job`);
    assert.equal(validateCandidate.environment, undefined, `${file} candidate validation must not request release secrets`);
    assert.equal(promote?.environment, 'release-shared', `${file} trusted promotion owns release secrets`);
    const trustedRootCheckout = promote?.steps?.find((step) => step?.uses === 'actions/checkout@11d5960a326750d5838078e36cf38b85af677262' && !step?.with?.path);
    assertTrustedCheckout(trustedRootCheckout, `${file} privileged root checkout`);
    for (const step of promote?.steps ?? []) {
      if (step?.uses === 'actions/checkout@11d5960a326750d5838078e36cf38b85af677262' && step?.with?.path) assert.equal(step.with['persist-credentials'], false);
      assert.notEqual(step?.['working-directory'], 'candidate', `${file} privileged promotion must not execute candidate code`);
      assert.doesNotMatch(String(step?.uses ?? ''), /^\.\/candidate\//, `${file} privileged promotion must not run candidate local actions`);
    }
  }
});

test('promotion source refs and OTA messages cannot become shell syntax', async () => {
  for (const file of promotionWorkflows) {
    const { parsed } = await loadWorkflow(file);
    for (const [jobName, job] of Object.entries(parsed?.jobs ?? {})) {
      for (const step of job?.steps ?? []) {
        const run = String(step?.run ?? '');
        assert.doesNotMatch(run, /\$\{\{\s*inputs\.source_ref\s*\}\}/, `${file} ${jobName} must bind source_ref through env`);
        assert.doesNotMatch(run, /\$\{\{\s*inputs\.expo_update_message\s*\}\}/, `${file} ${jobName} must bind Expo messages through env`);
      }
    }
  }
});

test('promote-ui prepares OTA bytes without secrets and publishes only the bound prepared artifact', async () => {
  const { parsed } = await loadWorkflow('promote-ui.yml');
  const validateText = JSON.stringify(parsed?.jobs?.validate_candidate);
  const promoteText = JSON.stringify(parsed?.jobs?.promote);
  assert.doesNotMatch(validateText, /EXPO_TOKEN|RELEASE_BOT_PRIVATE_KEY|MINISIGN_SECRET_KEY/);
  assert.match(validateText, /ota-update\.mjs/);
  assert.match(validateText, /--phase prepare/);
  assert.match(validateText, /actions\/upload-artifact@/);
  assert.match(promoteText, /ota-update\.mjs/);
  assert.match(promoteText, /--phase publish/);
  assert.match(promoteText, /--expected-source-sha/);
  assert.match(promoteText, /actions\/download-artifact@/);
  assert.match(promoteText, /EXPO_TOKEN/);
  assert.doesNotMatch(promoteText, /ui-mobile-release/);
});

test('prepared OTA artifacts preserve manifest-covered hidden files across the trust boundary', async () => {
  for (const [workflowName, jobName, stepName] of [
    ['publish-ui-mobile-dev.yml', 'prepare_ota', 'Upload exact prepared OTA bytes'],
    ['promote-ui.yml', 'validate_candidate', 'Upload prepared OTA artifacts'],
  ]) {
    const { parsed } = await loadWorkflow(workflowName);
    const upload = parsed?.jobs?.[jobName]?.steps?.find((step) => step?.name === stepName);
    assert.ok(upload, `${workflowName} must upload its prepared OTA artifact`);
    assert.equal(
      upload.with?.['include-hidden-files'],
      true,
      `${workflowName} must preserve manifest-covered .well-known files`,
    );
  }
});
