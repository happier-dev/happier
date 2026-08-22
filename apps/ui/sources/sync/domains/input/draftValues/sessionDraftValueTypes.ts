import { z } from 'zod';

import {
    ComposerAgentContinuationIntentV1Schema,
    ComposerAttachmentDraftV1Schema,
    SessionAgentTransitionResultV1Schema,
    type ComposerAttachmentDraftV1,
    type ComposerReferenceMentionPayloadV1,
    ParticipantRecipientV1Schema,
    type ParticipantRecipientV1,
} from '@happier-dev/protocol';

export const ExecutionRunDeliveryModeSchema = z.enum(['prompt', 'steer_if_supported', 'interrupt']);
export type ExecutionRunDeliveryMode = z.infer<typeof ExecutionRunDeliveryModeSchema>;

/**
 * Canonical declaration of a composer structured-input mention (SB-4, D-19).
 *
 * The persisted schema is the single owner of the shape: the composer's own
 * `ComposerStructuredInputMention` types are inferred from it. They used to be
 * declared a second time as hand-written TS in
 * `components/sessions/agentInput/structuredInputMentions.ts`, and the two
 * drifted — the skill arm here omitted `id`, `projectionRef`, `backendId` and
 * `agentId`, which the skill suggestion payload emits and the envelope writer
 * reads. Because `z.object` strips undeclared keys, a skill mention held in a
 * draft lost its provider context on the persist/restore round trip, so the
 * same composer content sent a DIFFERENT envelope after an app restart. Both
 * declarations were mutually assignable (every drifted field is optional), so
 * the type system could never see it. One declaration is the fix.
 */

/**
 * The textual half of a mention: the exact token the composer inserted. A mention belongs to
 * the draft for as long as the draft text still contains it, which is what the reconciler
 * enforces — there is deliberately no stored position (see `MentionRefV1Schema`).
 *
 * A draft written before positions were removed simply has two extra keys; the known-kind
 * arms are plain objects, so zod strips them, and the unknown-kind arm is passthrough and
 * carries them inertly.
 */
const StructuredInputMentionBaseSchema = z.object({
    tokenText: z.string().min(1),
});

export const ComposerVendorPluginMentionSchema = StructuredInputMentionBaseSchema.extend({
    kind: z.literal('vendorPlugin'),
    vendorPluginRef: z.string().min(1),
    label: z.string().min(1).optional(),
    backendId: z.string().min(1).optional(),
    agentId: z.string().min(1).optional(),
});
export type ComposerVendorPluginMention = Readonly<z.infer<typeof ComposerVendorPluginMentionSchema>>;

/**
 * Every field here is emitted by the skill suggestion payload
 * (`components/autocomplete/composerSuggestionKinds.ts`). `projectionRef`,
 * `backendId` and `agentId` are read by the envelope writer, and `id` is the
 * catalog identity a send-time resolver needs; none of them may be dropped by
 * the draft round trip.
 */
export const ComposerSkillMentionSchema = StructuredInputMentionBaseSchema.extend({
    kind: z.literal('skill'),
    id: z.string().min(1).optional(),
    name: z.string().min(1),
    path: z.string().min(1).optional(),
    displayName: z.string().min(1).optional(),
    description: z.string().min(1).optional(),
    origin: z.string().min(1).optional(),
    projectionKind: z.string().min(1).optional(),
    projectionRef: z.string().min(1).optional(),
    backendId: z.string().min(1).optional(),
    agentId: z.string().min(1).optional(),
});
export type ComposerSkillMention = Readonly<z.infer<typeof ComposerSkillMentionSchema>>;

const KNOWN_COMPOSER_MENTION_KINDS: ReadonlySet<string> = new Set(['vendorPlugin', 'skill']);

/**
 * INV-4: a well-formed mention of a kind this build does not know survives load, save and
 * transmission inert. It is never reinterpreted as a known kind, and a *malformed* known
 * kind is not laundered into it either — the arm refuses the known kind names outright.
 */
