import { lazyActionSpecRecord } from '../lazyActionSpecValue.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

import {
  BackendTargetKeySchema,
  buildBackendTargetKey,
} from '../../backends/targets/backendTargetRef.js';
import {
  BackendTargetKeyV2Schema,
  parseBackendTargetKeyV2,
  readBackendTargetRefV2,
  resolveBundledAgentRoutingIdV1,
  type BackendTargetRefV2,
} from '../../backends/targets/backendTargetRefV2.js';
import {
  buildQualifiedPluginContributionKey,
} from '../../plugins/contributionIdentity.js';
import {
  ExecutionRunClassSchema,
  ExecutionRunIntentSchema,
  ExecutionRunIoModeSchema,
  ExecutionRunRetentionPolicySchema,
  type ExecutionRunIntent,
} from '../../execution/runs/runPrimitives.js';
import { ExecutionRunStatusSchema } from '../../execution/runs/listRequest.js';
import { executionRunKindForIntent } from '../../execution/runs/startRequest.js';
import { EXECUTION_RUN_INTENT_OPTIONS, EXECUTION_RUN_INTENT_POLICY_MATRIX } from '../../execution/runs/intentPolicyMatrix.js';
import {
  EXECUTION_RUN_ACTION_PERMISSION_INPUTS,
  ExecutionRunActionPermissionModeSchema,
  defaultExecutionRunPermissionMode,
} from '../executionRunActionPermissionMode.js';
import { actionCliDerivedDefault, type ActionCliProjection } from '../actionCliProjection.js';

const SessionSelectorSchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1)));
const RunIdSchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1)));

/** Existing friendly defaults, shared by the compiled command and workflow adapters. */
export { defaultExecutionRunPermissionMode };

export function defaultExecutionRunClass(intent: ExecutionRunIntent): 'bounded' | 'long_lived' {
  return EXECUTION_RUN_INTENT_POLICY_MATRIX[intent].allowedRunClasses[0];
}

export function defaultExecutionRunIoMode(
  intent: ExecutionRunIntent,
): 'request_response' | 'streaming' {
  return EXECUTION_RUN_INTENT_POLICY_MATRIX[intent].allowedIoModes[0];
}

export function defaultExecutionRunRetention(
  intent: ExecutionRunIntent,
): 'ephemeral' | 'resumable' {
  return EXECUTION_RUN_INTENT_POLICY_MATRIX[intent].allowedRetentionPolicies[0];
}

/**
 * Resolves only syntax and stable contribution identity. Availability and
 * enablement remain with the runtime/options owner; a CLI binder has no host
 * catalog, credentials or authorization callback by design.
 */
export function readExecutionRunCliBackendTarget(raw: string): BackendTargetRefV2 | null {
  const value = raw.trim();
  // The friendly start command selects exactly one Agent.  Comma-separated
  // values are the legacy multi-target list grammar used by other workflows;
  // treating the whole string as one built-in id delays a clear argv error
  // until after authentication and Action dispatch.
  if (!value || value === 'customAcp' || value.includes(',')) return null;
  try {
    const v2Key = BackendTargetKeyV2Schema.safeParse(value);
    if (v2Key.success) {
      const target = parseBackendTargetKeyV2(v2Key.data);
      if (target.kind === 'backend') return readBackendTargetRefV2(target);
      const backendId = resolveBundledAgentRoutingIdV1(target.identity)
        ?? buildQualifiedPluginContributionKey(target.identity);
      return { kind: 'backend', backendId, sourceKind: 'built_in' };
    }

    const legacyKey = BackendTargetKeySchema.safeParse(value);
    return readBackendTargetRefV2(
      legacyKey.success
        ? legacyKey.data
        : buildBackendTargetKey({ kind: 'builtInAgent', agentId: value }),
    );
  } catch {
    return null;
  }
}

const ExecutionRunCliAgentSchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.refine((value) => readExecutionRunCliBackendTarget(value) !== null, { message: 'Agent must identify one concrete execution target' })));

const ExecutionRunCliPermissionModeSchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.refine((value) => ExecutionRunActionPermissionModeSchema.safeParse(value).success, { message: 'Invalid execution run permission mode' })));

