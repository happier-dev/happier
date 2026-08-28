import {
    HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1,
    RawIngressStructuredInputV1Schema,
    sameStrictJsonValue,
    sanitizeSessionUserMessageSendMeta,
    type ComposerAttachmentDraftV1,
    type ComposerAttachmentInputV1,
    type JsonValue,
    type RawIngressStructuredInputV1,
} from '@happier-dev/protocol';
import {
    admitMentionRefsV1ForText,
    hasRawStructuredInputSemanticContentV1,
    readAdmittedHappierStructuredInputV1FromMeta,
    type MentionRefV1,
} from '@happier-dev/protocol/runtime';
import { buildStructuredInputMetaOverrides } from '@/components/sessions/agentInput/structuredInputMentions';
import type { MutableComposerDocumentOwner } from '@/components/sessions/composer/composerDocumentOwner';
import { createPendingMessageComposerDocumentOwner } from '@/components/sessions/composer/pendingMessageComposerDocumentOwner';
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

type PendingMessageComposerAdmittedDocument = Omit<PendingMessageComposerDocument, 'attachments'> & Readonly<{
    attachments: readonly (ComposerAttachmentDraftV1 | ComposerAttachmentInputV1)[];
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
    admittedDocument: PendingMessageComposerAdmittedDocument;
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

/**
 * Rotating a Pending row to its approved successor installs a NEW document
 * owner, whose canonical snapshot starts its own revision sequence. The edit
 * state must publish that snapshot rather than carrying the retired owner's
 * counter across: the presentation revision plugins read, the revision a
 * submission-currentness check compares, and the revision the owner's own
 * `apply` CAS expects all have to name one document.
 *
 * The successor owner is built here rather than at the rotation call site so
 * one place decides what makes a mounted Pending document owner current. The
 * scope that opened the edit still bounds it: an owner whose Account scope has
 * been replaced must refuse a mutation exactly as the retired owner did.
 */
export function derivePendingMessageComposerSuccessorEditState(input: Readonly<{
    current: PendingMessageComposerEditState;
    sessionId: string;
    successorLocalId: string;
    admitted: Readonly<{
        text: string;
        mentions: readonly ComposerStructuredInputMention[];
        attachments: readonly (ComposerAttachmentDraftV1 | ComposerAttachmentInputV1)[];
    }>;
    /** The local id of the Pending edit currently mounted, read at call time. */
    readMountedEditLocalId: () => string | null;
}>): Readonly<{
    edit: PendingMessageComposerEditState;
    owner: MutableComposerDocumentOwner;
}> {
    const accountLifetime = input.current.accountLifetime;
    const owner = createPendingMessageComposerDocumentOwner({
        ref: {
            kind: 'pendingMessage',
            sessionId: input.sessionId,
            localId: input.successorLocalId,
        },
        initialDocument: {
            text: input.current.document.text,
            structuredInputMentions: input.current.document.mentions,
            composerAttachments: input.current.document.attachments,
        },
        isCurrent: () => input.readMountedEditLocalId() === input.successorLocalId
            && (accountLifetime === null || accountLifetime.isCurrent()),
    });
    const snapshot = owner.read();
    return {
        owner,
        edit: {
            ...input.current,
            pendingId: input.successorLocalId,
            localId: input.successorLocalId,
            document: {
                text: snapshot.document.text,
                mentions: snapshot.document.structuredInputMentions,
                attachments: snapshot.document.composerAttachments,
                revision: snapshot.revision,
            },
            admittedDocument: {
                text: input.admitted.text,
                mentions: input.admitted.mentions,
                attachments: input.admitted.attachments,
                revision: snapshot.revision,
            },
        },
    };
}

/**
 * The Pending identity a payload has already been exposed under. A Composer
 * attachment's `prepareForSend` receives the Message local id, and the durable
 * row later carries it into the post-acceptance lifecycle, so once an identity
 * is exposed the payload stored beneath it must never change.
 */
export type PendingMessageComposerExposedSuccessor = Readonly<{
    localId: string;
    /** Canonical admitted-payload fingerprint exposed under that identity. */
    fingerprint: JsonValue;
}>;

export type PendingMessageComposerRotationDecision = Readonly<{
    /** Absent means the incumbent row keeps its identity. */
    replacementLocalId?: string;
    exposed: PendingMessageComposerExposedSuccessor | null;
}>;

/**
 * Decides whether a Pending edit must rotate to a successor identity.
 *
 * Rotation is not "an attachment needed preparing": it is "the plugin-visible
 * identity would otherwise gain a second payload". A changed prepared
 * attachment exposes a fresh identity, and once that successor exists every
 * later differing payload — including a text-only one — has to rotate again.
 * An exact resubmission keeps its successor so a lost response rejoins the
 * existing server-side atomic rotation rather than allocating a second row.
 */
export function decidePendingMessageComposerRotation(input: Readonly<{
    pendingId: string;
    fingerprint: JsonValue;
    requiresPreparation: boolean;
    exposed: PendingMessageComposerExposedSuccessor | null;
    allocateLocalId: () => string;
}>): PendingMessageComposerRotationDecision {
    const exposed = input.exposed;
    if (exposed) {
        if (sameStrictJsonValue(exposed.fingerprint, input.fingerprint)) {
            // Exact retry of an already exposed payload. Rejoining the same
            // successor is what lets a lost response replay the server's
            // atomic rotation instead of allocating a second row.
            return exposed.localId === input.pendingId
                ? { exposed }
                : { replacementLocalId: exposed.localId, exposed };
        }
        // A different payload after ANY exposure must rotate, including while
        // the mounted edit still names the predecessor: the exposed identity
        // already carries another payload and must never gain a second one.
    } else if (!input.requiresPreparation) {
        // Nothing has been exposed and this payload exposes nothing.
        return { exposed: null };
    }
    const replacementLocalId = input.allocateLocalId();
    return {
        replacementLocalId,
        exposed: { localId: replacementLocalId, fingerprint: input.fingerprint },
    };
}

export type PendingMessageComposerEditStructuredInputBuild =
    | Readonly<{ status: 'ready'; structuredInput: RawIngressStructuredInputV1 }>
    | Readonly<{ status: 'unavailable' }>;

/**
 * The exit half of the rule `hydratePendingMessageComposerAttachmentDrafts` enforces on
 * entry. Entry stays tolerant — a row opened for editing may already hold a draft record —
 * but the exit contract is the CONSUMER's: materialization hands the stored envelope
 * straight to the Agent queue, which reads it with `readAdmittedHappierStructuredInputV1FromMeta`.
 * Anything that reader calls invalid — an attachment still carrying an unfinalized
 * transfer-staged claim above all — makes the queue reject the whole prompt before the
 * provider, so the user's edited message silently never runs. This write-back therefore
 * refuses rather than persisting a record its own consumer cannot admit.
 *
 * The length comparison remains the record-preservation guard: the ingress record schema is
 * strict, so a record survives whole or not at all, and the boundary sanitizer preserves
 * order for the ones it keeps.
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
    // `absent` is a plain text/reference edit with no envelope; only an envelope
    // the canonical consumer would reject is refused here.
    if (readAdmittedHappierStructuredInputV1FromMeta(meta).status === 'invalid') {
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
    loaded?: PendingMessageComposerSemanticDraftSnapshot,
): readonly SessionDraftValueFieldId[] {
    return fieldIds.filter((fieldId) => (
        typeof previous[fieldId] !== 'undefined'
        && (
            typeof current[fieldId] === 'undefined'
            || (
                typeof loaded?.[fieldId] !== 'undefined'
                && sameStrictJsonValue(current[fieldId], loaded[fieldId])
            )
        )
    ));
}