export const ComposerUnknownMentionSchema = StructuredInputMentionBaseSchema.extend({
    kind: z.string().min(1).refine((kind) => !KNOWN_COMPOSER_MENTION_KINDS.has(kind), {
        message: 'Known mention kinds must satisfy their own schema',
    }),
}).passthrough();
/**
 * Declared without the passthrough catch-all so the union keeps discriminating
 * property access; the *runtime* schema still preserves a newer build's extra
 * fields, which is what INV-4 is about.
 */
export type ComposerUnknownMention = Readonly<{
    kind: string;
    /**
     * Protocol-owned opaque identity for a newer reference kind. The persisted
     * schema remains passthrough so an older UI preserves fields it does not
     * understand; exposing these two known members lets the outbound adapter
     * retain the reference without teaching the UI what the kind means.
     */
    ref?: string;
    label?: string;
    /**
     * The one Protocol-owned companion identity whose current writer must
     * preserve for a public composer reference. Other unknown fields
     * remain persistence-compatible but are not inferred as transport data.
     */
    composerReference?: ComposerReferenceMentionPayloadV1['composerReference'];
    tokenText: string;
}>;

/** The Protocol-owned provider payload plus the composer's own token. */
export type ComposerReferenceMention = Readonly<
    ComposerReferenceMentionPayloadV1
    & Pick<ComposerUnknownMention, 'tokenText'>
>;

export const ComposerStructuredInputMentionSchema = z.union([
    ComposerVendorPluginMentionSchema,
    ComposerSkillMentionSchema,
    ComposerUnknownMentionSchema,
]);
export type ComposerStructuredInputMention =
    | ComposerVendorPluginMention
    | ComposerSkillMention
    | ComposerReferenceMention
    | ComposerUnknownMention;

/**
 * A composer mention WITHOUT its token — what a suggestion carries before it is
 * placed in the text. Derived from the same union so a new kind is never
 * declared twice (SB-4).
 */
export type ComposerStructuredInputMentionPayload =
    | Omit<ComposerVendorPluginMention, 'tokenText'>
    | Omit<ComposerSkillMention, 'tokenText'>
    | ComposerReferenceMentionPayloadV1
    /**
     * The selection-time half of an open Protocol reference. It does not
     * duplicate the transmitted shape: `AgentInput` supplies the exact token
     * and range when the candidate is inserted.
     */
    | Readonly<{
        kind: ComposerUnknownMention['kind'];
        ref: NonNullable<ComposerUnknownMention['ref']>;
        label?: ComposerUnknownMention['label'];
    }>;

/**
 * Element-wise (D-14). The previous whole-array parse discarded **every** draft mention when
 * a single element failed, which is silent user-data loss on the one field that survives an
 * app restart. A malformed element now drops alone.
 */
export const ComposerStructuredInputMentionsSchema = z.preprocess(
    (value) => {
        if (!Array.isArray(value)) return value;
        const surviving = value.filter((entry) => ComposerStructuredInputMentionSchema.safeParse(entry).success);
        // A stored list where nothing at all survives is an unreadable field, not an empty
        // draft, so it is dropped exactly as before. Partial corruption keeps its survivors.
        return value.length > 0 && surviving.length === 0 ? undefined : surviving;
    },
    z.array(ComposerStructuredInputMentionSchema),
);

/**
 * The Agent the reader armed for their next message, exactly as the picker holds
 * it — the wire intent plus the catalog row it was chosen from, so a Session with
 * several rows resolving to the same Agent restores the row that was tapped.
 *
 * It lives in the Session draft because it is one half of a single composer
 * decision whose other half — the draft text — already survives a remount.
 * Keeping the two at different lifetimes is what let a reader navigate away and
 * come back to their message with the Agent choice silently gone.
 *
 * The submission identity is not here either, because it belongs to a
 * SUBMITTED switch rather than to a choice about the next message. It lives in
 * the sibling field below, whose lifetime is the transition's rather than the
 * arm's.
 */
