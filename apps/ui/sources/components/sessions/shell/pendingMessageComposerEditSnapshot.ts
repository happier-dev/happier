import {
    HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1,
    HappierStructuredInputV1EnvelopeSchema,
    type ComposerAttachmentDraftV1,
    type ComposerAttachmentInputV1,
    type HappierStructuredInputV1Envelope,
} from '@happier-dev/protocol';
import {
    admitMentionRefsV1ForText,
    hasRawStructuredInputSemanticContentV1,
    readHappierStructuredInputV1FromMeta,
    type MentionRefV1,
} from '@happier-dev/protocol/runtime';
import { buildStructuredInputMetaOverrides } from '@/components/sessions/agentInput/structuredInputMentions';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { SESSION_DRAFT_VALUE_FIELD_CATALOG } from '@/sync/domains/input/draftValues/sessionDraftValueFieldCatalog';
import type {
    ComposerStructuredInputMention,
    SessionDraftValueByFieldId,
    SessionDraftValueFieldId,
} from '@/sync/domains/input/draftValues/sessionDraftValueTypes';

export type PendingMessageComposerSemanticDraftSnapshot = Readonly<{
    [FieldId in SessionDraftValueFieldId]: SessionDraftValueByFieldId[FieldId] | undefined;
}>;

/** Process-local compare tokens from the canonical session-draft store. */
export type PendingMessageComposerSemanticDraftMutationRevisions = Readonly<{
    [FieldId in SessionDraftValueFieldId]: number;
}>;

/**
 * The mounted Pending row has a document of its own. It is intentionally not
 * a second persisted draft store: the incumbent presentation registry owns
 * its addressability while this scope is mounted, and the canonical Pending
 * row remains its durable backing record.
 */
export type PendingMessageComposerDocument = Readonly<{
    text: string;
    mentions: readonly ComposerStructuredInputMention[];
    attachments: readonly ComposerAttachmentDraftV1[];
    revision: number;
}>;

export type PendingMessageComposerEditState = Readonly<{
    pendingId: string;
    /** The canonical pending-message identity used by the Composer admission scope. */
    localId: string;
    holdId: string;
    accountScope: ServerAccountScope | null;
    accountLifetime: ActiveServerAccountScopeLifetime | null;
    /** Current mounted Pending document, never mirrored into the Session draft. */
    document: PendingMessageComposerDocument;
    /** The durable Pending payload from which this edit scope was opened. */
    admittedDocument: PendingMessageComposerDocument;
}>;

type PendingMessageComposerAttachmentHydration =
    | Readonly<{
        status: 'ready';
        attachments: readonly ComposerAttachmentDraftV1[];
        mentions?: readonly MentionRefV1[];
    }>
    | Readonly<{ status: 'unavailable' }>;

const EMPTY_STRUCTURED_INPUT_FIELDS = new Set([
    'vendorPluginMentions',
    'skillMentions',
    'imageInputs',
    'attachments',
]);

function readRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

/**
 * Pending rows hold daemon-admitted attachment inputs. Only a contentless
 * record is representable in the draft owner: a SessionMedia id cannot be
 * reconstructed as the transfer-owned staged handle a draft requires.
 */
function hydrateContentlessComposerAttachmentDraft(
    attachment: ComposerAttachmentInputV1,
): ComposerAttachmentDraftV1 | null {
    if (attachment.content !== undefined) return null;
    return {
        v: attachment.v,
        instanceId: attachment.instanceId,
        attachment: attachment.attachment,
        key: attachment.key,
        value: attachment.value,
        presentation: attachment.presentation,
    };
}

/**
 * Pending Messages store admitted attachment records. A contentless record can
 * be returned to the canonical draft owner unchanged; media ids cannot become
 * draft content handles without the transfer owner, so that edit remains
 * unavailable rather than losing the selected attachment.
 */
