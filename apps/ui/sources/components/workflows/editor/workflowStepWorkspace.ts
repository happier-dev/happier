import { setWorkflowStepExecutionField } from '@happier-dev/protocol/workflows/workflowDefinitionEditV1';
import type { WorkflowStep } from '@happier-dev/protocol/workflows/workflowV1';
import type { WorkflowWorkspaceSelection } from '@happier-dev/protocol/workflows/workflowWorkspaceV1';

import {
  WORKSPACE_NEW_WORKTREE_OPTION_ID,
  WORKSPACE_SAME_AS_WORKFLOW_OPTION_ID,
  workspaceFromStepOptionId,
} from '@/components/sessions/new/hooks/screenModel/buildWorktreeSelectionListSteps';
import { listWorkflowProducerOptions } from '@/sync/domains/workflows/workflowAuthoring';
import type { WorkflowEditorDraft } from '@/sync/domains/workflows/workflowEditorDraft';
import { t } from '@/text';

import { formatWorkflowWorkspaceLabel } from './WorkflowContinuityControls';
import type {
  WorkflowStepWorkspaceScope,
  WorkflowWhereWorkspace,
} from './WorkflowProjectTargetControl';

/**
 * A step's Workspace as the checkout picker's step scope (WF-REDESIGN-1116 change a): the picker's own
 * rows write the project folder or a per-run new worktree, "Same as the workflow" clears the step's
 * choice, and "Where a step left it" names an earlier step's folder. Every write is the step's
 * `workspace` through the protocol draft operation.
 */
export function buildWorkflowStepWorkspace(
  params: Readonly<{
    draft: WorkflowEditorDraft;
    step: WorkflowStep;
    onChange: (next: WorkflowEditorDraft) => void;
  }>,
): WorkflowWhereWorkspace & Readonly<{ step: WorkflowStepWorkspaceScope }> {
  const { draft, step, onChange } = params;
  const value = step.execution?.workspace;
  const write = (next: WorkflowWorkspaceSelection | undefined) =>
    onChange(setWorkflowStepExecutionField(draft, step.id, 'workspace', next));
  // An earlier block reached from several scopes (a Repeat's previous round) is one folder row.
  const seen = new Set<string>();
  const fromSteps = listWorkflowProducerOptions(draft, step.id)
    .filter((producer) => {
      if (seen.has(producer.blockId)) return false;
      seen.add(producer.blockId);
      return true;
    })
    .map((producer) => ({
      blockId: producer.blockId,
      label: producer.label,
      onSelect: () =>
        write({
          kind: 'from_step',
          producer: { blockId: producer.blockId, scope: producer.scope },
        }),
    }));
  return {
    value,
    onChange: write,
    step: {
      sameAsWorkflow: {
        subtitle: t('workflows.page.inspector.workflowDefault', {
          value: formatWorkflowWorkspaceLabel(
            draft,
            draft.defaults.workspace ?? { kind: 'project_checkout' },
          ),
        }),
        onSelect: () => write(undefined),
      },
      fromSteps,
      selection: stepWorkspaceSelection(draft, value),
    },
  };
}

/** The popover row and field words for the step's choice; the project folder is the picker's own row. */
function stepWorkspaceSelection(
  draft: WorkflowEditorDraft,
  value: WorkflowWorkspaceSelection | undefined,
) {
  switch (value?.kind) {
    case undefined:
    case 'inherit':
      return {
        optionId: WORKSPACE_SAME_AS_WORKFLOW_OPTION_ID,
        label: t('workflows.workspace.sameAsWorkflow'),
      };
    case 'project_checkout':
      return undefined;
    case 'new_worktree':
      return {
        optionId: WORKSPACE_NEW_WORKTREE_OPTION_ID,
        label:
          value.source.kind === 'original'
            ? t('newSession.checkout.newWorktree')
            : formatWorkflowWorkspaceLabel(draft, value),
      };
    case 'from_step':
      return {
        optionId: workspaceFromStepOptionId(value.producer.blockId),
        label: formatWorkflowWorkspaceLabel(draft, value),
      };
  }
}
