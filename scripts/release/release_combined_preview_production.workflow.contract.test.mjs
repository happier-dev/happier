import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { summarizeReleaseStatus } from '../pipeline/release/summarize-release-status.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

async function workflow(name) {
  return parse(await readFile(join(repoRoot, '.github', 'workflows', name), 'utf8'));
}

test('all release selections share one static channel tree and one source-risk union', async () => {
  const [combined, release] = await Promise.all([workflow('release.yml'), workflow('release-channel.yml')]);
  await assert.rejects(readFile(join(repoRoot, '.github/workflows/release-preview-and-production.yml')), { code: 'ENOENT' });
  assert.ok(combined.on.workflow_dispatch.inputs.environment.options.includes('preview-and-production'));
  assert.equal(combined.jobs.source_validation.uses, './.github/workflows/release-source-validation.yml');
  assert.equal(combined.jobs.source_validation.with.base_refs, "${{ inputs.environment == 'preview-and-production' && 'preview,main' || inputs.environment == 'preview' && 'preview' || 'main' }}");
  const calls = Object.values(combined.jobs).filter(job => job.uses === './.github/workflows/release-channel.yml');
  assert.equal(calls.length, 1, 'conditional copies expand even when they are skipped at runtime');
  const channel = combined.jobs.release_channels;
  assert.equal(channel, calls[0]);
  assert.equal(channel.name, 'Release ${{ matrix.channel }} channel');
  assert.equal(channel.strategy['fail-fast'], false, 'a failed channel must not cancel its sibling');
  assert.equal(channel.strategy.matrix.channel, '${{ fromJSON(needs.release_preflight.outputs.channels) }}');
  const evaluate = (expression, inputs, matrix = {}) => Function('inputs', 'matrix', 'format',
    `return ${expression.slice(3, -2).trim()};`)(inputs, matrix, (pattern, value) => pattern.replace('{0}', value));
  const planned = combined.jobs.release_preflight.outputs.channels;
  for (const [environment, expected] of [['preview', ['preview']], ['production', ['production']], ['preview-and-production', ['preview', 'production']]]) {
    const inputs = { environment, confirm: environment === 'production' ? 'reset main from preview' : 'release dev to preview' };
    assert.deepEqual(JSON.parse(evaluate(planned, inputs)), expected);
    for (const selected of expected) {
      const matrix = { channel: selected };
      assert.equal(evaluate(channel.with.environment, inputs, matrix), selected);
      assert.equal(evaluate(channel.with.combined_preview_production, inputs, matrix), expected.length === 2);
      assert.equal(evaluate(channel.with.confirm, inputs, matrix), expected.length === 2 ? `release dev to ${selected === 'preview' ? 'preview' : 'main'}` : inputs.confirm);
    }
  }
  assert.ok(channel.needs.includes('source_validation'));
  assert.ok(channel.needs.includes('snapshot_release_issues'));
  assert.equal(channel.with.shared_source_validation_sha, '${{ needs.source_validation.outputs.source_sha }}');
  assert.equal(channel.with.authorized_promotion_source_sha, '${{ needs.release_preflight.outputs.source_sha }}');
  assert.equal(channel.with.ci_run_id, '${{ inputs.ci_run_id }}');
  assert.equal(channel.with.resume_run_id, '${{ inputs.resume_run_id }}');
  for (const name of ['ci', 'mysql_db_contract', 'platform_service_validation', 'trust_root_validation']) assert.equal(release.jobs[name], undefined);
  assert.equal(release.on.workflow_call.inputs.combined_preview_production.default, false);
  assert.equal(release.concurrency.group, 'release-channel-${{ inputs.environment }}');
  assert.equal(release.concurrency['cancel-in-progress'], false);
  for (const forbiddenJob of ['plan', 'publish_cli_binaries', 'publish_server_runtime', 'deploy_ui', 'release_single', 'release_preview', 'release_production']) {
    assert.equal(combined.jobs[forbiddenJob], undefined);
  }
});

