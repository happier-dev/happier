import * as zMini from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';
import { asProtocolZod } from '../../plugins/actions/internalProtocolZodAdapter.js';
import { ExecutionRunIdSchema, SessionIdSchema } from '../idsV1.js';
import { SessionDiscussionParticipantV1Schema } from './sessionDiscussionParticipantV1.js';
import { DiscussionModelParticipantLaunchV1Schema } from '../../discussions/modelParticipantLaunch.js';

export const SessionOriginKindV1Schema = lazyZodSchema(() => z.enum(['none', 'session', 'execution_run', 'run_step', 'discussion']));
export type SessionOriginKindV1 = z.infer<typeof SessionOriginKindV1Schema>;
// Session and SessionTurn persist this fact in a signed 32-bit Prisma Int.
export const SessionWorkDepthV1Schema = lazyZodSchema(() => z.number().check(z.int(), z.nonnegative(), z.maximum(2_147_483_647)));

/** Authenticated host create facts, never public Action caller authority. */
const SessionCreateOriginFieldsBaseV1Schema = lazyZodSchema(() => z.strictObject({
  originKind: z.optional(SessionOriginKindV1Schema),
  originSessionId: zMini.optional(asProtocolZod(SessionIdSchema)),
  originRunId: zMini.optional(ExecutionRunIdSchema),
  discussionParticipant: z.optional(SessionDiscussionParticipantV1Schema),
  discussionParticipantLaunch: z.optional(DiscussionModelParticipantLaunchV1Schema),
  workDepth: z.optional(SessionWorkDepthV1Schema),
}));
export type SessionCreateOriginFieldsV1 = z.infer<typeof SessionCreateOriginFieldsBaseV1Schema>;

export function refineSessionCreateOriginFieldsV1(fields: SessionCreateOriginFieldsV1, context: z.core.ParsePayload): void {
  const kind = fields.originKind ?? 'none';
  if ((kind === 'discussion') !== (fields.discussionParticipant !== undefined)) {
    context.issues.push({ code: 'custom', path: ['discussionParticipant'], message: 'Discussion origin requires its exact participant slot', input: context.value, continue: true });
  }
  if ((kind === 'discussion') !== (fields.discussionParticipantLaunch !== undefined)) {
    context.issues.push({ code: 'custom', path: ['discussionParticipantLaunch'], message: 'Discussion origin requires its admitted launch selection', input: context.value, continue: true });
  }
  if (kind === 'discussion' && fields.originSessionId !== undefined) {
    context.issues.push({ code: 'custom', path: ['originSessionId'], message: 'Discussion origin has no parent Session', input: context.value, continue: true });
  }
  if ((kind === 'session' || kind === 'execution_run') && fields.originSessionId === undefined) {
    context.issues.push({ code: 'custom', path: ['originSessionId'], message: 'Origin requires its hosting Session', input: context.value, continue: true });
  }
  if (kind === 'run_step' && fields.originRunId === undefined) {
    context.issues.push({ code: 'custom', path: ['originRunId'], message: 'Step origin requires its workflow Run', input: context.value, continue: true });
  }
  if (fields.originRunId !== undefined && kind !== 'run_step') {
    context.issues.push({ code: 'custom', path: ['originRunId'], message: 'Only workflow steps name a server Run', input: context.value, continue: true });
  }
  if (kind === 'none' && fields.originSessionId !== undefined) {
    context.issues.push({ code: 'custom', path: ['originSessionId'], message: 'Originless creation cannot name a Session', input: context.value, continue: true });
  }
}

export const SessionCreateOriginFieldsV1Schema = lazyZodSchema(() => SessionCreateOriginFieldsBaseV1Schema.check(z.superRefine(refineSessionCreateOriginFieldsV1)));
