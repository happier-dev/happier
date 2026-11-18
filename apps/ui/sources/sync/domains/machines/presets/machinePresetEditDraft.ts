import type { ManagedMachinePresetCreateInputV1, ManagedMachinePresetUpdateInputV1, ManagedMachinePresetV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';
import { mergeMachineSetupsV1, type MachinePresetItemV1 } from '@happier-dev/protocol/machines/managed/machineSetupV1';
import type { ManagedMachinePresetContentV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetContentV1';
import { randomUUID } from '@/platform/randomUUID';

/** Unsealed editor input; the collection owner decides the current Account envelope. */
export type MachinePresetCreateDraftInput = Omit<ManagedMachinePresetCreateInputV1,
    'content' | 'recipients' | 'contentEncryptionMode'> & Readonly<{ privateContent: ManagedMachinePresetContentV1 }>;
export type MachinePresetUpdateDraftInput = Omit<ManagedMachinePresetUpdateInputV1, 'patch'> & Readonly<{
    patch: Omit<ManagedMachinePresetUpdateInputV1['patch'], 'content' | 'recipients' | 'contentEncryptionMode'>
        & Readonly<{ privateContent?: ManagedMachinePresetContentV1 }>;
}>;
export type MachinePresetCreationDraft = Readonly<{ launch: NonNullable<ManagedMachinePresetContentV1['launch']> }>
    & Pick<ManagedMachinePresetV1, 'controller' | 'controllerPoolId' | 'retention' | 'wakeOnAcceptedMessage' | 'simultaneousLimit'>;

/** Editing intent, not a persisted record or an admitted creation receipt. */
export type MachinePresetEditDraft = Readonly<Pick<ManagedMachinePresetContentV1, 'name' | 'setup' | 'preparation' | 'projectFiles'> & {
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
export function machinePresetEditDraftContent(draft: MachinePresetEditDraft): Pick<MachinePresetCreateDraftInput,
    'privateContent' | 'controller' | 'controllerPoolId' | 'retention' | 'wakeOnAcceptedMessage' | 'simultaneousLimit'> {
    const creation = draft.creation;
    return {
        privateContent: { v: 1, name: draft.name,
            ...(creation ? { launch: creation.launch } : {}),
            ...(draft.setup === undefined ? {} : { setup: draft.setup }),
            ...(draft.preparation === undefined ? {} : { preparation: draft.preparation }),
            ...(draft.projectFiles === undefined ? {} : { projectFiles: draft.projectFiles }) },
        ...(creation ? {
            ...(creation.controllerPoolId ? { controllerPoolId: creation.controllerPoolId }
                : creation.controller ? { controller: creation.controller } : {}),
            ...(creation.retention === undefined ? {} : { retention: creation.retention }),
            ...(creation.wakeOnAcceptedMessage === undefined ? {} : { wakeOnAcceptedMessage: creation.wakeOnAcceptedMessage }),
            ...(creation.simultaneousLimit === undefined ? {} : { simultaneousLimit: creation.simultaneousLimit }),
        } : {}),
    };
}

/** The incumbent editor's full update patch; a full private body replaces removed creation and setup. */
export function machinePresetEditDraftUpdatePatch(draft: MachinePresetEditDraft): MachinePresetUpdateDraftInput['patch'] {
    const content = machinePresetEditDraftContent(draft);
    return { ...content,
        controller: content.controller ?? null,
        controllerPoolId: content.controllerPoolId ?? null,
        ...(draft.creation ? {} : { teamAcquireDelegated: false }),
        retention: content.retention ?? null,
        wakeOnAcceptedMessage: content.wakeOnAcceptedMessage ?? null,
        simultaneousLimit: content.simultaneousLimit ?? null };
}
