import * as React from 'react';
import type { WorkflowProjectTargetV1 } from '@happier-dev/protocol/workflows/workflowWorkspaceV1';

import { resolveContextualWorkflowProjectTarget } from '@/components/workflows/screens/resolveContextualWorkflowTarget';
import { useWorkflowEditorAccountMemory } from '@/components/workflows/screens/useWorkflowEditorAccountMemory';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import type { Machine } from '@/sync/domains/state/storageTypes';
import {
  isWorkflowProjectTarget,
  type WorkflowAuthoringTarget,
} from '@/sync/domains/workflows/workflowProjectTarget';
import { useMachineListForServer } from '@/sync/store/hooks';
import { getMachineDisplayName } from '@/utils/sessions/machineUtils';

const NO_MACHINES: never[] = [];

/**
 * Where a Workflow started from a Discussion runs (the composer's Run… and a second opinion asked of
 * several, which starts Fresh opinions). A Discussion has no Machine of its own, so it starts at the
 * contextual default New Session uses until the person chooses through `WorkflowProjectTargetControl`.
 * `project` is the admitted placement, or null while nothing resolves.
 */
export function useDiscussionWorkflowProject(
  accountLifetime: ServerAccountScopeLifetime,
  enabled = true,
  initialTarget?: WorkflowProjectTargetV1,
): Readonly<{
  target: WorkflowAuthoringTarget | null;
  project: WorkflowProjectTargetV1 | null;
  machines: readonly Machine[];
  machineName: string | null;
  choose: (target: WorkflowAuthoringTarget) => void;
}> {
  const machines =
    useMachineListForServer(accountLifetime.scope.serverId, enabled) ?? NO_MACHINES;
  const { recentMachinePaths } =
    useWorkflowEditorAccountMemory(enabled ? accountLifetime : null, { workspaceRefs: false });
  const [chosen, setChosen] = React.useState<WorkflowAuthoringTarget | null>(
    initialTarget ?? null,
  );
  const resolved = React.useMemo(
    () =>
      resolveContextualWorkflowProjectTarget({
        machines,
        recentMachinePaths,
        scope: accountLifetime.isCurrent() ? accountLifetime.scope : null,
      }),
    [machines, accountLifetime, recentMachinePaths],
  );
  // The contextual default is a value: keep one identity per Machine and folder, so consumers (the Run
  // chip, the composer's chip rail) do not change on every recent-paths read.
  const contextualKey = resolved
    ? JSON.stringify([resolved.machineId, resolved.directory])
    : null;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const contextual = React.useMemo(() => resolved, [contextualKey]);
  const target = chosen ?? contextual;
  const project =
    target &&
    isWorkflowProjectTarget(target) &&
    target.directory.trim().length > 0
      ? target
      : null;
  const machine = machines.find((entry) => entry.id === target?.machineId);
  return {
    target,
    project,
    machines,
    machineName: machine ? getMachineDisplayName(machine) : null,
    choose: setChosen,
  };
}
