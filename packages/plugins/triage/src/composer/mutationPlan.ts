import {
    MAX_COMPOSER_ATTACHMENT_DESCRIPTION_CODE_POINTS_V1,
    MAX_COMPOSER_ATTACHMENT_LABEL_CODE_POINTS_V1,
} from '@happier-dev/plugin-sdk/ui';
import type {
    ComposerAttachmentAuthorPresentationV1,
    PluginUiContributionIdentityV1,
    ComposerSnapshotV1,
    ComposerTransactionV1,
} from '@happier-dev/plugin-sdk/ui';
import type { TriageEvidenceCandidateV1 } from '@happier-dev/triage-sources/ui';
import type {
    TriageEntryLocatorV1,
    TriageEntryRefV1,
    TriageSourceInstanceRefV1,
} from '@happier-dev/triage-protocol/v1';

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
 * The disclosure-approved candidate shape is declared once, by the shared
 * source bridge both halves of this seam consume
 * (`@happier-dev/triage-sources/ui`): a source discloses it and this planner
 * turns it into the one transaction. A Triage-local copy would be a second
 * declaration of one wire between two packages that already share it.
 */
export type { TriageEvidenceCandidateV1 } from '@happier-dev/triage-sources/ui';

export type TriageTierBEvidenceInsertionPlanV1 =
    | Readonly<{ status: 'transaction'; transaction: ComposerTransactionV1 }>
    | Readonly<{ status: 'alreadySettled'; reason: 'referencePresent' }>
    | Readonly<{ status: 'refused'; reason: 'referencesUnsupported' | 'invalidCandidate' }>;

function buildComposerReferenceRef(candidateId: string): string | null {
    try {
        // `encodeURIComponent` gives the incumbent mention grammar a lossless
        // opaque component without interpreting provider identity. The host's
        // Composer schema remains the final bound and grammar authority.
        return `composerReference:${encodeURIComponent(candidateId)}`;
    } catch {
        return null;
    }
}

function sameContributionIdentity(
    left: PluginUiContributionIdentityV1 | undefined,
    right: PluginUiContributionIdentityV1,
): boolean {
    return left?.pluginId === right.pluginId && left.localId === right.localId;
}

/**
 * Plans the one atomic Tier-B text/reference insertion against a fresh
 * Composer snapshot.
 *
 * The current selection is the only placement fact. A non-empty selection is
 * replaced; a cursor inserts; an absent selection appends. When the exact token
 * is already present at that range and no other reference occupies it, only the
 * missing reference is inserted. Otherwise the text operation and
 * `reference.insert` remain one revision-checked transaction, so no candidate-
 * shaped intermediate draft state exists.
 */
export function planTriageTierBEvidenceInsertion(
    snapshot: ComposerSnapshotV1,
    disclosed: TriageEvidenceCandidateV1,
): TriageTierBEvidenceInsertionPlanV1 {
    if (!snapshot.capabilities.references) {
        return { status: 'refused', reason: 'referencesUnsupported' };
    }

    const ref = buildComposerReferenceRef(disclosed.candidate.id);
    if (ref === null) return { status: 'refused', reason: 'invalidCandidate' };

    const token = disclosed.candidate.label;
    const range = snapshot.selection ?? { start: snapshot.text.length, end: snapshot.text.length };
    const exact = snapshot.references.find((reference) => (
        reference.kind === 'happier.composerReference'
        && reference.ref === ref
        && reference.token === token
        && reference.start === range.start
        && reference.end === range.end
        && sameContributionIdentity(reference.composerReference, disclosed.reference)
    ));
    if (exact !== undefined) return { status: 'alreadySettled', reason: 'referencePresent' };

    const overlapsReference = snapshot.references.some((reference) => (
        reference.start < range.end && reference.end > range.start
    ));
    const tokenAlreadyAtRange = snapshot.text.slice(range.start, range.end) === token;
    const reference = {
        kind: 'happier.composerReference',
        ref,
        token,
        start: range.start,
        end: range.start + token.length,
        ...(token.trim().length === 0 ? {} : { label: token }),
        composerReference: disclosed.reference,
    } as const;

    const textOperation = tokenAlreadyAtRange && !overlapsReference
        ? []
        : range.start === range.end
            ? [{ kind: 'text.insert' as const, position: { offset: range.start }, text: token }]
            : [{ kind: 'text.replaceRange' as const, range, text: token }];

    return {
        status: 'transaction',
        transaction: {
            expectedRevision: snapshot.revision,
            operations: [
                ...textOperation,
                { kind: 'reference.insert', reference },
            ],
        },
    };
}

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
        /**
         * The locator the observation this row was built from carried, when one
         * was observed. It is stored beside identity as the routing hint the
         * dispatch read needs to reach an account-wide connection's entry, and
         * it is absent — never an empty locator — when nothing observed one.
         */
        lastKnownLocator?: TriageEntryLocatorV1;
    }>
    | Readonly<{ intent: 'remove' }>
);

