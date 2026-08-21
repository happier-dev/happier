import type { ParticipantRecipientV1 } from '@happier-dev/protocol';
import {
    ComposerAgentContinuationIntentV1Schema,
    ParticipantRecipientV1Schema,
    SessionAgentTransitionResultV1Schema,
} from '@happier-dev/protocol';
import { z } from 'zod';

export const SessionComposerExecutionRunDeliveryModeSchema = z.enum([
    'prompt',
    'steer_if_supported',
    'interrupt',
]);

export type SessionComposerExecutionRunDeliveryMode = z.infer<typeof SessionComposerExecutionRunDeliveryModeSchema>;

/**
 * Canonical declaration of a composer structured-input mention (SB-4, D-19).
 *
 * The persisted schema is the single owner of the shape; the composer's
 * `components/sessions/agentInput/structuredInputMentions.ts` re-exports these types instead
 * of declaring them a second time as hand-written TS. The two used to be separate, and in
 * `../dev` they drifted exactly where it hurts: the persisted arm dropped the skill fields the
 * envelope writer derives a `happier.skill` reference from, so the same composer content sent a
 * DIFFERENT envelope after a restart. Every drifted field was optional, so the type system could
 * never see it. One declaration is the fix.
 */

/**
 * The textual half of a mention: the exact token the composer inserted. A mention belongs to
 * the draft for as long as the draft text still contains it, which is what the reconciler
 * enforces — there is deliberately no stored position (see `MentionRefV1Schema`).
 *
 * A draft written before positions were removed simply has two extra keys; the known-kind
 * arms below are plain `z.object`, so zod strips them, and the unknown-kind arm is
 * passthrough and carries them inertly.
 */
const ComposerMentionTokenShape = {
    tokenText: z.string().min(1),
} as const;

export const ComposerVendorPluginMentionSchema = z.object({
    kind: z.literal('vendorPlugin'),
    ...ComposerMentionTokenShape,
    vendorPluginRef: z.string().min(1),
    label: z.string().min(1).optional(),
    backendId: z.string().min(1).optional(),
    agentId: z.string().min(1).optional(),
});

export type ComposerVendorPluginMention = z.infer<typeof ComposerVendorPluginMentionSchema>;

/**
 * Every field here is emitted by the skill suggestion payload
 * (`components/autocomplete/composerSuggestionKinds.ts`). `id`, `origin`, `backendId` and
 * `projectionRef` are the tuple a `happier.skill` reference's identity is derived from
 * (`resolveSkillCatalogItemIdentityV1`); dropping any of them on the draft round trip would
 * make a restored draft resolve to a different skill, or to none.
 */
