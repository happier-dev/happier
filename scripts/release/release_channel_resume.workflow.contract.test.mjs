import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';
import { resolveCandidateVerificationTargets } from '../pipeline/release/verify-release-candidate-identity.mjs';

const workflow = () => parse(readFileSync(new URL('../../.github/workflows/release-channel.yml', import.meta.url), 'utf8'));
const products = [
  ['cli', 'publish_cli_binaries', 'promote_cli_binaries', 'publish_cli_binaries_needed'],
  ['stack', 'publish_hstack_binaries', 'promote_hstack_binaries', 'publish_stack'],
  ['server', 'publish_server_runtime', 'promote_server_runtime', 'publish_server_runtime_needed'],
  ['runner', 'publish_runner_binaries', 'promote_runner_binaries', 'publish_runner_binaries_needed'],
  ['ui_web', 'publish_ui_web', 'promote_ui_web', 'publish_ui_web_needed'],
];

function context(source) {
  const needs = Object.fromEntries(Object.keys(source.jobs).map((id) => [id, {
    result: 'success', outputs: new Proxy({}, { get: (value, key) => value[key] ?? '' }),
  }]));
  for (const [, , , requested] of products) needs.plan.outputs[requested] = 'false';
  Object.assign(needs.plan.outputs, { bump_app: 'none', publish_plugin_sdk: 'false', publish_sdk: 'false' });
  return { needs, inputs: { dry_run: false, environment: 'preview', deploy_targets: 'website', force_deploy: false, ui_expo_action: 'none', desktop_mode: 'none' } };
}

function evaluate(expression, state) {
  if (typeof expression !== 'string') return expression;
  const body = expression.replace(/^\$\{\{\s*|\s*\}\}$/g, '');
  return Function('inputs', 'needs', 'always', 'contains', 'format', `return (${body});`)(
    state.inputs, state.needs, () => true, (value, part) => value.includes(part),
    (pattern, ...args) => pattern.replace(/\{(\d+)\}/g, (_, index) => args[Number(index)]),
  );
}

test('UI-web publication and status consume the canonical fresh or resumed request decision', () => {
  const source = workflow();
  const state = context(source);
  state.needs.resolve_resume.outputs.ui_web_requested = 'true';
  assert.ok(source.jobs.plan.outputs.publish_ui_web_needed, 'UI-web publisher must have an active request producer');
  assert.equal(evaluate(source.jobs.plan.outputs.publish_ui_web_needed, state), true);
  state.needs.plan.outputs.publish_ui_web_needed = 'true';
  assert.equal(evaluate(source.jobs.publish_ui_web.if, state), true);
  const projection = source.jobs.release_status.steps.find((step) => step.name === 'Project release status facts');
  assert.equal(projection.env.REQUEST_UI_WEB, "${{ needs.plan.outputs.publish_ui_web_needed == 'true' }}");
});

test('immutable verification cannot accept a skipped requested product publisher', () => {
  const source = workflow();
  for (const [, publisher, , requested] of products) {
    const state = context(source);
    state.needs.plan.outputs[requested] = 'true';
    state.needs[publisher].result = 'skipped';
    assert.equal(evaluate(source.jobs.verify_release_candidates.if, state), false, publisher);
  }
});

test('final verification requires each requested rolling publication or admitted resume and rechecks its mutable ref', () => {
  const source = workflow();
  const verify = source.jobs.release_verify;
  for (const [product, publisher, promotion, requested] of products) {
    for (const resumed of [false, true]) {
      const state = context(source);
      state.needs.plan.outputs[requested] = 'true';
      state.needs[publisher].outputs.version = '0.3.0-preview.1';
      state.needs[promotion].result = resumed ? 'skipped' : 'success';
      state.needs.resolve_resume.outputs[`${product}_rolling_complete`] = String(resumed);
      assert.equal(evaluate(verify.if, state), true, `${product} resumed=${resumed}`);
      assert.equal(evaluate(verify.with[`verify_${product}_release`], state), true, `${product} must verify the current rolling ref`);
      const productId = product.replace('_', '-');
      const targets = resolveCandidateVerificationTargets({
        channel: 'preview', versions: { [productId]: evaluate(verify.with[`candidate_${product}_version`], state) ?? '' },
        verifyDeploy: { ui: false, server: false, website: false, docs: false },
        verifyRelease: { cli: false, stack: false, server: false, runner: false, 'ui-web': false, [productId]: true },
      });
      assert.deepEqual(targets.tags, [`${productId}-preview`]);
      state.needs.resolve_resume.outputs[`${product}_rolling_complete`] = 'false';
      state.needs[promotion].result = 'skipped';
      assert.equal(evaluate(verify.if, state), false, `${product} skipped without completion must block verification`);
    }
  }
});

