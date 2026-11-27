import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Evaluates the condition subset these jobs use against one event's context.
function evaluate(expression, context) {
  if (expression === undefined) return true;
  const body = String(expression).replace(/^\$\{\{\s*|\s*\}\}$/gu, '')
    .replace(/\b(?:inputs|github|steps|matrix|env)(?:\.[A-Za-z0-9_-]+)+/gu, (path) => JSON.stringify(
      path.split('.').reduce((value, key) => (value == null ? undefined : value[key]), context) ?? ''))
    .replace(/\b(always|failure|cancelled)\(\)/gu, (_, name) => String(name === 'always'))
    .replace(/!=/gu, '!==').replace(/([^!=])==/gu, '$1===');
  assert.match(body, /^[\s"'A-Za-z0-9_./=|&()!-]*$/u, `unsupported condition: ${expression}`);
  return Function(`return (${body});`)();
}

const schedule = {
  inputs: { select_jobs_explicitly: false },
  github: { event_name: 'schedule', ref_name: 'v0.3' },
  steps: { changes: { outputs: {} } },
  matrix: { shard: 1 },
  env: { UI_E2E_SPECS: '' },
};

test('the scheduled run executes the complete journey suites, independent of changed paths', async () => {
  // A schedule has no push or pull-request base, so a changed-paths filter selects nothing.
  const workflow = YAML.parse(await readFile(join(repoRoot, '.github', 'workflows', 'tests.yml'), 'utf8'));
  assert.equal(workflow.on.schedule.length, 1);
  for (const jobName of ['e2e-core', 'e2e-core-slow', 'ui-e2e', 'cli-daemon-e2e', 'ui-unit', 'cli', 'server', 'stack', 'plugin-workspaces-unit']) {
    assert.equal(evaluate(workflow.jobs[jobName].if, schedule), true, `${jobName} runs on schedule`);
  }
  const uiE2e = workflow.jobs['ui-e2e'].steps;
  assert.equal(evaluate(uiE2e.find((step) => step.id === 'changes').if, schedule), false, 'no changed-paths filter on schedule');
  // A scheduled caller of this reusable workflow selects explicitly; unselected suites stay off.
  const scheduledCaller = { ...schedule, inputs: { select_jobs_explicitly: true, run_e2e_core_slow: false } };
  assert.equal(evaluate(workflow.jobs['e2e-core-slow'].if, scheduledCaller), false);
  for (const step of uiE2e.filter((step) => step.id !== 'changes' && !/failure\(\)/u.test(String(step.if ?? '')))) {
    assert.equal(evaluate(step.if, schedule), !/^Skip /u.test(step.name ?? ''), `ui-e2e step "${step.name}" on schedule`);
  }
});