/**
 * The one author-shaped `entry` attachment draft, built in exactly one place.
 *
 * A Composer transaction and a structured Session input carry the SAME author
 * half — `{ attachmentLocalId, value: { key, value, presentation } }` — because
 * the host qualifies identity, mints the instance and stamps the type label on
 * both routes (`packages/protocol/src/sessions/messages/sessionInputAdmission.ts`).
 * A direct-send action therefore attaches the entry through this builder rather
 * than through a second spelling of it, which is what keeps one entry attached
 * one way whether the reader composed it or the action sent it.
 *
 * `null` means the value's own parser refused it — a mismatched source/instance
 * pair — and is deliberately not an attachment with the mismatch dropped.
 */
export type TriageEntryAttachmentDraftV1 = Extract<
    ComposerTransactionV1['operations'][number],
    Readonly<{ kind: 'attachment.add' }>
> extends infer TAdd
    ? TAdd extends Readonly<{ kind: string }>
        ? Omit<TAdd, 'kind' | 'content'>
        : never
    : never;

export function buildTriageEntryAttachmentDraftV1(input: Readonly<{
    entryRef: TriageEntryRefV1;
    sourceInstance: TriageSourceInstanceRefV1;
    presentation: ComposerAttachmentAuthorPresentationV1;
    lastKnownLocator?: TriageEntryLocatorV1;
}>): TriageEntryAttachmentDraftV1 | null {
    // The value is validated by its one parser before it can be persisted, so a
    // mismatched source/instance pair is refused rather than silently attaching
    // an entry under a connection that could never observe it. An absent hint
    // stays absent: writing an empty locator would hand the source something to
    // interpret in place of the nothing it actually has.
    const value = {
        v: 1 as const,
        entryRef: input.entryRef,
        sourceInstance: input.sourceInstance,
        ...(input.lastKnownLocator === undefined ? {} : { lastKnownLocator: input.lastKnownLocator }),
    };
    if (parseTriageComposerEntryAttachmentValue(value).status !== 'valid') return null;
    return {
        attachmentLocalId: TRIAGE_ENTRY_ATTACHMENT_LOCAL_ID_V1,
        value: {
            key: deriveTriageComposerEntryAttachmentKey(input.entryRef),
            value,
            presentation: input.presentation,
        },
    };
}

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

    const draft = buildTriageEntryAttachmentDraftV1({
        entryRef,
        sourceInstance: input.sourceInstance,
        presentation: input.presentation,
        ...(input.lastKnownLocator === undefined ? {} : { lastKnownLocator: input.lastKnownLocator }),
    });
    if (draft === null) return { status: 'refused', reason: 'invalidValue' };

    // A repeated attach carries the same canonical key, so the qualified
    // identity plus key dedupe updates the existing record in place instead of
    // adding a second selection of one entry.
    return {
        status: 'transaction',
        transaction: {
            expectedRevision: snapshot.revision,
            operations: [{ kind: 'attachment.add', ...draft }],
        },
    };
}
