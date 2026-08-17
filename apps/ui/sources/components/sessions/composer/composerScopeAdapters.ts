import {
    buildQualifiedPluginContributionKey,
    isValidPluginJsonSchemaValue,
    readHappierStructuredInputV1FromMeta,
    type ComposerAttachmentDraftV1,
    type ComposerAttachmentViewV1,
    type ComposerSnapshotV1,
    type MentionRefV1,
    type PluginProjectedComposerAttachmentEntryV1,
} from '@happier-dev/protocol';

import { buildStructuredInputMetaOverrides } from '@/components/sessions/agentInput/structuredInputMentions';
import type { PluginUiComposerAttachmentProjection } from '@/sync/domains/plugins/ui/projection';
import type {
    ComposerStructuredInputMention,
    ComposerUnknownMention,
} from '@/sync/domains/input/draftValues/sessionDraftValueTypes';

type ComposerMentionRef = ComposerSnapshotV1['references'][number];

/**
 * Reading a reference back into a composer mention needs identity and token, never a
 * position — so these take the positionless persisted/transmitted shape. Only
 * `composerReferencesFromStructuredMentions`, which places references INTO a document
 * snapshot, produces the positional `ComposerMentionRef`, and it derives those ranges by
 * locating each token in that exact text.
 */
type ComposerMentionIdentity = Omit<ComposerMentionRef, 'start' | 'end'>;

/**
 * The current daemon-normalized attachment declarations for one live Composer
 * scope. It is deliberately supplied by that scope's projection/currentness
 * owner; draft persistence retains neither this catalog nor its generation.
 */
export type ComposerAttachmentAvailabilityCatalog = Readonly<{
    entriesById: Readonly<Record<string, PluginUiComposerAttachmentProjection>> | null | undefined;
}>;

/**
 * Resolves a persisted attachment only through its exact current qualified
 * declaration. The immutable generation is not persisted alongside the draft:
 * an admitted current entry is the generation proof at the point of use.
 */
export function resolveCurrentComposerAttachmentCatalogEntry<
    Entry extends PluginProjectedComposerAttachmentEntryV1,
>(
    attachment: Pick<ComposerAttachmentDraftV1, 'attachment'>,
    entriesById: Readonly<Record<string, Entry>> | null | undefined,
): Entry | null {
    const contributionId = buildQualifiedPluginContributionKey(attachment.attachment);
    const entry = entriesById?.[contributionId];
    if (
        !entry
        || entry.id !== contributionId
        || entry.pluginId !== attachment.attachment.pluginId
        || entry.identity.pluginId !== attachment.attachment.pluginId
        || entry.identity.localId !== attachment.attachment.localId
        || entry.definition.id !== attachment.attachment.localId
        || entry.immutableGenerationId.trim().length === 0
    ) {
        return null;
    }
    return entry;
}

function resolveComposerAttachmentAvailability(
    draft: ComposerAttachmentDraftV1,
    catalog: ComposerAttachmentAvailabilityCatalog,
): ComposerAttachmentViewV1['availability'] {
    const entry = resolveCurrentComposerAttachmentCatalogEntry(draft, catalog?.entriesById);
    if (!entry) return { status: 'unavailable' };
    try {
        if (!entry.valueValidator) return { status: 'invalid' };
        return isValidPluginJsonSchemaValue(entry.valueValidator, draft.value)
            ? { status: 'ready' }
            : { status: 'invalid' };
    } catch {
        // A malformed static schema cannot make persisted input sendable. The
        // fallback record remains intact so the host can still display/remove it.
        return { status: 'invalid' };
    }
}

/**
 * Adapts the incumbent scope-specific draft records into the one Composer
 * document snapshot. It owns no persistence or identity: each caller writes
 * through its existing draft owner after the shared transaction validator
 * returns a complete mutation.
 */
export function composerAttachmentDraftToView(
    draft: ComposerAttachmentDraftV1,
    catalog: ComposerAttachmentAvailabilityCatalog,
): ComposerAttachmentViewV1 {
    return {
        ...draft,
        availability: resolveComposerAttachmentAvailability(draft, catalog),
    };
}

