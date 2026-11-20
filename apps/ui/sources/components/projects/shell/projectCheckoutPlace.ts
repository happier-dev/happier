import type { IconName } from '@/components/ui/icons/Icon';
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