export const ExecutionRunStartCliInputSchema = lazyZodSchema(() => z.strictObject({
  sessionId: z.optional(z.nullable(SessionSelectorSchema)),
  cwd: z.optional(z.string().check(z.trim(), z.minLength(1))),
  intent: ExecutionRunIntentSchema,
  agent: ExecutionRunCliAgentSchema,
  instructions: z.optional(z.string()),
  permissionMode: z.optional(ExecutionRunCliPermissionModeSchema),
  retention: z.optional(ExecutionRunRetentionPolicySchema),
  runClass: z.optional(ExecutionRunClassSchema),
  ioMode: z.optional(ExecutionRunIoModeSchema),
}));
export type ExecutionRunStartCliInput = z.infer<typeof ExecutionRunStartCliInputSchema>;

export function bindExecutionRunStartCliInput(
  input: Readonly<Partial<ExecutionRunStartCliInput>>,
): Readonly<Record<string, unknown>> {
  // Over canonical whole-input JSON the caller shape reaches this binder as an
  // overlay, so a field the caller did not type is absent. Every projection
  // below is therefore conditional on the caller field it reads, and the
  // intent-derived run-shape defaults exist only when `intent` itself does.
  const intent = input.intent;
  return {
    ...(input.sessionId === undefined
      ? input.cwd === undefined ? {} : { sessionId: actionCliDerivedDefault(null) }
      : { sessionId: input.sessionId }),
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    ...(intent === undefined ? {} : { intent }),
    ...(intent === undefined || executionRunKindForIntent(intent) === undefined
      ? {}
      : { kind: actionCliDerivedDefault(executionRunKindForIntent(intent)) }),
    ...(input.agent === undefined
      ? {}
      : { backendTarget: readExecutionRunCliBackendTarget(input.agent)! }),
    ...(input.instructions === undefined ? {} : { instructions: input.instructions }),
    ...(input.permissionMode !== undefined
      ? { permissionMode: ExecutionRunActionPermissionModeSchema.parse(input.permissionMode) }
      : intent === undefined ? {} : { permissionMode: actionCliDerivedDefault(defaultExecutionRunPermissionMode(intent)) }),
    ...(input.retention !== undefined
      ? { retentionPolicy: input.retention }
      : intent === undefined ? {} : { retentionPolicy: actionCliDerivedDefault(defaultExecutionRunRetention(intent)) }),
    ...(input.runClass !== undefined
      ? { runClass: input.runClass }
      : intent === undefined ? {} : { runClass: actionCliDerivedDefault(defaultExecutionRunClass(intent)) }),
    ...(input.ioMode !== undefined
      ? { ioMode: input.ioMode }
      : intent === undefined ? {} : { ioMode: actionCliDerivedDefault(defaultExecutionRunIoMode(intent)) }),
  };
}

export const EXECUTION_RUN_START_CLI_PROJECTION: ActionCliProjection = lazyActionSpecRecord(() => ({
  transportMachineIdAliases: ['--machine'],
  commands: [{
    path: ['session', 'run', 'start'],
    positionals: ['sessionId'],
    visibility: 'canonical',
  }],
  inputSchema: ExecutionRunStartCliInputSchema,
  inputHints: {
    title: 'Start execution run',
    fields: [
      { path: 'sessionId', title: 'Session id, tag, or unambiguous prefix', widget: 'text' },
      { path: 'cwd', title: 'Detached run working directory', widget: 'text' },
      {
        path: 'intent',
        title: 'Run intent',
        widget: 'select',
        required: true,
        options: EXECUTION_RUN_INTENT_OPTIONS,
      },
      {
        path: 'agent',
        title: 'Agent id or canonical target key',
        widget: 'text',
        required: true,
        optionsSourceId: 'execution.backends.enabled',
      },
      { path: 'instructions', title: 'Initial instructions', widget: 'textarea' },
      {
        path: 'permissionMode',
        title: 'Permission mode',
        widget: 'select',
        options: EXECUTION_RUN_ACTION_PERMISSION_INPUTS.map((value) => ({ value, label: value })),
      },
      {
        path: 'retention',
        title: 'Retention',
        widget: 'select',
        options: ExecutionRunRetentionPolicySchema.options.map((value) => ({ value, label: value })),
      },
      {
        path: 'runClass',
        title: 'Run class',
        widget: 'select',
        options: ExecutionRunClassSchema.options.map((value) => ({ value, label: value })),
      },
      {
        path: 'ioMode',
        title: 'I/O mode',
        widget: 'select',
        options: ExecutionRunIoModeSchema.options.map((value) => ({ value, label: value })),
      },
    ],
  },
  bindInput: (value) => bindExecutionRunStartCliInput(value as Partial<ExecutionRunStartCliInput>),
}));