/** Drops only computed display availability while preserving canonical staged content. */
export function composerAttachmentViewToDraft(
    view: ComposerAttachmentViewV1,
): ComposerAttachmentDraftV1 {
    return {
        v: view.v,
        instanceId: view.instanceId,
        attachment: view.attachment,
        key: view.key,
        value: view.value,
        presentation: view.presentation,
        ...(view.content === undefined ? {} : { content: view.content }),
    };
}

function referenceIdentityKey(reference: Pick<MentionRefV1, 'kind' | 'ref' | 'token'>): string {
    return `${reference.kind}\u0000${reference.ref}\u0000${reference.token}`;
}

function readReferenceFromMention(
    mention: ComposerStructuredInputMention,
): MentionRefV1 | null {
    // Delegates identity encoding to the incumbent writer. The mention's own token is a
    // sufficient text basis: the writer admits a reference whose token the text contains.
    // This used to build a token-sized fake document and then restore the real document
    // range, which existed only to satisfy a range contract that no longer exists.
    const envelope = readHappierStructuredInputV1FromMeta(buildStructuredInputMetaOverrides({
        mentions: [mention],
        text: mention.tokenText,
    }));
    return envelope?.mentions?.[0] ?? null;
}

/**
 * Uses the incumbent structured-input writer/reader pair to retain its
 * reference identity rules. A document adapter never reimplements known
 * vendor/skill reference encoding.
 */
export function composerReferencesFromStructuredMentions(input: Readonly<{
    text: string;
    mentions: readonly ComposerStructuredInputMention[];
}>): readonly ComposerMentionRef[] {
    const envelope = readHappierStructuredInputV1FromMeta(buildStructuredInputMetaOverrides({
        mentions: input.mentions,
        text: input.text,
    }));
    const occupiedRanges: Array<Readonly<{ start: number; end: number }>> = [];
    const references = (envelope?.mentions ?? []).flatMap((reference) => {
        let start = input.text.indexOf(reference.token);
        while (start >= 0) {
            const end = start + reference.token.length;
            if (!occupiedRanges.some((range) => start < range.end && end > range.start)) {
                occupiedRanges.push({ start, end });
                return [{ ...reference, start, end }];
            }
            start = input.text.indexOf(reference.token, start + 1);
        }
        return [];
    });
    return references.sort((left, right) => left.start - right.start || left.end - right.end);
}

function rebaseStoredMention(
    mention: ComposerStructuredInputMention,
    reference: ComposerMentionIdentity,
): ComposerStructuredInputMention {
    if (mention.kind === 'skill' && 'name' in mention) {
        return {
            ...mention,
            tokenText: reference.token,
            ...(reference.label ? { displayName: reference.label } : {}),
        };
    }
    return {
        ...mention,
        tokenText: reference.token,
        ...(reference.label ? { label: reference.label } : {}),
    };
}

function createOpaqueMention(reference: ComposerMentionIdentity): ComposerUnknownMention {
    return {
        kind: reference.kind,
        ref: reference.ref,
        ...(reference.label ? { label: reference.label } : {}),
        ...(reference.composerReference ? { composerReference: reference.composerReference } : {}),
        tokenText: reference.token,
    };
}

/**
 * Preserve a known mention's richer catalog context when its Protocol identity
 * survives a transaction. New/foreign kinds use the persisted open mention arm
 * instead of being interpreted as a host/vendor/skill spelling.
 */
export function composerStructuredMentionsFromReferences(input: Readonly<{
    references: readonly ComposerMentionIdentity[];
    existing: readonly ComposerStructuredInputMention[];
}>): readonly ComposerStructuredInputMention[] {
    const existingByReference = new Map<string, ComposerStructuredInputMention>();
    for (const mention of input.existing) {
        const reference = readReferenceFromMention(mention);
        if (!reference) continue;
        existingByReference.set(referenceIdentityKey(reference), mention);
    }
    return input.references.map((reference) => {
        const existing = existingByReference.get(referenceIdentityKey(reference));
        return existing ? rebaseStoredMention(existing, reference) : createOpaqueMention(reference);
    });
}
