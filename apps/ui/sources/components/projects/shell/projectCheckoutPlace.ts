import type { IconName } from '@/components/ui/icons/Icon';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import type { WorkspaceAddressV2 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { workspaceAddressFromRefV2 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import { t } from '@/text';

type NameParts = Readonly<{ name: string; hint: string | null }>;

/**
 * Where the checkout chip says the files live (remote workspaces lab `project-ok`): a Machine by its name, or an
 * attached workspace by its own name with "via <controller>" as the hint the chip already draws after a name.
 * A name still resolving stays empty, never a placeholder (owner 11-15).
 */
export function describeManagedCheckoutPlace(input: Readonly<{
  controllerMachineId: string;
  machineNameParts: (machineId: string) => NameParts | null;
  /** The attached workspace's name from the managed resource owner; null while it resolves. */
  managedName: string | null;
}>): Readonly<{ machineName: string; machineNameParts: NameParts; machineIcon: IconName }> {
  const name = input.managedName?.trim() ?? '';
  const controller = input.machineNameParts(input.controllerMachineId)?.name ?? '';
  const hint = name && controller ? t('projects.checkouts.via', { machine: controller }) : null;
  return { machineName: name, machineNameParts: { name, hint }, machineIcon: 'terminal' };
}

/**
 * The place a checkout lives, from its exact address: a Machine, or an attached workspace (its managed resource).
 * A managed checkout names no Machine of its own, so comparing flat Machine ids would hide its siblings.
 */
export function checkoutPlaceKey(address: WorkspaceAddressV2): string {
  return 'kind' in address && address.kind === 'managed'
    ? JSON.stringify([address.serverId, 'managed', address.managedId])
    : JSON.stringify([address.serverId, 'machine', address.machineId]);
}

/**
 * A sibling checkout in the chip's menu, by its place (lab `project-chip`): a Machine under "Other machines" with its
 * name, or an attached workspace under "On servers" with its own name and "via <controller>". A name still resolving
 * stays out of the line, never a placeholder.
 */
export function describeSiblingCheckoutPlace(ref: WorkspaceRefV1, names: Readonly<{
  machineName: (machineId: string) => string;
  managedName: (managedId: string) => string | null;
}>): Readonly<{ subtitle: string; category: string; icon: IconName }> {
  const address = workspaceAddressFromRefV2(ref);
  if ('kind' in address && address.kind === 'managed') {
    const controller = names.machineName(address.controller.machineId);
    const parts = [names.managedName(address.managedId)?.trim() || null,
      controller ? t('projects.checkouts.via', { machine: controller }) : null, address.rootPath];
    return { subtitle: parts.filter(Boolean).join(' · '), category: t('projects.checkouts.onServers'), icon: 'terminal' };
  }
  const machine = names.machineName(address.machineId);
  return { subtitle: [machine || null, address.rootPath].filter(Boolean).join(' · '),
    category: t('projects.checkouts.otherMachines'), icon: 'desktop' };
}
