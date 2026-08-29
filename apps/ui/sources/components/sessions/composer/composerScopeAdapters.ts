import {
    buildQualifiedPluginContributionKey,
    ComposerAttachmentDraftV1Schema,
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
 * The current daemon-normalized attachment declarations for one live Composer
 * scope. It is deliberately supplied by that scope's projection/currentness
 * owner; draft persistence retains neither this catalog nor its generation.
 */
export type ComposerAttachmentAvailabilityCatalog = Readonly<{
    entriesById: Readonly<Record<string, PluginUiComposerAttachmentProjection>> | null | undefined;
}>;

export type ComposerAttachmentDraftAvailabilitySummary = Readonly<{
    pluginUnavailable: boolean;
    attachmentNeedsAttention: boolean;
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

/**
 * Reduces persisted opaque attachment values to presentation-safe currentness
 * flags. Callers never need to retain or expose the attachment records, daemon
 * resources, or catalog generation in their own state.
 */
export function summarizeComposerAttachmentDraftAvailability(input: Readonly<{
    values: readonly unknown[];
    catalog: ComposerAttachmentAvailabilityCatalog;
    installedPluginIds: ReadonlySet<string>;
}>): ComposerAttachmentDraftAvailabilitySummary {
    let pluginUnavailable = false;
    let attachmentNeedsAttention = false;
    for (const value of input.values) {
        const parsed = ComposerAttachmentDraftV1Schema.safeParse(value);
        if (!parsed.success) {
            attachmentNeedsAttention = true;
            continue;
        }
        const draft = parsed.data;
        if (!input.installedPluginIds.has(draft.attachment.pluginId)) {
            pluginUnavailable = true;
            continue;
        }
        if (composerAttachmentDraftToView(draft, input.catalog).availability.status !== 'ready') {
            attachmentNeedsAttention = true;
        }
    }
    return { pluginUnavailable, attachmentNeedsAttention };
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
    // The envelope owns only positionless Message identity. Normalize this token-sized
    // identity probe while retaining the real editable-draft range in the caller.
    const envelope = readHappierStructuredInputV1FromMeta(buildStructuredInputMetaOverrides({
        mentions: [{ ...mention, start: 0, end: mention.tokenText.length }],
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
    const references = input.mentions.flatMap((mention) => {
        // Editable Composer references have exact occurrence custody. A stale
        // range is not permission to search/rebind another equal token: doing
        // so can send provider context for text the user never selected.
        if (
            mention.start < 0
            || mention.end < mention.start
            || mention.end > input.text.length
            || input.text.slice(mention.start, mention.end) !== mention.tokenText
        ) return [];
        const reference = readReferenceFromMention(mention);
        return reference ? [{ ...reference, start: mention.start, end: mention.end }] : [];
    });
    return references.sort((left, right) => left.start - right.start || left.end - right.end);
}

function rebaseStoredMention(
    mention: ComposerStructuredInputMention,
    reference: ComposerMentionRef,
): ComposerStructuredInputMention {
    if (mention.kind === 'skill' && 'name' in mention) {
        return {
            ...mention,
            tokenText: reference.token,
            start: reference.start,
            end: reference.end,
            ...(reference.label ? { displayName: reference.label } : {}),
        };
    }
    return {
        ...mention,
        tokenText: reference.token,
        start: reference.start,
        end: reference.end,
        ...(reference.label ? { label: reference.label } : {}),
    };
}

function createOpaqueMention(reference: ComposerMentionRef): ComposerUnknownMention {
    return {
        kind: reference.kind,
        ref: reference.ref,
        ...(reference.label ? { label: reference.label } : {}),
        ...(reference.composerReference ? { composerReference: reference.composerReference } : {}),
        tokenText: reference.token,
        start: reference.start,
        end: reference.end,
    };
}

/**
 * Place positionless Message references into a fresh document's text, once, at
 * the seed boundary.
 *
 * A persisted template (an Automation edit seed's stored message-level refs)
 * carries no occurrence ranges — the Message wire is deliberately positionless.
 * Before such a reference can live in an editable draft it needs the exact
 * UTF-16 `[start, end)` occurrence it binds, and choosing it is a one-time
 * placement decision, not an ongoing reconciliation: after placement the
 * document's exact-range custody owns the occurrence, and later reads never
 * re-search the text. Each token takes the leftmost unoccupied occurrence, so
 * two references rendering the same token bind two distinct occurrences, and
 * a token the text does not contain is dropped instead of being silently
 * relocated onto an unrelated occurrence.
 */
export function placePositionlessComposerReferences(input: Readonly<{
    text: string;
    references: readonly MentionRefV1[];
}>): readonly ComposerMentionRef[] {
    const occupied: Array<Readonly<{ start: number; end: number }>> = [];
    const placed: ComposerMentionRef[] = [];
    for (const reference of input.references) {
        if (reference.token.length === 0) continue;
        let searchFrom = 0;
        let start = -1;
        while (searchFrom <= input.text.length) {
            const index = input.text.indexOf(reference.token, searchFrom);
            if (index < 0) break;
            const end = index + reference.token.length;
            const overlaps = occupied.some((range) => index < range.end && end > range.start);
            if (!overlaps) {
                start = index;
                break;
            }
            searchFrom = index + 1;
        }
        if (start < 0) continue;
        occupied.push({ start, end: start + reference.token.length });
        placed.push({ ...reference, start, end: start + reference.token.length });
    }
    return placed.sort((left, right) => left.start - right.start || left.end - right.end);
}

/**
 * Preserve a known mention's richer catalog context when its Protocol identity
 * survives a transaction. New/foreign kinds use the persisted open mention arm
 * instead of being interpreted as a host/vendor/skill spelling.
 */
export function composerStructuredMentionsFromReferences(input: Readonly<{
    /** Positional document references; ranges remain editable Composer custody. */
    references: readonly ComposerMentionRef[];
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
