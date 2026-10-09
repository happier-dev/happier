import type { MachineProvisionersListResultV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import type { MachineRetentionCategoryV1 } from '@happier-dev/protocol/account/settings/machineRetentionDefaultsV1';
import type { PluginLocalizedTextResolver } from '@/sync/domains/plugins/ui/i18n';
import { resolveMachineRetentionCategoryV1 } from '@happier-dev/protocol/machines/managed/resolveMachineRetentionPolicyV1';

type Provisioner = MachineProvisionersListResultV1['provisioners'][number];
type CategoryProvisioner = Readonly<{ contribution: Provisioner['contribution']; descriptor: Pick<Provisioner['descriptor'], 'title' | 'billing'> }>;
export function projectManagedRetentionProviders(provisioners: readonly CategoryProvisioner[], localized: PluginLocalizedTextResolver): Readonly<Record<MachineRetentionCategoryV1, readonly string[]>> {
    const categories: Record<MachineRetentionCategoryV1, string[]> = { local: [], 'running-only': [], 'stopped-billed': [], unknown: [] };
    for (const provisioner of provisioners) {
        const names = categories[resolveMachineRetentionCategoryV1(provisioner.descriptor.billing)];
        const name = localized(provisioner.contribution.pluginId, provisioner.descriptor.title);
        if (!names.includes(name)) names.push(name);
    }
    return categories;
}
