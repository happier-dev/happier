import { getWorkflowStartWhereChipPlacement } from '../workflowComposerControlPlacements';
import * as React from 'react';

import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';
import { createExecutionRunStartContentChip } from '@/components/sessions/runs/launcher/executionRunStartChips';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import type { Machine } from '@/sync/domains/state/storageTypes';
import type { WorkflowAuthoringTarget } from '@/sync/domains/workflows/workflowProjectTarget';
import { t } from '@/text';

import {
  formatWorkflowWhereSummary,
  WorkflowProjectTargetControl,
} from '../editor/WorkflowProjectTargetControl';

/**
 * The start composer's one Where chip. With `onChange` it chooses the next start's target; without
 * it, it shows a target that is already decided (an accepted Run, or a request already sent while
 * its outcome is unknown) read-only.
 */
export function createWorkflowStartWhereChip(
  params: Readonly<{
    target: WorkflowAuthoringTarget | null | undefined;
    machineName: string | null;
    machineHomeDir?: string | null;
    machines?: readonly Machine[];
    accountLifetime?: ServerAccountScopeLifetime | null;
    onChange?: (target: WorkflowAuthoringTarget) => void;
    /** What the chip says when the target cannot be summarized; defaults to "Choose". */
    fallbackLabel?: string;
    testID: string;
    testIDPrefix: string;
    controlId?: 'machine' | 'path';
  }>,
): AgentInputExtraActionChip {
  return {
    ...createExecutionRunStartContentChip({
      key: 'workflow-start-where',
      controlId: params.controlId ?? 'machine',
      placementId: 'machine:workflow-start-where',
      pending: true,
      icon: 'folder',
      title: t('workflows.page.where.label'),
      label:
        formatWorkflowWhereSummary({
          target: params.target,
          machineName: params.machineName,
          machineHomeDir: params.machineHomeDir,
        }) ??
        params.fallbackLabel ??
        t('workflows.page.where.choose'),
      testID: params.testID,
      revision: JSON.stringify([
        params.target ?? null,
        params.onChange !== undefined,
      ]),
      renderContent: (
        <WorkflowProjectTargetControl
          purpose="workflow"
          target={params.target}
          machineName={params.machineName}
          {...(params.machineHomeDir === undefined
            ? {}
            : { machineHomeDir: params.machineHomeDir })}
          {...(params.machines === undefined
            ? {}
            : { machines: params.machines })}
          {...(params.accountLifetime === undefined
            ? {}
            : { accountLifetime: params.accountLifetime })}
          {...(params.onChange === undefined
            ? {}
            : { onChange: params.onChange })}
          testIDPrefix={params.testIDPrefix}
        />
      ),
    }),
    controlId: params.controlId ?? 'machine',
    placement: { ...getWorkflowStartWhereChipPlacement(), pending: true },
  };
}
