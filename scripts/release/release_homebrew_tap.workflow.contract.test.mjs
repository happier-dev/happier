import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

async function loadTapJob() {
  const raw = await readFile(join(repoRoot, '.github', 'workflows', 'release-channel.yml'), 'utf8');
  return YAML.parse(raw).jobs.publish_homebrew_tap;
}

test('the configured stable Homebrew publication follows its own verified CLI and precedes final channel verification', async () => {
  const raw = await readFile(join(repoRoot, '.github', 'workflows', 'release-channel.yml'), 'utf8');
  const { jobs } = YAML.parse(raw);
  const job = jobs.publish_homebrew_tap;
  assert.match(jobs.plan.outputs.publish_homebrew_tap_needed, /inputs\.environment == 'production'/);
  assert.match(jobs.plan.outputs.publish_homebrew_tap_needed, /vars\.HOMEBREW_TAP_REPO_NAME != ''/);
  assert.match(job.if, /inputs\.dry_run != true/);
  assert.match(job.if, /needs\.plan\.outputs\.publish_homebrew_tap_needed == 'true'/);
  assert.match(job.if, /needs\.verify_cli_candidate\.result == 'success'/);
  assert.ok(job.needs.includes('verify_cli_candidate'));
  assert.ok(!job.needs.includes('release_verify'));
  assert.ok(jobs.release_verify.needs.includes('publish_homebrew_tap'));
  const projection = jobs.release_status.steps.find((step) => step.name === 'Project release status facts');
  assert.equal(projection.env.REQUEST_HOMEBREW, "${{ needs.plan.outputs.publish_homebrew_tap_needed == 'true' }}");
  assert.equal(projection.env.HOMEBREW_RESULT, '${{ needs.publish_homebrew_tap.result }}');
});

test('a resumed release whose CLI promotion already completed still publishes the formula, for the resumed version', async () => {
  const job = await loadTapJob();
  const condition = String(job.if);
  assert.ok(job.needs.includes('resolve_resume'), 'the job consumes the resume owner');
  assert.match(
    condition,
    /\(needs\.promote_cli_binaries\.result == 'success' \|\| needs\.resolve_resume\.outputs\.cli_rolling_complete == 'true'\)/,
    'CLI promotion in this run or a verified completed promotion in the resumed origin run',
  );
  const version = "needs.publish_cli_binaries.outputs.version || needs.resolve_resume.outputs.cli_version";
  assert.ok(condition.includes(`(${version}) != ''`), 'a published or resumed CLI version is required');
  for (const step of job.steps.filter((candidate) => candidate.env?.CLI_VERSION !== undefined)) {
    assert.equal(step.env.CLI_VERSION, `\${{ ${version} }}`, `${step.name} renders/commits the published or resumed version`);
  }
});
