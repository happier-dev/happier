import { describe, expect, it } from 'vitest';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { defineProtocolJsonValue } from '@happier-dev/plugin-sdk/protocol';
import { PluginActionContributionV2Schema, pluginActionRequiresPresentUserIntent } from '@happier-dev/protocol';
import { createTriageSourceV1Fixture } from '@happier-dev/triage-protocol/testing/v1';
import { PLUGIN_MANIFEST } from '../../manifest.js';
import { activate, activateAccount } from '../../activate.js';
import { GITHUB_CONNECTED_ACCOUNT_PURPOSE, GITHUB_PLUGIN_ID } from '../../observations/githubProviderContracts.js';
import { encodeGithubTriageConfiguration } from '../configuration.js';
import { createStubGithubTransport, readRecordedJsonBody, type StubHttpResponse } from '../testkit/githubTriage.test-support.js';
import { GithubRelationshipMutationResultV1Schema } from './relationshipContracts.js';
import { projectGithubMutationOutcomeV1, githubMutationMayHaveChangedProviderStateV1 } from './outcome.js';

// Synthetic GraphQL responses follow GitHub's Issues/Projects reference consulted 2026-10-31.
// Only the existing HTTP/Connected Account testkit boundaries are substituted.
const route = 'octo-org/example-app';
const ref = { kindId: 'issue', collisionScope: 'github:4210', entryId: '12' };
const related = { localRef: { ...ref, entryId: '13' }, routingToken: route };
const pr = { localRef: { ...ref, kindId: 'pull-request', entryId: '14' }, routingToken: route };
function input(fields: Readonly<Record<string, unknown>> = {}) {
  const fixture = createTriageSourceV1Fixture();
  return { v: 1, instance: { ...fixture.configuredInstance,
    instance: { ...fixture.configuredInstance.instance, source: { pluginId: GITHUB_PLUGIN_ID, localId: 'github-forge' } },
    binding: { purpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE,
      account: { service: { pluginId: GITHUB_PLUGIN_ID, localId: 'github-account' }, accountId: 'configured-account' } },
    localInstanceKey: 'github.com',
    configuration: { v: 1, token: encodeGithubTriageConfiguration({ v: 1, scope: { kind: 'repository', repositoryKey: route } }) },
  }, localRef: ref, routingToken: route, ...fields };
}

