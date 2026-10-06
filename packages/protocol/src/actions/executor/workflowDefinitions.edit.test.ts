import { describe, expect, it, vi } from 'vitest';
import { createWorkflowDefinitionActions, type WorkflowDefinitionArtifactOperations } from './workflowDefinitions.js';
import { WorkflowDefinitionV1Schema } from '../../workflows/workflowV1.js';

function harness() {
    const definitionId = 'definition-1';
    const revision = { headerVersion: 2, bodyVersion: 3 };
    const metadata = { title: 'Original', description: 'Retained' };
    const definition = WorkflowDefinitionV1Schema.parse({ version: 1, defaults: {
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
    }, blocks: [{ kind: 'step', id: 'step-1', document: { text: 'Before', references: [], attachments: [] },
      input: [], result: { kind: 'text' } }] });
    // Persistent Artifact storage is the system boundary; edit/normalization stay real.
    const update = vi.fn<WorkflowDefinitionArtifactOperations['update']>().mockResolvedValue({
      ok: true, revision: { headerVersion: 3, bodyVersion: 4 },
    });
    const read = vi.fn<WorkflowDefinitionArtifactOperations['read']>(async () => ({ artifactId: definitionId, ownerAccountId: 'owner', access: 'owner', revision,
        header: { kind: 'workflow-definition.v1', definitionId, revision, metadata },
        body: JSON.stringify({ kind: 'workflow-definition.v1', definition }) }));
    const artifactStore: WorkflowDefinitionArtifactOperations = {
      read,
      update, list: async () => ({ items: [] }), create: async () => {}, delete: async () => ({ ok: true }),
    };
    const owner = createWorkflowDefinitionActions({ artifactStore, encodeListCursor: () => '',
      assertDefinitionWriteAllowed: () => {} });
    return { owner, update, read, definitionId, definition, revision, metadata };
}

describe('the shared definition edit owner', () => {
  it('atomically edits the opened definition and keeps its private metadata', async () => {
    const { owner, update, read, definitionId, definition, revision, metadata } = harness();
    const result = await owner.edit({ definitionId, expectedRevision: revision,
      ops: [{ kind: 'set_step_prompt', blockId: 'step-1', text: 'After' }, { kind: 'rename', name: 'New' }] }, undefined,
    { surface: 'agent', runtimeAccountId: 'editor', defaultSessionId: 'editing-session' });
    expect(result).toEqual({ definition: { ...definition, blocks: [{ ...definition.blocks[0],
      document: { text: 'After', references: [], attachments: [] } }] },
      revision: { headerVersion: 3, bodyVersion: 4 }, metadata: { ...metadata, title: 'New' }, changedBlockIds: ['step-1'] });
    expect(update).toHaveBeenCalledExactlyOnceWith({ artifactId: definitionId, expectedRevision: revision,
      header: { kind: 'workflow-definition.v1', definitionId, revision: result.revision, metadata: { ...metadata, title: 'New' }, previewSteps: ['After'] },
      body: JSON.stringify({ kind: 'workflow-definition.v1', definition: result.definition }),
      savedBy: { kind: 'agent', accountId: 'editor', sessionId: 'editing-session' } });
    expect(read).toHaveBeenCalledOnce();
  });

  it.each([{ headerVersion: 1, bodyVersion: 3 }, { headerVersion: 2, bodyVersion: 2 }])('compares both revision fields before applying any operation (%j)', async (expectedRevision) => {
    const { owner, update, definitionId } = harness();
    await expect(owner.edit({ definitionId, expectedRevision, ops: [{ kind: 'remove_block', blockId: 'missing' }] }))
      .rejects.toMatchObject({ code: 'currentness_conflict' });
    expect(update).not.toHaveBeenCalled();
  });

  it('rejects the whole batch at its first invalid target with an operation path', async () => {
    const { owner, update, definitionId, revision } = harness();
    await expect(owner.edit({ definitionId, expectedRevision: revision, ops: [
      { kind: 'set_step_prompt', blockId: 'step-1', text: 'Not saved' },
      { kind: 'remove_block', blockId: 'missing' },
    ] })).rejects.toMatchObject({ code: 'invalid_input', details: { issues: [{ code: 'unknown_block_id', path: ['ops', 1] }] } });
    expect(update).not.toHaveBeenCalled();
  });

  it('runs semantic validation on the edited document before any write', async () => {
    const { owner, update, definitionId, revision } = harness();
    await expect(owner.edit({ definitionId, expectedRevision: revision, ops: [
      { kind: 'set_final_output', finalOutput: { kind: 'result', producer: { blockId: 'missing', scope: { kind: 'current' } }, path: [] } },
    ] })).rejects.toMatchObject({ code: 'invalid_input' });
    expect(update).not.toHaveBeenCalled();
  });

  it('reports a lost Artifact CAS without reopening or replaying', async () => {
    const { owner, update, read, definitionId, revision } = harness();
    update.mockResolvedValue({ ok: false, errorCode: 'version_mismatch', error: 'Changed' });
    await expect(owner.edit({ definitionId, expectedRevision: revision, ops: [{ kind: 'rename', name: 'New' }] }))
      .rejects.toMatchObject({ code: 'currentness_conflict' });
    expect(update).toHaveBeenCalledOnce();
    expect(read).toHaveBeenCalledOnce();
  });
});
