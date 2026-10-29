import { z } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { SessionIdSchema, TurnIdSchema } from '../idsV1.js';
import { PendingLocalIdSchema } from '../pending/pendingLocalId.js';
import { SessionTurnLifecycleStatusV1Schema } from '../turns/sessionTurnLifecycleStatusV1.js';
import { SessionRuntimeIssueV1Schema } from '../control/runtimeIssueV1.js';
import { SessionMessageRefV1Schema } from './sessionMessageRefV1.js';
import { SessionTargetV1Schema } from '../../actions/sessionTargetV1.js';
import { asProtocolZod } from '../../plugins/actions/internalProtocolZodAdapter.js';
import { SessionMessageReplyReadResultV1Schema } from './sessionMessageReplyV1.js';
import { SessionInputAdmissionRejectionCodeV1Schema } from './sessionInputAdmissionRejectionV1.js';

export const SessionInputUsageV1Schema = lazyZodSchema(() => z.strictObject({
    inputTokens: z.optional(z.number()), outputTokens: z.optional(z.number()), costUsd: z.optional(z.number()),
}));
export type SessionInputUsageV1 = z.infer<typeof SessionInputUsageV1Schema>;

/** The canonical exact-input result, shared by waiting and nonblocking readers. */
export const SessionInputResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('pending') }),
    z.strictObject({ kind: z.literal('final_text'), text: z.string(), usage: z.optional(SessionInputUsageV1Schema), messageRef: z.optional(SessionMessageRefV1Schema) }),
    z.strictObject({ kind: z.literal('terminal_no_result'), reason: z.literal('missing_final_assistant_text'), usage: z.optional(SessionInputUsageV1Schema) }),
    z.strictObject({ kind: z.literal('failed'), message: z.string(), runtimeIssueV1: z.optional(SessionRuntimeIssueV1Schema), usage: z.optional(SessionInputUsageV1Schema) }),
    z.strictObject({ kind: z.literal('cancelled'), message: z.string(), partialText: z.optional(z.string()), messageRef: z.optional(SessionMessageRefV1Schema), usage: z.optional(SessionInputUsageV1Schema) }),
]));
export type SessionInputResultV1 = z.infer<typeof SessionInputResultV1Schema>;

/** Content-free projection of an exact Pending input's proven pre-effect refusal. */
export const SessionInputRefusalDispositionV1Schema = lazyZodSchema(() => z.strictObject({
    localId: PendingLocalIdSchema,
    result: z.strictObject({ status: z.literal('rejected'), code: SessionInputAdmissionRejectionCodeV1Schema }),
}));
export type SessionInputRefusalDispositionV1 = z.infer<typeof SessionInputRefusalDispositionV1Schema>;

export const SessionInputResultGetInputV1Schema = lazyZodSchema(() => z.strictObject({ sessionId: SessionTargetV1Schema, localId: PendingLocalIdSchema,
    projection: z.optional(z.literal('reply')) }));
export const SessionInputResultGetResultV1Schema = lazyZodSchema(() => z.union([
    z.strictObject({ ok: z.literal(true), sessionId: asProtocolZod(SessionIdSchema), localId: PendingLocalIdSchema,
        acceptedTurnId: z.optional(TurnIdSchema), turnStartWitnessId: z.optional(TurnIdSchema),
        turnStatus: z.optional(SessionTurnLifecycleStatusV1Schema), result: SessionInputResultV1Schema }),
    z.strictObject({ ok: z.literal(true), sessionId: asProtocolZod(SessionIdSchema), localId: PendingLocalIdSchema,
        projection: z.literal('reply'), reply: SessionMessageReplyReadResultV1Schema }),
    z.strictObject({ ok: z.literal(false), code: z.union([
        z.enum(['session_not_found', 'session_id_ambiguous', 'session_lookup_timeout',
            'unsupported', 'encryption_material_unavailable', 'invalid_local_id', 'cancelled', 'result_read_failed']),
        SessionInputAdmissionRejectionCodeV1Schema,
    ]), candidates: z.optional(z.array(z.string())) }),
]));
export type SessionInputResultGetResultV1 = z.infer<typeof SessionInputResultGetResultV1Schema>;
