import { t } from '@/text';
import type { ManagedMachineV1, ValidatedLaunchSnapshotV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import type { ManagedConfigurationFactsV1 } from '@happier-dev/protocol/machines/managed/managedConfigurationV1';
import { stableJsonStringify } from '@/utils/json/stableJsonStringify';
import { formatMachineDisplayNameParts, resolveMachineDisplayNameParts } from '@/utils/sessions/machineDisplayNames';

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
    const made = input.machines.filter(machine => machine.homeId === input.homeId && machine.preset?.id === input.presetId);
    // Named as the Machines list names created machines: same-named ones are told apart by their short id (TH D-K).
    // An unreadable sealed machine has no name to tell apart: it keeps the generic label.
    const names = resolveMachineDisplayNameParts(made.flatMap(machine => machine.launch?.name ? [{ id: machine.id, managedName: machine.launch.name }] : []));
    return made.flatMap(machine => {
        if (!machine.preset) return [];
        // A history row's status is the state's one word ("Ended"), not its sentence (TH D3).
        const creation = describeManagedCreation(machine);
        const parts = names.get(machine.id);
        return [{ managedId: machine.id, presetRevision: machine.preset.revision,
            title: parts ? formatMachineDisplayNameParts(parts) : machine.launch?.name ?? t('common.machine'), subtitle: creation.word ?? creation.line,
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
