import type { LocalServiceLaunchTarget } from '@/sync/domains/local/services/launch';

/** The SOURCE checkout owns the declaration, including its copies admitted on workers. */
export type ProjectServiceSource = Readonly<{ serverId: string; refId: string; machineId: string; rootPath?: string }>;

export function isProjectServiceTargetFromSource(
  source: ProjectServiceSource,
  target: Pick<LocalServiceLaunchTarget, 'declaration' | 'machineId'>,
): boolean {
  // Other-Machine targets reach this Project through its accepted worker-binding projection.
  // This machine's other checkouts retain their own declaration facts and placement.
  return Boolean(target.declaration && (target.declaration.workspaceRefId === source.refId || target.machineId !== source.machineId));
}
