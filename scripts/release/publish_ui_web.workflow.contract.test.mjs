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

function usesAction(step, name) {
  return String(step?.uses ?? '').split('@')[0] === name;
}

test('publish-ui-web workflow exists and is a dedicated rolling release publisher', async () => {
  const raw = await loadWorkflow('publish-ui-web.yml');

  assert.match(raw, /name:\s*PUBLISH\s+—\s+UI Web Bundle/i);
  assert.match(raw, /workflow_dispatch:/);
  assert.match(raw, /workflow_call:/);

  assert.match(raw, /node scripts\/pipeline\/release\/publish-ui-web\.mjs/);

  assert.doesNotMatch(raw, /deploy\//, 'ui web bundle publishing must not manage deploy/* branches');
});

test('publish-ui-web uses release bot GitHub App token for rolling tag updates', async () => {
  const raw = await loadWorkflow('publish-ui-web.yml');

  assert.match(raw, /actions\/create-github-app-token@d72941d797fd3113feb6b93fd0dec494b13a2547/);
  assert.match(raw, /RELEASE_BOT_APP_ID/);
  assert.match(raw, /RELEASE_BOT_PRIVATE_KEY/);
});

test('publish-ui-web supports dev and resolves auto source_ref from the selected channel', async () => {
  const raw = await loadWorkflow('publish-ui-web.yml');

  assert.match(raw, /options:[\s\S]*?- preview[\s\S]*?- dev[\s\S]*?- stable/);
  assert.match(raw, /node scripts\/pipeline\/release\/resolve-public-release-channel-meta\.mjs/);
  assert.match(raw, /id:\s*channel_meta/);
  assert.match(raw, /ref:\s*\$\{\{[^\n]*steps\.channel_meta\.outputs\.source_ref[^\n]*\}\}/);
  assert.doesNotMatch(
    raw,
    /if \[ "\$src" = "auto" \]; then[\s\S]*?src="dev"[\s\S]*?src="preview"[\s\S]*?src="main"/,
  );
});

test('publish-ui-web embeds build feature policy defaults and exports production variant for stable', async () => {
  const raw = await loadWorkflow('publish-ui-web.yml');

  assert.match(
    raw,
    /HAPPIER_EMBEDDED_POLICY_ENV:\s*\$\{\{\s*needs\.prepare\.outputs\.embedded_policy_env\s*\}\}/,
    'ui web publishing should set HAPPIER_EMBEDDED_POLICY_ENV to production for stable bundles',
  );
  assert.match(
    raw,
    /APP_ENV:\s*\$\{\{\s*needs\.prepare\.outputs\.app_env\s*\}\}/,
    'ui web publishing should set APP_ENV so stable bundles use production config',
  );
  assert.match(
    raw,
    /EXPO_APP_SCHEME:\s*\$\{\{\s*(?:needs\.prepare|steps\.channel_meta)\.outputs\.app_scheme\s*\}\}/,
    'ui web publishing should emit account-connect URLs for the matching native release ring',
  );
  assert.match(
    raw,
    /EXPO_UPDATES_CHANNEL:\s*\$\{\{\s*needs\.prepare\.outputs\.expo_updates_channel\s*\}\}/,
    'ui web publishing should set EXPO_UPDATES_CHANNEL so updates headers match stable, preview, and dev channels',
  );
  assert.match(
    raw,
    /EXPO_UNSTABLE_WEB_MODAL:\s*"1"/,
    'ui web publishing should enable Expo Router web modal support for exported bundles',
  );
  assert.doesNotMatch(raw, /inputs\.channel\s*==\s*'publicdev'/);
});

test('publish-ui-web executes candidate source only in a permissionless secret-free builder', async () => {
  const jobs = YAML.parse(await loadWorkflow('publish-ui-web.yml')).jobs;
  const prepare = jobs.prepare;
  const build = jobs.build_candidate;
  const publish = jobs.publish;

  assert.ok(prepare);
  assert.ok(build);
  assert.deepEqual(build.permissions, {});
  assert.equal(build.environment, undefined);
  assert.equal((build.steps ?? []).some((step) => usesAction(step, 'actions/checkout')), false);
  assert.doesNotMatch(
    JSON.stringify(build),
    /secrets\.|github\.token|GH_TOKEN|GITHUB_TOKEN|create-github-app-token|MINISIGN_SECRET_KEY.*secrets/,
  );
  assert.match(JSON.stringify(build), /ui-web-source-.*needs\.prepare\.outputs\.source_sha/);
  assert.match(JSON.stringify(build), /ui-web-candidate-.*needs\.prepare\.outputs\.version.*needs\.prepare\.outputs\.source_sha/);

  const inertSource = (prepare.steps ?? []).find((step) => step.name === 'Checkout exact source as inert data');
  assert.equal(inertSource?.with?.path, '.candidate-source');
  assert.notEqual(inertSource?.with?.ref, '${{ job.workflow_sha }}');

  const publisherCheckouts = (publish.steps ?? []).filter((step) => usesAction(step, 'actions/checkout'));
  assert.equal(publisherCheckouts.length, 1);
  assert.equal(publisherCheckouts[0].with?.repository, '${{ job.workflow_repository }}');
  assert.equal(publisherCheckouts[0].with?.ref, '${{ job.workflow_sha }}');
  assert.equal(publisherCheckouts[0].with?.['persist-credentials'], false);
  assert.match(JSON.stringify(publish), /--prepared-artifacts/);
  assert.doesNotMatch(JSON.stringify(publish), /steps\.channel_meta\.outputs\.source_ref|Checkout source ref/);
});

test('publish-ui-web uploads source maps from the exact opaque candidate only in the trusted publisher', async () => {
  const jobs = YAML.parse(await loadWorkflow('publish-ui-web.yml')).jobs;
  const build = jobs.build_candidate;
  const publish = jobs.publish;

  const buildStep = (build.steps ?? []).find((step) => step.name === 'Build unsigned UI-web archive');
  assert.ok(buildStep);
  assert.equal(buildStep.env?.EXPO_PUBLIC_SENTRY_RELEASE, '${{ needs.prepare.outputs.version }}');
  assert.doesNotMatch(JSON.stringify(build), /SENTRY_AUTH_TOKEN|secrets\./);

  const uploadStep = (publish.steps ?? []).find((step) => step.name === 'Upload exact UI-web source maps to Sentry');
  assert.ok(uploadStep);
  assert.equal(uploadStep.env?.SENTRY_AUTH_TOKEN, '${{ secrets.SENTRY_AUTH_TOKEN }}');
  assert.equal(uploadStep.env?.SENTRY_RELEASE, '${{ needs.prepare.outputs.version }}');
  assert.match(String(uploadStep.run), /node scripts\/pipeline\/release\/node-archive\.mjs/);
  assert.match(String(uploadStep.run), /happier-ui-web-v\$\{VERSION\}-web-any\.tar\.gz/);
  assert.match(String(uploadStep.run), /node scripts\/pipeline\/expo\/sentry-upload-sourcemaps\.mjs/);
  assert.match(String(uploadStep.run), /--dist-dir "\$bundle_dir"/);

  const publishStep = (publish.steps ?? []).find((step) => step.name === 'Publish UI web bundle (pipeline)');
  assert.ok(publishStep);
  assert.doesNotMatch(JSON.stringify(publishStep), /SENTRY_AUTH_TOKEN/);
});

test('publish-ui-web pins every trusted control checkout to the called workflow SHA', async () => {
  const jobs = YAML.parse(await loadWorkflow('publish-ui-web.yml')).jobs;
  for (const jobName of ['release_actor_guard', 'prepare', 'publish', 'promote_existing']) {
    const trustedCheckout = (jobs[jobName].steps ?? []).find(
      (step) => usesAction(step, 'actions/checkout') && step.with?.path !== '.candidate-source',
    );
    assert.ok(trustedCheckout, `${jobName} trusted checkout`);
    assert.equal(trustedCheckout.with?.repository, '${{ job.workflow_repository }}');
    assert.equal(trustedCheckout.with?.ref, '${{ job.workflow_sha }}');
    assert.equal(trustedCheckout.with?.['persist-credentials'], false);
  }
});

test('publish-ui-web passes a malicious release message only through quoted environment data', async () => {
  const jobs = YAML.parse(await loadWorkflow('publish-ui-web.yml')).jobs;
  const malicious = '"; touch /tmp/happier-ui-web-pwned; #';
  assert.match(malicious, /[";#]/, 'fixture must remain shell-active if interpolated into source');

  for (const jobName of ['publish', 'promote_existing']) {
    const step = (jobs[jobName].steps ?? []).find((candidate) => (
      String(candidate.run ?? '').includes('--release-message')
    ));
    assert.ok(step, `${jobName} release-message step`);
    assert.equal(step.env?.RELEASE_MESSAGE, '${{ inputs.release_message }}');
    assert.match(String(step.run), /--release-message "\$RELEASE_MESSAGE"/);
    assert.doesNotMatch(String(step.run), /\$\{\{\s*inputs\.release_message\s*\}\}/);
  }
});
