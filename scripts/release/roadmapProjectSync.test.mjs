import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import YAML from 'yaml';

const workflow = YAML.parse(readFileSync(new URL('../../.github/workflows/roadmap-add-to-project.yml', import.meta.url), 'utf8'));
const script = workflow.jobs['add-to-project'].steps.find(step => step.with?.script)?.with.script;
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

// GitHub API and clock are the boundaries; execute the workflow's real script.
function scenario({ labels = [], manual = false, itemPage = 1, missingOption = false } = {}) {
  const issue = { node_id: 'issue-node', labels };
  const mutations = [];
  const cursors = [];
  let reads = 0;
  let waits = 0;
  const fields = [
    { __typename: 'ProjectV2SingleSelectField', id: 'priority', name: 'Priority', options: ['P0', 'P1', 'P2', 'P3'].map(name => ({ id: name, name })) },
    // Observed Project #1 options via read-only ghops GraphQL, 2026-10-29.
    { __typename: 'ProjectV2SingleSelectField', id: 'stage', name: 'Release stage', options: (missingOption ? [] : ['Not shipped', 'Experimental', 'Beta', 'GA']).map(name => ({ id: name, name })) },
  ];
  const github = {
    rest: { issues: { get: async ({ issue_number }) => { assert.equal(issue_number, 42); reads++; return { data: issue }; } } },
    graphql: async (query, variables) => {
      if (query.includes('query ProjectFields')) return { organization: { projectV2: { id: 'project', fields: { nodes: fields } } } };
      if (query.includes('query ProjectItems')) {
        cursors.push(variables.after);
        const page = variables.after === null ? 1 : Number(variables.after) + 1;
        const found = page === itemPage;
        return { organization: { projectV2: { items: {
          nodes: found ? [{ id: 'project-item', content: { __typename: 'Issue', id: issue.node_id } }] : [],
          pageInfo: { hasNextPage: itemPage !== null && !found, endCursor: String(page) },
        } } } };
      }
      assert.match(query, /updateProjectV2ItemFieldValue|clearProjectV2ItemFieldValue/);
      mutations.push({ clear: query.includes('clearProjectV2ItemFieldValue'), ...variables });
      return {};
    },
  };
  const run = () => new AsyncFunction('github', 'context', 'core', 'process', 'setTimeout', script)(
    github, { repo: { owner: 'happier-dev', repo: 'happier' }, eventName: manual ? 'workflow_dispatch' : 'issues',
      payload: manual ? { inputs: { issue_number: '42' } } : { issue } },
    { info() {} }, { env: { PROJECT_ORG: 'happier-dev', PROJECT_NUMBER: '1' } }, callback => { waits++; callback(); },
  );
  return { run, mutations, cursors, reads: () => reads, waits: () => waits };
}

test('current stage labels project to the existing Project options while preserving priority', async () => {
  for (const [stage, option] of [['source', 'Not shipped'], ['dev', 'Experimental'], ['preview', 'Beta'], ['stable', 'GA']]) {
    const fixture = scenario({ labels: ['roadmap', 'priority:p1', `stage:${stage}`] });
    await fixture.run();
    assert.deepEqual(fixture.mutations.map(({ fieldId, optionId, clear }) => ({ fieldId, optionId, clear })), [
      { fieldId: 'priority', optionId: 'P1', clear: false }, { fieldId: 'stage', optionId: option, clear: false },
    ]);
  }
});

test('label removal and manual resync clear fields whose labels are absent', async () => {
  for (const manual of [false, true]) {
    const fixture = scenario({ labels: ['roadmap'], manual });
    await fixture.run();
    assert.deepEqual(fixture.mutations.map(({ fieldId, clear }) => ({ fieldId, clear })), [
      { fieldId: 'priority', clear: true }, { fieldId: 'stage', clear: true },
    ]);
    assert.equal(fixture.reads(), manual ? 1 : 0);
  }
});

test('project item discovery follows cursors beyond the former twenty-page cutoff', async () => {
  const fixture = scenario({ labels: ['roadmap', 'stage:dev'], itemPage: 21 });
  await fixture.run();
  assert.equal(fixture.mutations.find(({ fieldId }) => fieldId === 'stage')?.itemId, 'project-item');
  assert.deepEqual(fixture.cursors, [null, ...Array.from({ length: 20 }, (_, index) => String(index + 1))]);
  assert.equal(fixture.waits(), 0);
});

test('a missing or delayed auto-added item fails visibly and can be recovered by manual resync', async () => {
  const missing = scenario({ labels: ['roadmap', 'stage:dev'], itemPage: null });
  await assert.rejects(missing.run, /Project item not found/);
  assert.deepEqual(missing.mutations, []);
  assert.deepEqual(missing.cursors, [null]);
  assert.equal(missing.waits(), 0);
  const recovered = scenario({ labels: ['roadmap', 'stage:dev'], manual: true });
  await recovered.run();
  assert.equal(recovered.mutations.find(({ fieldId }) => fieldId === 'stage')?.optionId, 'Experimental');
});

test('missing Project field options fail instead of reporting successful projection', async () => {
  const fixture = scenario({ labels: ['roadmap', 'stage:source'], missingOption: true });
  await assert.rejects(fixture.run, /option.*Not shipped|Not shipped.*option/);
});
