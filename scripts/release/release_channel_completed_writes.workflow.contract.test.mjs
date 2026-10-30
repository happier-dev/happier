import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';

const workflow = () => parse(readFileSync(new URL('../../.github/workflows/release-channel.yml', import.meta.url), 'utf8'));

function context(source) {
  return {
    inputs: { dry_run: false, force_deploy: false, environment: 'production' },
    needs: Object.fromEntries(Object.keys(source.jobs).map((id) => [id, {
      result: 'success', outputs: new Proxy({}, { get: (value, key) => value[key] ?? '' }),
    }])),
  };
}

function evaluate(expression, { inputs, needs }) {
  const body = expression.replace(/^\$\{\{\s*|\s*\}\}$/g, '');
  return Function('inputs', 'needs', 'always', `return (${body});`)(inputs, needs, () => true);
}

test('accepted completed Docker and generic npm writes are skipped through admitted resume evidence', () => {
  const source = workflow();
  for (const [jobName, completion] of [['publish_docker', 'docker_complete'], ['publish_npm', 'npm_complete']]) {
    const state = context(source);
    state.needs.plan.outputs.publish_cli = 'true';
    assert.equal(evaluate(source.jobs[jobName].if, state), true, `${jobName} fresh write remains enabled`);
    state.needs.resolve_resume.outputs[completion] = 'true';
    assert.equal(evaluate(source.jobs[jobName].if, state), false, `${jobName} must not repeat an accepted completed write`);
    assert.ok(source.jobs[jobName].needs.includes('resolve_resume'));
    state.needs.resolve_resume.outputs[completion] = 'false';
    state.needs.resolve_resume.result = 'failure';
    assert.equal(evaluate(source.jobs[jobName].if, state), false, `${jobName} rejects failed resume admission`);
  }
});

test('current SDK integrity requests override generic npm completion from an older origin', () => {
  const source = workflow();
  for (const environment of ['preview', 'production']) {
    for (const selected of ['publish_plugin_sdk', 'publish_sdk']) {
      const state = context(source);
      state.inputs.environment = environment;
      state.needs.resolve_resume.outputs.npm_complete = 'true';
      state.needs.plan.outputs[selected] = 'true';
      assert.equal(evaluate(source.jobs.publish_npm.if, state), true, `${environment}: ${selected}`);
      assert.equal(evaluate(source.jobs.publish_npm.with[selected], state), true, `${environment}: ${selected} reaches the canonical publisher`);
    }
  }
});

test('skipped completed deploys still request fresh external verification rather than treating acceptance as verified', () => {
  const source = workflow();
  for (const surface of ['ui', 'server', 'website', 'docs']) {
    const state = context(source);
    const flag = source.jobs.release_verify.with[`verify_deploy_${surface}`];
    assert.equal(evaluate(flag, state), true, `fresh production ${surface}`);
    state.needs[`deploy_${surface}`].result = 'skipped';
    assert.equal(evaluate(flag, state), false, `unrequested ${surface}`);
    if (surface === 'ui') state.needs.deploy_plan.outputs.deploy_ui_resume_complete = 'true';
    else state.needs.resolve_resume.outputs[`deploy_${surface}_complete`] = 'true';
    assert.equal(evaluate(flag, state), true, `accepted completed ${surface} requires verification`);
    if (surface === 'ui') {
      state.inputs.environment = 'preview';
      assert.equal(evaluate(flag, state), false, 'preview preserves the existing UI deploy verification scope');
    }
  }
});
