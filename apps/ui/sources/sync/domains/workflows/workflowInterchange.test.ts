import { describe, expect, it } from 'vitest';

import type { WorkflowBlock, WorkflowStep } from '@happier-dev/protocol/workflows/workflowV1';

import { exportWorkflowDefinition } from './workflowInterchange';
import { createWorkflowEditorDraft, type WorkflowEditorDraft } from './workflowEditorDraft';
import { setWorkflowDefaultField } from '@happier-dev/protocol/workflows/workflowDefinitionEditV1';
import { createWorkflowDefinitionActions } from '@happier-dev/protocol/actions/executor/workflowDefinitions';
import { createWorkflowActionExecutor } from '@happier-dev/protocol/actions/executor/workflowAccountActions';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { buildWorkflowDefinitionCandidate } from './workflowAuthoring';

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

/** The catalog editor's export: the same validator and codec the export Action uses. */
function exportDraft(draft: WorkflowEditorDraft) {
  return exportWorkflowDefinition({ definition: buildWorkflowDefinitionCandidate(draft) });
}

describe('exportWorkflowDefinition', () => {
  it('exports the mounted unsaved draft through the agent Action with exactly the UI JSON', async () => {
    const unexpected = (): never => { throw new Error('draft export must not access persistence'); };
    const definitions = createWorkflowDefinitionActions({ encodeListCursor: unexpected, assertDefinitionWriteAllowed: unexpected,
      artifactStore: { read: unexpected, list: unexpected, create: unexpected, update: unexpected, delete: unexpected } });
    const workflowAction = createWorkflowActionExecutor({ isWorkflowFeatureEnabled: () => true, definitions,
      runs: { execute: unexpected } });
    const executor = createActionExecutor({ workflowAction });
    const draft = draftWith([step('unsaved-analysis'), step('unsaved-review')]);
    const expected = exportDraft(draft);
    expect(expected.ok).toBe(true);
    if (!expected.ok) throw new Error('invalid UI draft fixture');
    await expect(executor.execute('workflow.definition.export', { draft: buildWorkflowDefinitionCandidate(draft) }, { surface: 'agent' }))
      .resolves.toMatchObject({ ok: true, result: { json: expected.json, document: expected.document } });
  });
  it('refuses an invalid draft and names the first blocking issue', () => {
    const result = exportDraft(draftWith([
      step('analyze'),
      step('implement', {
        input: [{ kind: 'result', producer: { blockId: 'ghost', scope: { kind: 'current' } }, path: [] }],
      }),
    ]));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.blockingIssue?.code).toBe('missing_reference');
    expect(result.blockingIssue?.path).toBe('/blocks/1/input/0/producer/blockId');
    expect(result.issues.length).toBeGreaterThan(0);
  });

  it('exports only the canonical definition, with no credentials or run content', () => {
    const result = exportDraft(draftWith([step('analyze'), step('implement')]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const parsed = JSON.parse(result.json) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(['definition', 'kind', 'version']);
    expect(Object.keys(parsed['definition'] as Record<string, unknown>).sort())
      .toEqual(['blocks', 'defaults', 'inputs', 'version']);
    for (const forbidden of ['environmentVariables', 'runId', 'startedAt', 'progress', 'outcome', 'invocation']) {
      expect(result.json).not.toContain(forbidden);
    }
  });

  it('lets the canonical schema, not a hand-written filter, reject secret-bearing fields', () => {
    // `credentials` is not a member of the canonical step selection.
    // The cast is the only way to present the shape a hand-rolled exporter
    // would have had to strip; the schema must reject it instead.
    const leaking = {
      ...step('leak'),
      execution: { credentials: { TOKEN: 'secret' } },
    } as unknown as WorkflowStep;

    const result = exportDraft(draftWith([leaking]));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.code)).toContain('unknown_field');
  });
});
