import * as React from 'react';

import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';
import { createExecutionRunStartContentChip } from '@/components/sessions/runs/launcher/executionRunStartChips';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import type { Machine } from '@/sync/domains/state/storageTypes';
import {
  isWorkflowProjectTarget,
  type WorkflowAuthoringTarget,
} from '@/sync/domains/workflows/workflowProjectTarget';
import { t } from '@/text';
import { formatPathRelativeToHome } from '@/utils/sessions/formatPathRelativeToHome';
import {
  getWorkflowStartFolderChipPlacement,
  getWorkflowStartWhereChipPlacement,
} from '../workflowComposerControlPlacements';
import { WorkflowStartPlacementPicker } from '../editor/WorkflowProjectTargetControl';

/** The Machine chip's key: a composer that carries it already shows and changes where the start runs. */
export const WORKFLOW_START_WHERE_CHIP_KEY = 'workflow-start-where';
const WORKFLOW_START_FOLDER_CHIP_KEY = 'workflow-start-folder';

/**
 * A start composer's Machine chip and folder chip (owner 2026-11-12: two chips everywhere, as in New
 * Session), each opening New Session's picker with the workflow rules. With `onChange` they choose the
 * next start's place; without it they show a place already decided (an accepted Run) read-only.
 */
export function createWorkflowStartPlacementChips(
  params: Readonly<{
    target: WorkflowAuthoringTarget | null | undefined;
    machineName: string | null;
    machineHomeDir?: string | null;
    machines?: readonly Machine[];
    accountLifetime?: ServerAccountScopeLifetime | null;
    onChange?: (target: WorkflowAuthoringTarget) => void;
    /** What the Machine chip says before a Machine is known; defaults to "Choose". */
    fallbackLabel?: string;
    testID: string;
    testIDPrefix: string;
  }>,
): readonly AgentInputExtraActionChip[] {
  const target = params.target ?? null;
  const shared = {
    target,
    machineName: params.machineName,
    machineHomeDir: params.machineHomeDir ?? null,
    ...(params.machines === undefined ? {} : { machines: params.machines }),
    ...(params.accountLifetime === undefined
      ? {}
      : { accountLifetime: params.accountLifetime }),
    ...(params.onChange === undefined ? {} : { onChange: params.onChange }),
    testIDPrefix: params.testIDPrefix,
  };
  const revision = JSON.stringify([
    target,
    params.onChange !== undefined,
    params.machines?.length ?? null,
  ]);
  const folderLabel =
    target === null
      ? null
      : isWorkflowProjectTarget(target)
        ? formatPathRelativeToHome(
            target.directory,
            params.machineHomeDir ?? undefined,
            {
              homeLabel: t('workspacePresentation.homeFolder'),
            },
          )
        : t('newSession.folder.noFolder');
  const machine: AgentInputExtraActionChip = {
    ...createExecutionRunStartContentChip({
      key: WORKFLOW_START_WHERE_CHIP_KEY,
      controlId: 'machine',
      pending: true,
      icon: 'desktop',
      title: t('newSession.wizardSection.machine'),
      label:
        params.machineName ??
        params.fallbackLabel ??
        t('workflows.page.where.choose'),
      testID: params.testID,
      disabled: params.onChange === undefined || params.machines === undefined,
      revision,
      renderContent: (args) => (
        <WorkflowStartPlacementPicker
          {...shared}
          picker="machine"
          args={args}
        />
      ),
    }),
    controlId: 'machine',
    placement: { ...getWorkflowStartWhereChipPlacement(), pending: true },
  };
  if (folderLabel === null) return [machine];
  const folder: AgentInputExtraActionChip = {
    ...createExecutionRunStartContentChip({
      key: WORKFLOW_START_FOLDER_CHIP_KEY,
      controlId: 'path',
      pending: true,
      icon: 'folder',
      title: t('newSession.wizardSection.folder'),
      label: folderLabel,
      testID: `${params.testID}-folder`,
      disabled: params.onChange === undefined,
      revision,
      renderContent: (args) => (
        <WorkflowStartPlacementPicker {...shared} picker="folder" args={args} />
      ),
    }),
    controlId: 'path',
    placement: { ...getWorkflowStartFolderChipPlacement(), pending: true },
  };
  return [machine, folder];
}
