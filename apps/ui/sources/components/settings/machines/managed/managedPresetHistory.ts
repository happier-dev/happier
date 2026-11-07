import type { ManagedMachineV1, ValidatedLaunchSnapshotV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import type { ManagedConfigurationFactsV1 } from '@happier-dev/protocol/machines/managed/managedConfigurationV1';
import { stableJsonStringify } from '@/utils/json/stableJsonStringify';

import { machineCollectionHref } from '../collection/machineCollectionModel';
import { describeManagedCreation } from './managedCreationPresentation';

export type ManagedPresetHistoryRow = Readonly<{
    managedId: string;
    presetRevision: number;
    title: string;
    subtitle: string;
    href: string;
    machine: ManagedMachineV1;
}>;

/** History is a projection of admitted resource rows, including archived and recovery rows. */
export function buildManagedPresetHistory(input: Readonly<{
    serverId: string;
    homeId: string;
    presetId: string;
    machines: readonly ManagedMachineV1[];
}>): readonly ManagedPresetHistoryRow[] {
    return input.machines.flatMap(machine => {
        if (machine.homeId !== input.homeId || machine.preset?.id !== input.presetId) return [];
        return [{ managedId: machine.id, presetRevision: machine.preset.revision,
            title: machine.launch.name, subtitle: describeManagedCreation(machine).line,
            href: machineCollectionHref({ kind: 'managed', managedId: machine.id, serverId: input.serverId }), machine }];
    });
}

/**
 * The preset's size and image as last saved: the reviewed facts of a machine made with exactly its saved choices.
 * Nothing is derived from choice ids, so a preset no machine was made from has no last saved facts.
 */
export function findPresetLastSavedFacts(input: Readonly<{ launch: ValidatedLaunchSnapshotV1; history: readonly ManagedPresetHistoryRow[] }>):
    Pick<NonNullable<ManagedConfigurationFactsV1['nativeFacts']>, 'size' | 'image'> | undefined {
    const saved = (launch: Pick<ValidatedLaunchSnapshotV1, 'provider' | 'schemaVersion' | 'choices'>) =>
        stableJsonStringify([launch.provider, launch.schemaVersion, launch.choices]);
    const choices = saved(input.launch);
    for (const row of [...input.history].reverse()) {
        const facts = row.machine.reviewedFacts;
        const native = facts?.nativeFacts;
        if (!native || (!native.size && !native.image) || saved(facts.launch) !== choices) continue;
        return { ...(native.size ? { size: native.size } : {}), ...(native.image ? { image: native.image } : {}) };
    }
    return undefined;
}
