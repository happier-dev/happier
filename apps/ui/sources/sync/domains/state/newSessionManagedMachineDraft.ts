import * as z from 'zod/mini';

import {
    ManagedConfigurationFactsV1Schema,
    ManagedCreationSelectionV1Schema,
    ManagedPresetSelectionV1Schema,
    type ManagedConfigurationFactsV1,
    type ManagedCreationSelectionV1,
} from '@happier-dev/protocol/machines/managed/managedConfigurationV1';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { ActionOperationGetV1RequestSchema } from '@happier-dev/protocol/actions/operations/v1';
import {
    ManagedControllerV1Schema,
    ManagedMachineEnrollmentIdentityV1Schema,
    ReusableRetentionV1Schema,
    type ManagedMachineEnrollmentIdentityV1,
} from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { MachinePoolIdV1Schema } from '@happier-dev/protocol/machines/pools';
import {
    ManagedMachinePresetLaunchNameOverrideV1Schema,
    type ManagedMachinePresetLaunchNameOverrideV1,
} from '@happier-dev/protocol/machines/managed/managedMachinePresetContentV1';

/**
 * Public provenance from the exact opened Preset selected by the person. It is
 * local continuation state only: acquire input still contains only the opaque
 * Preset selection and its sealed override.
 */
export const ManagedMachinePresetAcquireOriginDraftSchema = z.strictObject({
    id: z.string().check(z.trim(), z.minLength(1)),
    homeId: z.string().check(z.trim(), z.minLength(1)),
    revision: z.number().check(z.int(), z.nonnegative()),
    name: z.optional(z.string()),
    controller: z.optional(ManagedControllerV1Schema),
    controllerPoolId: z.optional(MachinePoolIdV1Schema),
    retention: z.optional(ReusableRetentionV1Schema),
    wakeOnAcceptedMessage: z.optional(z.boolean()),
});
export type ManagedMachinePresetAcquireOriginDraft = z.infer<typeof ManagedMachinePresetAcquireOriginDraftSchema>;

/** Local reviewed intent; admission and acquired resource identity stay with their real owners. */
const ManagedMachineReviewedSelectionDraftSchema = z.strictObject({
    selection: ManagedCreationSelectionV1Schema,
    receipt: ManagedConfigurationFactsV1Schema,
    enrollmentIdentity: z.optional(ManagedMachineEnrollmentIdentityV1Schema),
    /** Exact selected Preset's same-DEK private acquire delta; never decoded by Home. */
    presetContentOverride: z.optional(ManagedMachinePresetLaunchNameOverrideV1Schema),
    /** Captured structural route for a fresh selected Preset; never Action input. */
    presetOrigin: z.optional(ManagedMachinePresetAcquireOriginDraftSchema),
    archiveEffect: z.enum(['keep', 'stop', 'delete']),
});

/**
 * A freshly authored Team Preset has no reviewed facts: those are admitted and
 * opened by its Account host. Keep only the exact opaque delta plus the public
 * structural route selected by the person; it is deliberately not a weakened
 * reviewed-draft shape.
 */
const ManagedMachineDeferredAuthorPresetOriginDraftSchema = ManagedMachinePresetAcquireOriginDraftSchema;

export const ManagedMachineDeferredAuthorPresetDraftSchema = z.strictObject({
    deferredAuthorPreset: z.literal(true),
    selection: ManagedPresetSelectionV1Schema,
    presetContentOverride: ManagedMachinePresetLaunchNameOverrideV1Schema,
    presetOrigin: ManagedMachineDeferredAuthorPresetOriginDraftSchema,
    archiveEffect: z.literal('keep'),
}).check(z.refine(value => value.selection.id === value.presetOrigin.id
    && value.selection.homeId === value.presetOrigin.homeId
    && value.selection.revision === value.presetOrigin.revision));

export const ManagedMachineSelectionDraftSchema = z.union([
    ManagedMachineReviewedSelectionDraftSchema,
    ManagedMachineDeferredAuthorPresetDraftSchema,
]);

export const ManagedMachineSelectionDraftReadSchema = createStoredReadSchema(ManagedMachineSelectionDraftSchema);
export type ManagedMachineSelectionDraft = z.infer<typeof ManagedMachineSelectionDraftSchema>;
export type ManagedMachineDeferredAuthorPresetDraft = z.infer<typeof ManagedMachineDeferredAuthorPresetDraftSchema>;

export function isDeferredManagedMachineAuthorPresetDraft(
    draft: ManagedMachineSelectionDraft | ManagedMachineCreationIntent,
): draft is ManagedMachineDeferredAuthorPresetDraft {
    return 'deferredAuthorPreset' in draft && draft.deferredAuthorPreset === true;
}

/** Deferred author Presets deliberately have no pre-admission reviewed facts. */
export function readManagedMachineSelectionReceipt(
    draft: ManagedMachineSelectionDraft | null | undefined,
): ManagedConfigurationFactsV1 | null {
    return draft && !isDeferredManagedMachineAuthorPresetDraft(draft) ? draft.receipt : null;
}

