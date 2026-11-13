import type { MachineDisplayRenderable } from './machineDisplayRenderable';
import { t } from '@/text';
import { formatOSPlatform } from '@/utils/sessions/sessionUtils';

/** Actual custodian and safely published platform facts, shared by all Machine row presentations. */
export function describeMachineSharedOwnership(machine: Pick<MachineDisplayRenderable, 'isShared' | 'access' | 'metadata'>): string | null {
    if (!machine.isShared || !machine.access?.custodian) return null;
    const platform = formatOSPlatform(machine.metadata?.platform);
    // Like the group title: an owner without a public name is left out, never drawn as a bare "'s".
    const owner = machine.access.custodian.displayName?.trim();
    // A locked machine has published no platform: name the owner alone, never a dangling separator.
    if (!owner) return platform;
    return platform ? t('machines.destinations.owner', { owner, platform }) : t('machines.destinations.ownerOnly', { owner });
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
        const key = custodian?.displayName?.trim() ? custodian.accountId : '';
        let group = shared.get(key);
        if (!group) { group = { custodian, machines: [] }; shared.set(key, group); }
        group.machines.push(machine);
    }
    return [
        ...(owned.length > 0 || shared.size === 0 ? [{ key: 'owned', custodian: null, machines: owned }] : []),
        ...Array.from(shared).sort(([leftKey, left], [rightKey, right]) =>
            (left.custodian?.displayName?.trim() ?? '').localeCompare(right.custodian?.displayName?.trim() ?? '', undefined, { sensitivity: 'base' })
            || leftKey.localeCompare(rightKey))
            .map(([key, group]) => ({ key: `shared:${key}`, ...group })),
    ];
}
