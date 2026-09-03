import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

async function loadWorkflow(name) {
  return readFile(join(repoRoot, '.github', 'workflows', name), 'utf8');
}

test('promote-website delegates deploy branch promotion to pipeline script', async () => {
  const raw = await loadWorkflow('promote-website.yml');
  assert.match(raw, /node scripts\/pipeline\/github\/promote-deploy-branch\.mjs/);
  assert.doesNotMatch(raw, /Wait for deploy workflow/i);
});

test('release grants reusable promote-website the contents permission it requests', async () => {
  const { parse } = await import('yaml');
  const release = parse(await loadWorkflow('release.yml'));
  const deployWebsite = release?.jobs?.deploy_website;

  assert.equal(
    deployWebsite?.permissions?.contents,
    'write',
    'release caller must permit promote-website to write its deploy branch',
  );
});

// The website is published to Cloudflare Workers static assets, not to the
// Dokploy origin the other components use. The deploy branch is still promoted
// — it remains the record of which SHA is live — but it no longer triggers a
// webhook, so trigger-webhooks.mjs must not reappear in this workflow.
test('promote-website publishes to Cloudflare and not to the Dokploy webhook', async () => {
  const raw = await loadWorkflow('promote-website.yml');
  assert.doesNotMatch(raw, /node scripts\/pipeline\/deploy\/trigger-webhooks\.mjs/);
  assert.doesNotMatch(raw, /CF_WEBHOOK_DEPLOY_CLIENT_(ID|SECRET)/);
  assert.match(raw, /wrangler@4 deploy/);
  assert.match(raw, /wrangler@4 versions upload --preview-alias preview/);
});

// Cloudflare credentials must stay out of the job that builds candidate code,
// and the published bytes must be the ones that job validated.
test('promote-website builds without deploy secrets and publishes only the built artifact', async () => {
  const { parse } = await import('yaml');
  const parsed = parse(await loadWorkflow('promote-website.yml'));
  const validate = JSON.stringify(parsed?.jobs?.validate_candidate);
  const deploy = parsed?.jobs?.deploy_cloudflare;

  assert.equal(parsed?.jobs?.validate_candidate?.environment, undefined);
  assert.doesNotMatch(validate, /CLOUDFLARE_API_TOKEN|CLOUDFLARE_ACCOUNT_ID/);
  assert.match(validate, /actions\/upload-artifact@/);

  assert.equal(deploy?.environment, 'cloudflare-deploy');
  assert.match(JSON.stringify(deploy), /actions\/download-artifact@/);

  const upload = parsed.jobs.validate_candidate.steps.find(
    (step) => step?.name === 'Upload built site across the trust boundary',
  );
  assert.ok(upload, 'validate_candidate must upload the built site');
  assert.equal(upload.with?.['include-hidden-files'], true, 'dist/.well-known must survive the artifact hop');
  assert.equal(upload.with?.['if-no-files-found'], 'error', 'an empty dist must fail rather than deploy nothing');
});
