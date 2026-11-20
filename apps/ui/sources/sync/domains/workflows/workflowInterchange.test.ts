import { describe, expect, it } from 'vitest';

import type { WorkflowBlock, WorkflowStep } from '@happier-dev/protocol/workflows/workflowV1';

import { createWorkflowEditorDraft, type WorkflowEditorDraft } from './workflowEditorDraft';
import { setWorkflowDefaultField } from '@happier-dev/protocol/workflows/workflowDefinitionEditV1';
import { createWorkflowDefinitionActions } from '@happier-dev/protocol/actions/executor/workflowDefinitions';
import { createWorkflowActionExecutor } from '@happier-dev/protocol/actions/executor/workflowAccountActions';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { buildWorkflowDefinitionCandidate } from './workflowAuthoring';
import { serializeWorkflowDocumentJsonV1 } from '@happier-dev/protocol/workflows/workflowDocumentV1';

const CLAUDE_AGENT_TARGET = {
  kind: 'agent' as const,
  identity: { pluginId: 'happier.agent.claude', localId: 'claude' },
};

function step(id: string, extra: Partial<WorkflowStep> = {}): WorkflowStep {
  return {
    kind: 'step',
    id,
    document: { text: `${id} prompt`, references: [], attachments: [] },
    input: [],
    result: { kind: 'text' },
    ...extra,
  };
}

function draftWith(blocks: readonly WorkflowBlock[], name = 'Review'): WorkflowEditorDraft {
  return setWorkflowDefaultField(
    createWorkflowEditorDraft({ draftId: 'draft-current', name, blocks }),
    'agentTarget',
    CLAUDE_AGENT_TARGET,
  );
}

function exportDraft(draft: WorkflowEditorDraft) {
  const unexpected = (): never => { throw new Error('draft export must not access persistence'); };
  const definitions = createWorkflowDefinitionActions({ encodeListCursor: unexpected, assertDefinitionWriteAllowed: unexpected,
    artifactStore: { read: unexpected, list: unexpected, create: unexpected, update: unexpected, delete: unexpected } });
  const workflowAction = createWorkflowActionExecutor({ isWorkflowFeatureEnabled: () => true, definitions,
    runs: { execute: unexpected } });
  return createActionExecutor({ workflowAction }).execute(
    'workflow.definition.export', { draft: buildWorkflowDefinitionCandidate(draft) }, { surface: 'agent' },
  );
}

describe('workflow.definition.export', () => {
  it('exports an unsaved draft through the agent Action without touching persistence', async () => {
    const draft = draftWith([step('unsaved-analysis'), step('unsaved-review')]);
    const exported = await exportDraft(draft);
    expect(exported).toMatchObject({ ok: true, result: { document: { kind: 'happier.workflow', version: 1,
      definition: { blocks: [expect.objectContaining({ id: 'unsaved-analysis' }), expect.objectContaining({ id: 'unsaved-review' })] },
    } } });
  });
  it('refuses an invalid draft and names the dangling reference', async () => {
    const result = await exportDraft(draftWith([
      step('analyze'),
      step('implement', {
        input: [{ kind: 'result', producer: { blockId: 'ghost', scope: { kind: 'current' } }, path: [] }],
      }),
    ]));

    expect(result).toMatchObject({ ok: false, errorCode: 'invalid_input', details: { issues: expect.arrayContaining([
      expect.objectContaining({ code: 'missing_reference', path: '/blocks/1/input/0/producer/blockId' }),
    ]) } });
  });

  it('exports only the canonical definition, with no credentials or run content', async () => {
    const result = await exportDraft(draftWith([step('analyze'), step('implement')]));
    if (!result.ok) throw new Error('Expected a valid Workflow export');
    const { WorkflowDefinitionExportResultV1Schema } = await import('@happier-dev/protocol/workflows/actionsV1');
    const exported = WorkflowDefinitionExportResultV1Schema.parse(result.result);
    expect(exported.json).toBe(serializeWorkflowDocumentJsonV1(exported.document));
    const parsed = JSON.parse(exported.json) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(['definition', 'kind', 'version']);
    expect(Object.keys(parsed['definition'] as Record<string, unknown>).sort())
      .toEqual(['blocks', 'defaults', 'inputs', 'version']);
    for (const forbidden of ['environmentVariables', 'runId', 'startedAt', 'progress', 'outcome', 'invocation']) {
      expect(exported.json).not.toContain(forbidden);
    }
  });

  it('lets the canonical schema reject secret-bearing fields', async () => {
    // `credentials` is not a member of the canonical step selection.
    // The cast is the only way to present the shape a hand-rolled exporter
    // would have had to strip; the schema must reject it instead.
    const leaking = {
      ...step('leak'),
      execution: { credentials: { TOKEN: 'secret' } },
    } as unknown as WorkflowStep;

    await expect(exportDraft(draftWith([leaking]))).resolves.toMatchObject({ ok: false, errorCode: 'invalid_input' });
  });
});
