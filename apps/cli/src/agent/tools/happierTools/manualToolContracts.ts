import { z } from 'zod';
import {
  BackendTargetRefSchema,
  ExecutionRunIntentSchema,
  ExecutionRunStartRequestSchema,
  normalizeConnectedServiceSelectionForRunStart,
} from '@happier-dev/protocol';
import {
  defaultIoModeForExecutionRunIntent,
  defaultPermissionModeForExecutionRunIntent,
  defaultRunClassForExecutionRunIntent,
} from '@/session/services/executionRunStartDefaults';
import { lazySchema } from '@happier-dev/protocol';

export const changeTitleToolInputSchema = lazySchema(() => z.object({
  title: z.string().min(1),
}).passthrough());

export const actionExecuteToolInputSchema = lazySchema(() => z.object({
  actionId: z.string().min(1),
  input: z.unknown().optional(),
}).passthrough());

export const executionRunStartToolInputSchema = lazySchema(() => z.object({
  sessionId: z.string().min(1).optional(),
  intent: ExecutionRunIntentSchema,
  backendTarget: BackendTargetRefSchema.optional(),
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
}));

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

  // Normalize the agent-friendly connected-services selection (simple string / object) to canonical
  // bindings at this ONE boundary; malformed input is a typed rejection, never a silent drop.
  const normalizedConnectedServices = normalizeConnectedServiceSelectionForRunStart(parsed.data.connectedServices);
  if (!normalizedConnectedServices.ok) {
    // Align with the canonical action path (actionExecutor `execution.run.start`), which returns
    // `invalid_parameters` for a malformed connected-services selection. A malformed selection is a
    // bad parameter, not an unparseable action payload — keep the two contracts identical.
    return {
      ok: false,
      errorCode: 'invalid_parameters',
      error: normalizedConnectedServices.error,
    };
  }

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
    ...(normalizedConnectedServices.bindings !== undefined
      ? { connectedServices: normalizedConnectedServices.bindings }
      : {}),
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
