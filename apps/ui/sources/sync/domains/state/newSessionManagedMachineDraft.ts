import * as z from 'zod/mini';

import {
    ManagedConfigurationFactsV1Schema,
    ManagedCreationSelectionV1Schema,
    type ManagedConfigurationFactsV1,
    type ManagedCreationSelectionV1,
} from '@happier-dev/protocol/machines/managed/managedConfigurationV1';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { ActionOperationGetV1RequestSchema } from '@happier-dev/protocol/actions/operations/v1';

/** Local reviewed intent; admission and acquired resource identity stay with their real owners. */
export const ManagedMachineSelectionDraftSchema = z.strictObject({
    selection: ManagedCreationSelectionV1Schema,
    receipt: ManagedConfigurationFactsV1Schema,
    archiveEffect: z.enum(['keep', 'stop', 'delete']),
});

export const ManagedMachineSelectionDraftReadSchema = createStoredReadSchema(ManagedMachineSelectionDraftSchema);
export type ManagedMachineSelectionDraft = z.infer<typeof ManagedMachineSelectionDraftSchema>;

/** Archive continuation is a local post-start choice, not part of paid acquire intent. */
export function managedMachineCreationIntent(
    draft: ManagedMachineSelectionDraft | null | undefined,
): Readonly<Pick<ManagedMachineSelectionDraft, 'selection' | 'receipt'>> | null {
    return draft ? { selection: draft.selection, receipt: draft.receipt } : null;
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
    archiveEffect?: ManagedMachineSelectionDraft['archiveEffect'];
}>): ManagedMachineSelectionDraft {
    return ManagedMachineSelectionDraftSchema.parse({
        selection: input.selection,
        receipt: input.receipt,
        archiveEffect: input.archiveEffect ?? 'keep',
    });
}