test('issue availability consumes each terminal channel artifact even when the matrix fails', async (t) => {
  const combined = await workflow('release.yml');
  const advance = combined.jobs.advance_release_issues;
  assert.deepEqual(advance.needs, ['snapshot_release_issues', 'release_channels']);
  assert.match(String(advance.if), /always\(\)/u);
  assert.doesNotMatch(String(advance.if), /needs\.release_channels\.(result|outputs)/u, 'matrix aggregate failure or last-writer outputs cannot hide a successful channel');
  const download = advance.steps.find(step => step.uses?.startsWith('actions/download-artifact@'));
  assert.equal(download.with.pattern, 'happier-release-status-*');
  assert.notEqual(download.with['merge-multiple'], true, 'both channel files have the same basename');
  const select = advance.steps.find(step => step.id === 'channel_status');
  const reconcile = advance.steps.find(step => step.env?.TO_STAGE);
  assert.equal(reconcile.env.TO_STAGE, '${{ steps.channel_status.outputs.to_stage }}');
  assert.equal(reconcile.if, "${{ steps.channel_status.outputs.to_stage != '' }}");
  const scratch = await mkdtemp(join(tmpdir(), 'happier-matrix-status-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const evaluate = (expression, dryRun) => Function('needs', 'inputs', 'always',
    `return ${expression.slice(3, -2).trim()};`)({ snapshot_release_issues: { outputs: { eligible: 'true' } } }, { dry_run: dryRun, environment: 'preview-and-production' }, () => true);
  assert.equal(evaluate(advance.if, false), true);
  assert.equal(evaluate(advance.if, true), false);
  assert.ok(combined.jobs.snapshot_release_issues.outputs.preview_issues_json, 'recovery must include already-preview issues');
  for (const [preview, production, stage] of [
    [null, null, ''], ['failed', 'partial', ''], ['complete', 'failed', 'stage:preview'],
    ['failed', 'complete', 'stage:stable'], ['complete', 'complete', 'stage:stable'],
    ['published', null, 'stage:preview'], [null, 'published', 'stage:stable'],
  ]) {
    const directory = await mkdtemp(join(scratch, 'case-'));
    for (const [channel, terminal] of [['preview', preview], ['production', production]]) {
      if (terminal === null) continue;
      const status = summarizeReleaseStatus({
        run: { id: 42, url: 'https://github.com/happier-dev/happier/actions/runs/42', name: 'RELEASE' },
        channel, sourceSha: 'a'.repeat(40),
        requestedSurfaces: [{ id: 'channel', requested: true, required: true, evidence: terminal === 'published' ? 'accepted' : 'verified' }],
        surfaces: [{ id: 'channel', result: terminal === 'published' ? 'accepted' : terminal === 'complete' ? 'success' : terminal === 'failed' ? 'failed' : 'pending', identity: { verified: true } }],
      });
      assert.equal(status.terminal, terminal);
      const artifact = join(directory, `happier-release-status-${channel}`);
      await mkdir(artifact);
      await writeFile(join(artifact, 'release-status.json'), JSON.stringify(status));
    }
    const output = join(directory, 'output');
    const result = spawnSync('bash', ['-c', select.run], { cwd: repoRoot, encoding: 'utf8', env: { ...process.env, STATUS_DIRECTORY: directory, GITHUB_OUTPUT: output } });
    assert.equal(result.status, 0, result.stderr);
    assert.equal((await readFile(output, 'utf8')).trim(), `to_stage=${stage}`);
  }
  assert.match(reconcile.run, /--from-stage "stage:source"[\s\S]*--to-stage "\$TO_STAGE"/u);
  assert.match(reconcile.run, /--from-stage "stage:dev"[\s\S]*--to-stage "\$TO_STAGE"/u);
  assert.match(reconcile.run, /if \[ "\$TO_STAGE" = "stage:stable" \]; then[\s\S]*--from-stage "stage:preview"[\s\S]*--to-stage "\$TO_STAGE"/u);
});

test('the statically expanded release tree stays within the approved expansion budget', async () => {
  async function expandedCalls(name, ancestors = []) {
    assert.ok(!ancestors.includes(name), `recursive workflow call: ${[...ancestors, name].join(' -> ')}`);
    const { jobs } = await workflow(name);
    let calls = 0;
    for (const job of Object.values(jobs)) {
      if (!job.uses?.startsWith('./.github/workflows/')) continue;
      calls += 1 + await expandedCalls(job.uses.slice('./.github/workflows/'.length), [...ancestors, name]);
    }
    return calls;
  }
  const count = await expandedCalls('release.yml');
  assert.ok(count <= 100, `${count} expanded reusable calls exceed the release loader budget (94 worked; 151 failed)`);
});


test('the reusable channel retains the canonical top-level OIDC caller identity', async () => {
  const [root, channel] = await Promise.all([workflow('release.yml'), workflow('release-channel.yml')]);
  assert.equal(root.permissions['id-token'], 'write');
  assert.equal(root.jobs.release_channels.permissions['id-token'], 'write');
  const env = { ...process.env, CALLER_REPOSITORY: 'happier-dev/happier', WORKFLOW_REPOSITORY: 'happier-dev/happier',
    WORKFLOW_REF: 'happier-dev/happier/.github/workflows/release-channel.yml@refs/heads/dev',
    CALLER_WORKFLOW_REF: 'happier-dev/happier/.github/workflows/release.yml@refs/heads/dev' };
  const guard = channel.jobs.trusted_ref_guard.steps[0].run;
  const run = overrides => spawnSync('bash', ['-c', guard], { env: { ...env, ...overrides }, encoding: 'utf8' });
  assert.equal(run({}).status, 0);
  for (const caller of ['release-channel.yml', 'release-preview-and-production.yml']) {
    assert.notEqual(run({ CALLER_WORKFLOW_REF: `happier-dev/happier/.github/workflows/${caller}@refs/heads/dev` }).status, 0);
  }
  assert.notEqual(run({ WORKFLOW_REF: env.WORKFLOW_REF.replace('heads/dev', 'heads/topic/untrusted') }).status, 0);
});


test('canonical source admission and channel publication have a schedulable dependency graph', async () => {
  for (const name of ['release.yml', 'release-channel.yml']) {
    const { jobs } = await workflow(name);
    const active = new Set();
    const completed = new Set();
    const visit = name => {
      assert.ok(jobs[name], `dependency ${name} must exist`);
      assert.ok(!active.has(name), `dependency cycle reaches ${name}`);
      if (completed.has(name)) return;
      active.add(name);
      const needs = jobs[name].needs;
      for (const dependency of Array.isArray(needs) ? needs : needs ? [needs] : []) visit(dependency);
      active.delete(name);
      completed.add(name);
    };
    for (const name of Object.keys(jobs)) visit(name);
  }
});