const cases = [
  { id: 'github/issue/closing-reference-add', fields: { related: pr }, mutation: 'addCloseIssueReferences',
    operands: { issueId: 'I12', pullRequestIds: ['PR14'] }, result: { issue: { id: 'I12' } } },
  { id: 'github/issue/closing-reference-remove', fields: { related: pr }, mutation: 'removeCloseIssueReferences',
    operands: { issueId: 'I12', pullRequestIds: ['PR14'] }, result: { issue: { id: 'I12' } } },
  { id: 'github/issue/sub-issue-add', fields: { related }, mutation: 'addSubIssue',
    operands: { issueId: 'I12', subIssueId: 'I13' }, result: { issue: { id: 'I12' }, subIssue: { id: 'I13' } } },
  { id: 'github/issue/sub-issue-remove', fields: { related }, mutation: 'removeSubIssue',
    operands: { issueId: 'I12', subIssueId: 'I13' }, result: { issue: { id: 'I12' }, subIssue: { id: 'I13' } } },
  { id: 'github/issue/sub-issue-reprioritize', fields: { related, before: { ...related, localRef: { ...ref, entryId: '15' } } },
    mutation: 'reprioritizeSubIssue', operands: { issueId: 'I12', subIssueId: 'I13', beforeId: 'I15' },
    result: { issue: { id: 'I12' } } },
  { id: 'github/issue/blocked-by-add', fields: { related }, mutation: 'addBlockedBy',
    operands: { issueId: 'I12', blockingIssueId: 'I13' }, result: { issue: { id: 'I12' }, blockingIssue: { id: 'I13' } } },
  { id: 'github/issue/blocked-by-remove', fields: { related }, mutation: 'removeBlockedBy',
    operands: { issueId: 'I12', blockingIssueId: 'I13' }, result: { issue: { id: 'I12' }, blockingIssue: { id: 'I13' } } },
  { id: 'github/issue/blocking-add', fields: { related }, mutation: 'addBlockedBy',
    operands: { issueId: 'I13', blockingIssueId: 'I12' }, result: { issue: { id: 'I13' }, blockingIssue: { id: 'I12' } } },
  { id: 'github/issue/blocking-remove', fields: { related }, mutation: 'removeBlockedBy',
    operands: { issueId: 'I13', blockingIssueId: 'I12' }, result: { issue: { id: 'I13' }, blockingIssue: { id: 'I12' } } },
  { id: 'github/project/item-add', fields: { projectId: 'P1' }, mutation: 'addProjectV2ItemById',
    operands: { projectId: 'P1', contentId: 'I12' }, result: { item: { id: 'PI1', project: { id: 'P1' }, content: { id: 'I12' } } } },
  { id: 'github/project/item-remove', fields: { projectId: 'P1', itemId: 'PI1' }, mutation: 'deleteProjectV2Item',
    operands: { projectId: 'P1', itemId: 'PI1' }, result: { deletedItemId: 'PI1' } },
  { id: 'github/project/field-set', fields: { projectId: 'P1', itemId: 'PI1', fieldId: 'F1', value: { text: 'Release 🦊' } },
    mutation: 'updateProjectV2ItemFieldValue', operands: { projectId: 'P1', itemId: 'PI1', fieldId: 'F1', value: { text: 'Release 🦊' } },
    result: { projectV2Item: { id: 'PI1' } } },
  { id: 'github/project/field-clear', fields: { projectId: 'P1', itemId: 'PI1', fieldId: 'F1' },
    mutation: 'clearProjectV2ItemFieldValue', operands: { projectId: 'P1', itemId: 'PI1', fieldId: 'F1' },
    result: { projectV2Item: { id: 'PI1' } } },
] as const;

function transport(options: Readonly<{ response?: StubHttpResponse | 'lost'; wrongRepository?: boolean; wrongRelated?: boolean; wrongItem?: boolean; wrongProject?: boolean }> = {}) {
  return createStubGithubTransport({ respond: request => {
    if (new URL(request.url).pathname !== '/graphql') return undefined;
    const document = readRecordedJsonBody(request) as { query: string; variables: Record<string, unknown> };
    if (document.query.startsWith('query GithubRelationshipEntry')) {
      const number = Number(document.variables.number);
      const kind = document.query.includes('pullRequest(number:') ? 'PullRequest' : 'Issue';
      return { status: 200, body: { data: { repository: {
        databaseId: options.wrongRepository || (options.wrongRelated && number === 13) ? 999 : 4210, name: 'example-app', owner: { login: 'octo-org' },
        entry: { __typename: kind, id: `${kind === 'Issue' ? 'I' : 'PR'}${number}`, number },
      } } } };
    }
    if (document.query.startsWith('query GithubRelationshipProjectItem')) return { status: 200, body: { data: {
      node: { __typename: 'ProjectV2Item', id: 'PI1', project: { id: options.wrongProject ? 'P9' : 'P1' }, content: { id: options.wrongItem ? 'I99' : 'I12' } },
    } } };
    if (document.query.startsWith('mutation ')) {
      if (options.response === 'lost') throw new Error('GitHub response lost');
      if (options.response !== undefined) return options.response;
      const operands = document.variables.input as Readonly<Record<string, unknown>>;
      const match = cases.find(candidate => document.query.includes(`${candidate.mutation}(input:`)
        && (!('issueId' in candidate.operands) || candidate.operands.issueId === operands.issueId));
      return match ? { status: 200, body: { data: { result: match.result } } } : undefined;
    }
    return undefined;
  } });
}
async function invoke(id: string, fields: Readonly<Record<string, unknown>>, stub = transport()) {
  const kit = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate, activateAccount }, services: stub.context.services });
  try { return await kit.invokeAction(id, defineProtocolJsonValue().parse(input(fields))); }
  finally { await kit.dispose(); }
}

