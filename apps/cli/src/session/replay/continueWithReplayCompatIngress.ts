import { z } from 'zod';

import {
  BackendTargetRefV2Schema,
  SessionContinueWithReplayRequestSchema,
  SessionContinueWithReplayRpcParamsSchema,
  normalizeBackendTargetRefV2InputToV2,
  normalizeLegacyContinueWithReplayRpcParamsInput,
  buildBackendTargetKeyV2,
  SessionModelSelectionV1Schema,
  type SessionContinueWithReplayRpcParams,
  validateLegacyContinueWithReplayRpcParamsCompat,
} from '@happier-dev/protocol';

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
      modelSelection: SessionModelSelectionV1Schema.optional(),
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
  .transform(({ agent: _agent, modelId, modelUpdatedAt, modelSelection, ...rest }, ctx) => {
    const targetKey = rest.backendTarget ? buildBackendTargetKeyV2(rest.backendTarget) : null;
    if (modelSelection && (!targetKey || modelSelection.ref.agentTargetKey !== targetKey)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['modelSelection', 'ref', 'agentTargetKey'],
        message: 'Model selection agent target must match backendTarget',
      });
      return z.NEVER;
    }
    const legacyModelId = typeof modelId === 'string' ? modelId.trim() : '';
    const normalizedSelection = modelSelection ?? (legacyModelId && targetKey
      ? SessionModelSelectionV1Schema.parse({
        v: 1,
        updatedAt: modelUpdatedAt ?? Date.now(),
        ref: { agentTargetKey: targetKey, providerConnectionId: null, modelId: legacyModelId },
      })
      : undefined);
    return { ...rest, ...(normalizedSelection ? { modelSelection: normalizedSelection } : {}) };
  });

export function parseSessionContinueWithReplayRpcParamsCompatIngress(
  raw: unknown,
): z.ZodSafeParseResult<SessionContinueWithReplayRpcParams> {
  const compatParsed = SessionContinueWithReplayCompatIngressSchema.safeParse(raw);
  if (!compatParsed.success) {
    return compatParsed as z.ZodSafeParseError<SessionContinueWithReplayRpcParams>;
  }
  return SessionContinueWithReplayRpcParamsSchema.safeParse(compatParsed.data);
}