export function hydratePendingMessageComposerAttachmentDrafts(
    metadata: unknown,
    text?: string,
): PendingMessageComposerAttachmentHydration {
    if (!hasRawStructuredInputSemanticContentV1(metadata)) {
        return { status: 'ready', attachments: [] };
    }

    const rawEnvelope = readRecord(readRecord(metadata)?.[HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1]);
    if (!rawEnvelope) {
        return { status: 'unavailable' };
    }
    const envelope = HappierStructuredInputV1EnvelopeSchema.safeParse(rawEnvelope);
    if (!envelope.success) return { status: 'unavailable' };

    for (const [key, value] of Object.entries(rawEnvelope)) {
        if (key === 'v' || key === 'mentions' || key === 'composerAttachments') continue;
        if (!EMPTY_STRUCTURED_INPUT_FIELDS.has(key) || !Array.isArray(value) || value.length > 0) {
            return { status: 'unavailable' };
        }
    }

    const attachments: ComposerAttachmentDraftV1[] = [];
    for (const attachment of envelope.data.composerAttachments ?? []) {
        const draft = hydrateContentlessComposerAttachmentDraft(attachment);
        if (!draft) return { status: 'unavailable' };
        attachments.push(draft);
    }

    const mentions = envelope.data.mentions ?? [];
    if (mentions.length > 0) {
        if (typeof text !== 'string') return { status: 'unavailable' };
        const admittedMentions = admitMentionRefsV1ForText(text, mentions);
        if (admittedMentions.length !== mentions.length) return { status: 'unavailable' };
        return {
            status: 'ready',
            attachments,
            mentions: admittedMentions,
        };
    }
    return {
        status: 'ready',
        attachments,
    };
}

export type PendingMessageComposerEditStructuredInputBuild =
    | Readonly<{ status: 'ready'; structuredInput: HappierStructuredInputV1Envelope }>
    | Readonly<{ status: 'unavailable' }>;

/**
 * The exit half of the rule `hydratePendingMessageComposerAttachmentDrafts`
 * already enforces on entry: a Pending row persists admitted, contentless
 * attachment records only. The canonical envelope reader is a sanitizer — it
 * drops every record it cannot admit, and a draft that still owns a
 * transfer-staged claim is exactly such a record. Durable media finalization
 * belongs to Message admission, which a queued row has not reached, so a save
 * that would lose the selection is refused rather than silently completed.
 *
 * The length comparison is the whole guard: the admitted record schema is
 * strict, so a record is admitted whole or not at all, and the sanitizer
 * preserves order for the ones it keeps.
 */
export function buildPendingMessageComposerEditStructuredInput(input: Readonly<{
    text: string;
    mentions: readonly ComposerStructuredInputMention[];
    attachments: readonly ComposerAttachmentDraftV1[];
}>): PendingMessageComposerEditStructuredInputBuild {
    const structuredInput: HappierStructuredInputV1Envelope = readHappierStructuredInputV1FromMeta(
        buildStructuredInputMetaOverrides({
            mentions: input.mentions,
            text: input.text,
            composerAttachments: input.attachments,
        }),
    ) ?? { v: 1 };
    if ((structuredInput.composerAttachments ?? []).length !== input.attachments.length) {
        return { status: 'unavailable' };
    }
    return { status: 'ready', structuredInput };
}

export function isEmptyPendingMessageComposerSemanticDraftSnapshot(
    snapshot: PendingMessageComposerSemanticDraftSnapshot,
): boolean {
    return (Object.keys(SESSION_DRAFT_VALUE_FIELD_CATALOG) as SessionDraftValueFieldId[])
        .every((fieldId) => typeof snapshot[fieldId] === 'undefined');
}

/**
 * A pending-row edit clears the semantic draft fields while it is active. When
 * that row leaves the queue, restore only the prior fields the user has not
 * changed in the interim. The catalog supplied by the caller keeps new draft
 * fields on the same lifecycle without a second owner here.
 */
export function readPendingMessageComposerSemanticDraftFieldsToRestore(
    previous: PendingMessageComposerSemanticDraftSnapshot,
    current: PendingMessageComposerSemanticDraftSnapshot,
    fieldIds: readonly SessionDraftValueFieldId[],
    expectedCurrentMutationRevisions?: PendingMessageComposerSemanticDraftMutationRevisions,
    currentMutationRevisions?: PendingMessageComposerSemanticDraftMutationRevisions,
    loaded?: PendingMessageComposerSemanticDraftSnapshot,
): readonly SessionDraftValueFieldId[] {
    return fieldIds.filter((fieldId) => (
        typeof previous[fieldId] !== 'undefined'
        && (
            !expectedCurrentMutationRevisions
            || !currentMutationRevisions
            || expectedCurrentMutationRevisions[fieldId] === currentMutationRevisions[fieldId]
        )
        && (
            typeof current[fieldId] === 'undefined'
            || (
                typeof loaded?.[fieldId] !== 'undefined'
                && JSON.stringify(current[fieldId]) === JSON.stringify(loaded[fieldId])
            )
        )
    ));
}
