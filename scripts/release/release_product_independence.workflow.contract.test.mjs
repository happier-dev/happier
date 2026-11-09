import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';
import { resolveReleaseValidationPlan } from '../pipeline/release-validation/resolve-validation-plan.mjs';

const workflow = parse(readFileSync(new URL('../../.github/workflows/release-channel.yml', import.meta.url), 'utf8'));
const evaluate = (expression, needs) => Function('needs', 'inputs', 'always', `return (${expression.replace(/^\$\{\{\s*|\s*\}\}$/g, '')});`)(needs, { dry_run: false, resume_run_id: '' }, () => true);

test('each ready immutable product verifies and promotes without unrelated products', () => {
  for (const [product, publisher] of [['server', 'server_runtime'], ['ui_web', 'ui_web'], ['cli', 'cli_binaries'], ['stack', 'hstack_binaries'], ['runner', 'runner_binaries']]) {
    const verifier = workflow.jobs[`verify_${product}_candidate`];
    assert.ok(verifier, `${product} has independently settling verification`);
    assert.equal(verifier.uses, './.github/workflows/release-verify.yml');
    assert.ok(verifier.needs.includes(`publish_${publisher}`));
    assert.ok(verifier.needs.includes('prepare_release_candidate'));
    assert.equal(verifier.with[`candidate_${product}_version`], `\${{ needs.publish_${publisher}.outputs.version }}`);
    const promotion = workflow.jobs[`promote_${publisher}`];
    assert.ok(promotion.needs.includes(`verify_${product}_candidate`));
    assert.ok(promotion.needs.includes(`publish_${publisher}`));
    for (const sibling of ['server_runtime', 'ui_web', 'cli_binaries', 'hstack_binaries', 'runner_binaries']) {
      if (sibling !== publisher) assert.ok(!promotion.needs.includes(`promote_${sibling}`));
    }
    const needs = Object.fromEntries(Object.keys(workflow.jobs).map((id) => [id, { result: 'failure', outputs: {} }]));
    needs.plan.result = 'success';
    needs.prepare_release_candidate.result = 'success';
    needs.resolve_resume = { result: 'success', outputs: {} };
    needs[`verify_${product}_candidate`].result = 'success';
    needs[`publish_${publisher}`] = { result: 'success', outputs: { version: '1.2.3-preview.4' } };
    assert.equal(evaluate(verifier.if, needs), true, `${product} verifies despite sibling failure`);
    needs[`publish_${publisher}`].result = 'failure';
    assert.equal(evaluate(verifier.if, needs), false, `${product} requires its own complete publication`);
    needs[`publish_${publisher}`].result = 'success';
    assert.equal(evaluate(promotion.if, needs), true, `${product} survives sibling failure`);
    needs[`verify_${product}_candidate`].result = 'failure';
    assert.equal(evaluate(promotion.if, needs), false, `${product} refuses its own failed signature/platform verification`);
    needs[`verify_${product}_candidate`].result = 'success';
    needs.resolve_resume.outputs[`${product === 'stack' ? 'stack' : product}_rolling_complete`] = 'true';
    assert.equal(evaluate(promotion.if, needs), false, `${product} does not republish completed work`);
  }
});

test('web deployment has no native/CLI candidate barrier and aggregate acquires no artifacts', () => {
  for (const job of ['deploy_ui', 'deploy_docs', 'deploy_website']) {
    assert.ok(!workflow.jobs[job].needs.includes('verify_release_candidates'));
  }
  assert.equal(workflow.jobs.verify_resume_candidates, undefined);
  assert.equal(workflow.jobs.verify_release_candidates.uses, undefined);
  assert.ok(workflow.jobs.release_status.needs.includes('verify_ui_web_candidate'));
});