describe('registered GitHub relationship write parity', () => {
  for (const entry of cases) {
    it(`${entry.id} exposes the same exact write to UI and agents with Ask default`, () => {
      const action = PluginActionContributionV2Schema.parse(PLUGIN_MANIFEST.contributes.actions?.find(value => value.id === entry.id));
      for (const surface of ['ui', 'agent', 'mcp', 'cli'] as const) expect(action.surfaces).toContain(surface);
      for (const surface of ['agent', 'mcp', 'cli'] as const) {
        expect(pluginActionRequiresPresentUserIntent(action, surface, input(entry.fields))).toBe(true);
        expect(pluginActionRequiresPresentUserIntent({ ...action, approvalRequiredByActionSettings: false }, surface, input(entry.fields))).toBe(false);
      }
    });
    it(`${entry.id} sends one exact delta and settles the GitHub mutation result`, async () => {
      const stub = transport();
      expect(await invoke(entry.id, entry.fields, stub)).toMatchObject({ kind: 'applied', effect: 'changed' });
      const documents = stub.requests.map(request => readRecordedJsonBody(request) as { query: string; variables: unknown });
      const writes = documents.filter(document => document.query.startsWith('mutation '));
      expect(writes).toHaveLength(1);
      expect(writes[0]!.query).toContain(`${entry.mutation}(input:`);
      expect(writes[0]!.variables).toEqual({ input: entry.operands });
      // Work is proportional to explicitly selected entries, never the size of any relationship collection.
      expect(documents).toHaveLength(1 + ('related' in entry.fields ? 2 : 'itemId' in entry.fields ? 2 : 1) + ('before' in entry.fields ? 1 : 0));
      expect(documents.every(document => !document.query.includes('first:') && !document.query.includes('last:'))).toBe(true);
    });
    it(`${entry.id} reports a definite provider refusal without retrying`, async () => {
      const stub = transport({ response: { status: 200, body: { data: null, errors: [{ type: 'FORBIDDEN' }] } } });
      expect(await invoke(entry.id, entry.fields, stub)).toMatchObject({ kind: 'failed', failure: { class: 'permission', code: 'github_forbidden' } });
      expect(stub.requests.filter(request => (readRecordedJsonBody(request) as { query: string }).query.startsWith('mutation '))).toHaveLength(1);
    });
  }
  it('supports manual closing references from the PR detail without changing its body', async () => {
    expect(await invoke(cases[0].id, { localRef: pr.localRef, related: { localRef: ref, routingToken: route } })).toMatchObject({ kind: 'applied' });
  });
  it('refuses a reused repository route before any effect', async () => {
    const stub = transport({ wrongRepository: true });
    expect(await invoke(cases[2].id, { related }, stub)).toMatchObject({ kind: 'failed' });
    expect(stub.requests.some(request => (readRecordedJsonBody(request) as { query: string }).query.startsWith('mutation '))).toBe(false);
  });
  it('refuses a Project item belonging to another issue', async () => {
    const stub = transport({ wrongItem: true });
    expect(await invoke('github/project/item-remove', { projectId: 'P1', itemId: 'PI1' }, stub)).toMatchObject({ kind: 'failed' });
    expect(stub.requests.some(request => (readRecordedJsonBody(request) as { query: string }).query.startsWith('mutation '))).toBe(false);
  });
  it('refuses a related entry whose repository route was reused', async () => {
    const stub = transport({ wrongRelated: true });
    expect(await invoke(cases[2].id, { related }, stub)).toMatchObject({ kind: 'failed' });
    expect(stub.requests.some(request => (readRecordedJsonBody(request) as { query: string }).query.startsWith('mutation '))).toBe(false);
  });
  it('refuses a Project item from a different selected Project', async () => {
    const stub = transport({ wrongProject: true });
    expect(await invoke('github/project/field-clear', { projectId: 'P1', itemId: 'PI1', fieldId: 'F1' }, stub)).toMatchObject({ kind: 'failed' });
    expect(stub.requests.some(request => (readRecordedJsonBody(request) as { query: string }).query.startsWith('mutation '))).toBe(false);
  });
  it('leaves a lost response uncertain and never blindly resends', async () => {
    const stub = transport({ response: 'lost' });
    expect(await invoke(cases[2].id, { related }, stub)).toMatchObject({ kind: 'uncertain' });
    expect(stub.requests.filter(request => (readRecordedJsonBody(request) as { query: string }).query.startsWith('mutation '))).toHaveLength(1);
  });
  it('rejects whole-set replacement and ambiguous field/position operands before HTTP', async () => {
    for (const [id, fields] of [
      [cases[2].id, { related, relatedEntries: [] }],
      ['github/issue/sub-issue-reprioritize', { related, before: related, after: related }],
      ['github/project/field-set', { projectId: 'P1', itemId: 'PI1', fieldId: 'F1', value: { text: 'x', number: 2 } }],
    ] as const) {
      const stub = transport();
      await expect(invoke(id, fields, stub)).rejects.toThrow();
      expect(stub.requests).toHaveLength(0);
    }
  });
  it('carries applied and uncertain relationship results through the existing outcome owner', async () => {
    for (const response of [undefined, 'lost'] as const) {
      const result = GithubRelationshipMutationResultV1Schema.parse(await invoke(cases[2].id, { related }, transport({ response })));
      const outcome = projectGithubMutationOutcomeV1(result);
      expect(outcome.kind).toBe(response === 'lost' ? 'uncertain' : 'applied');
      expect(githubMutationMayHaveChangedProviderStateV1(outcome)).toBe(true);
    }
  });
  it('does not call a null or partial GraphQL mutation payload applied', async () => {
    for (const body of [{ data: { result: null } }, { data: { result: { issue: { id: 'I12' } } }, errors: [{ type: 'FORBIDDEN' }] }]) {
      const stub = transport({ response: { status: 200, body } });
      expect(await invoke(cases[2].id, { related }, stub)).toMatchObject({ kind: 'uncertain' });
      expect(stub.requests.filter(request => (readRecordedJsonBody(request) as { query: string }).query.startsWith('mutation '))).toHaveLength(1);
    }
  });
  it('supports a caller-selected after position and explicit parent replacement without replacing collections', async () => {
    for (const [id, fields, operands] of [
      ['github/issue/sub-issue-reprioritize', { related, after: { ...related, localRef: { ...ref, entryId: '15' } } }, { issueId: 'I12', subIssueId: 'I13', afterId: 'I15' }],
      ['github/issue/sub-issue-add', { related, replaceParent: true }, { issueId: 'I12', subIssueId: 'I13', replaceParent: true }],
    ] as const) {
      const stub = transport();
      expect(await invoke(id, fields, stub)).toMatchObject({ kind: 'applied' });
      const mutation = stub.requests.find(request => (readRecordedJsonBody(request) as { query: string }).query.startsWith('mutation '));
      expect(readRecordedJsonBody(mutation!)).toMatchObject({ variables: { input: operands } });
    }
  });
  it.each([{ text: '' }, { number: 0 }, { date: '2026-10-31' }, { singleSelectOptionId: 'O1' },
    { iterationId: 'IT1' }, { multiSelectOptionIds: ['O1', 'O2'] }])('preserves the exact typed Project field value %j', async value => {
    const stub = transport();
    expect(await invoke('github/project/field-set', { projectId: 'P1', itemId: 'PI1', fieldId: 'F1', value }, stub)).toMatchObject({ kind: 'applied' });
    const mutation = stub.requests.find(request => (readRecordedJsonBody(request) as { query: string }).query.startsWith('mutation '));
    expect(readRecordedJsonBody(mutation!)).toMatchObject({ variables: { input: { projectId: 'P1', itemId: 'PI1', fieldId: 'F1', value } } });
  });
});
