import type { MachineSetupObservationV1 } from '@happier-dev/protocol';
import type { MachineMetadata } from '../types';
import type { MachineSetupEffectPlanV1 } from '@happier-dev/protocol/machines/setup/machineRecipeV1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { isMachineSetupRecipeItemV1 } from '@happier-dev/protocol/machines/managed/machineSetupV1';

function projectAttachedPresets(metadata: MachineMetadata): NonNullable<MachineSetupObservationV1['attachedPresets']> {
    const attachedPresets: NonNullable<MachineSetupObservationV1['attachedPresets']> = [];
    for (const source of metadata.setup?.sources ?? []) {
        if (source.kind === 'accountPreset') attachedPresets.push({ kind: source.kind,
            presetId: source.presetId, presetRevision: source.presetRevision,
            ...(source.setupRevision === undefined ? {} : { setupRevision: source.setupRevision }) });
        if (source.kind === 'bundledPreset') attachedPresets.push({ kind: source.kind, ref: {
            pluginId: source.ref.pluginId, localId: source.ref.localId, revision: source.ref.revision,
        } });
    }
    return attachedPresets;
}

/** Consume successful native Apply, whose interpreter already verified its effects. */
export function projectMachineSetupAppliedObservation(
    previous: MachineSetupObservationV1 | undefined,
    metadata: MachineMetadata | null,
    plans: readonly MachineSetupEffectPlanV1[],
): MachineSetupObservationV1 {
    const recipes: MachineSetupObservationV1['recipes'] = [];
    for (const source of metadata?.setup?.sources ?? []) for (const item of source.setup.items ?? []) {
        if (!isMachineSetupRecipeItemV1(item) || recipes.some(recipe => sameStrictJsonValue(recipe.ref, item.selection.ref))) continue;
        const plan = plans.find(plan => plan.basis.kind === 'setup' && sameStrictJsonValue(plan.basis.selection, item.selection));
        // Reboot Apply proves dispatch only; its reconnect owner establishes readiness.
        const status = plan && !plan.steps.some(step => step.kind === 'reboot') ? 'satisfied' : 'unverifiable';
        recipes.push({ ref: item.selection.ref, status,
            ...(status === 'unverifiable' ? { reason: 'required_fact_unavailable' as const } : {}),
            steps: plan?.steps.map(step => ({ stepId: step.id,
                status: step.kind === 'reboot' ? 'unverifiable' as const : 'satisfied' as const })) ?? [] });
    }
    return { version: 1, desiredRevision: metadata?.setup?.revision ?? 0,
        status: recipes.every(recipe => recipe.status === 'satisfied') ? 'satisfied' : 'unverifiable', recipes,
        ...(previous?.updates ? { updates: previous.updates } : {}),
        ...(metadata ? { attachedPresets: projectAttachedPresets(metadata) }
            : previous?.attachedPresets ? { attachedPresets: previous.attachedPresets } : {}) };
}

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
        ...(previous?.updates?.heldPackages !== undefined ? { heldPackages: previous.updates.heldPackages } : {}),
        ...(previous?.updates?.checkedAt !== undefined ? { checkedAt: previous.updates.checkedAt } : {}),
        ...updates,
    } : updates;
    return {
        ...(previous ?? { version: 1, desiredRevision: metadata?.setup?.revision ?? 0,
            status: 'unverifiable', reason: 'required_fact_unavailable', recipes: [] }),
        ...(metadata ? { attachedPresets: projectAttachedPresets(metadata) } : {}),
        updates: published,
    };
}
