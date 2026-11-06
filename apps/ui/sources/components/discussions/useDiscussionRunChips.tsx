import * as React from 'react';
import type { DiscussionAddressV1 } from '@happier-dev/protocol/discussions';
import type { WorkflowRunStartResultV1 } from '@happier-dev/protocol/workflows/actionsV1';

import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';
import { createExecutionRunStartContentChip } from '@/components/sessions/runs/launcher/executionRunStartChips';
import {
  formatWorkflowWhereSummary,
  WorkflowProjectTargetControl,
} from '@/components/workflows/editor/WorkflowProjectTargetControl';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { isWorkflowProjectTarget } from '@/sync/domains/workflows/workflowProjectTarget';
import { t } from '@/text';

import { useDiscussionWorkflowProject } from './useDiscussionWorkflowProject';
import { useDiscussionWorkflowRun } from './useDiscussionWorkflowRun';

/**
 * The Discussion composer's Run… (lab T2-A, T4-R): the shared Pattern picker started from this Discussion,
 * where it runs from the shared Where owner. A Discussion has no Machine of its own, so Where starts at the
 * contextual default New Session uses and stays visible beside Run…; while nothing resolves, Where takes
 * Run…'s place (never a dead Run…).
 */
export function useDiscussionRunChips(
  params: Readonly<{
    discussion: DiscussionAddressV1;
    accountLifetime: ServerAccountScopeLifetime;
    readDraft: () => string;
    prepareAddressingMessage: NonNullable<
      Parameters<typeof useDiscussionWorkflowRun>[0]['prepareAddressingMessage']
    >;
    onStarted: (result: WorkflowRunStartResultV1) => void;
    disabled: boolean;
  }>,
): Readonly<{ chips: readonly AgentInputExtraActionChip[]; capture: ReturnType<typeof useDiscussionWorkflowRun>['saveAsPattern'] }> {
  const { target, project, machines, machineName, choose } = useDiscussionWorkflowProject(params.accountLifetime);
  const run = useDiscussionWorkflowRun({
    discussion: params.discussion,
    accountLifetime: params.accountLifetime,
    addressingMessageId: null,
    prepareAddressingMessage: params.prepareAddressingMessage,
    project,
    readDraft: params.readDraft,
    onStarted: params.onStarted,
    disabled: params.disabled,
  });
  const where = React.useMemo(
    () =>
      createExecutionRunStartContentChip({
        key: 'discussion-run-where',
        controlId: 'machine',
        icon: 'folder',
        title: t('workflows.page.where.label'),
        label:
          formatWorkflowWhereSummary({ target, machineName }) ??
          t('workflows.page.where.choose'),
        testID: 'discussion-workflow-run-where',
        // Resolved, Where is a quiet glyph beside Run… whose name says the Machine and folder; unresolved it
        // reads "Choose where".
        iconOnly: project !== null,
        disabled: params.disabled,
        revision: JSON.stringify([
          target?.machineId ?? null,
          target && isWorkflowProjectTarget(target) ? target.directory : null,
        ]),
        renderContent: () => (
          <WorkflowProjectTargetControl
            purpose="workflow"
            target={target}
            machines={machines}
            onChange={choose}
            machineName={machineName}
            testIDPrefix="discussion-workflow-run"
          />
        ),
      }),
    [choose, machineName, machines, params.disabled, project, target],
  );
  const chips = React.useMemo(
    () => (project ? [run.chip, where] : [where]),
    [project, run.chip, where],
  );
  return { chips, capture: run.saveAsPattern };
}
