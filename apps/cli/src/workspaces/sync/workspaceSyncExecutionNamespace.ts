import type { WorkspaceRefV1 } from '@happier-dev/protocol';
import { isManagedWorkspaceRefV2, type ManagedWorkspaceRefV2 } from '@happier-dev/protocol/workspaces/workspaceRefV1';

export type WorkspaceSyncLocalManagedTarget = Pick<ManagedWorkspaceRefV2, 'managedId' | 'controller'>;

/** A controller route never makes the guest filesystem the controller's filesystem. */
export function isWorkspaceSyncLocalNamespace(
  workspace: WorkspaceRefV1,
  localServerId: string,
  localMachineId: string,
  localManagedTarget?: WorkspaceSyncLocalManagedTarget,
): boolean {
  if (!localServerId.trim() || workspace.serverId.trim() !== localServerId.trim() || !localMachineId.trim()) return false;
  if (isManagedWorkspaceRefV2(workspace)) {
    return localManagedTarget !== undefined && workspace.managedId === localManagedTarget.managedId
      && workspace.controller.machineId === localMachineId.trim()
      && workspace.controller.machineId === localManagedTarget.controller.machineId
      && workspace.controller.installationId === localManagedTarget.controller.installationId;
  }
  return localManagedTarget === undefined && workspace.machineId.trim() === localMachineId.trim();
}
