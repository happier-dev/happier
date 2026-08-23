import {
    HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1,
    RawIngressStructuredInputV1Schema,
    sanitizeSessionUserMessageSendMeta,
    type ComposerAttachmentDraftV1,
    type RawIngressStructuredInputV1,
} from '@happier-dev/protocol';
import {
    admitMentionRefsV1ForText,
    hasRawStructuredInputSemanticContentV1,
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
 * A Pending row is Message *ingress*: the queue re-sends its stored metadata verbatim
 * through the send RPC, so its attachments are drafts and a media one still carries the
 * transfer-owned staged claim. Reading the row through the persisted envelope refused every
 * queued media message outright — the draft owner can hold that claim unchanged. A durable
 * SessionMedia id is the one shape that cannot come back: it is not reconstructible as a
 * staged handle, and the ingress envelope rejects it, so that edit stays unavailable rather
 * than losing the selected attachment.
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
    const envelope = RawIngressStructuredInputV1Schema.safeParse(rawEnvelope);
    if (!envelope.success) return { status: 'unavailable' };

    for (const [key, value] of Object.entries(rawEnvelope)) {
        if (key === 'v' || key === 'mentions' || key === 'composerAttachments') continue;
        if (!EMPTY_STRUCTURED_INPUT_FIELDS.has(key) || !Array.isArray(value) || value.length > 0) {
            return { status: 'unavailable' };
        }
    }

    const attachments: readonly ComposerAttachmentDraftV1[] = envelope.data.composerAttachments ?? [];
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
    | Readonly<{ status: 'ready'; structuredInput: RawIngressStructuredInputV1 }>
    | Readonly<{ status: 'unavailable' }>;

/**
 * The exit half of the rule `hydratePendingMessageComposerAttachmentDrafts` enforces on
 * entry: a Pending row is Message ingress, so it may carry a draft whose media is still the
 * transfer-owned staged claim. The daemon's SessionMedia finalizer replaces that claim when
 * the row is eventually sent — this write-back must not require finalization a queued row has
 * not reached, and must not silently drop the record instead.
 *
 * The length comparison is the whole guard: the ingress record schema is strict, so a record
 * survives whole or not at all, and the boundary sanitizer preserves order for the ones it
 * keeps.
 */
export function buildPendingMessageComposerEditStructuredInput(input: Readonly<{
    text: string;
    mentions: readonly ComposerStructuredInputMention[];
    attachments: readonly ComposerAttachmentDraftV1[];
}>): PendingMessageComposerEditStructuredInputBuild {
    const meta = sanitizeSessionUserMessageSendMeta(buildStructuredInputMetaOverrides({
        mentions: input.mentions,
        text: input.text,
        composerAttachments: input.attachments,
    }));
    const envelope = readRecord(meta[HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1]) ?? { v: 1 };
    const parsed = RawIngressStructuredInputV1Schema.safeParse(envelope);
    if (!parsed.success) return { status: 'unavailable' };
    if ((parsed.data.composerAttachments ?? []).length !== input.attachments.length) {
        return { status: 'unavailable' };
    }
    return { status: 'ready', structuredInput: parsed.data };
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
