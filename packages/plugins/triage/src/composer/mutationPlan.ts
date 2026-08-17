import {
    MAX_COMPOSER_ATTACHMENT_DESCRIPTION_CODE_POINTS_V1,
    MAX_COMPOSER_ATTACHMENT_LABEL_CODE_POINTS_V1,
} from '@happier-dev/plugin-sdk/ui';
import type {
    ComposerAttachmentAuthorPresentationV1,
    ComposerSnapshotV1,
    ComposerTransactionV1,
} from '@happier-dev/plugin-sdk/ui';
import type { TriageEntryRefV1, TriageSourceInstanceRefV1 } from '@happier-dev/triage-protocol/v1';

import { findTriageAttachedEntry, selectTriageAttachedEntries } from './attachedEntries.js';
import {
    TRIAGE_ENTRY_ATTACHMENT_LOCAL_ID_V1,
    deriveTriageComposerEntryAttachmentKey,
    parseTriageComposerEntryAttachmentValue,
} from './attachmentValue.js';

/**
 * The exact content of one Triage attach or remove (`core/COMPOSER.md` §3).
 *
 * This module owns what the mutation *is*; the caller owns the canonical
 * `get` → `read` → `apply(expectedRevision)` round trip and its single conflict
 * replay. Splitting it there keeps one owner for the operation content while
 * every attach and every remove — from the picker or from a host-rendered badge
 * — plans through the same revision-checked, textless transaction.
 */

export type TriageEntryAttachmentPlanV1 =
    /** Apply this transaction verbatim; its `expectedRevision` is the read revision. */
    | Readonly<{ status: 'transaction'; transaction: ComposerTransactionV1 }>
    /** The draft already holds the desired state; applying anything would undo it. */
    | Readonly<{ status: 'alreadySettled'; reason: 'notAttached' }>
    | Readonly<{ status: 'refused'; reason: 'attachmentsUnsupported' | 'invalidValue' }>;

/**
 * Shorten one display string to a code-point ceiling without splitting a
 * surrogate pair or leaving the surrounding whitespace the schema rejects.
 */
function boundDisplayText(value: string, maxCodePoints: number): string {
    const trimmed = value.trim();
    const codePoints = Array.from(trimmed);
    if (codePoints.length <= maxCodePoints) return trimmed;
    const kept = codePoints.slice(0, maxCodePoints - 1).join('').trimEnd();
    return `${kept}…`;
}

/**
 * The bounded immutable fallback one entry contributes to a draft.
 *
 * A source title is bounded at 4 KiB while a composer attachment label is
 * bounded at 256 code points, so passing a provider title straight through
 * makes the host reject the whole attach. Shortening a *display fallback* is
 * admissible precisely because it is presentation: identity travels in the
 * value, and fresh context is resolved at dispatch.
 */
export function buildTriageEntryAttachmentPresentation(input: Readonly<{
    title: string;
    scopeLabel: string;
}>): ComposerAttachmentAuthorPresentationV1 {
    return {
        label: boundDisplayText(input.title, MAX_COMPOSER_ATTACHMENT_LABEL_CODE_POINTS_V1),
        description: boundDisplayText(input.scopeLabel, MAX_COMPOSER_ATTACHMENT_DESCRIPTION_CODE_POINTS_V1),
    };
}

/**
 * A removal carries no connection and no presentation, because it addresses the
 * record already in the draft by its host-minted instance id. Modelling that as
 * a union rather than as ignored parameters removes the invalid state where a
 * caller supplies a connection that could never observe the entry it is
 * removing — and lets a removal succeed for an entry no configured connection
 * observes any more.
 */
export type TriageEntryAttachmentMutationV1 = Readonly<{
    /** The snapshot from the read that precedes this apply, never a remembered one. */
    snapshot: ComposerSnapshotV1;
    entryRef: TriageEntryRefV1;
}> & (
    | Readonly<{
        intent: 'attach';
        sourceInstance: TriageSourceInstanceRefV1;
        /** The bounded immutable fallback the host freezes; never fresh dispatch context. */
        presentation: ComposerAttachmentAuthorPresentationV1;
    }>
    | Readonly<{ intent: 'remove' }>
);

export function planTriageEntryAttachmentMutation(
    input: TriageEntryAttachmentMutationV1,
): TriageEntryAttachmentPlanV1 {
    const { snapshot, entryRef } = input;
    const attached = selectTriageAttachedEntries(snapshot.attachments);

    if (input.intent === 'remove') {
        // Matched through the canonical key rather than the parsed value, so a
        // record written by an older declaration is still removable. An entry
        // that is already gone is the desired state: re-adding it here would
        // resurrect what a host badge removal just committed.
        const existing = findTriageAttachedEntry(attached, entryRef);
        if (!existing) return { status: 'alreadySettled', reason: 'notAttached' };
        return {
            status: 'transaction',
            transaction: {
                expectedRevision: snapshot.revision,
                operations: [{ kind: 'attachment.remove', instanceId: existing.instanceId }],
            },
        };
    }

    // The scope's declared capability, not a guess about editability: a composer
    // that admits no attachment can never take this operation, so the picker
    // refuses instead of offering an action that always fails.
    if (!snapshot.capabilities.attachments) {
        return { status: 'refused', reason: 'attachmentsUnsupported' };
    }

    // The value is validated by its one parser before it can be persisted, so a
    // mismatched source/instance pair is refused rather than silently attaching
    // an entry under a connection that could never observe it.
    const value = { v: 1 as const, entryRef, sourceInstance: input.sourceInstance };
    if (parseTriageComposerEntryAttachmentValue(value).status !== 'valid') {
        return { status: 'refused', reason: 'invalidValue' };
    }

    // A repeated attach carries the same canonical key, so the qualified
    // identity plus key dedupe updates the existing record in place instead of
    // adding a second selection of one entry.
    return {
        status: 'transaction',
        transaction: {
            expectedRevision: snapshot.revision,
            operations: [{
                kind: 'attachment.add',
                attachmentLocalId: TRIAGE_ENTRY_ATTACHMENT_LOCAL_ID_V1,
                value: {
                    key: deriveTriageComposerEntryAttachmentKey(entryRef),
                    value,
                    presentation: input.presentation,
                },
            }],
        },
    };
}
