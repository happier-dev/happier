import type { SessionFollowOriginalOccurrenceV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowRuleOccurrenceV1';
import { z } from 'zod/mini';
import { FollowPolicyV1Schema } from '@happier-dev/protocol/sessions/follow/sessionFollowPolicyV1';
import { RunFollowOccurrenceV1Schema } from '@happier-dev/protocol/sessions/follow/sessionFollowInputV1';
import { SessionFollowRuleSourceOccurrenceV1Schema } from '@happier-dev/protocol/sessions/follow/sessionFollowRuleOccurrenceV1';

/** Source-original hint only. The dispatcher re-reads retained source and relation authority. */
export const SessionFollowRunOccurrenceSchema = RunFollowOccurrenceV1Schema;
export type SessionFollowRunOccurrence = z.infer<typeof SessionFollowRunOccurrenceSchema>;
export const SessionFollowOccurrenceNotificationSchema = z.union([
    SessionFollowRuleSourceOccurrenceV1Schema, SessionFollowRunOccurrenceSchema,
]);
export type SessionFollowOccurrenceNotification = z.infer<typeof SessionFollowOccurrenceNotificationSchema>;

/** Private source-to-original-owner contribution. Rule definitions and identities never leave the evaluator. */
export const SessionActivityChangedResultSchema = z.strictObject({
    personalFollow: z.optional(z.strictObject({
        sourceSessionId: z.string().check(z.minLength(1)),
        /** Proven existing source-backed Inbox effect, never a provider callback. */
        accepted: z.optional(z.literal(true)),
        requests: z.optional(z.array(z.strictObject({
            requestId: z.string().check(z.minLength(1)),
            policies: z.array(FollowPolicyV1Schema),
        }))),
        sourceMessage: z.optional(z.strictObject({
            localId: z.string().check(z.minLength(1)),
            seq: z.number().check(z.int(), z.positive()),
            policies: z.array(FollowPolicyV1Schema),
        })),
    })),
});
export type SessionActivityChangedResult = z.infer<typeof SessionActivityChangedResultSchema>;
export const SessionActivityChangedResponseSchema = z.strictObject({
    ok: z.literal(true),
    ...SessionActivityChangedResultSchema.shape,
});

export function projectSessionFollowOccurrenceDiagnostic(occurrence: SessionFollowOriginalOccurrenceV1): Readonly<{
    sourceSessionId: string; sourceMessageSeq?: number; sourceTurnId?: string; agentStateVersion?: number;
}> {
    return { sourceSessionId: occurrence.sourceSessionId,
        ...('sourceMessage' in occurrence ? { sourceMessageSeq: occurrence.sourceMessage.seq }
            : 'sourceTurn' in occurrence ? { sourceTurnId: occurrence.sourceTurn.id }
                : { agentStateVersion: occurrence.sourceRequests.agentStateVersion }) };
}