export const ComposerSkillMentionSchema = z.object({
    kind: z.literal('skill'),
    ...ComposerMentionTokenShape,
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

export type ComposerSkillMention = z.infer<typeof ComposerSkillMentionSchema>;

/**
 * A reference to another session on the SAME server (D-8). Only the session id is persisted:
 * it is the whole identity, and it survives a rename. `label` is an insert-time display
 * snapshot and is never identity.
 */
export const ComposerSessionMentionSchema = z.object({
    kind: z.literal('session'),
    ...ComposerMentionTokenShape,
    sessionId: z.string().min(1),
    label: z.string().min(1).optional(),
});

export type ComposerSessionMention = z.infer<typeof ComposerSessionMentionSchema>;

const KNOWN_COMPOSER_MENTION_KINDS: ReadonlySet<string> = new Set(['vendorPlugin', 'skill', 'session']);

/**
 * INV-4: a well-formed mention of a kind this build does not know survives load, save and
 * transmission inert. It is never reinterpreted as a known kind, and a *malformed* known
 * kind is not laundered into it either — the arm refuses the known kind names outright.
 */
export const ComposerUnknownMentionSchema = z.object({
    kind: z.string().min(1).refine((kind) => !KNOWN_COMPOSER_MENTION_KINDS.has(kind), {
        message: 'Known mention kinds must satisfy their own schema',
    }),
    ...ComposerMentionTokenShape,
}).passthrough();

/**
 * Declared by hand rather than inferred so the union keeps discriminating on `kind`; the
 * *runtime* schema stays passthrough, which is what preserves a newer build's fields. `ref` and
 * `label` are named because the outbound envelope writer transmits a newer kind's reference
 * inertly (INV-4) without this build understanding what the kind means.
 */
export type ComposerUnknownMention = Readonly<{
    kind: string;
    ref?: string;
    label?: string;
    tokenText: string;
}>;

export const ComposerStructuredInputMentionSchema = z.union([
    ComposerVendorPluginMentionSchema,
    ComposerSkillMentionSchema,
    ComposerSessionMentionSchema,
    ComposerUnknownMentionSchema,
]);

export type ComposerStructuredInputMention =
    | ComposerVendorPluginMention
    | ComposerSkillMention
    | ComposerSessionMention
    | ComposerUnknownMention;

/**
 * A composer mention WITHOUT its token — what a suggestion carries before it is placed in the
 * text. Derived from the same union so a new kind is never declared twice (SB-4).
 */
export type ComposerStructuredInputMentionPayload =
    | Omit<ComposerVendorPluginMention, 'tokenText'>
    | Omit<ComposerSkillMention, 'tokenText'>
    | Omit<ComposerSessionMention, 'tokenText'>;

/**
 * Element-wise (D-14). The previous whole-array parse discarded **every** draft mention when
 * a single element failed, which is silent user-data loss on the one field that survives an
 * app restart. A malformed element now drops alone. The per-field persistence version is
 * deliberately NOT bumped: this store has no upgrade hook, so a bump would discard every
 * existing draft.
 */
export const ComposerStructuredInputMentionsSchema = z.preprocess(
    (value) => {
        if (!Array.isArray(value)) return value;
        const surviving = value.filter((entry) => ComposerStructuredInputMentionSchema.safeParse(entry).success);
        // A stored list where nothing at all survives is an unreadable field, not an empty
        // draft, so it is dropped exactly as before. Partial corruption keeps its survivors.
        return value.length > 0 && surviving.length === 0 ? undefined : surviving;
    },
    z.array(ComposerStructuredInputMentionSchema).readonly(),
);

/**
 * The Agent the reader armed for their next message, exactly as the picker holds
 * it — the wire intent, the catalog row it was chosen from (so a Session with
 * several rows resolving to the same Agent restores the row that was tapped), and
 * the picker's own words for the chosen model, which the composer's engine chip
 * names.
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
    // Null when the target is on its own defaults, which is the absence of a model
    // choice rather than a model called default. An unreadable arm is dropped
    // whole: a restored arm that named the wrong model would be worse than none.
    modelLabel: z.string().min(1).nullable(),
}).strict();

export type SessionArmedAgentContinuation = z.infer<typeof SessionArmedAgentContinuationSchema>;

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
    z.infer<typeof SessionArmedAgentContinuationSubmissionSchema>;

export type SessionDraftValueByFieldId = Readonly<{
    'routing.recipient': ParticipantRecipientV1 | null;
    /** The armed target Agent for the next message; see the schema above. */
    'routing.agentContinuation': SessionArmedAgentContinuation;
    /** The submitted switch whose effect is not established; see above. */
    'routing.agentContinuationSubmission': SessionArmedAgentContinuationSubmission;
    'routing.executionRunDelivery': SessionComposerExecutionRunDeliveryMode;
    'structuredInput.mentions': readonly ComposerStructuredInputMention[];
}>;

export type SessionDraftValueFieldId = keyof SessionDraftValueByFieldId;

export const SessionDraftValueFieldSchemas = {
    'routing.recipient': ParticipantRecipientV1Schema.nullable(),
    'routing.agentContinuation': SessionArmedAgentContinuationSchema,
    'routing.agentContinuationSubmission': SessionArmedAgentContinuationSubmissionSchema,
    'routing.executionRunDelivery': SessionComposerExecutionRunDeliveryModeSchema,
    'structuredInput.mentions': ComposerStructuredInputMentionsSchema,
} satisfies {
    readonly [TFieldId in SessionDraftValueFieldId]: z.ZodType<SessionDraftValueByFieldId[TFieldId]>;
};

export type SessionDraftValueClearLifecycle = Readonly<{
    send?: 'outboundHandoff';
    composerClear?: boolean;
    sessionDelete?: boolean;
    abort?: boolean;
    ttlDays?: number;
}>;

export type SessionDraftValueLifecycle = 'outboundHandoff' | 'composerCleared' | 'sessionDeleted' | 'abort';
