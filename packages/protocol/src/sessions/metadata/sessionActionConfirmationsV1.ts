import { lazyZodSchema } from '../../lazyZodSchema.js';
import { SessionPermissionAnsweringClientCategoryV1Schema } from '../permissions/respondRpcParamsV1.js';
import { z } from '../../zodRuntimePolicy.js';

import { ActionIdSchema } from '../../actions/actionIds.js';
import { StrictJsonValueSchema } from '../../json/strictJsonValue.js';
import { asProtocolZod } from '../../plugins/actions/internalProtocolZodAdapter.js';
import { ExecutionRunIdSchema, SessionIdSchema, SidechainIdSchema, TurnIdSchema } from '../idsV1.js';
import {
  SessionPermissionAccountIdV1Schema,
  SessionPermissionAccountUserDecisionActorV1Schema,
  SessionPermissionRequestIdV1Schema,
} from '../permissions/v1.js';

const RequestIdSchema = SessionPermissionRequestIdV1Schema;
const TimestampSchema = lazyZodSchema(() => z.number().check(z.int(), z.nonnegative(), z.maximum(Number.MAX_SAFE_INTEGER)));

/** Host confirmations keep their native request kind but always need an approval decision. */
export function isSessionActionConfirmationRequest(request: Readonly<{ source?: string }>): boolean {
  return request.source === 'happier_action';
}

export const SessionActionConfirmationResponseTargetV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('happier_action_confirmation_v1'),
  requestId: RequestIdSchema,
  actionId: ActionIdSchema,
  inputDigestV1: z.string().check(z.regex(/^sha256:[0-9a-f]{64}$/u)),
  runtimeAccountId: SessionPermissionAccountIdV1Schema,
  sessionId: asProtocolZod(SessionIdSchema),
  turnId: TurnIdSchema,
  run: z.optional(z.strictObject({
    runId: ExecutionRunIdSchema,
    occurrenceId: z.string().check(z.trim(), z.minLength(1)),
    sidechainId: SidechainIdSchema,
  })),
}));

const ArgumentsSchema = lazyZodSchema(() => z.strictObject({
  actionId: ActionIdSchema,
  preview: StrictJsonValueSchema,
  sessionId: asProtocolZod(SessionIdSchema),
  turnId: TurnIdSchema,
}));

const PresentUserClaimSchema = lazyZodSchema(() => z.strictObject({
  version: z.literal(1),
  origin: z.literal('presentUser'),
  actor: SessionPermissionAccountUserDecisionActorV1Schema,
  turnId: TurnIdSchema,
  decision: z.enum(['approved', 'denied', 'abort']),
  scope: z.literal('request'),
}));

export const SessionActionConfirmationRequestV1Schema = lazyZodSchema(() => z.strictObject({
  tool: z.literal('Happier Action confirmation'),
  kind: z.literal('user_action'),
  arguments: ArgumentsSchema,
  createdAt: TimestampSchema,
  turnId: TurnIdSchema,
  source: z.literal('happier_action'),
  responseTarget: SessionActionConfirmationResponseTargetV1Schema,
  sidechainId: z.optional(SidechainIdSchema),
  permissionResponseClaimV1: z.optional(PresentUserClaimSchema),
}));

export const SessionActionConfirmationCompletedV1Schema = lazyZodSchema(() => z.strictObject({
  tool: z.literal('Happier Action confirmation'),
  kind: z.literal('user_action'),
  arguments: ArgumentsSchema,
  createdAt: TimestampSchema,
  completedAt: TimestampSchema,
  status: z.enum(['canceled', 'denied', 'approved']),
  decision: z.enum(['approved', 'denied', 'abort']),
  reason: z.optional(z.string()),
  turnId: TurnIdSchema,
  source: z.literal('happier_action'),
  responseTarget: SessionActionConfirmationResponseTargetV1Schema,
  sidechainId: z.optional(SidechainIdSchema),
  permissionDecisionActorV1: z.optional(SessionPermissionAccountUserDecisionActorV1Schema),
  answeringClientCategory: z.optional(SessionPermissionAnsweringClientCategoryV1Schema),
}));

export const SessionActionConfirmationsV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  requests: z.record(RequestIdSchema, SessionActionConfirmationRequestV1Schema),
  completedRequests: z.record(RequestIdSchema, SessionActionConfirmationCompletedV1Schema),
}).check(z.superRefine((state, context) => {
  for (const [requestId, entry] of [
    ...Object.entries(state.requests),
    ...Object.entries(state.completedRequests),
  ]) {
    if (
      entry.responseTarget.requestId !== requestId
      || entry.arguments.actionId !== entry.responseTarget.actionId
      || entry.arguments.sessionId !== entry.responseTarget.sessionId
      || entry.arguments.turnId !== entry.responseTarget.turnId
      || entry.turnId !== entry.responseTarget.turnId
    ) {
      context.addIssue({
        code: "custom",
        message: 'Action confirmation request identity does not match its response target',
      });
    }
  }
})));
export type SessionActionConfirmationsV1 = z.infer<typeof SessionActionConfirmationsV1Schema>;
