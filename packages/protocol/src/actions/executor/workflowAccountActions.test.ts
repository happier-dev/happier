import { describe, expect, it } from 'vitest';
import { createActionExecutor, type ActionExecutorDeps } from '../actionExecutor.js';
import { createWorkflowActionExecutor } from './workflowAccountActions.js';
import { createWorkflowDefinitionActions } from './workflowDefinitions.js';
import { createWorkflowAccountRunActionOwner } from './workflowRunActions.js';

const definitionId = '11111111-1111-4111-8111-111111111111';
const definition = { version: 1 as const, inputs: [], defaults: {}, blocks: [{ kind: 'wait' as const, id: 'wait',
  document: { text: 'Continue', references: [], attachments: [] } }] };

function executor(invalidStoredHeader = false, readFailure?: unknown) {
  const unexpected = (): never => { throw new Error('unexpected_effect'); };
  // Artifact and Run persistence are the only boundaries; all family, reader,
  // validation and admission logic stays real.
  const definitions = createWorkflowDefinitionActions({ encodeListCursor: unexpected,
    assertDefinitionWriteAllowed: unexpected, artifactStore: {
    read: async () => {
      if (readFailure !== undefined) throw readFailure;
      return { artifactId: definitionId, ownerAccountId: 'account', access: 'owner',
      revision: { headerVersion: 1, bodyVersion: 1 },
      header: { kind: 'workflow-definition.v1', definitionId, revision: { headerVersion: 1, bodyVersion: 1 },
        metadata: { title: invalidStoredHeader ? 7 : 'Saved Wait' } },
      body: JSON.stringify({ kind: 'workflow-definition.v1', definition }) };
    },
    list: unexpected, create: unexpected, update: unexpected, delete: unexpected,
  } });
  const runs = createWorkflowAccountRunActionOwner({ definitions, storage: { execute: unexpected },
    resolveAccountId: async () => 'account', resolveEncryption: async () => ({ kind: 'available',
      witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
    normalizeAbsolutePath: unexpected, randomBytes: unexpected });
  return createWorkflowActionExecutor({ isWorkflowFeatureEnabled: () => true, definitions, runs });
}

describe('workflow Action refusal classification', () => {
  it.each([
    ['uncoded server failure', new Error('Failed to fetch artifact'), 'storage_unavailable'],
    ['unknown transport code', Object.assign(new Error('Connection reset'), { code: 'ECONNRESET' }), 'storage_unavailable'],
    ['unknown server code', Object.assign(new Error('Transaction acquisition unavailable'), { code: 'P2028' }), 'storage_unavailable'],
    ['typed storage refusal', Object.assign(new Error('Storage unavailable'), { code: 'storage_unavailable' }), 'storage_unavailable'],
    ['typed unopened content refusal', Object.assign(new Error('Artifact content is unavailable'), { code: 'content_unavailable' }), 'content_unavailable'],
    ['retained Session custody missing', Object.assign(new Error('session_key_required'), { code: 'session_key_required' }), 'content_unavailable'],
    ['template encryption material missing', Object.assign(new Error('encryption_material_unavailable'), { code: 'encryption_material_unavailable' }), 'content_unavailable'],
    ['template envelope mode mismatch', Object.assign(new Error('encryption_mode_mismatch'), { code: 'encryption_mode_mismatch' }), 'content_unavailable'],
    ['template decryption failed', Object.assign(new Error('invalid_template'), { code: 'invalid_template' }), 'content_unavailable'],
  ])('classifies %s through the Workflow Action boundary', async (_case, error, errorCode) => {
    const actions = createActionExecutor({ workflowAction: executor(false, error) } as unknown as ActionExecutorDeps);
    await expect(actions.execute('workflow.definition.get', { definitionId }, { surface: 'ui' }))
      .resolves.toMatchObject({ ok: false, errorCode });
  });

  it('reports invalid requests separately from unavailable private content', async () => {
    const execute = executor();
    await expect(execute({ actionId: 'workflow.definition.get', input: { definitionId: '' }, context: { surface: 'ui' } }))
      .resolves.toMatchObject({ ok: false, errorCode: 'invalid_input' });
    const input = { runId: definitionId, source: { kind: 'inline' as const, definition }, extra: true };
    await expect(execute({ actionId: 'workflow.run.start', input, context: { surface: 'ui' } }))
      .resolves.toMatchObject({ ok: false, errorCode: 'invalid_input' });
  });

  it('keeps invalid persisted content unavailable and readable content available', async () => {
    await expect(executor(true)({ actionId: 'workflow.definition.get', input: { definitionId }, context: { surface: 'ui' } }))
      .resolves.toMatchObject({ ok: false, errorCode: 'content_unavailable', details: { reason: 'invalid_header' } });
    await expect(executor()({ actionId: 'workflow.definition.get', input: { definitionId }, context: { surface: 'ui' } }))
      .resolves.toMatchObject({ definitionId, definition });
  });
});
