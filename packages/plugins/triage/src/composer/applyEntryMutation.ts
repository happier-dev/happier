import type { ComposerAttachmentAuthorPresentationV1 } from '@happier-dev/plugin-sdk/ui';
import type { ComposerHandle, ComposerRequestOptions } from '@happier-dev/plugin-ui';
import type {
    TriageEntryLocatorV1,
    TriageEntryRefV1,
    TriageSourceInstanceRefV1,
} from '@happier-dev/triage-protocol/v1';

import { isHostCancellation } from '../hostCancellation.js';
import { planTriageEntryAttachmentMutation } from './mutationPlan.js';

/**
 * The canonical `read` → plan → revision-checked `apply` round trip for one
 * Triage attach or remove (`core/COMPOSER.md` §3).
 *
 * The plan owns what the mutation *is*; this owns the trip it takes. Both the
 * picker row controls and any later host-rendered badge removal go through
 * here, so there is exactly one place that decides how a revision conflict is
 * handled.
 *
 * A conflict is replayed exactly once, and the replay re-reads and **re-plans**
 * rather than resubmitting the same operation with a newer revision. That
 * distinction is the whole point: between the two reads the draft may already
 * have gained or lost this entry, and blindly re-applying would resurrect an
 * attachment the user just removed. A second conflict is reported rather than
 * looped, because a draft changing under two rapid writers is a fact the user
 * should see, not one to retry against forever.
 *
 * The returned outcome is TOTAL: every trip that starts here ends in one of
 * these three answers. `read` and `apply` are host calls that reject rather
 * than answer when the mounted scope's method is not currently negotiated — a
 * daemon reconnect is enough — and a rejection that escapes this function never
 * reaches the caller's outcome branch at all. The control it was invoked from
 * then stays pending forever, with no error and no way back to idle, which is
 * the one failure this round trip must never produce.
 */

export type TriageEntryMutationOutcomeV1 =
    | Readonly<{ kind: 'applied' }>
    /** The draft already holds the desired state; nothing needed to change. */
    | Readonly<{ kind: 'settled' }>
    | Readonly<{ kind: 'refused'; reason: string }>;

export type TriageEntryMutationRequestV1 = Readonly<{
    handle: ComposerHandle;
    entryRef: TriageEntryRefV1;
    options?: ComposerRequestOptions;
}> & (
    | Readonly<{
        intent: 'attach';
        sourceInstance: TriageSourceInstanceRefV1;
        presentation: ComposerAttachmentAuthorPresentationV1;
        /** The observed routing hint, carried through to the planned value. */
        lastKnownLocator?: TriageEntryLocatorV1;
    }>
    | Readonly<{ intent: 'remove' }>
);

const REFUSAL_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
    attachmentsUnsupported: 'This composer cannot carry attachments.',
    invalidValue: 'This entry cannot be attached under that connection.',
    referencesUnsupported: 'This composer cannot carry references.',
    invalidCandidate: 'This evidence reference cannot be inserted.',
    composerUnavailable: 'The composer is no longer open.',
    notEditable: 'The composer cannot be edited right now.',
    conflict: 'The draft changed while this was applied. Try again.',
    unavailable: 'The composer is no longer open.',
    // Deliberately not 'nothing changed': a rejected `apply` may have landed
    // before the answer was lost. The picker re-reads the draft after every
    // outcome, so the canonical snapshot -- not this sentence -- settles what
    // the row actually holds.
    unreachable: 'The composer could not be reached. Try again.',
});

function refused(reason: string): TriageEntryMutationOutcomeV1 {
    return { kind: 'refused', reason: REFUSAL_MESSAGES[reason] ?? 'The change could not be applied.' };
}

type TriageRevisionCheckedPlanV1 =
    | Readonly<{ status: 'transaction'; transaction: import('@happier-dev/plugin-sdk/ui').ComposerTransactionV1 }>
    | Readonly<{ status: 'alreadySettled'; reason: string }>
    | Readonly<{ status: 'refused'; reason: string }>;

