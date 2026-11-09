import { z } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { defineStoredReadProjection } from '../../json/storedReadSchema.js';
import { InteractionTransientAuthorRequestV1Schema, InteractionTransientQuestionsAuthorRequestV1Schema } from '../../plugins/interactions/transientV1.js';
// Keep this cyclic export live under Metro's named-import snapshot transform.
import * as sessionPermissions from './v1.js';

const NonemptyText = z.string().check(z.trim(), z.minLength(1));

export const SessionQuestionHandlerV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('person'), accountId: z.optional(sessionPermissions.SessionPermissionAccountIdV1Schema) }),
    z.strictObject({ kind: z.literal('session'), sessionId: NonemptyText }),
]));
export type SessionQuestionHandlerV1 = z.infer<typeof SessionQuestionHandlerV1Schema>;

export const SessionQuestionContextV1Schema = lazyZodSchema(() => z.strictObject({
    mode: z.enum(['wait', 'continue']),
    assumption: z.optional(NonemptyText),
    lasting: z.boolean(),
    type: z.optional(z.enum(['decision', 'blocked'])),
    reason: z.optional(NonemptyText),
}).check(z.superRefine((value, context) => {
    if (value.mode === 'continue' && !value.assumption) {
        context.addIssue({ code: 'custom', path: ['assumption'], message: 'Continue requires an assumption.' });
    }
})));
export type SessionQuestionContextV1 = z.infer<typeof SessionQuestionContextV1Schema>;
// Routing and question identity remain closed beneath permissive stored reads.
defineStoredReadProjection(SessionQuestionHandlerV1Schema, () => SessionQuestionHandlerV1Schema);
defineStoredReadProjection(SessionQuestionContextV1Schema, () => SessionQuestionContextV1Schema);

const RaiseQuestionV1Schema = lazyZodSchema(() => z.strictObject({
    sessionId: z.optional(NonemptyText),
    mode: z.enum(['wait', 'continue']),
    type: z.enum(['decision', 'blocked']),
    assumption: z.optional(NonemptyText),
    lasting: z.optional(z.boolean()),
    reason: z.optional(NonemptyText),
    title: InteractionTransientQuestionsAuthorRequestV1Schema.shape.title,
    questions: InteractionTransientQuestionsAuthorRequestV1Schema.shape.questions,
}).check(z.superRefine((value, context) => {
    const form = InteractionTransientAuthorRequestV1Schema.safeParse({ kind: 'questions', title: value.title, questions: value.questions });
    if (!form.success) for (const issue of form.error.issues) context.addIssue({ ...issue });
    if (value.mode === 'continue' && !value.assumption) {
        context.addIssue({ code: 'custom', path: ['assumption'], message: 'Continue requires an assumption.' });
    }
})));

export const SessionNeedsYouRaiseInputV1Schema = lazyZodSchema(() => z.union([
    RaiseQuestionV1Schema,
    z.strictObject({ sessionId: z.optional(NonemptyText), requestId: NonemptyText, withdraw: NonemptyText }),
]));
export type SessionNeedsYouRaiseInputV1 = z.infer<typeof SessionNeedsYouRaiseInputV1Schema>;

export const SessionNeedsYouRaiseOutputV1Schema = lazyZodSchema(() => z.union([
    z.strictObject({ ok: z.literal(true), requestId: NonemptyText, mode: z.enum(['wait', 'continue']) }),
    z.strictObject({ ok: z.literal(true), requestId: NonemptyText, withdrawn: z.literal(true) }),
]));
export type SessionNeedsYouRaiseOutputV1 = z.infer<typeof SessionNeedsYouRaiseOutputV1Schema>;