export type ManagedMachineCreationIntent =
    | Readonly<Pick<z.infer<typeof ManagedMachineReviewedSelectionDraftSchema>,
        'selection' | 'receipt' | 'enrollmentIdentity' | 'presetContentOverride' | 'presetOrigin'>>
    | Readonly<Pick<ManagedMachineDeferredAuthorPresetDraft,
        'deferredAuthorPreset' | 'selection' | 'presetContentOverride' | 'presetOrigin'>>;

/** Display intent stays local; sealed acquire choices remain opaque on the Action wire. */
export function readManagedMachineSelectionName(draft: ManagedMachineSelectionDraft | null | undefined): string | undefined {
    return draft ? isDeferredManagedMachineAuthorPresetDraft(draft) ? draft.presetOrigin.name : draft.receipt.launch.name : undefined;
}

/** Archive continuation is a local post-start choice, not part of paid acquire intent. */
export function managedMachineCreationIntent(
    draft: ManagedMachineSelectionDraft | null | undefined,
): ManagedMachineCreationIntent | null {
    if (!draft) return null;
    if (isDeferredManagedMachineAuthorPresetDraft(draft)) {
        return { deferredAuthorPreset: true, selection: draft.selection,
            presetContentOverride: draft.presetContentOverride, presetOrigin: draft.presetOrigin };
    }
    return { selection: draft.selection, receipt: draft.receipt,
        ...(draft.enrollmentIdentity ? { enrollmentIdentity: draft.enrollmentIdentity } : {}),
        ...(draft.presetContentOverride ? { presetContentOverride: draft.presetContentOverride } : {}),
        ...(draft.presetOrigin ? { presetOrigin: draft.presetOrigin } : {}) };
}

/** The ordinary draft retains only replay identity and the canonical managed reference. */
export const ManagedMachineAcquisitionDraftSchema = z.strictObject({
    requestId: z.string().check(z.trim(), z.minLength(1)),
    selection: ManagedCreationSelectionV1Schema,
    managedId: z.optional(z.string().check(z.trim(), z.minLength(1))),
    operation: z.optional(ActionOperationGetV1RequestSchema),
}).check(z.refine(value => value.operation === undefined || value.managedId !== undefined));
export const ManagedMachineAcquisitionDraftReadSchema = createStoredReadSchema(ManagedMachineAcquisitionDraftSchema);
export type ManagedMachineAcquisitionDraft = z.infer<typeof ManagedMachineAcquisitionDraftSchema>;

export function createManagedMachineSelectionDraft(input: Readonly<{
    selection: ManagedCreationSelectionV1;
    receipt: ManagedConfigurationFactsV1;
    enrollmentIdentity?: ManagedMachineEnrollmentIdentityV1;
    presetContentOverride?: ManagedMachinePresetLaunchNameOverrideV1;
    presetOrigin?: ManagedMachinePresetAcquireOriginDraft;
    archiveEffect?: z.infer<typeof ManagedMachineReviewedSelectionDraftSchema>['archiveEffect'];
}>): z.infer<typeof ManagedMachineReviewedSelectionDraftSchema>;
export function createManagedMachineSelectionDraft(input: Readonly<{
    deferredAuthorPreset: true;
    selection: ManagedMachineDeferredAuthorPresetDraft['selection'];
    presetContentOverride: ManagedMachineDeferredAuthorPresetDraft['presetContentOverride'];
    presetOrigin: ManagedMachineDeferredAuthorPresetDraft['presetOrigin'];
}>): ManagedMachineDeferredAuthorPresetDraft;
export function createManagedMachineSelectionDraft(input: Readonly<{
    selection: ManagedCreationSelectionV1;
    receipt?: ManagedConfigurationFactsV1;
    enrollmentIdentity?: ManagedMachineEnrollmentIdentityV1;
    presetContentOverride?: ManagedMachinePresetLaunchNameOverrideV1;
    presetOrigin?: ManagedMachinePresetAcquireOriginDraft;
    archiveEffect?: z.infer<typeof ManagedMachineReviewedSelectionDraftSchema>['archiveEffect'];
    deferredAuthorPreset?: true;
}>): ManagedMachineSelectionDraft {
    if (input.deferredAuthorPreset === true) {
        return ManagedMachineDeferredAuthorPresetDraftSchema.parse({
            deferredAuthorPreset: true,
            selection: input.selection,
            presetContentOverride: input.presetContentOverride,
            presetOrigin: input.presetOrigin,
            archiveEffect: 'keep',
        });
    }
    return ManagedMachineReviewedSelectionDraftSchema.parse({
        selection: input.selection,
        receipt: input.receipt,
        ...(input.enrollmentIdentity ? { enrollmentIdentity: input.enrollmentIdentity } : {}),
        ...(input.presetContentOverride ? { presetContentOverride: input.presetContentOverride } : {}),
        ...(input.presetOrigin ? { presetOrigin: input.presetOrigin } : {}),
        archiveEffect: input.archiveEffect ?? 'keep',
    });
}
