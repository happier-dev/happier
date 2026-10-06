import { describe, expect, it } from 'vitest';
import { createWorkflowActionExecutor } from './workflowAccountActions.js';
import { createWorkflowDefinitionActions } from './workflowDefinitions.js';
import { createWorkflowAccountRunActionOwner } from './workflowRunActions.js';

const definitionId = '11111111-1111-4111-8111-111111111111';
const definition = { version: 1 as const, inputs: [], defaults: {}, blocks: [{ kind: 'wait' as const, id: 'wait',
  document: { text: 'Continue', references: [], attachments: [] } }] };

function executor(invalidStoredHeader = false) {
  const unexpected = (): never => { throw new Error('unexpected_effect'); };
  // Artifact and Run persistence are the only boundaries; all family, reader,
  // validation and admission logic stays real.
  const definitions = createWorkflowDefinitionActions({ encodeListCursor: unexpected,
    assertDefinitionWriteAllowed: unexpected, artifactStore: {
    read: async () => ({ artifactId: definitionId, ownerAccountId: 'account', access: 'owner',
      revision: { headerVersion: 1, bodyVersion: 1 },
      header: { kind: 'workflow-definition.v1', definitionId, revision: { headerVersion: 1, bodyVersion: 1 },
        metadata: { title: invalidStoredHeader ? 7 : 'Saved Wait' } },
      body: JSON.stringify({ kind: 'workflow-definition.v1', definition }) }),
    list: unexpected, create: unexpected, update: unexpected, delete: unexpected,
  } });
  const runs = createWorkflowAccountRunActionOwner({ definitions, storage: { execute: unexpected },
    resolveAccountId: async () => 'account', resolveEncryption: async () => ({ kind: 'available',
      witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
    normalizeAbsolutePath: unexpected, randomBytes: unexpected });
  return createWorkflowActionExecutor({ isWorkflowFeatureEnabled: () => true, definitions, runs });
}

describe('workflow Action refusal classification', () => {
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
