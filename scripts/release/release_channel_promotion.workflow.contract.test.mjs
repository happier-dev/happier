import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';

const { jobs } = parse(readFileSync(new URL('../../.github/workflows/release-channel.yml', import.meta.url), 'utf8'));
const evaluate = (expression, needs, environment) => Function('needs', 'inputs', 'always', 'contains', `return (${expression.replace(/^\$\{\{\s*|\s*\}\}$/g, '').replaceAll('needs.*.result', 'Object.values(needs).map(job => job.result)')});`)(needs, { dry_run: false, environment }, () => true, (items, value) => items.includes(value));
function ancestors(id, seen = new Set(), visiting = new Set()) {
  assert.ok(jobs[id], `unknown dependency ${id}`);
  assert.ok(!visiting.has(id), `dependency cycle at ${id}`);
  visiting.add(id);
  for (const parent of jobs[id].needs ?? []) {
    if (seen.has(parent)) continue;
    ancestors(parent, seen, visiting);
    seen.add(parent);
  }
  visiting.delete(id);
  return seen;
}
for (const id of Object.keys(jobs)) ancestors(id);

test('channel branches move only after every selected publication and deployment settles successfully', () => {
  const effects = Object.keys(jobs).filter((id) => /^(publish_|deploy_)/.test(id) && id !== 'deploy_plan');
  for (const [id, environment] of [['promote_main', 'production'], ['promote_preview', 'preview']]) {
    const dependencies = ancestors(id);
    for (const effect of effects) {
      assert.ok(dependencies.has(effect), `${id} must wait for ${effect}`);
    }
    assert.ok(!ancestors('prepare_release_candidate').has(id), 'candidate publication must precede channel promotion');
    const needs = Object.fromEntries(Object.keys(jobs).map((name) => [name, { result: 'success', outputs: {} }]));
    assert.equal(evaluate(jobs[id].if, needs, environment), true);
    needs.publish_cli_binaries.result = 'failure';
    needs.release_verify.result = 'skipped';
    assert.equal(evaluate(jobs[id].if, needs, environment), false, 'failed CLI finalization cannot advance the channel');
    needs.publish_cli_binaries.result = 'success';
    needs.release_verify.result = 'success';
    for (const effect of effects) {
      needs[effect].result = 'failure';
      assert.equal(evaluate(jobs.release_verify.if, needs, environment), false, `${effect} failure cannot pass channel verification`);
      needs.release_verify.result = 'skipped';
      assert.equal(evaluate(jobs[id].if, needs, environment), false, `${effect} failure cannot advance the channel`);
      needs.release_verify.result = 'success';
      needs[effect].result = 'skipped';
      assert.equal(evaluate(jobs[id].if, needs, environment), true, `${effect} may be unselected or completed on resume`);
      needs[effect].result = 'success';
    }
  }
});

test('GitHub Latest is promoted only after the production channel and final status observes it', () => {
  assert.ok(jobs.promote_github_latest, 'Latest has a post-channel promotion step');
  assert.ok(ancestors('promote_github_latest').has('promote_main'));
  const needs = Object.fromEntries(Object.keys(jobs).map((id) => [id, { result: 'success', outputs: {} }]));
  assert.equal(evaluate(jobs.promote_github_latest.if, needs, 'production'), true);
  for (const result of ['failure', 'skipped', 'cancelled']) {
    needs.promote_main.result = result;
    assert.equal(evaluate(jobs.promote_github_latest.if, needs, 'production'), false);
  }
  needs.promote_main.result = 'success';
  assert.equal(evaluate(jobs.promote_github_latest.if, needs, 'preview'), false, 'prereleases cannot be GitHub Latest');
  for (const id of ['promote_main', 'promote_preview', 'promote_github_latest']) assert.ok(jobs.release_status.needs.includes(id));
});
