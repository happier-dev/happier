import { z } from 'zod/mini';

import { BackendTargetRefV2Schema, normalizeBackendTargetRefV2InputToV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { SessionContinueWithReplayRequestSchema, SessionContinueWithReplayRpcParamsSchema } from '@happier-dev/protocol/sessions/continueWithReplay';
import { normalizeLegacyContinueWithReplayRpcParamsInput, validateLegacyContinueWithReplayRpcParamsCompat } from '@happier-dev/protocol/backends/targets/compat/continueWithReplayRpcParamsCompat';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { SessionModelSelectionV1Schema } from '@happier-dev/protocol/providers/model-selection';
import { SessionModelSelectionSchema } from '@happier-dev/protocol/providers/selection/v2';
import type { SessionContinueWithReplayRpcParams } from '@happier-dev/protocol';

const SessionContinueWithReplayCompatIngressSchema = z.pipe((<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform(normalizeLegacyContinueWithReplayRpcParamsInput), z.looseObject({
      directory: z.string().check(z.minLength(1)),
      agent: z.optional(z.string().check(z.minLength(1))),
      backendTarget: (<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform(normalizeBackendTargetRefV2InputToV2), z.optional(BackendTargetRefV2Schema)),
      approvedNewDirectoryCreation: z.optional(z.boolean()),
      permissionMode: z.optional(z.string()),
      permissionModeUpdatedAt: z.optional(z.number()),
      modelId: z.optional(z.string()),
      modelUpdatedAt: z.optional(z.number()),
      modelSelection: z.optional(SessionModelSelectionSchema),
      replay: SessionContinueWithReplayRequestSchema,
    })).check(z.superRefine((value, ctx) => {
    validateLegacyContinueWithReplayRpcParamsCompat(value, ctx);
    if (!value.agent && !value.backendTarget) {
      ctx.addIssue({
        code: "custom",
        message: 'backendTarget is required',
        path: ['backendTarget'],
      });
    }
  })), z.transform(({ agent: _agent, modelId, modelUpdatedAt, modelSelection, ...rest }, ctx) => {
    const targetKey = rest.backendTarget ? buildBackendTargetKeyV2(rest.backendTarget) : null;
    if (modelSelection && (!targetKey || modelSelection.ref.agentTargetKey !== targetKey)) {
      ctx.issues.push({
        code: "custom",
        path: ['modelSelection', 'ref', 'agentTargetKey'],
        message: 'Model selection agent target must match backendTarget', input: ctx.value });
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
  }));

export function parseSessionContinueWithReplayRpcParamsCompatIngress(
  raw: unknown,
): z.core.util.SafeParseResult<SessionContinueWithReplayRpcParams> {
  const compatParsed = SessionContinueWithReplayCompatIngressSchema.safeParse(raw);
  if (!compatParsed.success) {
    return compatParsed as z.core.util.SafeParseError<SessionContinueWithReplayRpcParams>;
  }
  return SessionContinueWithReplayRpcParamsSchema.safeParse(compatParsed.data);
}