export const ExecutionRunListCliInputSchema = lazyZodSchema(() => z.strictObject({
  sessionId: SessionSelectorSchema,
  agent: z.optional(ExecutionRunCliAgentSchema),
  status: z.optional(ExecutionRunStatusSchema),
  limit: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(200))),
}));
export type ExecutionRunListCliInput = z.infer<typeof ExecutionRunListCliInputSchema>;

export function bindExecutionRunListCliInput(
  input: ExecutionRunListCliInput,
): Readonly<Record<string, unknown>> {
  return {
    sessionId: input.sessionId,
    ...(input.agent === undefined
      ? {}
      : { backendTarget: readExecutionRunCliBackendTarget(input.agent)! }),
    ...(input.status === undefined ? {} : { status: input.status }),
    ...(input.limit === undefined ? {} : { limit: input.limit }),
  };
}

export const EXECUTION_RUN_LIST_CLI_PROJECTION: ActionCliProjection = lazyActionSpecRecord(() => ({
  commands: [{ path: ['session', 'run', 'list'], positionals: ['sessionId'], visibility: 'canonical' }],
  inputSchema: ExecutionRunListCliInputSchema,
  inputHints: {
    title: 'List execution runs',
    fields: [
      { path: 'sessionId', title: 'Session id, tag, or unambiguous prefix', widget: 'text', required: true },
      {
        path: 'agent',
        title: 'Agent id or canonical target key',
        widget: 'text',
        optionsSourceId: 'execution.backends.enabled',
      },
      {
        path: 'status',
        title: 'Run status',
        widget: 'select',
        options: ExecutionRunStatusSchema.options.map((value) => ({ value, label: value })),
      },
      { path: 'limit', title: 'Maximum runs', widget: 'text' },
    ],
  },
  bindInput: (value) => bindExecutionRunListCliInput(value as ExecutionRunListCliInput),
}));

export const EXECUTION_RUN_GET_CLI_PROJECTION: ActionCliProjection = {
  transportMachineIdAliases: ['--machine'],
  commands: [{
    path: ['session', 'run', 'get'],
    positionals: ['sessionId', 'runId'],
    visibility: 'canonical',
  }],
};

export const EXECUTION_RUN_STOP_CLI_PROJECTION: ActionCliProjection = {
  transportMachineIdAliases: ['--machine'],
  commands: [{
    path: ['session', 'run', 'stop'],
    positionals: ['sessionId', 'runId'],
    visibility: 'canonical',
  }],
};

export const EXECUTION_RUN_WAIT_CLI_PROJECTION: ActionCliProjection = {
  transportMachineIdAliases: ['--machine'],
  commands: [{
    path: ['session', 'run', 'wait'],
    positionals: ['sessionId', 'runId'],
    visibility: 'canonical',
  }],
  flagAliases: [{ path: 'timeoutSeconds', aliases: ['--timeout'] }],
};

export const EXECUTION_RUN_STREAM_START_CLI_PROJECTION: ActionCliProjection = {
  commands: [{
    path: ['session', 'run', 'stream-start'],
    positionals: ['sessionId', 'runId', 'message'],
    visibility: 'canonical',
  }],
};

export const EXECUTION_RUN_STREAM_READ_CLI_PROJECTION: ActionCliProjection = {
  commands: [{
    path: ['session', 'run', 'stream-read'],
    positionals: ['sessionId', 'runId', 'streamId'],
    visibility: 'canonical',
  }],
};

export const EXECUTION_RUN_STREAM_CANCEL_CLI_PROJECTION: ActionCliProjection = {
  commands: [{
    path: ['session', 'run', 'stream-cancel'],
    positionals: ['sessionId', 'runId', 'streamId'],
    visibility: 'canonical',
  }],
};
