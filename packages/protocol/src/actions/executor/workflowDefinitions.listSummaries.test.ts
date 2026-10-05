import { describe, expect, it } from 'vitest';
import { WorkflowDefinitionV1Schema } from '../../workflows/workflowV1.js';
import { createWorkflowDefinitionActions } from './workflowDefinitions.js';
import { WorkflowDefinitionListResultV1Schema } from '../../workflows/actionsV1.js';

describe('workflow definition library summary read', () => {
  it.each(['denied', 'list_failed', 'artifact_account_mode_mismatch'])('keeps %s request-wide', async code => {
    const error = Object.assign(new Error(code), { code });
    const owner = createWorkflowDefinitionActions({ artifactStore: {
      list: async () => { throw error; }, read: async () => null, create: async () => {},
      update: async () => ({ ok: false, errorCode: 'unused', error: 'unused' }), delete: async () => ({ ok: true }),
    }, encodeListCursor: () => 'cursor', assertDefinitionWriteAllowed: () => {} });
    await expect(owner.list({})).rejects.toBe(error);
  });
  it('isolates missing and malformed bodies while retaining identity, paging and scheduler facts', async () => {
    const definition = WorkflowDefinitionV1Schema.parse({ version: 1,
      defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } },
      blocks: [{ kind: 'step', id: 'work', document: { text: 'Work', references: [], attachments: [] }, input: [], result: { kind: 'text' } }],
    });
    const rows = ['good', 'missing', 'malformed', 'last'].map((artifactId, index) => ({
      artifactId, headerVersion: 1, updatedAt: index, ownerAccountId: 'account', access: 'owner' as const,
      header: { kind: 'workflow-definition.v1', definitionId: artifactId, revision: { headerVersion: 1, bodyVersion: 1 }, metadata: { title: artifactId } },
      ...(artifactId === 'missing' ? {} : { bodyVersion: 1,
        body: artifactId === 'malformed' ? '{' : JSON.stringify({ kind: 'workflow-definition.v1', definition }) }),
    }));
    const owner = createWorkflowDefinitionActions({ artifactStore: {
      list: async ({ cursor }) => ({ items: cursor ? rows.slice(Number(cursor)) : rows }),
      read: async () => { throw new Error('no_per_record_read'); }, create: async () => {},
      update: async () => ({ ok: false, errorCode: 'unused', error: 'unused' }), delete: async () => ({ ok: true }),
    }, encodeListCursor: row => String(rows.findIndex(item => item.artifactId === row.artifactId) + 1),
    assertDefinitionWriteAllowed: () => {}, readWorkflowTriggerSummaries: async () => new Map() });
    const first = await owner.list({ limit: 3 });
    expect(first.definitions).toMatchObject([
      { definitionId: 'good', contentStatus: 'available', stepCount: 1, nextRunAt: null },
      { definitionId: 'missing', contentStatus: 'unavailable', stepCount: null, nextRunAt: null },
      { definitionId: 'malformed', contentStatus: 'unavailable', stepCount: null },
    ]);
    expect(WorkflowDefinitionListResultV1Schema.parse(first)).toEqual(first);
    const next = await owner.list({ cursor: first.nextCursor });
    expect(next.definitions).toMatchObject([{ definitionId: 'last', contentStatus: 'available', stepCount: 1, nextRunAt: null }]);
  });
  it('counts opened authored leaves, excluding containers and repeat occurrences', async () => {
    const step = { kind: 'step', id: 'first', document: { text: 'Do the work', references: [], attachments: [] }, input: [], result: { kind: 'text' } };
    const definition = WorkflowDefinitionV1Schema.parse({ version: 1, defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } }, blocks: [
      { kind: 'parallel', id: 'lanes', failurePolicy: 'fail_stop', branches: [
        { id: 'left', blocks: [step] }, { id: 'right', blocks: [{ ...step, id: 'second' }] },
      ] },
      { kind: 'loop', id: 'repeat', body: [{ ...step, id: 'third' }], repetition: { kind: 'count', count: { kind: 'literal', value: 12 } } },
    ] });
    const row = { artifactId: 'workflow-one', headerVersion: 1, updatedAt: 1, ownerAccountId: 'account', access: 'owner' as const,
      header: { kind: 'workflow-definition.v1', definitionId: 'workflow-one', revision: { headerVersion: 1, bodyVersion: 1 }, metadata: { title: 'Work' } },
      body: JSON.stringify({ kind: 'workflow-definition.v1', definition }), bodyVersion: 1 };
    const owner = createWorkflowDefinitionActions({ artifactStore: {
      list: async () => ({ items: [row] }),
      read: async () => { throw new Error('library_summary_must_use_batched_opened_content'); },
      create: async () => {}, update: async () => ({ ok: false, errorCode: 'unused', error: 'unused' }), delete: async () => ({ ok: true }),
    }, encodeListCursor: () => 'cursor', assertDefinitionWriteAllowed: () => {},
    readWorkflowTriggerSummaries: async () => new Map([['workflow-one', { triggers: [], nextRunAt: 1_900_000_000_000 }]]) });
    const result = await owner.list({});
    expect(result.definitions[0]).toMatchObject({ stepCount: 3, triggers: [], nextRunAt: 1_900_000_000_000 });
  });
});
