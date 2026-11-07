import type { ManagedMachinePresetCreationV1, ManagedMachinePresetUpdateInputV1, ManagedMachinePresetV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';
import { mergeMachineSetupsV1, type MachinePresetItemV1 } from '@happier-dev/protocol/machines/managed/machineSetupV1';
import { randomUUID } from '@/platform/randomUUID';

export type MachinePresetCreationDraft = ManagedMachinePresetCreationV1
    & Pick<ManagedMachinePresetV1, 'retention' | 'wakeOnAcceptedMessage' | 'simultaneousLimit'>;

/** Editing intent, not a persisted record or an admitted creation receipt. */
export type MachinePresetEditDraft = Readonly<Pick<ManagedMachinePresetV1, 'name' | 'setup'> & {
    /** Undefined deliberately removes creation; the CRUD owner must clear both persisted fields. */
    creation?: MachinePresetCreationDraft;
}>;

/**
 * An Add-to-Preset hand-off into the one existing editor: the exact App or Software item, the editor draft it
 * joins, the Preset revision that draft was based on, and where to go back. Entering or cancelling writes nothing;
 * only the editor's explicit Save does, and a successful Save returns.
 */
export type MachinePresetEditContinuation = Readonly<{
    item: Exclude<MachinePresetItemV1, { kind: 'setupRecipe' }>;
    draft: MachinePresetEditDraft;
    preset?: Readonly<{ id: string; revision: number }>;
    onReturn: () => void;
}>;

/** Resume local editing without mutating the caller's draft or restoring an omitted creation part. */
export function machinePresetEditContinuationDraft(continuation: MachinePresetEditContinuation) {
    const item = continuation.item.kind === 'app' && continuation.item.definition.definition.from !== 'catalogApp'
        && !continuation.item.authoredKey ? { ...continuation.item, authoredKey: randomUUID() } : continuation.item;
    const merged = mergeMachineSetupsV1([continuation.draft.setup ?? {}, { items: [item] }]);
    return merged.ok ? { ok: true as const, draft: { ...continuation.draft, setup: merged.setup } } : merged;
}

/** Full draft content; absence is not an update-patch instruction to retain old creation. */
export function machinePresetEditDraftContent(draft: MachinePresetEditDraft) {
    const creation = draft.creation;
    return {
        name: draft.name,
        ...(creation ? {
            launch: creation.launch,
            controller: creation.controller,
            ...(creation.retention === undefined ? {} : { retention: creation.retention }),
            ...(creation.wakeOnAcceptedMessage === undefined ? {} : { wakeOnAcceptedMessage: creation.wakeOnAcceptedMessage }),
            ...(creation.simultaneousLimit === undefined ? {} : { simultaneousLimit: creation.simultaneousLimit }),
        } : {}),
        ...(draft.setup === undefined ? {} : { setup: draft.setup }),
    };
}

/** The incumbent editor's full update patch; unlike create, absent fields clear saved content. */
export function machinePresetEditDraftUpdatePatch(draft: MachinePresetEditDraft): ManagedMachinePresetUpdateInputV1['patch'] {
    const content = machinePresetEditDraftContent(draft);
    return { ...content,
        ...(draft.creation ? {} : { launch: null, controller: null, teamAcquireDelegated: false }),
        setup: content.setup ?? null, retention: content.retention ?? null,
        wakeOnAcceptedMessage: content.wakeOnAcceptedMessage ?? null,
        simultaneousLimit: content.simultaneousLimit ?? null };
}
