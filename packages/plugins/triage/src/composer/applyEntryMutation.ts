import type { ComposerAttachmentAuthorPresentationV1 } from '@happier-dev/plugin-sdk/ui';
import type { ComposerHandle, ComposerRequestOptions, PluginTranslate } from '@happier-dev/plugin-ui';
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
 * A known revision conflict is returned without another read or apply. The
 * caller can show the changed draft and let the user choose a fresh mutation.
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
    | Readonly<{ kind: 'refused'; refusal: TriageMutationRefusalV1 }>;

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

/**
 * Why a Triage attach or remove was refused, as a code plus the one fact its
 * sentence needs. The outcome never carries prose: the reader's sentence is
 * `describeTriageMutationRefusal`, so every refusal is translated by the same
 * catalog and no raw host code, body or path can reach the screen.
 */
export type TriageMutationRefusalV1 =
    | Readonly<{ code: 'attachmentLimit'; maximum: number }>
    | Readonly<{ code: Exclude<TriageMutationRefusalCode, 'attachmentLimit'> }>;

const REFUSAL_COPY = {
    attachmentLimit: {
        key: 'plugins.triage.picker.refusal.attachmentLimit',
        fallback: 'Attachment limit reached ({maximum}). Remove one first.',
    },
    attachmentsUnsupported: {
        key: 'plugins.triage.picker.refusal.attachmentsUnsupported',
        fallback: 'This message can’t carry attachments.',
    },
    invalidValue: {
        key: 'plugins.triage.picker.refusal.invalidValue',
        fallback: 'Can’t be attached as it is. Refresh the list and retry.',
    },
    notAcceptedHere: {
        key: 'plugins.triage.picker.refusal.notAcceptedHere',
        fallback: 'This message isn’t accepting PRs & Issues now. Reopen the picker.',
    },
    referencesUnsupported: {
        key: 'plugins.triage.picker.refusal.referencesUnsupported',
        fallback: 'This message can’t carry references.',
    },
    invalidCandidate: {
        key: 'plugins.triage.picker.refusal.invalidCandidate',
        fallback: 'This evidence reference can’t be inserted.',
    },
    composerUnavailable: {
        key: 'plugins.triage.picker.refusal.composerUnavailable',
        fallback: 'The message box was closed. Reopen it and try again.',
    },
    notEditable: {
        key: 'plugins.triage.picker.refusal.notEditable',
        fallback: 'The message can’t be edited right now.',
    },
    conflict: {
        key: 'plugins.triage.picker.refusal.conflict',
        fallback: 'The draft changed meanwhile. Try again.',
    },
    // Deliberately not 'nothing changed': a rejected `apply` may have landed
    // before the answer was lost. The picker re-reads the draft after every
    // outcome, so the canonical snapshot -- not this sentence -- settles what
    // the row actually holds.
    unreachable: {
        key: 'plugins.triage.picker.refusal.unreachable',
        fallback: 'Couldn’t reach the message box. Try again.',
    },
    evidenceNotPrepared: {
        key: 'plugins.triage.picker.refusal.evidenceNotPrepared',
        fallback: 'Couldn’t prepare the evidence reference. Try again.',
    },
    changeRejected: {
        key: 'plugins.triage.picker.refusal.changeRejected',
        fallback: 'Couldn’t change the attachment. Try again.',
    },
} as const satisfies Readonly<Record<string, Readonly<{ key: string; fallback: string }>>>;

type TriageMutationRefusalCode = keyof typeof REFUSAL_COPY;

export function describeTriageMutationRefusal(text: PluginTranslate, refusal: TriageMutationRefusalV1): string {
    const copy = REFUSAL_COPY[refusal.code];
    return refusal.code === 'attachmentLimit'
        ? text(copy.key, copy.fallback, { maximum: refusal.maximum })
        : text(copy.key, copy.fallback);
}

/**
 * The host applier answers a rejected attachment with an open vocabulary of
 * `invalidOperation` reasons. Only the ones a reader can act on get their own
 * sentence; anything the host adds later reads as a plain failed change rather
 * than leaking its code.
 */
function refusalForInvalidOperation(reason: string): TriageMutationRefusalV1 {
    switch (reason) {
        case 'attachments_unsupported': return { code: 'attachmentsUnsupported' };
        case 'attachment_authority_mismatch': return { code: 'notAcceptedHere' };
        case 'attachment_value_invalid': return { code: 'invalidValue' };
        default: return { code: 'changeRejected' };
    }
}

function refused(code: Exclude<TriageMutationRefusalCode, 'attachmentLimit'>): TriageEntryMutationOutcomeV1 {
    return { kind: 'refused', refusal: { code } };
}

type TriageRevisionCheckedPlanV1 =
    | Readonly<{ status: 'transaction'; transaction: import('@happier-dev/plugin-sdk/ui').ComposerTransactionV1 }>
    | Readonly<{ status: 'alreadySettled'; reason: string }>
    | Readonly<{ status: 'refused'; reason: 'attachmentsUnsupported' | 'invalidValue' | 'referencesUnsupported' | 'invalidCandidate' }>;

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
        if (read.status !== 'ready') return refused('composerUnavailable');

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
            case 'invalidOperation':
                return { kind: 'refused', refusal: refusalForInvalidOperation(applied.reason) };
            case 'limitExceeded':
                return {
                    kind: 'refused',
                    refusal: applied.limit === 'composerAttachments'
                        ? { code: 'attachmentLimit', maximum: applied.maximum }
                        : { code: 'changeRejected' },
                };
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
    return outcome.kind === 'inert' ? refused('composerUnavailable') : outcome;
}

export async function applyTriageEntryMutation(
    request: TriageEntryMutationRequestV1,
): Promise<TriageEntryMutationOutcomeV1> {
    try {
        const outcome = await attempt(request);
        return outcome.kind === 'conflict' ? refused('conflict') : outcome;
    } catch (error) {
        // A CANCELLED call is not a refusal and must not be settled as one.
        // `hostCancellation.ts` owns that distinction and states why: the
        // caller stopped asking and learned nothing, so reporting "the composer
        // could not be reached" invents an answer nobody received — and hides
        // it behind the exact sentence a real transport failure produces. The
        // two sibling consumers already route through this helper.
        if (isHostCancellation(error, request.options?.signal)) throw error;
        return refused('unreachable');
    }
}
