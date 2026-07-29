import { z } from 'zod';
import {
  AcpConfigOptionOverridesV1Schema,
  BackendTargetRefV2InputSchema,
  ExecutionRunIntentSchema,
  ExecutionRunStartRequestSchema,
  SpawnConfigOptionValueSchema,
  findSpawnConfigOptionAliasConflicts,
  mergeSpawnConfigOptionAliases,
  normalizeConnectedServiceSelectionInput,
} from '@happier-dev/protocol';
import {
  defaultIoModeForExecutionRunIntent,
  defaultPermissionModeForExecutionRunIntent,
  defaultRunClassForExecutionRunIntent,
} from '@/session/services/executionRunStartDefaults';

export const changeTitleToolInputSchema = z.object({
  title: z.string().min(1),
}).passthrough();

export const actionExecuteToolInputSchema = z.object({
  actionId: z.string().min(1),
  input: z.unknown().optional(),
}).passthrough();

export const pluginsReloadToolInputSchema = z.object({
  pluginId: z.string().min(1),
}).passthrough();

export const executionRunStartToolInputSchema = z.object({
  sessionId: z.string().min(1).optional(),
  intent: ExecutionRunIntentSchema,
  backendTarget: BackendTargetRefV2InputSchema.optional(),
  backendId: z.string().min(1).optional(),
  instructions: z.string().optional(),
  display: z.unknown().optional(),
  intentInput: z.unknown().optional(),
  initialContextMode: z.enum(['bootstrap', 'first_turn']).optional(),
  resumeHandle: z.unknown().optional(),
  replay: z.unknown().optional(),
  permissionMode: z.string().min(1).optional(),
  retentionPolicy: z.enum(['ephemeral', 'resumable']).optional(),
  runClass: z.enum(['bounded', 'long_lived']).optional(),
  ioMode: z.enum(['request_response', 'streaming']).optional(),
  connectedServices: z.unknown().optional(),
  modelId: z.string().min(1).optional(),
  sessionConfigOptionOverrides: AcpConfigOptionOverridesV1Schema.optional(),
  configOptions: z.record(z.string(), SpawnConfigOptionValueSchema).optional(),
}).passthrough().superRefine((value, ctx) => {
  const hasBackendTarget = typeof value.backendTarget !== 'undefined';
  const backendId = typeof value.backendId === 'string' ? value.backendId.trim() : '';
  if (!hasBackendTarget && !backendId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['backendTarget'],
      message: 'backendTarget is required (or provide legacy backendId)',
    });
  }
});

export function normalizeExecutionRunStartToolInput(params: Readonly<{
  sessionId: string;
  args: unknown;
}>):
  | Readonly<{ ok: true; request: z.infer<typeof ExecutionRunStartRequestSchema> }>
  | Readonly<{ ok: false; errorCode: 'invalid_action_input' | 'invalid_parameters' | 'execution_run_not_allowed'; error: string }> {
  const parsed = executionRunStartToolInputSchema.safeParse(params.args ?? {});
  if (!parsed.success) {
    return {
      ok: false,
      errorCode: 'invalid_action_input',
      error: 'Invalid execution run payload',
    };
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
    ...(connectedServices ? { connectedServices } : {}),
    ...(typeof parsed.data.modelId === 'string' ? { modelId: parsed.data.modelId } : {}),
    ...(sessionConfigOptionOverrides ? { sessionConfigOptionOverrides } : {}),
  });
  if (!request.success) {
    return {
      ok: false,
      errorCode: 'invalid_action_input',
      error: 'Invalid execution run payload',
    };
  }

  return {
    ok: true,
    request: request.data,
  };
}
