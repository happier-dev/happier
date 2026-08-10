import type { ParticipantRecipientV1 } from '@happier-dev/protocol';
import { ParticipantRecipientV1Schema } from '@happier-dev/protocol';
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
 * Positional half of the binding range contract: UTF-16 code units, half-open
 * `[start, end)`, integers with `0 <= start < end`. The `slice(start, end) === token` half
 * needs the composer text and is enforced by the mention reconciler.
 */
const ComposerMentionRangeShape = {
    tokenText: z.string().min(1),
    start: z.number().int().min(0),
    end: z.number().int().min(1),
} as const;

export const ComposerVendorPluginMentionSchema = z.object({
    kind: z.literal('vendorPlugin'),
    ...ComposerMentionRangeShape,
    vendorPluginRef: z.string().min(1),
    label: z.string().min(1).optional(),
    backendId: z.string().min(1).optional(),
    agentId: z.string().min(1).optional(),
}).refine((mention) => mention.end > mention.start, {
    path: ['end'],
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
    ...ComposerMentionRangeShape,
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
}).refine((mention) => mention.end > mention.start, {
    path: ['end'],
});

export type ComposerSkillMention = z.infer<typeof ComposerSkillMentionSchema>;

/**
 * A reference to another session on the SAME server (D-8). Only the session id is persisted:
 * it is the whole identity, and it survives a rename. `label` is an insert-time display
 * snapshot and is never identity.
 */
export const ComposerSessionMentionSchema = z.object({
    kind: z.literal('session'),
    ...ComposerMentionRangeShape,
    sessionId: z.string().min(1),
    label: z.string().min(1).optional(),
}).refine((mention) => mention.end > mention.start, {
    path: ['end'],
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
    ...ComposerMentionRangeShape,
}).passthrough().refine((mention) => mention.end > mention.start, {
    path: ['end'],
});

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
    start: number;
    end: number;
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
 * A composer mention WITHOUT its positional fields — what a suggestion carries before it is
 * placed in the text. Derived from the same union so a new kind is never declared twice (SB-4).
 */
export type ComposerStructuredInputMentionPayload =
    | Omit<ComposerVendorPluginMention, 'tokenText' | 'start' | 'end'>
    | Omit<ComposerSkillMention, 'tokenText' | 'start' | 'end'>
    | Omit<ComposerSessionMention, 'tokenText' | 'start' | 'end'>;

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

export type SessionDraftValueByFieldId = Readonly<{
    'routing.recipient': ParticipantRecipientV1 | null;
    'routing.executionRunDelivery': SessionComposerExecutionRunDeliveryMode;
    'structuredInput.mentions': readonly ComposerStructuredInputMention[];
}>;

export type SessionDraftValueFieldId = keyof SessionDraftValueByFieldId;

export const SessionDraftValueFieldSchemas = {
    'routing.recipient': ParticipantRecipientV1Schema.nullable(),
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