test('signed engine acquisition gates only runtime consumers in a mixed release', () => {
  assert.ok(!workflow.jobs.release_admission.needs.includes('mutagen_engine_release_gate'));
  const needs = Object.fromEntries(Object.keys(workflow.jobs).map((id) => [id, { result: 'success', outputs: {} }]));
  needs.mutagen_engine_release_gate.result = 'failure';
  needs.plan.outputs.publish_cli_binaries_needed = 'true';
  needs.plan.outputs.publish_ui_web_needed = 'true';
  assert.equal(evaluate(workflow.jobs.publish_ui_web.if, needs), true);
  assert.equal(evaluate(workflow.jobs.publish_cli_binaries.if, needs), false);
  for (const job of ['publish_cli_binaries', 'publish_hstack_binaries', 'publish_server_runtime', 'publish_runner_binaries']) {
    assert.ok(workflow.jobs[job].needs.includes('mutagen_engine_release_gate'));
    needs.plan.outputs.publish_cli_binaries_needed = 'true';
    needs.plan.outputs.publish_stack = 'true';
    needs.plan.outputs.publish_server_runtime_needed = 'true';
    needs.plan.outputs.publish_runner_binaries_needed = 'true';
    assert.equal(evaluate(workflow.jobs[job].if, needs), false, `${job} refuses failed signed-engine acquisition`);
  }
  needs.plan.outputs.publish_cli_binaries_needed = 'false';
  needs.plan.outputs.publish_stack = 'false';
  needs.plan.outputs.publish_server_runtime_needed = 'false';
  needs.plan.outputs.publish_runner_binaries_needed = 'false';
  assert.equal(evaluate(workflow.jobs.mutagen_engine_release_gate.if, needs), false, 'web/docs alone acquire no runtime engine');
});

test('web deployment requires its signed candidate while unrelated products may fail', () => {
  const needs = Object.fromEntries(Object.keys(workflow.jobs).map((id) => [id, { result: 'failure', outputs: {} }]));
  for (const id of ['plan', 'release_admission', 'prepare_release_candidate', 'deploy_plan']) needs[id].result = 'success';
  needs.deploy_plan.outputs = { deploy_ui_requested: 'true', deploy_ui_web: 'true' };
  for (const result of ['failure', 'skipped']) {
    needs.verify_ui_web_candidate.result = result;
    assert.equal(evaluate(workflow.jobs.deploy_ui.if, needs), false, `web deployment refuses ${result} signature/identity verification`);
  }
  needs.verify_ui_web_candidate.result = 'success';
  assert.equal(evaluate(workflow.jobs.deploy_ui.if, needs), true, 'verified web can deploy despite failed siblings');
  assert.ok(workflow.jobs.deploy_ui.needs.includes('verify_ui_web_candidate'));
  needs.deploy_plan.outputs.deploy_ui_web = 'false';
  needs.verify_ui_web_candidate.result = 'skipped';
  assert.equal(evaluate(workflow.jobs.deploy_ui.if, needs), true, 'native-only promotion needs no web artifact');
});


test('per-product validation preserves the complete applicable upgrade and continuity suite union', () => {
  const plan = (hasCliCandidate, hasServerCandidate) => resolveReleaseValidationPlan({
    profileId: 'integrated', hasCliCandidate, hasServerCandidate, hasPublishedRelayPredecessor: true,
    risks: { cliUpgrade: true, sessionContinuity: true, relayUpgrade: true },
  });
  const combined = plan(true, true);
  const pieces = ['cli', 'server', 'stack', 'ui_web'].map((product) => {
    const versions = workflow.jobs[`verify_${product}_candidate`].with;
    return plan(versions.candidate_cli_version !== undefined, versions.candidate_server_version !== undefined);
  });
  for (const [output, enabled] of Object.entries(combined)) {
    if (output.startsWith('run_')) assert.equal(pieces.some((piece) => piece[output] === 'true'), enabled === 'true', output);
  }
});


test('server deployment cannot bypass a selected runtime whose engine acquisition failed', () => {
  const needs = Object.fromEntries(Object.keys(workflow.jobs).map((id) => [id, { result: 'success', outputs: {} }]));
  needs.plan.outputs.publish_server_runtime_needed = 'true';
  needs.deploy_plan.outputs.deploy_server_needed = 'true';
  needs.mutagen_engine_release_gate.result = 'failure';
  needs.publish_server_runtime.result = 'skipped';
  needs.verify_server_candidate.result = 'skipped';
  needs.promote_server_runtime.result = 'skipped';
  const run = (expression) => Function('needs', 'inputs', 'always', 'contains', 'format', `return (${expression});`)(
    needs, { dry_run: false, deploy_targets: 'server' }, () => true,
    (haystack, needle) => haystack.includes(needle), (template, value) => template.replace('{0}', value));
  assert.equal(run(workflow.jobs.deploy_server.if), false);
  needs.mutagen_engine_release_gate.result = 'success';
  needs.publish_server_runtime.result = 'success';
  needs.verify_server_candidate.result = 'success';
  needs.promote_server_runtime.result = 'success';
  assert.equal(run(workflow.jobs.deploy_server.if), true);
});
