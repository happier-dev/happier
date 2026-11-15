import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import YAML from 'yaml';

const workflow = YAML.parse(readFileSync(new URL('../../.github/workflows/tests.yml', import.meta.url), 'utf8'));

test('automatic metadata child keeps artifact gates and only permits the source compiler to skip with admitted metadata', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'happier-metadata-gate-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const gate = workflow.jobs.gate;
  const script = gate.steps.find((step) => step.env?.NEEDS_JSON).run;
  const needs = Object.fromEntries(gate.needs.map((id) => [id, { result: 'success', outputs: {} }]));
  needs['gate-prepare'].outputs = { metadata_only: 'true', packages: '[]', server_db_contract: 'false' };
  needs['gate-unit'].result = 'skipped';
  needs['gate-compiler'].result = 'skipped';
  needs['server-db-contract'].result = 'skipped';
  // Run the hosted aggregate's actual script at its process boundary.
  const run = () => spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { ...process.env, NEEDS_JSON: JSON.stringify(needs), CI_RUN_ID: '43', CI_SOURCE_SHA: 'a'.repeat(40) }, cwd: root });
  assert.equal(run().status, 0);
  needs['gate-build-artifacts'].result = 'skipped';
  assert.notEqual(run().status, 0, 'metadata cannot skip packaging');
  needs['gate-build-artifacts'].result = 'success';
  needs['gate-prepare'].outputs.metadata_only = 'false';
  assert.notEqual(run().status, 0, 'ordinary source cannot skip its compiler');
  assert.match(workflow.jobs['gate-compiler'].if, /metadata_only/);
  assert.ok(workflow.jobs['gate-prepare'].steps.some((step) => step.run?.includes('release_notes_projection.contract.test.mjs')));
});


test('default v0.3 CI enforces plugin import policy after dependencies without a compiler prerequisite', () => {
  const prepare = workflow.jobs['gate-prepare'];
  const policyIndex = prepare.steps.findIndex(step => /(?:^|[\s;&])pnpm run test:policy(?:$|[\s;&])/.test(step.run ?? ''));
  assert.ok(policyIndex >= 0, 'the default v0.3 path skips the ordinary typecheck job and must still run test:policy');
  const dependencyIndex = prepare.steps.findIndex(step => step.id === 'dependencies');
  assert.ok(policyIndex > dependencyIndex);
  assert.equal(prepare.steps[policyIndex].if, undefined);
  assert.notEqual(prepare.steps[policyIndex]['continue-on-error'], true);
  const buildIndex = prepare.steps.findIndex(step => step.id === 'workspace-build');
  assert.ok(policyIndex < buildIndex, 'source policy cannot depend on a successful workspace compilation');
});
