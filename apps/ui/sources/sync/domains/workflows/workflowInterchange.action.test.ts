import { describe, expect, it, vi } from 'vitest';
import { createWorkflowEditorDraft } from './workflowEditorDraft';

// The lazy host loader and Artifact transport are system boundaries; codec,
// Action admission, dispatch and draft projection all run their real owners.
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')>();
  const { createActionExecutor } = await import('@happier-dev/protocol/actions/actionExecutor');
  const { createWorkflowDefinitionActions } = await import('@happier-dev/protocol/actions/executor/workflowDefinitions');
  const { createWorkflowActionExecutor } = await import('@happier-dev/protocol/actions/executor/workflowAccountActions');
  const unexpected = (): never => { throw new Error('import_must_not_persist_or_run'); };
  const definitions = createWorkflowDefinitionActions({ artifactStore: {
    read: unexpected, list: unexpected, create: unexpected, update: unexpected, delete: unexpected,
  }, encodeListCursor: unexpected, assertDefinitionWriteAllowed: unexpected });
  return { ...original, createFrontDoorActionExecute: () => original.createFrontDoorActionExecute(createActionExecutor({
    workflowAction: createWorkflowActionExecutor({ isWorkflowFeatureEnabled: () => true, definitions,
      runs: { execute: unexpected } }),
  })) };
});
vi.mock('@/sync/domains/scope/activeServerAccountScope', () => ({ captureActiveServerAccountScopeLifetime: () => null }));

describe('Workflow document Action draft projection', () => {
  it('opens an imported document as a fresh unsaved draft and preserves current work on a typed failure', async () => {
    const { importWorkflowDocumentViaAction } = await import('./workflowInterchange');
    const currentDraft = createWorkflowEditorDraft({ draftId: 'current', name: 'Open work', blocks: [] });
    const definition = { version: 1, inputs: [], defaults: {}, blocks: [{ kind: 'wait', id: 'wait',
      document: { text: 'Continue', references: [], attachments: [] } }] };
    const imported = await importWorkflowDocumentViaAction({ source: JSON.stringify({ kind: 'happier.workflow', version: 1, definition }),
      currentDraft, draftId: 'imported' });
    expect(imported).toMatchObject({ ok: true, definition, draft: { draftId: 'imported', name: '' } });
    expect(imported.draft).not.toBe(currentDraft);
    const rejected = await importWorkflowDocumentViaAction({ source: '{', currentDraft, draftId: 'rejected' });
    expect(rejected).toMatchObject({ ok: false, code: 'invalid_json' });
    expect(rejected.draft).toBe(currentDraft);
  });
});
