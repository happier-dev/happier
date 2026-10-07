import { TemporaryComputerActivationRefV1Schema } from '@happier-dev/protocol/sessions/authoring/fieldCatalog';
import type { SessionDraftDocumentV2 } from '@happier-dev/protocol/drafts/sessionDraftsV2';

import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import {
    createRunnerActivationKeyCustody,
    removeRunnerActivationKeyCustodyByActivationId,
    type RunnerActivationKeyCustody,
} from './runnerActivationKeyCustody';
import {
    forgetRunnerCreatorCustodyActivation,
    listRunnerCreatorCustodyActivationIds,
    listRunnerCreatorCustodyActivationIdsForDraft,
    removeRunnerCreatorLaunchCustody,
} from './runnerCreatorLaunchCustody';

/** Clears one exact activation only after both sensitive custody owners agree. */
export async function removeRunnerCreatorCustodyForActivation(
    scope: ServerAccountScope,
    activationId: string,
): Promise<void> {
    // File-backed attachment custody must disappear before its only locator.
    // Keeping the activation key and scope locator until then makes failure
    // observable and retryable without a background cleanup mechanism.
    await removeRunnerCreatorLaunchCustody(scope, activationId);
    await removeRunnerActivationKeyCustodyByActivationId(scope, activationId);
    await forgetRunnerCreatorCustodyActivation(scope, activationId);
}

/** Account-erasure cleanup for the exact Home/Account scope, never ordinary sign-out. */
export async function removeRunnerCreatorCustodyForAccount(scope: ServerAccountScope): Promise<void> {
    const activationIds = await listRunnerCreatorCustodyActivationIds(scope);
    for (const activationId of activationIds) {
        await removeRunnerCreatorCustodyForActivation(scope, activationId);
    }
}

/**
 * Recovers only failed pre-activation preparation owned by one exact draft.
 * The incumbent scope index is the durable association; successful server
 * activations are reconciled before this is called by the launch owner.
 */
export async function removeRunnerCreatorCustodyForDraft(
    scope: ServerAccountScope,
    draftId: string,
): Promise<void> {
    const activationIds = await listRunnerCreatorCustodyActivationIdsForDraft(scope, draftId);
    for (const activationId of activationIds) {
        await removeRunnerCreatorCustodyForActivation(scope, activationId);
    }
    if ((await listRunnerCreatorCustodyActivationIdsForDraft(scope, draftId)).length !== 0) {
        throw new Error('runner_creator_draft_custody_cleanup_incomplete');
    }
}

/** Recovery and replacement are one owner-level operation so allocation cannot overtake cleanup. */
export async function recoverAndCreateRunnerActivationKeyCustodyForDraft(
    scope: ServerAccountScope,
    draftId: string,
): Promise<RunnerActivationKeyCustody> {
    await removeRunnerCreatorCustodyForDraft(scope, draftId);
    return await createRunnerActivationKeyCustody(scope, draftId);
}

/**
 * Removes only creator-device custody after the canonical draft owner has
 * acknowledged removal. Server activation closure remains owned by the draft
 * tombstone transaction; this function never sends a second cancel request.
 */
export async function removeRunnerCreatorCustodyForRemovedDraft(input: Readonly<{
    scope: ServerAccountScope;
    document: SessionDraftDocumentV2;
}>): Promise<void> {
    // Only the current catalogued document can carry the activation reference;
    // the released V1 vocabulary has no such field to remove custody for.
    const document = input.document;
    if (document.v !== 2 || document.target.kind !== 'newSession') return;
    const parsed = TemporaryComputerActivationRefV1Schema.safeParse(
        document.target.authoring.temporaryComputerActivationRef?.value,
    );
    if (!parsed.success) return;
    await removeRunnerCreatorCustodyForActivation(input.scope, parsed.data.activationId);
}