export const SessionArmedAgentContinuationSchema = z.object({
    backendTargetKey: z.string().trim().min(1),
    intent: ComposerAgentContinuationIntentV1Schema,
    /**
     * What the detail pane called the chosen model, when the composer's engine chip
     * names it. Optional because a target on its own defaults has no model to name,
     * and because the intent — not this display snapshot — is what gets sent.
     */
    modelLabel: z.string().min(1).nullable().optional(),
}).strict();
export type SessionArmedAgentContinuation = Readonly<z.infer<typeof SessionArmedAgentContinuationSchema>>;

/**
 * The armed switch this Session has already submitted, whose effect on the
 * Session is not yet established.
 *
 * It is the other half of the same composer decision as the arm above, and it
 * outlives the mount for a sharper reason than the draft text does: `localId`
 * is the daemon's dedupe key and the divider correlation key. Held only in a
 * mounted ref, a remount minted a NEW identity for the same armed choice while
 * the still-visible draft stayed sendable, so the retry committed a SECOND
 * message and divider for a switch that may already have happened. The banner
 * that said so and the send block that stood in the way lived in that same lost
 * state.
 *
 * This is not a recovery record and carries no recovery of its own. It holds
 * exactly what the disposition owner needs to re-decide the outcome against
 * canonical facts, and it is deleted the moment that owner says the transition
 * has nothing left to say.
 */
export const SessionArmedAgentContinuationSubmissionSchema = z.object({
    /**
     * The submitted identity: the transition's dedupe key, the divider
     * correlation key, and the only key the composer may compare-clear against.
     */
    localId: z.string().trim().min(1),
    /**
     * The switch that was submitted. A restored arm keeps this submission's
     * identity only while it still describes the SAME switch; a reader who
     * re-armed elsewhere gets a fresh one.
     */
    intent: ComposerAgentContinuationIntentV1Schema,
    /** The daemon's own closed answer, re-decided rather than re-interpreted. */
    result: SessionAgentTransitionResultV1Schema,
    /**
     * The exact composer text this submission carried, so custody observed
     * later can compare-clear an UNCHANGED draft instead of leaving the reader
     * holding a message they have already sent.
     */
    submittedText: z.string(),
    /** Whether canonical Session/message facts have been read since the call. */
    reconciled: z.boolean(),
}).strict();
export type SessionArmedAgentContinuationSubmission =
    Readonly<z.infer<typeof SessionArmedAgentContinuationSubmissionSchema>>;

export type SessionDraftValueByFieldId = Readonly<{
    'routing.recipient': ParticipantRecipientV1 | null;
    /** The armed target Agent for the next message; see the schema above. */
    'routing.agentContinuation': SessionArmedAgentContinuation;
    /** The submitted switch whose effect is not established; see above. */
    'routing.agentContinuationSubmission': SessionArmedAgentContinuationSubmission;
    'routing.executionRunDelivery': ExecutionRunDeliveryMode;
    /**
     * Contentless plugin attachment drafts remain source data until the
     * canonical submission owner prepares them after stable Message identity.
     */
    'structuredInput.composerAttachments': readonly ComposerAttachmentDraftV1[];
    'structuredInput.mentions': readonly ComposerStructuredInputMention[];
}>;

export type SessionDraftValueFieldId = keyof SessionDraftValueByFieldId;

export const SESSION_DRAFT_VALUE_SCHEMAS = {
    'routing.recipient': ParticipantRecipientV1Schema.nullable(),
    'routing.agentContinuation': SessionArmedAgentContinuationSchema,
    'routing.agentContinuationSubmission': SessionArmedAgentContinuationSubmissionSchema,
    'routing.executionRunDelivery': ExecutionRunDeliveryModeSchema,
    'structuredInput.composerAttachments': z.array(ComposerAttachmentDraftV1Schema).max(64),
    'structuredInput.mentions': ComposerStructuredInputMentionsSchema,
} satisfies Readonly<Record<SessionDraftValueFieldId, z.ZodType>>;

export type SessionDraftValueEnvelope<FieldId extends SessionDraftValueFieldId = SessionDraftValueFieldId> = Readonly<{
    v: 1;
    updatedAt: number;
    lastEditedAt: number;
    value: SessionDraftValueByFieldId[FieldId];
}>;
