import type { WorkspaceAddressV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';

import type { ActionOperationProjection } from '@/sync/domains/actionOperations/actionOperationSelectors';
import { useActionOperation, useProjectHeldSetupReviewOperation, useProjectScriptActionOperation, useProjectSetupActionOperation } from '@/sync/domains/actionOperations/useActionOperations';
import type { ActionOperationProjectScriptSelection } from '@/sync/domains/actionOperations/qualifiedActionOperation';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';

/** Shared requesters follow the selected custody owner; its Account push belongs to the custodian. */
function useProjectRunObservation(operation: ActionOperationProjection | null, lifetime?: ServerAccountScopeLifetime | null) {
  return useActionOperation(operation ? { serverId: operation.serverId, operationId: operation.snapshot.operationId } : null,
    operation && lifetime ? { machineId: operation.snapshot.scope.machineId, actionId: operation.snapshot.actionId, lifetime } : undefined);
}

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
  lifetime?: ServerAccountScopeLifetime | null,
): ActionOperationProjection | null {
  const operation = useProjectScriptActionOperation({ accountId, workspace: { ...workspace,
    serverId: resolveServerProfileScopeIdForIdentifier(workspace.serverId) }, selection });
  return useProjectRunObservation(operation, lifetime);
}

/**
 * Standalone preparation only; a Script's setup phase remains attached to its Script row.
 */
export function useProjectSetupRun(
  workspace: WorkspaceAddressV1 | null,
  accountId: string | null,
  lifetime?: ServerAccountScopeLifetime | null,
): ActionOperationProjection | null {
  const operation = useProjectSetupActionOperation(workspace ? { accountId, workspace: { ...workspace,
    serverId: resolveServerProfileScopeIdForIdentifier(workspace.serverId) } } : null);
  return useProjectRunObservation(operation, lifetime);
}

/** The setup review the checkout is waiting on, held by its preparation or by a Script's setup phase. */
export function useProjectHeldSetupReview(
  workspace: WorkspaceAddressV1,
  accountId: string | null,
): ActionOperationProjection | null {
  return useProjectHeldSetupReviewOperation({ accountId, workspace: { ...workspace,
    serverId: resolveServerProfileScopeIdForIdentifier(workspace.serverId) } });
}
