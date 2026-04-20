import { z } from 'zod';

import {
  normalizeLegacyContinueWithReplayRpcParamsInput,
  validateLegacyContinueWithReplayRpcParamsCompat,
} from './backendTargets/compat/continueWithReplayRpcParamsCompat.js';
import {
  BackendTargetRefV2Schema,
  normalizeBackendTargetRefV2InputToV2,
} from './backendTargets/backendTargetRefV2.js';
import {
  SessionContinueWithReplayRequestSchema,
  SessionContinueWithReplayRpcParamsSchema,
  type SessionContinueWithReplayRpcParams,
} from './sessionContinueWithReplay.js';

const SessionContinueWithReplayCompatIngressSchema = z
  .preprocess(
    normalizeLegacyContinueWithReplayRpcParamsInput,
    z.object({
      directory: z.string().min(1),
      agent: z.string().min(1).optional(),
      backendTarget: z.preprocess(normalizeBackendTargetRefV2InputToV2, BackendTargetRefV2Schema.optional()),
      approvedNewDirectoryCreation: z.boolean().optional(),
      permissionMode: z.string().optional(),
      permissionModeUpdatedAt: z.number().finite().optional(),
      modelId: z.string().optional(),
      modelUpdatedAt: z.number().finite().optional(),
      replay: SessionContinueWithReplayRequestSchema,
    }).passthrough(),
  )
  .superRefine((value, ctx) => {
    validateLegacyContinueWithReplayRpcParamsCompat(value, ctx);
    if (!value.agent && !value.backendTarget) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'backendTarget is required',
        path: ['backendTarget'],
      });
    }
  })
  .transform(({ agent: _agent, ...rest }) => rest);

export function parseSessionContinueWithReplayRpcParamsCompatIngress(
  raw: unknown,
): z.ZodSafeParseResult<SessionContinueWithReplayRpcParams> {
  const compatParsed = SessionContinueWithReplayCompatIngressSchema.safeParse(raw);
  if (!compatParsed.success) {
    return compatParsed as z.ZodSafeParseError<SessionContinueWithReplayRpcParams>;
  }
  return SessionContinueWithReplayRpcParamsSchema.safeParse(compatParsed.data);
}
