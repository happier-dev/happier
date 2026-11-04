import { z } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { AnyClientUpgradeRequiredV1Schema, type AnyClientUpgradeRequiredV1 } from '../../clientCompatibility/upgradeRequiredV1.js';
import { OperationUpdateRequiredV1Schema, type OperationUpdateRequiredV1 } from '../../compat/operationUpdateRequiredV1.js';
import { V2SessionByIdResponseSchema, type V2SessionByIdResponse } from '../control/contract.js';
import { SessionMessagesPageV1Schema, type SessionMessagesPageV1 } from '../messages/sessionMessagesPageV1.js';
import { SessionTurnsProjectionV1Schema, type SessionTurnsProjectionV1 } from '../turns/sessionTurnV1.js';

export type SessionReadBatchRequestV1 = {
  sessionIds: string[];
  accessProjectionVersion?: 1;
  /** List-document hydration remains confined to the current managed subtree. */
  underSessionId?: string;
  includeSnapshot: boolean;
  includeTurns?: boolean;
  includeMessages: boolean;
};

/** The application HTTP body limit owns request size; there is no competing id cap. */
export const SessionReadBatchRequestV1Schema: z.ZodMiniType<SessionReadBatchRequestV1> = lazyZodSchema(() => z.strictObject({
  sessionIds: z.array(z.string().check(z.minLength(1))),
  accessProjectionVersion: z.optional(z.literal(1)),
  underSessionId: z.optional(z.string().check(z.minLength(1))),
  includeSnapshot: z._default(z.boolean(), true),
  /** Omission keeps the full snapshot contract; context-only readers explicitly omit turns. */
  includeTurns: z.optional(z.boolean()),
  includeMessages: z._default(z.boolean(), false),
}).check(z.refine(value => value.includeSnapshot || value.includeMessages, {
  message: 'At least one Session read part is required',
})).check(z.refine(value => value.includeTurns !== true || value.includeSnapshot, {
  message: 'Session turns require a snapshot demand',
})).check(z.refine(value => value.underSessionId === undefined
  || (value.includeSnapshot && value.includeTurns === false && !value.includeMessages), {
  message: 'Managed-subtree demand requires snapshot-only reads without turns',
})));
type SessionReadFailureV1 = {
  status: 400 | 401 | 403 | 404 | 409 | 426 | 429 | 500 | 503;
  body: { error: string; code?: string } | AnyClientUpgradeRequiredV1 | OperationUpdateRequiredV1;
};
const SessionReadFailureV1Schema: z.ZodMiniType<SessionReadFailureV1> = lazyZodSchema(() => z.strictObject({
  status: z.union([z.literal(400), z.literal(401), z.literal(403), z.literal(404),
    z.literal(409), z.literal(426), z.literal(429), z.literal(500), z.literal(503)]),
  body: z.union([
    z.strictObject({ error: z.string(), code: z.optional(z.string()) }),
    AnyClientUpgradeRequiredV1Schema,
    OperationUpdateRequiredV1Schema,
  ]),
}));

export type SessionReadBatchDetailV1 = { status: 200; body: V2SessionByIdResponse } | SessionReadFailureV1;
export type SessionReadBatchTurnsV1 = { status: 200; body: SessionTurnsProjectionV1 } | SessionReadFailureV1;
export type SessionReadBatchMessagesV1 = { status: 200; body: SessionMessagesPageV1 } | SessionReadFailureV1;

export const SessionReadBatchDetailV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ status: z.literal(200), body: V2SessionByIdResponseSchema }),
  SessionReadFailureV1Schema,
])) satisfies z.ZodMiniType<SessionReadBatchDetailV1>;
export const SessionReadBatchTurnsV1Schema: z.ZodMiniType<SessionReadBatchTurnsV1> = lazyZodSchema(() => z.union([
  z.strictObject({ status: z.literal(200), body: SessionTurnsProjectionV1Schema }),
  SessionReadFailureV1Schema,
]));
export const SessionReadBatchMessagesV1Schema: z.ZodMiniType<SessionReadBatchMessagesV1> = lazyZodSchema(() => z.union([
  z.strictObject({ status: z.literal(200), body: SessionMessagesPageV1Schema }),
  SessionReadFailureV1Schema,
]));

export type SessionReadBatchResultV1 = {
  sessionId: string;
  detail?: SessionReadBatchDetailV1;
  turns?: SessionReadBatchTurnsV1;
  messages?: SessionReadBatchMessagesV1;
};
export type SessionReadBatchResponseV1 = { results: SessionReadBatchResultV1[] };

/** Components retain single-read admission failures; clients open their normal envelopes. */
// Bound declaration emission while preserving object identity for safeExtend consumers.
export const SessionReadBatchResultV1Schema: z.ZodMiniObject<{
  sessionId: z.ZodMiniString<string>;
  detail: z.ZodMiniOptional<typeof SessionReadBatchDetailV1Schema>;
  turns: z.ZodMiniOptional<typeof SessionReadBatchTurnsV1Schema>;
  messages: z.ZodMiniOptional<typeof SessionReadBatchMessagesV1Schema>;
}, z.core.$strict> = lazyZodSchema(() => z.strictObject({
  sessionId: z.string().check(z.minLength(1)),
  detail: z.optional(SessionReadBatchDetailV1Schema),
  turns: z.optional(SessionReadBatchTurnsV1Schema),
  messages: z.optional(SessionReadBatchMessagesV1Schema),
})) satisfies z.ZodMiniType<SessionReadBatchResultV1>;
export const SessionReadBatchResponseV1Schema: z.ZodMiniObject<{
  results: z.ZodMiniArray<typeof SessionReadBatchResultV1Schema>;
}, z.core.$strict> = lazyZodSchema(() => z.strictObject({
  results: z.array(SessionReadBatchResultV1Schema),
})) satisfies z.ZodMiniType<SessionReadBatchResponseV1>;
