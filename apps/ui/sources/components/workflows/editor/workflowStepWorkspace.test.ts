import { describe, expect, it, vi } from 'vitest';
import type { WorkflowStep } from '@happier-dev/protocol/workflows/workflowV1';
import { findWorkflowBlock } from '@happier-dev/protocol/workflows/workflowDefinitionEditV1';
import {
  createWorkflowEditorDraft,
  type WorkflowEditorDraft,
} from '@/sync/domains/workflows/workflowEditorDraft';

import { buildWorkflowStepWorkspace } from './workflowStepWorkspace';

vi.mock('@/text', async () =>
  (await import('@/dev/testkit/mocks/text')).createTextModuleMock(),
);

const step = (
  id: string,
  workspace?: NonNullable<WorkflowStep['execution']>['workspace'],
): WorkflowStep => ({
  kind: 'step',
  id,
  name: id,
  document: { text: id, references: [], attachments: [] },
  input: [],
  result: { kind: 'text' },
  ...(workspace === undefined ? {} : { execution: { workspace } }),
});

function workspaceOf(draft: WorkflowEditorDraft, blockId: string) {
  const block = findWorkflowBlock(draft, blockId);
  return block?.kind === 'step' ? block.execution?.workspace : 'not a step';
}

/** The step's Workspace field over a draft, re-read after each write as the editor does. */
function field(initial: WorkflowEditorDraft, blockId: string) {
  let draft = initial;
  const read = () => {
    const block = findWorkflowBlock(draft, blockId);
    if (block?.kind !== 'step') throw new Error('not a step');
    return buildWorkflowStepWorkspace({
      draft,
      step: block,
      onChange: (next) => {
        draft = next;
      },
    });
  };
  return { read, draft: () => draft };
}

describe("a step's Workspace (the checkout picker at step scope)", () => {
  it('follows the workflow until the step chooses, and "Same as the workflow" clears the step\'s choice', () => {
    const subject = field(
      createWorkflowEditorDraft({
        draftId: 'ws',
        name: 'Fix',
        blocks: [step('find'), step('check'), step('tell')],
      }),
      'check',
    );

    expect(subject.read().step.selection?.optionId).toBe(
      'workspace_same_as_workflow',
    );
    expect(subject.read().step.fromSteps.map((row) => row.blockId)).toEqual([
      'find',
    ]);

    subject
      .read()
      .onChange?.({ kind: 'new_worktree', source: { kind: 'original' } });
    expect(workspaceOf(subject.draft(), 'check')).toEqual({
      kind: 'new_worktree',
      source: { kind: 'original' },
    });
    expect(subject.read().step.selection?.optionId).toBe('create_git_worktree');

    subject.read().step.sameAsWorkflow.onSelect();
    expect(workspaceOf(subject.draft(), 'check')).toBeUndefined();
    expect(subject.read().step.selection?.optionId).toBe(
      'workspace_same_as_workflow',
    );
  });

  it('writes "Where a step left it" as that earlier step\'s folder and points the popover at its row', () => {
    const subject = field(
      createWorkflowEditorDraft({
        draftId: 'ws',
        name: 'Fix',
        blocks: [step('find'), step('check'), step('tell')],
      }),
      'tell',
    );

    expect(subject.read().step.fromSteps.map((row) => row.blockId)).toEqual([
      'find',
      'check',
    ]);
    subject.read().step.fromSteps[1]!.onSelect();

    expect(workspaceOf(subject.draft(), 'tell')).toEqual({
      kind: 'from_step',
      producer: { blockId: 'check', scope: { kind: 'current' } },
    });
    expect(subject.read().step.selection?.optionId).toBe(
      'workspace_from_step:check',
    );
  });

  it('records the project folder from the checkout row, and the first step has no step to follow', () => {
    const subject = field(
      createWorkflowEditorDraft({
        draftId: 'ws',
        name: 'Fix',
        blocks: [step('find'), step('check')],
      }),
      'find',
    );

    expect(subject.read().step.fromSteps).toEqual([]);
    subject.read().onChange?.({ kind: 'project_checkout' });
    expect(workspaceOf(subject.draft(), 'find')).toEqual({
      kind: 'project_checkout',
    });
    // The folder row is the checkout picker's own selection.
    expect(subject.read().step.selection).toBeUndefined();
  });

  it('keeps a recorded choice whose step was moved after it visible as recorded', () => {
    const subject = field(
      createWorkflowEditorDraft({
        draftId: 'ws',
        name: 'Fix',
        blocks: [
          step('find', {
            kind: 'from_step',
            producer: { blockId: 'check', scope: { kind: 'current' } },
          }),
          step('check'),
        ],
      }),
      'find',
    );

    expect(subject.read().step.fromSteps).toEqual([]);
    expect(subject.read().step.selection?.optionId).toBe(
      'workspace_from_step:check',
    );
    expect(subject.read().step.selection?.label).toContain('check');
  });
});
