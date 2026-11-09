import type { MachineSetupObservationV1 } from '@happier-dev/protocol';
import type { MachineMetadata } from '../types';

/** Project only facts already held by the daemon; the state publisher deduplicates. */
export function projectMachineSetupUpdatesObservation(
    previous: MachineSetupObservationV1 | undefined,
    metadata: MachineMetadata | null,
    updates: NonNullable<MachineSetupObservationV1['updates']>,
): MachineSetupObservationV1 {
    const retainLastKnown = updates.status === 'unavailable' || updates.status === 'unverifiable';
    const published = retainLastKnown ? {
        ...(previous?.updates?.pendingAll !== undefined ? { pendingAll: previous.updates.pendingAll } : {}),
        ...(previous?.updates?.pendingSecurity !== undefined ? { pendingSecurity: previous.updates.pendingSecurity } : {}),
        ...(previous?.updates?.rebootNeeded !== undefined ? { rebootNeeded: previous.updates.rebootNeeded } : {}),
        ...updates,
    } : updates;
    const attachedPresets: NonNullable<MachineSetupObservationV1['attachedPresets']> = [];
    for (const source of metadata?.setup?.sources ?? []) {
        if (source.kind === 'accountPreset') attachedPresets.push({ kind: source.kind,
            presetId: source.presetId, presetRevision: source.presetRevision });
        if (source.kind === 'bundledPreset') attachedPresets.push({ kind: source.kind, ref: {
            pluginId: source.ref.pluginId, localId: source.ref.localId, revision: source.ref.revision,
        } });
    }
    return {
        ...(previous ?? { version: 1, desiredRevision: metadata?.setup?.revision ?? 0,
            status: 'unverifiable', reason: 'required_fact_unavailable', recipes: [] }),
        ...(metadata ? { attachedPresets } : {}),
        updates: published,
    };
}