export type TriageRevisionCheckedMutationOutcomeV1 =
    | TriageEntryMutationOutcomeV1
    | Readonly<{ kind: 'conflict' }>
    | Readonly<{ kind: 'inert' }>;

/**
 * The one Triage-owned Composer mutation trip.
 *
 * Attachment changes and selected-evidence references differ only in their
 * planner and conflict policy; both read the exact bound handle, plan from that
 * snapshot, and apply against its revision here. `isCurrent` is checked after
 * every awaited boundary and immediately before apply, making a late source
 * result/read inert without inventing another Composer owner.
 */
export async function applyTriageRevisionCheckedMutation(input: Readonly<{
    handle: ComposerHandle;
    plan: (snapshot: import('@happier-dev/plugin-sdk/ui').ComposerSnapshotV1) => TriageRevisionCheckedPlanV1;
    options?: ComposerRequestOptions;
    isCurrent?: () => boolean;
}>): Promise<TriageRevisionCheckedMutationOutcomeV1> {
    const isCurrent = input.isCurrent ?? (() => true);
    try {
        const read = await input.handle.read(input.options);
        if (!isCurrent()) return { kind: 'inert' };
        if (read.status !== 'ready') return refused('unavailable');

        const plan = input.plan(read.snapshot);
        if (plan.status === 'alreadySettled') return { kind: 'settled' };
        if (plan.status === 'refused') return refused(plan.reason);
        if (!isCurrent()) return { kind: 'inert' };

        const applied = await input.handle.apply(plan.transaction, input.options);
        if (!isCurrent()) return { kind: 'inert' };
        switch (applied.status) {
            case 'applied':
                return { kind: 'applied' };
            case 'conflict':
                return { kind: 'conflict' };
            case 'composerUnavailable':
            case 'notEditable':
                return refused(applied.status);
            default:
                return { kind: 'refused', reason: 'The change could not be applied.' };
        }
    } catch (error) {
        if (!isCurrent()) return { kind: 'inert' };
        if (isHostCancellation(error, input.options?.signal)) throw error;
        return refused('unreachable');
    }
}

async function attempt(
    request: TriageEntryMutationRequestV1,
): Promise<TriageEntryMutationOutcomeV1 | Readonly<{ kind: 'conflict' }>> {
    const outcome = await applyTriageRevisionCheckedMutation({
        handle: request.handle,
        ...(request.options === undefined ? {} : { options: request.options }),
        plan: (snapshot) => planTriageEntryAttachmentMutation(request.intent === 'remove'
            ? { intent: 'remove', snapshot, entryRef: request.entryRef }
            : {
                intent: 'attach',
                snapshot,
                entryRef: request.entryRef,
                sourceInstance: request.sourceInstance,
                presentation: request.presentation,
                ...(request.lastKnownLocator === undefined
                    ? {}
                    : { lastKnownLocator: request.lastKnownLocator }),
            }),
    });
    // Attachment callers have no lifecycle currentness predicate, so `inert`
    // is unreachable here. Keep the public attachment outcome unchanged.
    return outcome.kind === 'inert' ? refused('unavailable') : outcome;
}

export async function applyTriageEntryMutation(
    request: TriageEntryMutationRequestV1,
): Promise<TriageEntryMutationOutcomeV1> {
    try {
        const first = await attempt(request);
        if (first.kind !== 'conflict') return first;
        const replay = await attempt(request);
        return replay.kind === 'conflict' ? refused('conflict') : replay;
    } catch (error) {
        // A CANCELLED call is not a refusal and must not be settled as one.
        // `hostCancellation.ts` owns that distinction and states why: the
        // caller stopped asking and learned nothing, so reporting "the composer
        // could not be reached" invents an answer nobody received — and hides
        // it behind the exact sentence a real transport failure produces. The
        // two sibling consumers already route through this helper.
        if (isHostCancellation(error, request.options?.signal)) throw error;
        // Both attempts are covered: the replay reaches the same boundary a
        // second time, and its rejection has to settle through the same answer
        // rather than escaping the outcome the first attempt already committed
        // this call to producing.
        return refused('unreachable');
    }
}
