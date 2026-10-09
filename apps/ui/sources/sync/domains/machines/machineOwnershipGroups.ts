import type { MachineDisplayRenderable } from './machineDisplayRenderable';
import { t } from '@/text';
import { formatOSPlatform } from '@/utils/sessions/sessionUtils';

/** Actual custodian and safely published platform facts, shared by all Machine row presentations. */
export function describeMachineSharedOwnership(machine: Pick<MachineDisplayRenderable, 'isShared' | 'access' | 'metadata'>): string | null {
    if (!machine.isShared || !machine.access?.custodian) return null;
    return t('machines.destinations.owner', {
        owner: machine.access.custodian.displayName,
        platform: formatOSPlatform(machine.metadata?.platform),
    });
}

export type MachineOwnershipGroup<T extends MachineDisplayRenderable> = Readonly<{
    key: string;
    custodian: NonNullable<T['access']>['custodian'] | null;
    machines: readonly T[];
}>;

/** A shared group names its actual custodian only when that public name is available. */
export function describeMachineSharedGroupTitle(custodian: MachineOwnershipGroup<MachineDisplayRenderable>['custodian'] | undefined): string {
    const owner = custodian?.displayName?.trim();
    return owner ? t('machines.destinations.shared', { team: owner }) : t('machines.destinations.sharedWithoutOwner');
}

/** One inventory grouping for the Machines collection and destination picker, within an exact Home. */
export function buildMachineOwnershipGroups<T extends MachineDisplayRenderable>(machines: readonly T[]): readonly MachineOwnershipGroup<T>[] {
    const owned: T[] = [];
    const shared = new Map<string, { custodian: NonNullable<T['access']>['custodian'] | null; machines: T[] }>();
    for (const machine of machines) {
        if (!machine.isShared) { owned.push(machine); continue; }
        const custodian = machine.access?.custodian ?? null;
        const key = custodian?.accountId ?? '';
        let group = shared.get(key);
        if (!group) { group = { custodian, machines: [] }; shared.set(key, group); }
        group.machines.push(machine);
    }
    return [
        ...(owned.length > 0 || shared.size === 0 ? [{ key: 'owned', custodian: null, machines: owned }] : []),
        ...Array.from(shared, ([key, group]) => ({ key: `shared:${key}`, ...group })),
    ];
}
