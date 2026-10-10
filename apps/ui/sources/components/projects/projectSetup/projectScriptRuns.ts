import type { WorkspaceAddressV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';

import type { ActionOperationProjection } from '@/sync/domains/actionOperations/actionOperationSelectors';
import { useProjectScriptActionOperation, useProjectSetupActionOperation } from '@/sync/domains/actionOperations/useActionOperations';
import type { ActionOperationProjectScriptSelection } from '@/sync/domains/actionOperations/qualifiedActionOperation';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';

/** Dispatch feedback key only; operation identity and status never depend on this key. */
export function projectScriptRowKey(
  workspace: WorkspaceAddressV1,
  name: string,
): string {
  return JSON.stringify([
    workspace.serverId,
    workspace.machineId,
    workspace.workspaceId,
    name,
  ]);
}

/** Any client's current or latest run for this original Source checkout and Script. */
export function useProjectScriptRun(
  workspace: WorkspaceAddressV1,
  selection: ActionOperationProjectScriptSelection,
  accountId: string | null,
): ActionOperationProjection | null {
  return useProjectScriptActionOperation({ accountId, workspace: { ...workspace,
    serverId: resolveServerProfileScopeIdForIdentifier(workspace.serverId) }, selection });
}

/**
 * Standalone preparation only; a Script's setup phase remains attached to its Script row.
 */
export function useProjectSetupRun(
  workspace: WorkspaceAddressV1,
  accountId: string | null,
): ActionOperationProjection | null {
  return useProjectSetupActionOperation({ accountId, workspace: { ...workspace,
    serverId: resolveServerProfileScopeIdForIdentifier(workspace.serverId) } });
}
