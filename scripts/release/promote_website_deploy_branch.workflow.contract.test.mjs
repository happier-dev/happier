import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

async function loadWorkflow(name) {
  return readFile(join(repoRoot, '.github', 'workflows', name), 'utf8');
}

test('website next resolves v0.3 without allowing release bumps or implicit cross-promotion', async () => {
  const { parse } = await import('yaml');
  const workflow = parse(await loadWorkflow('promote-website.yml'));
  const step = workflow.jobs.resolve_source.steps.find((step) => step.id === 'resolve');
  const dir = await mkdtemp(join(tmpdir(), 'website-next-'));
  try {
    for (const [environment, source, bump, allow, expected] of [
      ['production', 'auto', 'none', 'false', 'main'],
      ['preview', 'auto', 'none', 'false', 'preview'],
      ['next', 'auto', 'none', 'false', 'v0.3'],
      ['next', 'main', 'none', 'false', null],
      ['next', 'main', 'none', 'true', 'main'],
      ['next', 'auto', 'patch', 'false', null],
      ['invalid', 'auto', 'none', 'false', null],
    ]) {
      const output = join(dir, `${environment}-${source}-${bump}-${allow}`);
      const result = spawnSync('bash', ['-c', step.run], {
        cwd: repoRoot, encoding: 'utf8',
        env: { ...process.env, DEPLOY_ENVIRONMENT: environment, SOURCE_REF: source,
          BUMP: bump, ALLOW_CROSS_PROMOTE: allow, GITHUB_OUTPUT: output },
      });
      assert.equal(result.status === 0, expected !== null, `${environment}/${source}/${bump}: ${result.stderr}`);
      if (expected !== null) assert.equal((await readFile(output, 'utf8')).trim(), `source_ref=${expected}`);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('promote-website delegates deploy branch promotion to pipeline script', async () => {
  const raw = await loadWorkflow('promote-website.yml');
  assert.match(raw, /node scripts\/pipeline\/github\/promote-deploy-branch\.mjs/);
  assert.doesNotMatch(raw, /Wait for deploy workflow/i);
});

test('next publishes its Worker without promoting a release branch and shares catalog verification', async () => {
  const { parse } = await import('yaml');
  const workflow = parse(await loadWorkflow('promote-website.yml'));
  const steps = workflow.jobs.deploy_cloudflare.steps;
  const publish = steps.find((step) => step.name === 'Publish to Cloudflare');
  for (const [environment, expected] of [
    ['next', '--yes wrangler@4 deploy --env next --message promote candidate'],
    ['production', '--yes wrangler@4 deploy --message promote candidate'],
    ['preview', '--yes wrangler@4 versions upload --preview-alias preview --message promote candidate'],
  ]) {
    // npx is the external publisher boundary; execute the real workflow switch.
    const result = spawnSync('bash', ['-c', `npx() { printf '%s ' "$@"; };\n${publish.run}`], {
      encoding: 'utf8', env: { ...process.env, DEPLOY_ENVIRONMENT: environment, RELEASE_SHA: 'candidate' },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), expected);
  }
  for (const step of workflow.jobs.promote.steps.filter((step) =>
    step.id === 'app_token' || step.id === 'before' || step.id === 'after' || step.name === 'Promote exact release SHA')) {
    assert.equal(step.if, "inputs.environment != 'next'");
  }
  const catalogChecks = steps.filter((step) => /cmp --silent dist\/catalog.json/.test(step.run ?? ''));
  assert.equal(catalogChecks.length, 1, 'one catalog verification serves both deployments');
  assert.equal(catalogChecks[0].if, "inputs.environment == 'production' || inputs.environment == 'next'");
  const homepage = steps.find((step) => step.name === 'Verify the next website');
  assert.equal(homepage.if, "inputs.environment == 'next'");
  for (const status of ['200', '301']) {
    const result = spawnSync('bash', ['-c', `curl() { printf '%s' "$HTTP_STATUS"; };\n${homepage.run}`], {
      encoding: 'utf8', env: { ...process.env, HTTP_STATUS: status },
    });
    assert.equal(result.status === 0, status === '200');
  }
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
  assert.equal(upload.with?.name, 'website-dist-${{ inputs.environment }}-${{ needs.apply_bump.outputs.release_sha }}');
  const download = deploy.steps.find((step) => step?.name === 'Download the exact built site');
  assert.equal(download?.with?.name, upload.with?.name);
});
