import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

async function loadWorkflow(name) {
  return readFile(join(repoRoot, '.github', 'workflows', name), 'utf8');
}

test('promote-docs records the deploy branch and publishes the validated artifact directly', async () => {
  const raw = await loadWorkflow('promote-docs.yml');
  assert.match(raw, /node scripts\/pipeline\/github\/promote-deploy-branch\.mjs/);
  assert.match(raw, /--github-output "\$GITHUB_OUTPUT"/);
  assert.match(raw, /steps\.promote_ref\.outputs\.new_sha/);
  assert.doesNotMatch(raw, /Resolve deploy branch SHA \((?:before|after)\)/);
  assert.match(raw, /group: deploy-ref-\$\{\{ github\.repository \}\}-\$\{\{ inputs\.environment \}\}-docs/);
  assert.match(raw, /deploy_cloudflare:/);
  assert.match(raw, /Download the exact built site/);
  assert.doesNotMatch(raw, /node scripts\/pipeline\/deploy\/trigger-webhooks\.mjs/);
  assert.doesNotMatch(raw, /Wait for deploy workflow/i);

  const workflow = parse(raw);
  const upload = workflow.jobs.validate_candidate.steps.find((step) => step.name === 'Upload the exact built site');
  const deploy = workflow.jobs.deploy_cloudflare;
  const download = deploy.steps.find((step) => step.name === 'Download the exact built site');
  const publish = deploy.steps.find((step) => step.name === 'Publish to Cloudflare');
  assert.equal(upload.with.name, 'docs-out-${{ needs.resolve_source.outputs.candidate_sha }}');
  assert.equal(download.with.name, 'docs-out-${{ needs.resolve_source.outputs.candidate_sha }}');
  assert.deepEqual(deploy.needs, ['release_actor_guard', 'resolve_source', 'validate_candidate', 'promote']);
  assert.equal(publish.env.RELEASE_SHA, '${{ needs.resolve_source.outputs.candidate_sha }}');
  assert.doesNotMatch(String(upload.with.name) + String(download.with.name) + String(publish.run), /github\.sha/);
});
