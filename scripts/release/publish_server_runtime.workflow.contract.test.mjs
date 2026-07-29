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

test('publish-server-runtime workflow exists and does not manage deploy branches', async () => {
  const raw = await loadWorkflow('publish-server-runtime.yml');

  assert.match(raw, /name:\s*PUBLISH\s+—\s+Server Runtime/i);
  assert.match(raw, /workflow_dispatch:/);
  assert.match(raw, /workflow_call:/);

  assert.doesNotMatch(raw, /deploy\//, 'server runtime publish must not push deploy/* branches');
  assert.doesNotMatch(raw, /Promote source ref to deploy branch/i);
});

test('publish-server-runtime workflow publishes rolling server-preview tag via release bot', async () => {
  const raw = await loadWorkflow('publish-server-runtime.yml');
  const parsed = YAML.parse(raw);

  assert.match(raw, /actions\/create-github-app-token@v1/);
  assert.match(raw, /RELEASE_BOT_APP_ID/);
  assert.match(raw, /RELEASE_BOT_PRIVATE_KEY/);

  const finalizeRun = parsed.jobs.finalize_publish.steps.map((step) => step.run ?? '').join('\n');
  assert.match(finalizeRun, /publish-server-runtime\.mjs/);
  assert.match(finalizeRun, /--authorized-sha/);
  assert.match(finalizeRun, /--prepared-artifacts/);
});

test('publish-server-runtime supports dev and resolves auto source_ref from the selected channel', async () => {
  const raw = await loadWorkflow('publish-server-runtime.yml');
  const parsed = YAML.parse(raw);

  assert.deepEqual(parsed.on.workflow_dispatch.inputs.channel.options, ['preview', 'dev', 'stable']);
  assert.match(raw, /node scripts\/pipeline\/release\/resolve-public-release-channel-meta\.mjs/);
  assert.match(raw, /id:\s*channel_meta/);
  const sourceCheckout = parsed.jobs.build_candidate.steps.find((step) => step.name === 'Checkout source without persisted credentials');
  assert.match(sourceCheckout.with.ref, /steps\.channel_meta\.outputs\.source_ref/);
  assert.match(sourceCheckout.with.ref, /inputs\.authorized_sha/);
  assert.doesNotMatch(
    raw,
    /if \[ "\$src" = "auto" \]; then[\s\S]*?src="dev"[\s\S]*?src="preview"[\s\S]*?src="main"/,
  );
});

test('publish-server-runtime embeds build feature policy defaults by channel', async () => {
  const raw = await loadWorkflow('publish-server-runtime.yml');

  assert.match(
    raw,
    /HAPPIER_EMBEDDED_POLICY_ENV:\s*\$\{\{\s*steps\.channel_meta\.outputs\.embedded_policy_env\s*\}\}/,
    'server runtime publishing should set HAPPIER_EMBEDDED_POLICY_ENV to production for stable artifacts',
  );
  assert.doesNotMatch(raw, /inputs\.channel\s*==\s*'publicdev'/);
});
