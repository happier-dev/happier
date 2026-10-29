import { lazyZodSchema } from '@happier-dev/protocol/lazyZodSchema';
import { z } from 'zod/mini';
import { AcpConfigOptionOverridesV1Schema } from '@happier-dev/protocol/sessions/metadata/overrides';
import { BackendTargetRefV2InputSchema } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { ExecutionRunIntentSchema } from '@happier-dev/protocol/execution/runs/runPrimitives';
import { ExecutionRunStartRequestSchema } from '@happier-dev/protocol/execution/runs/startRequest';
import { SpawnConfigOptionValueSchema, findSpawnConfigOptionAliasConflicts, mergeSpawnConfigOptionAliases } from '@happier-dev/protocol/actions/sessionSpawnConfigOptions';
import { normalizeConnectedServiceSelectionInput } from '@happier-dev/protocol/connect/normalizeConnectedServiceSelectionInput';
import { actionInputValidationFailure } from '@happier-dev/protocol/actions/executor/actionInputValidation';
import {
  defaultIoModeForExecutionRunIntent,
  defaultPermissionModeForExecutionRunIntent,
  defaultRunClassForExecutionRunIntent,
} from '@/session/services/executionRunStartDefaults';

export const changeTitleToolInputSchema = lazyZodSchema(() => z.looseObject({
  title: z.string().check(z.minLength(1)),
}));

export const actionExecuteToolInputSchema = lazyZodSchema(() => z.looseObject({
  actionId: z.string().check(z.minLength(1)),
  input: z.optional(z.unknown()),
}));

export const executionRunStartToolInputSchema = lazyZodSchema(() => z.looseObject({
  sessionId: z.optional(z.string().check(z.minLength(1))),
  intent: ExecutionRunIntentSchema,
  backendTarget: z.optional(BackendTargetRefV2InputSchema),
  backendId: z.optional(z.string().check(z.minLength(1))),
  instructions: z.optional(z.string()),
  display: z.optional(z.unknown()),
  intentInput: z.optional(z.unknown()),
  initialContextMode: z.optional(z.enum(['bootstrap', 'first_turn'])),
  resumeHandle: z.optional(z.unknown()),
  replay: z.optional(z.unknown()),
  permissionMode: z.optional(z.string().check(z.minLength(1))),
  retentionPolicy: z.optional(z.enum(['ephemeral', 'resumable'])),
  runClass: z.optional(z.enum(['bounded', 'long_lived'])),
  ioMode: z.optional(z.enum(['request_response', 'streaming'])),
  connectedServices: z.optional(z.unknown()),
  modelId: z.optional(z.string().check(z.minLength(1))),
  sessionConfigOptionOverrides: z.optional(AcpConfigOptionOverridesV1Schema),
  configOptions: z.optional(z.record(z.string(), SpawnConfigOptionValueSchema)),
}).check(z.superRefine((value, ctx) => {
  const hasBackendTarget = typeof value.backendTarget !== 'undefined';
  const backendId = typeof value.backendId === 'string' ? value.backendId.trim() : '';
  if (!hasBackendTarget && !backendId) {
    ctx.addIssue({
      code: "custom",
      path: ['backendTarget'],
      message: 'backendTarget is required (or provide legacy backendId)',
    });
  }
})));

export function normalizeExecutionRunStartToolInput(params: Readonly<{
  sessionId: string;
  args: unknown;
}>):
  | Readonly<{ ok: true; request: z.infer<typeof ExecutionRunStartRequestSchema> }>
  | Readonly<{ ok: false; errorCode: 'invalid_parameters' | 'execution_run_not_allowed'; error: string; details?: unknown }> {
  const parsed = executionRunStartToolInputSchema.safeParse(params.args ?? {});
  if (!parsed.success) {
    return { ...actionInputValidationFailure(parsed.error), errorCode: 'invalid_parameters' };
  }

  if (typeof parsed.data.sessionId === 'string' && parsed.data.sessionId.trim() !== params.sessionId) {
    return {
      ok: false,
      errorCode: 'execution_run_not_allowed',
      error: 'This tool call is scoped to a different session',
    };
  }

  const backendTarget = parsed.data.backendTarget ?? {
    kind: 'builtInAgent' as const,
    agentId: String(parsed.data.backendId ?? '').trim(),
  };

  // Validate the optional connected-services selection at this ONE boundary via the SAME normalizer
  // the canonical action path uses — accepts the agent-friendly simple string / array / full object
  // forms. A malformed selection is a bad parameter, not an unparseable action payload; the two
  // contracts must stay identical.
  let connectedServices: unknown;
  if (typeof parsed.data.connectedServices !== 'undefined') {
    const normalized = normalizeConnectedServiceSelectionInput(parsed.data.connectedServices);
    if (!normalized.ok) {
      return {
        ok: false,
        errorCode: 'invalid_parameters',
        error: 'Invalid connected-services selection',
      };
    }
    connectedServices = normalized.bindings;
  }

  // Merge the `configOptions` shorthand into the canonical `sessionConfigOptionOverrides` (reasoning
  // effort, etc.) via the SAME owner session spawn + the canonical action path use; a conflict is a
  // bad parameter.
  if (findSpawnConfigOptionAliasConflicts({
    sessionConfigOptionOverrides: parsed.data.sessionConfigOptionOverrides,
    configOptions: parsed.data.configOptions,
  }).length > 0) {
    return { ok: false, errorCode: 'invalid_parameters', error: 'Conflicting configOptions and sessionConfigOptionOverrides' };
  }
  const sessionConfigOptionOverrides = mergeSpawnConfigOptionAliases({
    ...(parsed.data.sessionConfigOptionOverrides ? { sessionConfigOptionOverrides: parsed.data.sessionConfigOptionOverrides } : {}),
    ...(parsed.data.configOptions ? { configOptions: parsed.data.configOptions } : {}),
  });

  const request = ExecutionRunStartRequestSchema.safeParse({
    intent: parsed.data.intent,
    backendTarget,
    ...(typeof parsed.data.instructions === 'string' ? { instructions: parsed.data.instructions } : {}),
    ...(typeof parsed.data.display !== 'undefined' ? { display: parsed.data.display } : {}),
    ...(typeof parsed.data.intentInput !== 'undefined' ? { intentInput: parsed.data.intentInput } : {}),
    permissionMode: parsed.data.permissionMode ?? defaultPermissionModeForExecutionRunIntent(parsed.data.intent),
    retentionPolicy: parsed.data.retentionPolicy ?? 'ephemeral',
    runClass: parsed.data.runClass ?? defaultRunClassForExecutionRunIntent(parsed.data.intent),
    ioMode: parsed.data.ioMode ?? defaultIoModeForExecutionRunIntent(parsed.data.intent),
    ...(typeof parsed.data.initialContextMode !== 'undefined' ? { initialContextMode: parsed.data.initialContextMode } : {}),
    ...(typeof parsed.data.resumeHandle !== 'undefined' ? { resumeHandle: parsed.data.resumeHandle } : {}),
    ...(typeof parsed.data.replay !== 'undefined' ? { replay: parsed.data.replay } : {}),
    ...(connectedServices !== undefined ? { connectedServices } : {}),
    ...(typeof parsed.data.modelId === 'string' ? { modelId: parsed.data.modelId } : {}),
    ...(sessionConfigOptionOverrides ? { sessionConfigOptionOverrides } : {}),
  });
  if (!request.success) {
    return { ...actionInputValidationFailure(request.error), errorCode: 'invalid_parameters' };
  }

  return {
    ok: true,
    request: request.data,
  };
}
