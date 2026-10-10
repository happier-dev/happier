import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';
import { asProtocolZod } from '../../plugins/actions/internalProtocolZodAdapter.js';
import { ExecutionRunIdSchema, SessionIdSchema } from '../idsV1.js';

export const SessionOriginKindV1Schema = lazyZodSchema(() => z.enum(['none', 'session', 'execution_run', 'run_step']));
export type SessionOriginKindV1 = z.infer<typeof SessionOriginKindV1Schema>;
// Session and SessionTurn persist this fact in a signed 32-bit Prisma Int.
export const SessionWorkDepthV1Schema = lazyZodSchema(() => z.number().int().nonnegative().max(2_147_483_647));

/** Authenticated host create facts, never public Action caller authority. */
const SessionCreateOriginFieldsBaseV1Schema = lazyZodSchema(() => z.object({
  originKind: SessionOriginKindV1Schema.optional(),
  originSessionId: asProtocolZod(SessionIdSchema).optional(),
  originRunId: ExecutionRunIdSchema.optional(),
  workDepth: SessionWorkDepthV1Schema.optional(),
}).strict());
export type SessionCreateOriginFieldsV1 = z.infer<typeof SessionCreateOriginFieldsBaseV1Schema>;

export function refineSessionCreateOriginFieldsV1(fields: SessionCreateOriginFieldsV1, context: z.RefinementCtx): void {
  const kind = fields.originKind ?? 'none';
  if ((kind === 'session' || kind === 'execution_run') && fields.originSessionId === undefined) {
    context.addIssue({ code: 'custom', path: ['originSessionId'], message: 'Origin requires its hosting Session' });
  }
  if (kind === 'run_step' && fields.originRunId === undefined) {
    context.addIssue({ code: 'custom', path: ['originRunId'], message: 'Step origin requires its workflow Run' });
  }
  if (fields.originRunId !== undefined && kind !== 'run_step') {
    context.addIssue({ code: 'custom', path: ['originRunId'], message: 'Only workflow steps name a server Run' });
  }
  if (kind === 'none' && fields.originSessionId !== undefined) {
    context.addIssue({ code: 'custom', path: ['originSessionId'], message: 'Originless creation cannot name a Session' });
  }
}

export const SessionCreateOriginFieldsV1Schema = lazyZodSchema(() => SessionCreateOriginFieldsBaseV1Schema
  .superRefine(refineSessionCreateOriginFieldsV1));