test('Runner rolling completion is consumed by promotion and projected into the next resume', () => {
  const source = workflow();
  const state = context(source);
  state.needs.publish_runner_binaries.outputs.version = '0.3.0-preview.1';
  state.needs.resolve_resume.outputs.runner_rolling_complete = 'true';
  assert.equal(evaluate(source.jobs.promote_runner_binaries.if, state), false);
  const projection = source.jobs.release_status.steps.find((step) => step.name === 'Project release status facts');
  assert.equal(projection.env.RUNNER_ROLLING_RESUME_COMPLETE, '${{ needs.resolve_resume.outputs.runner_rolling_complete }}');
});

test('resumed UI work consumes effective plan intent even when UI is absent from current targets', () => {
  const source = workflow();
  const state = context(source);
  Object.assign(state.needs.resolve_resume.outputs, {
    deploy_ui_requested: 'true', deploy_ui_complete: 'false', deploy_ui_intent_recorded: 'true',
    deploy_ui_expo_action: 'ota', deploy_ui_desktop_mode: 'none', deploy_ui_web_requested: 'false', ui_ota_complete: 'true',
  });
  Object.assign(state.needs.deploy_plan.outputs, {
    deploy_ui_requested: 'true', deploy_ui_resume_complete: 'false', deploy_ui_web: 'false', deploy_ui_expo_action: 'ota', deploy_ui_desktop_mode: 'none',
  });
  assert.equal(evaluate(source.jobs.deploy_ui.if, state), true);
  assert.equal(evaluate(source.jobs.deploy_ui.with.ui_ota_complete, state), true);
  const projection = source.jobs.release_status.steps.find((step) => step.name === 'Project release status facts');
  assert.equal(projection.env.REQUEST_DEPLOY_UI, "${{ needs.deploy_plan.outputs.deploy_ui_requested == 'true' }}");
  state.needs.resolve_resume.outputs.deploy_ui_complete = 'true';
  state.needs.resolve_resume.outputs.deploy_ui_intent_recorded = 'false';
  assert.equal(evaluate(source.jobs.deploy_plan.outputs.deploy_ui_resume_complete, state), false, 'unknown legacy UI intent cannot suppress a requested flow');
});

test('a fresh preview mobile or desktop request runs the canonical UI intent producer', () => {
  const source = workflow();
  const state = context(source);
  state.inputs.deploy_targets = 'ui';
  state.inputs.ui_expo_action = 'ota';
  assert.equal(evaluate(source.jobs.deploy_plan.if, state), true);
});

test('every channel job reads outputs only from existing directly declared dependencies', () => {
  const source = workflow();
  const missing = [];
  for (const [id, job] of Object.entries(source.jobs)) {
    const dependencies = Array.isArray(job.needs) ? job.needs : job.needs ? [job.needs] : [];
    for (const dependency of dependencies) {
      if (!source.jobs[dependency]) missing.push(`${id} requires undefined ${dependency}`);
    }
    const references = new Set([...JSON.stringify(job).matchAll(/needs\.([a-z_]+)\./g)].map((match) => match[1]));
    for (const reference of references) {
      if (!dependencies.includes(reference)) missing.push(`${id} reads undeclared ${reference}`);
    }
  }
  assert.deepEqual(missing, []);
});

test('rolling verification receives retained versions solely from the admitted resume owner', () => {
  const source = workflow();
  const verifier = parse(readFileSync(new URL('../../.github/workflows/release-verify.yml', import.meta.url), 'utf8'));
  const identity = verifier.jobs.verify_candidate_identity.steps.find((step) => step.name === 'Verify release candidate identity');
  for (const product of ['cli', 'stack', 'server', 'runner']) {
    const input = `retained_${product}_version`;
    assert.equal(source.jobs.release_verify.with[input], `\${{ needs.resolve_resume.outputs.${product}_version }}`);
    assert.equal(verifier.on.workflow_call.inputs[input]?.default, '');
    assert.equal(identity.env[`RETAINED_${product.toUpperCase()}_VERSION`], `\${{ inputs.${input} }}`);
    assert.ok(identity.run.includes(`--retained-${product}-version`));
  }
});
