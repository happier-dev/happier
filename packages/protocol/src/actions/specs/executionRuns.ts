import type { ActionSpecSurfaceBindings, PreNormalizedActionSpec } from './definition.js';
import { EXECUTION_RUN_INTENT_OPTIONS } from '../../execution/runs/intentPolicyMatrix.js';
import { type ActionInputFieldHint } from '../actionInputHints.js';
import { ExecutionRunListRequestSchema } from '../../execution/runs/listRequest.js';
import { ExecutionRunCancelTurnRequestSchema, ExecutionRunCancelTurnResponseSchema } from '../../execution/runs/cancelTurn.js';
import { ExecutionRunListResponseSchema, ExecutionRunSendResponseSchema, ExecutionRunStartResponseSchema, ExecutionRunStopResponseSchema, ExecutionRunWaitResultSchema } from '../../execution/runs/responseSchemas.js';
import { ExecutionRunTurnStreamCancelResponseSchema, ExecutionRunTurnStreamReadResponseSchema, ExecutionRunTurnStreamStartResponseSchema } from '../../execution/runs/streaming.js';
import { EXECUTION_RUN_ACTION_PERMISSION_INPUTS, EXECUTION_RUN_ACTION_PERMISSION_MODE_DESCRIPTION } from '../executionRunActionPermissionMode.js';
import { RPC_METHODS, SESSION_RPC_METHODS } from '../../rpc/methods.js';
import { EXECUTION_RUN_GET_CLI_PROJECTION, EXECUTION_RUN_LIST_CLI_PROJECTION, EXECUTION_RUN_START_CLI_PROJECTION, EXECUTION_RUN_STOP_CLI_PROJECTION, EXECUTION_RUN_STREAM_CANCEL_CLI_PROJECTION, EXECUTION_RUN_STREAM_READ_CLI_PROJECTION, EXECUTION_RUN_STREAM_START_CLI_PROJECTION, EXECUTION_RUN_WAIT_CLI_PROJECTION } from './executionRunCli.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';
import { ExecutionRunWaitConditionSchema } from '../../execution/runs/waitForTerminal.js';
import { ExecutionRunOutputObservationSchema } from '../../reviews/reviewNarration.js';
import { BackendTargetKeySchema } from '../../backends/targets/backendTargetRef.js';
import { BackendTargetKeyV2Schema } from '../../backends/targets/backendTargetRefV2.js';
import { ConnectedServiceBindingsV2IngressSchema } from '../../connect/connectedServiceBindings.js';
import { normalizeConnectedServiceSelectionInput } from '../../connect/normalizeConnectedServiceSelectionInput.js';
import { ExecutionRunGetResponseSchema } from '../../execution/runs/responseSchemas.js';
import { ExecutionRunTurnStreamReadRequestSchema } from '../../execution/runs/runPrimitives.js';
import { ExecutionRunStartRequestBaseSchema, ExecutionRunStartRequestSchema, ExecutionRunTeamCredentialSessionBindingConsentV1Schema, refineExecutionRunStartRequest } from '../../execution/runs/startRequest.js';
import { ExecutionRunResultContractV1Schema } from '../../execution/runs/resultContractV1.js';
import { AcpConfigOptionOverridesV1Schema } from '../../sessions/metadata/metadataOverridesV1.js';
import { SecretReferenceOverlayV1Schema } from '../../profiles/secretReferenceOverlayV1.js';
import { SpawnConfigOptionValueSchema } from '../sessionSpawnConfigOptions.js';
import { ExecutionRunActionPermissionModeSchema } from '../executionRunActionPermissionMode.js';
import { StructuredQuestionAnswersV1Schema } from '../../tools/structuredQuestionAnswersV1.js';
import { TeamCredentialProviderModelSelectionV1Schema } from '../../teams/credentials/resourceV1.js';
import { StrictJsonValueSchema } from '../../json/strictJsonValue.js';


export const BackendTargetKeyInputSchema = lazyZodSchema(() => z.union([BackendTargetKeySchema, BackendTargetKeyV2Schema]));

export const IntentStartCommonSchema = lazyZodSchema(() => z.looseObject({
  roleId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  launchProfileId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  sessionId: z.optional(z.string().check(z.minLength(1))),
  backendTargetKeys: z.array(BackendTargetKeyInputSchema).check(z.minLength(1)),
  instructions: z.string().check(z.trim(), z.minLength(1)),
  permissionMode: z.optional(ExecutionRunActionPermissionModeSchema),
  retentionPolicy: z.optional(z.enum(['ephemeral', 'resumable'])),
  runClass: z.optional(z.enum(['bounded', 'long_lived'])),
  ioMode: z.optional(z.enum(['request_response', 'streaming'])),
  notifyParentOnCompletion: z.optional(z.boolean()),
  /**
   * Optional model selection applied to EVERY started run, reusing the canonical session-spawn
   * `modelId` vocabulary. Attached omission inherits at host admission;
   * independent starts use their default model.
   */
  modelId: z.optional(z.string().check(z.minLength(1))),
  modelSelection: ExecutionRunStartRequestBaseSchema.shape.modelSelection,
  /** Exact recipient-safe Team resource/model selection for the one selected Agent target. */
  teamCredentialModel: z.optional(TeamCredentialProviderModelSelectionV1Schema),
  teamCredentialSessionBindingConsent: z.optional(ExecutionRunTeamCredentialSessionBindingConsentV1Schema),
  /** Value-free Saved Secret binding overrides for this launch only. */
  secretReferenceOverlay: z.optional(SecretReferenceOverlayV1Schema),
  /**
   * Optional canonical agent config-option overrides (e.g. reasoning effort) applied to every
   * started run — the SAME `AcpConfigOptionOverridesV1` shape session spawn uses.
   */
  sessionConfigOptionOverrides: z.optional(AcpConfigOptionOverridesV1Schema),
  /**
   * Ergonomic shorthand for `sessionConfigOptionOverrides` (id → value). Merged into the canonical
   * overrides at the action boundary; a value conflicting with `sessionConfigOptionOverrides`
   * fails with `invalid_parameters`.
   */
  configOptions: z.optional(z.record(z.string(), SpawnConfigOptionValueSchema)),
  /** Blanket connected-services selection; an exact per-target entry overrides it. */
  connectedServices: z.optional(StrictJsonValueSchema),
  /**
   * Optional per-backend-target connected-services selection, keyed by the SAME backend target
   * key strings passed in `backendTargetKeys`. Each value may be an agent-friendly simple string
   * (`"<service>:group:<id>"`, `"<service>:<profileId>"`, `"<service>:native"`), an array of those,
   * or the full current connected-service bindings object — normalized at the action boundary. Targets
   * without an entry use the blanket choice, attached host inheritance, or independent
   * Account defaults; connected selections fail closed at run start.
   */
  connectedServicesByBackendTargetKey: z.optional(z
    .record(z.string(), StrictJsonValueSchema)),
}));

export const PlanStartInputSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.extend(IntentStartCommonSchema, {
  target: z.optional(z.strictObject({ kind: z.literal('detached') })),
  permissionMode: z._default(ExecutionRunActionPermissionModeSchema, 'read_only'),
  retentionPolicy: z._default(z.enum(['ephemeral', 'resumable']), 'ephemeral'),
  runClass: z._default(z.enum(['bounded', 'long_lived']), 'bounded'),
  ioMode: z._default(z.enum(['request_response', 'streaming']), 'request_response'),
})).check(z.refine((input) => !input.target || input.sessionId === undefined, {
  path: ['sessionId'], message: 'A detached plan cannot target a Session',
})));

export const DelegateStartInputSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.extend(IntentStartCommonSchema, {
  permissionMode: z.optional(ExecutionRunActionPermissionModeSchema),
  retentionPolicy: z._default(z.enum(['ephemeral', 'resumable']), 'ephemeral'),
  runClass: z._default(z.enum(['bounded', 'long_lived']), 'bounded'),
  ioMode: z._default(z.enum(['request_response', 'streaming']), 'request_response'),
})));

export const VoiceAgentStartInputSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.extend(IntentStartCommonSchema, {
  permissionMode: z._default(ExecutionRunActionPermissionModeSchema, 'read_only'),
  retentionPolicy: z._default(z.enum(['ephemeral', 'resumable']), 'ephemeral'),
  runClass: z._default(z.enum(['bounded', 'long_lived']), 'long_lived'),
  ioMode: z._default(z.enum(['request_response', 'streaming']), 'streaming'),
})));

/**
 * Scope is intentionally tri-state: an omitted field resolves to the caller's
 * current Session when one exists; explicit `null` means detached; and a string
 * identifies one exact Session. Keep the property optional so the action owner
 * can distinguish omission from explicit `null` by property presence.
 */
export const ExecutionRunScopeSessionIdSchema = lazyZodSchema(() => z.optional(z.nullable(z.string().check(z.minLength(1), z.refine((sessionId) => sessionId.trim().length > 0, { message: 'sessionId must not be whitespace only' })))));

export const ExecutionRunIdInputSchema = lazyZodSchema(() => z.looseObject({
  sessionId: ExecutionRunScopeSessionIdSchema,
  runId: z.string().check(z.minLength(1)),
}));

export type ExecutionRunStartActionRawInput = z.input<typeof ExecutionRunStartPluginInputSchema>;

/**
 * Normalize the agent-friendly `connectedServices` simple-form (string / array) into the canonical
 * current bindings object BEFORE the strict run-request schema validates it. A malformed
 * value is left untouched so the strict schema rejects it (→ `invalid_parameters`). Non-simple
 * (already-object) values pass through unchanged. This keeps the run REQUEST schema strict while the
 * action input accepts the ergonomic forms an agent can produce from the spec alone.
 */
export function preprocessRunStartConnectedServicesInput(raw: ExecutionRunStartActionRawInput): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const record = raw as Record<string, unknown>;
  const selection = record.connectedServices;
  if (typeof selection !== 'string' && !Array.isArray(selection)) return raw;
  const normalized = normalizeConnectedServiceSelectionInput(selection);
  if (!normalized.ok) return raw;
  return { ...record, connectedServices: normalized.bindings };
}

export const ExecutionRunStartActionRequestSchema = lazyZodSchema(() => z.extend(ExecutionRunStartRequestBaseSchema, {
  // Action callers use the canonical permission-intent vocabulary. The
  // execution-run RPC retains its historical wire tokens, so this shared
  // Action-boundary schema projects `safe-yolo` → `workspace_write` once,
  // before it reaches the run owner.
  permissionMode: ExecutionRunActionPermissionModeSchema,
  sessionId: ExecutionRunScopeSessionIdSchema,
  waitForCompletion: z.optional(z.boolean()),
  waitTimeoutSeconds: z.optional(z.number().check(z.int(), z.minimum(1))),
  /**
   * Ergonomic shorthand for `sessionConfigOptionOverrides` (id → value). Merged into the canonical
   * overrides at the action boundary; conflicting values fail with `invalid_parameters`.
   */
  configOptions: z.optional(z.record(z.string(), SpawnConfigOptionValueSchema)),
}).check(z.superRefine(refineExecutionRunStartRequest), z.superRefine((value, ctx) => {
  if (
    value.teamCredentialSessionBindingConsent
    && (
      value.sessionId === null
      || value.teamCredentialSessionBindingConsent.sessionId !== value.sessionId
    )
  ) {
    ctx.addIssue({
      code: "custom",
      message: 'Session binding consent requires and must match an attached Session',
      path: ['teamCredentialSessionBindingConsent', 'sessionId'],
    });
  }
  if (value.waitTimeoutSeconds !== undefined && value.waitForCompletion !== true) {
    ctx.addIssue({
      code: "custom",
      message: 'waitTimeoutSeconds requires waitForCompletion=true',
      path: ['waitTimeoutSeconds'],
    });
  }
})));

export const ExecutionRunStartPluginInputSchema = lazyZodSchema(() => z.extend(ExecutionRunStartRequestBaseSchema, {
  // Trusted plugins share the public Action contract; do not let them carry
  // a second, unnormalized permission-mode vocabulary into execution runs.
  permissionMode: ExecutionRunActionPermissionModeSchema,
  sessionId: ExecutionRunScopeSessionIdSchema,
  waitForCompletion: z.optional(z.boolean()),
  waitTimeoutSeconds: z.optional(z.number().check(z.int(), z.minimum(1))),
  configOptions: z.optional(z.record(z.string(), SpawnConfigOptionValueSchema)),
  connectedServices: z.optional(z.union([
    ConnectedServiceBindingsV2IngressSchema,
    z.string(),
    z.array(z.string()),
  ])),
}).check(z.superRefine(refineExecutionRunStartRequest), z.superRefine((value, ctx) => {
  if (
    value.teamCredentialSessionBindingConsent
    && (
      value.sessionId === null
      || value.teamCredentialSessionBindingConsent.sessionId !== value.sessionId
    )
  ) {
    ctx.addIssue({
      code: "custom",
      message: 'Session binding consent requires and must match an attached Session',
      path: ['teamCredentialSessionBindingConsent', 'sessionId'],
    });
  }
  if (value.waitTimeoutSeconds !== undefined && value.waitForCompletion !== true) {
    ctx.addIssue({
      code: "custom",
      message: 'waitTimeoutSeconds requires waitForCompletion=true',
      path: ['waitTimeoutSeconds'],
    });
  }
})));

export const ExecutionRunStartInputSchema = lazyZodSchema(() => (<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform(preprocessRunStartConnectedServicesInput), ExecutionRunStartActionRequestSchema));

export const ExecutionRunGetInputSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.extend(ExecutionRunIdInputSchema, {
  includeStructured: z.optional(z.boolean()),
  includeLatestToolResult: z.optional(z.boolean()),
  waitForInputId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  waitForOutput: z.optional(ExecutionRunOutputObservationSchema),
})));

export const DetachedExecutionRunSendInputSchema = lazyZodSchema(() => z.strictObject({
  sessionId: z.null(),
  runId: z.string().check(z.minLength(1)),
  message: z.string().check(z.minLength(1)),
  localInputId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  resultContract: z.optional(ExecutionRunResultContractV1Schema),
  resume: z.optional(z.boolean()),
  delivery: z.optional(z.enum(['prompt', 'steer_if_supported', 'interrupt'])),
}).check(z.superRefine((value, ctx) => {
  if (value.resultContract && !value.localInputId) {
    ctx.addIssue({
      code: "custom",
      path: ['localInputId'],
      message: 'resultContract requires exact localInputId correspondence',
    });
  }
})));

export const ExecutionRunEnsureInputSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.extend(ExecutionRunIdInputSchema, {
  resume: z.optional(z.boolean()),
})));

export const ExecutionRunEnsureOrStartInputSchema = lazyZodSchema(() => z.looseObject({
  sessionId: ExecutionRunScopeSessionIdSchema,
  runId: z.optional(z.nullable(z.string().check(z.minLength(1)))),
  start: z.optional(ExecutionRunStartRequestSchema),
  resume: z.optional(z.boolean()),
}).check(z.superRefine((value, ctx) => {
  const runId = typeof value.runId === 'string' ? value.runId.trim() : '';
  if (!runId && !value.start) {
    ctx.addIssue({ code: "custom", message: 'start is required when runId is missing' });
  }
})));

export const ExecutionRunStreamStartInputSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.extend(ExecutionRunIdInputSchema, {
  message: z.string().check(z.minLength(1)),
  displayMessage: z.optional(z.string().check(z.minLength(1))),
  resume: z.optional(z.boolean()),
})));

export const ExecutionRunStreamReadInputSchema = lazyZodSchema(() => z.extend(ExecutionRunTurnStreamReadRequestSchema, {
  sessionId: ExecutionRunScopeSessionIdSchema,
}));

export const ExecutionRunStreamCancelInputSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.extend(ExecutionRunIdInputSchema, {
  streamId: z.string().check(z.minLength(1)),
})));

export const ExecutionRunActionInputSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.extend(ExecutionRunIdInputSchema, {
  actionId: z.string().check(z.minLength(1)),
  input: z.optional(StrictJsonValueSchema),
})));

export const ExecutionRunPermissionRespondInputSchema = lazyZodSchema(() => z.union([
  z.strictObject({ runId: z.string().check(z.trim(), z.minLength(1)), requestId: z.string().check(z.trim(), z.minLength(1)), approved: z.boolean() }),
  z.strictObject({ runId: z.string().check(z.trim(), z.minLength(1)), requestId: z.string().check(z.trim(), z.minLength(1)), answers: StructuredQuestionAnswersV1Schema }),
]));

export type ExecutionRunPermissionRespondActionInput = z.input<typeof ExecutionRunPermissionRespondInputSchema>;

export const ExecutionRunWaitInputSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.extend(ExecutionRunIdInputSchema, {
  timeoutSeconds: z.optional(z.number().check(z.int(), z.minimum(1))),
  condition: z.optional(ExecutionRunWaitConditionSchema),
  after: z.optional(ExecutionRunGetResponseSchema),
})));

export const ExecutionRunWaitPublicInputSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(ExecutionRunWaitInputSchema));



export const EXECUTION_RUN_SESSION_SCOPE_DESCRIPTION =
  'A nonempty sessionId selects that exact authorized Session. Omitting sessionId inherits the current Action Session, or selects detached scope when none exists. sessionId:null selects detached scope even inside a current Session.';

export const EXECUTION_RUN_SESSION_SCOPE_HINT = {
  path: 'sessionId',
  title: 'Session id',
  prompt: 'Which session?',
  description: 'Use a nonempty value for an exact authorized Session. Omit it to inherit the current Action Session, or to select detached scope when no current Session exists. Set null to select detached scope even inside a current Session.',
  widget: 'text',
} satisfies ActionInputFieldHint;

export const EXECUTION_RUN_WAIT_OBSERVATION_DESCRIPTION =
  'Timeout only ends this observation; it does not stop, retry, or start the run. Cancellation only ends this wait.';

export const EXECUTION_RUN_ACTION_SPECS = Object.freeze([
  {
    id: 'execution.run.start', executionPlacement: 'machine', approval: {result: 'optional',flow: 'deferred'},
    title: 'Start execution run',
    description: `Start a new execution run. Resolve dependent model, config, and connected-service options with draftInput.backendTargetKey set to the selected backend option.value; then supply the schema-defined backendTarget object to start. Set waitForCompletion=true to wait for a terminal run result. waitTimeoutSeconds only bounds this observation; it never stops, retries, or starts the run. ${EXECUTION_RUN_SESSION_SCOPE_DESCRIPTION}`,
    safety: 'safe',
    placements: [],
    bindings: {
      rpcMethod: SESSION_RPC_METHODS.EXECUTION_RUN_START,
      voiceClientToolName: 'startExecutionRun',
      mcpToolName: 'execution_run_start',
    },
    sideEffectClass: 'write',
    examples: {
      mcp: {
        argsExample: '{"intent":"delegate","backendTarget":{"kind":"backend","backendId":"codex","sourceKind":"built_in"},"instructions":"Summarize recent changes.","permissionMode":"read_only","retentionPolicy":"ephemeral","runClass":"bounded","ioMode":"request_response","waitForCompletion":true,"waitTimeoutSeconds":60}',
      },
      voice: {
        argsExample: '{"intent":"delegate","backendTarget":{"kind":"backend","backendId":"codex","sourceKind":"built_in"},"instructions":"Summarize recent changes.","permissionMode":"read_only","retentionPolicy":"ephemeral","runClass":"bounded","ioMode":"request_response"}',
      },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: true,
      },
    cli: EXECUTION_RUN_START_CLI_PROJECTION,
    surfaceBindings: {
      plugin: {
        inputSchema: ExecutionRunStartPluginInputSchema,
      },
    },
    inputHints: {
      title: 'Start a run',
      fields: [
        EXECUTION_RUN_SESSION_SCOPE_HINT,
        { path: 'intent', title: 'Intent', description: 'Choose the purpose and its accepted retentionPolicy, runClass and ioMode together. Delegate covers ordinary bounded child work; Voice serves ongoing conversations.', widget: 'select', required: true, options: EXECUTION_RUN_INTENT_OPTIONS },
        { path: 'backendTarget', title: 'Backend target (json)', widget: 'textarea', required: true },
        { path: 'instructions', title: 'Instructions', widget: 'textarea' },
        {
          path: 'permissionMode',
          title: 'Permission intent',
          description: EXECUTION_RUN_ACTION_PERMISSION_MODE_DESCRIPTION,
          widget: 'select',
          required: true,
          options: EXECUTION_RUN_ACTION_PERMISSION_INPUTS.map((value) => ({ value, label: value })),
        },
        { path: 'retentionPolicy', title: 'Retention policy', widget: 'text', required: true },
        { path: 'runClass', title: 'Run class', widget: 'text', required: true },
        { path: 'ioMode', title: 'IO mode', widget: 'text', required: true },
        {
          path: 'waitForCompletion',
          title: 'Wait for completion',
          description: 'Return the terminal run disposition under wait instead of returning immediately after start.',
          widget: 'boolean',
        },
        {
          path: 'waitTimeoutSeconds',
          title: 'Wait timeout seconds',
          description: 'Optional observation deadline; requires waitForCompletion=true and never stops the run.',
          widget: 'text',
        },
        { path: 'initialContextMode', title: 'Initial context mode', widget: 'text' },
        {
          path: 'modelId',
          title: 'Model id',
          description: 'Optional explicit model for the run backend. Assign the model option.value string, not the {value,label} choice object or a stamped Session snapshot. Attached omission inherits the applied parent choice; independent starts use defaults.',
          widget: 'text',
          optionsSourceId: 'agents.models.available',
        },
        {
          path: 'configOptions',
          title: 'Config options (e.g. reasoning effort)',
          description: 'Optional scalar overrides keyed by config-option ids, e.g. {"reasoning_effort":"high"}. Supply draftInput.modelId for model-scoped choices. Config-option choices name ids; read agents.config_options.list with modelId for their value choices. These are not stamped Session configuration fields. Merged into sessionConfigOptionOverrides at the boundary; a conflict fails with invalid_parameters.',
          widget: 'json',
          optionsSourceId: 'agents.config_options.available',
        },
        {
          path: 'connectedServices',
          title: 'Connected services (json)',
          description: 'Optional connected-services selection for the run backend. Accepts "native", a per-service string ("<service>:group:<id>", "<service>:<profileId>", "<service>:native"), an array, or the full object. Attached omission inherits the parent choice; independent starts use Account defaults. Enumerate valid selections via the shared session-spawn options source.',
          widget: 'textarea',
          optionsSourceId: 'sessions.spawn.connected_services.available',
        },
        {
          path: 'secretReferenceOverlay',
          title: 'Saved Secret overrides (json)',
          description: 'Optional value-free Saved Secret references for this launch only. Values are resolved by the exact daemon and the selected Profile is not changed.',
          widget: 'json',
        },
      ],
    },
    outputSchema: ExecutionRunStartResponseSchema,
    inputSchema: ExecutionRunStartInputSchema,
  } satisfies PreNormalizedActionSpec,
  {
    id: 'execution.run.list', executionPlacement: 'machine', toolExposure: { agent: 'direct', mcp: 'direct' }, approval: {result: 'required'},
    title: 'List execution runs',
    description: `List agent execution runs in the selected scope. Saved workflow definitions are read with workflow.definition.list; workflow Run history is read with workflow.run.list. An empty runs result says only that this execution scope has no matching runs. ${EXECUTION_RUN_SESSION_SCOPE_DESCRIPTION}`,
    safety: 'safe',
    placements: ['run_list', 'command_palette', 'slash_command', 'voice_panel'],
    prompting: { voiceHotPath: true },
    slash: { tokens: ['/h.runs'] },
    bindings: { rpcMethod: SESSION_RPC_METHODS.EXECUTION_RUN_LIST, voiceClientToolName: 'listExecutionRuns', mcpToolName: 'execution_run_list' },
    sideEffectClass: 'read',
    inputHints: {
      title: 'List execution runs',
      fields: [
        EXECUTION_RUN_SESSION_SCOPE_HINT,
        { path: 'backendTarget', title: 'Backend target', widget: 'text' },
        {
          path: 'status',
          title: 'Status',
          widget: 'select',
          options: [
            { value: 'running', label: 'Running' },
            { value: 'succeeded', label: 'Succeeded' },
            { value: 'failed', label: 'Failed' },
            { value: 'cancelled', label: 'Cancelled' },
            { value: 'timeout', label: 'Timeout' },
          ],
        },
        { path: 'limit', title: 'Max runs', widget: 'text' },
      ],
    },
    examples: {
      voice: { argsExample: '{"status":"running","limit":10}' },
    },
	    surfaces: {
	      ui: true,
	      voice: true,
	      agent: true,
	      mcp: true,
	      cli: true,
	      rpc: true,
	      },
	    cli: EXECUTION_RUN_LIST_CLI_PROJECTION,
	    outputSchema: ExecutionRunListResponseSchema,
    inputSchema: lazyZodSchema(() => z.extend(ExecutionRunListRequestSchema, {
      sessionId: ExecutionRunScopeSessionIdSchema,
    })),
	  } satisfies PreNormalizedActionSpec,
  {
    id: 'execution.run.get', executionPlacement: 'machine', toolExposure: { agent: 'direct', mcp: 'direct' }, approval: {result: 'required'},
    title: 'Get execution run',
    description: `Get one execution run from the selected scope. ${EXECUTION_RUN_SESSION_SCOPE_DESCRIPTION}`,
    safety: 'safe',
    placements: ['run_list', 'run_card', 'command_palette'],
    prompting: { voiceHotPath: true },
    bindings: { rpcMethod: SESSION_RPC_METHODS.EXECUTION_RUN_GET, voiceClientToolName: 'getExecutionRun', mcpToolName: 'execution_run_get' },
    sideEffectClass: 'read',
    examples: {
      voice: { argsExample: '{"sessionId":null,"runId":"run_123","includeStructured":false}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: true,
      },
    cli: EXECUTION_RUN_GET_CLI_PROJECTION,
    inputHints: {
      title: 'Get a run',
      fields: [
        EXECUTION_RUN_SESSION_SCOPE_HINT,
        { path: 'runId', title: 'Run id', widget: 'text', required: true },
        { path: 'includeStructured', title: 'Include structured output', widget: 'boolean' },
      ],
    },
    outputSchema: ExecutionRunGetResponseSchema,
    inputSchema: ExecutionRunGetInputSchema,
  } satisfies PreNormalizedActionSpec,
  {
    id: 'execution.run.send', executionPlacement: 'machine', approval: {result: 'optional',flow: 'deferred'},
    title: 'Send to detached execution run',
    description: 'Send a message to a detached execution run on the selected Machine. Requires sessionId: null. Session-owned runs use session.message.send with a recipient.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: SESSION_RPC_METHODS.EXECUTION_RUN_SEND, mcpToolName: 'execution_run_send' },
    sideEffectClass: 'write',
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: true,
      },
    inputHints: {
      title: 'Send to detached run',
      fields: [
        { path: 'sessionId', title: 'Detached scope (null)', widget: 'text', required: true },
        { path: 'runId', title: 'Run id', widget: 'text', required: true },
        { path: 'message', title: 'Message', widget: 'textarea', required: true },
        { path: 'resume', title: 'Resume if needed', widget: 'boolean' },
      ],
    },
    outputSchema: ExecutionRunSendResponseSchema,
    inputSchema: DetachedExecutionRunSendInputSchema,
  } satisfies PreNormalizedActionSpec,
  {
    id: 'execution.run.ensure', executionPlacement: 'machine', approval: {result: 'optional',flow: 'deferred'},
    title: 'Ensure execution run',
    description: `Ensure an existing execution run is active or resumable. ${EXECUTION_RUN_SESSION_SCOPE_DESCRIPTION}`,
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE, mcpToolName: 'execution_run_ensure' },
    sideEffectClass: 'write',
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: true,
    },
    cli: { acceptsServerId: true, commands: [{ path: ['session', 'run', 'ensure'], visibility: 'canonical' }] },
    inputHints: {
      title: 'Ensure a run',
      fields: [
        EXECUTION_RUN_SESSION_SCOPE_HINT,
        { path: 'runId', title: 'Run id', widget: 'text', required: true },
        { path: 'resume', title: 'Resume if needed', widget: 'boolean' },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: ExecutionRunEnsureInputSchema,
  } satisfies PreNormalizedActionSpec,
  {
    id: 'execution.run.ensure_or_start', executionPlacement: 'machine', approval: {result: 'optional',flow: 'deferred'},
    title: 'Ensure or start execution run',
    description: `Ensure an existing execution run, or start a new one when no run id is supplied. ${EXECUTION_RUN_SESSION_SCOPE_DESCRIPTION}`,
    safety: 'safe',
    placements: [],
    bindings: {
      rpcMethod: SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START,
      rpcMethodAliases: [SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START_PROVIDER_SAFE_V1],
    },
    sideEffectClass: 'write',
    surfaces: {
      ui: false,
      voice: false,
      agent: true,
      mcp: false,
      cli: false,
      rpc: true,
    },
    inputHints: {
      title: 'Ensure or start a run',
      fields: [
        EXECUTION_RUN_SESSION_SCOPE_HINT,
        { path: 'runId', title: 'Run id', widget: 'text' },
        { path: 'start', title: 'Start request (json)', widget: 'textarea' },
        { path: 'resume', title: 'Resume if needed', widget: 'boolean' },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: ExecutionRunEnsureOrStartInputSchema,
  } satisfies PreNormalizedActionSpec,
  {
    id: 'execution.run.stream.start', executionPlacement: 'machine', approval: {result: 'optional',flow: 'deferred'},
    title: 'Start execution run stream',
    description: `Start a bounded streaming turn for an execution run. ${EXECUTION_RUN_SESSION_SCOPE_DESCRIPTION}`,
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START },
    sideEffectClass: 'write',
    surfaces: {
      ui: false,
      voice: false,
      agent: true,
      mcp: false,
      cli: true,
      rpc: true,
    },
    cli: EXECUTION_RUN_STREAM_START_CLI_PROJECTION,
    inputHints: {
      title: 'Start a run stream',
      fields: [
        EXECUTION_RUN_SESSION_SCOPE_HINT,
        { path: 'runId', title: 'Run id', widget: 'text', required: true },
        { path: 'message', title: 'Message', widget: 'textarea', required: true },
        { path: 'displayMessage', title: 'Display message', widget: 'textarea' },
        { path: 'resume', title: 'Resume if needed', widget: 'boolean' },
      ],
    },
    outputSchema: lazyZodSchema(() => z.lazy(() => ExecutionRunTurnStreamStartResponseSchema)),
    inputSchema: ExecutionRunStreamStartInputSchema,
  } satisfies PreNormalizedActionSpec,
  {
    id: 'execution.run.stream.read', executionPlacement: 'machine', approval: {result: 'required'},
    title: 'Read execution run stream',
    description: `Read bounded deltas from an execution-run stream cursor. ${EXECUTION_RUN_SESSION_SCOPE_DESCRIPTION}`,
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_READ },
    sideEffectClass: 'read',
    surfaces: {
      ui: false,
      voice: false,
      agent: true,
      mcp: false,
      cli: true,
      rpc: true,
    },
    cli: EXECUTION_RUN_STREAM_READ_CLI_PROJECTION,
    inputHints: {
      title: 'Read a run stream',
      fields: [
        EXECUTION_RUN_SESSION_SCOPE_HINT,
        { path: 'runId', title: 'Run id', widget: 'text', required: true },
        { path: 'streamId', title: 'Stream id', widget: 'text', required: true },
        { path: 'cursor', title: 'Cursor', widget: 'text' },
        { path: 'maxEvents', title: 'Max events', widget: 'text' },
      ],
    },
    outputSchema: lazyZodSchema(() => z.lazy(() => ExecutionRunTurnStreamReadResponseSchema)),
    inputSchema: ExecutionRunStreamReadInputSchema,
  } satisfies PreNormalizedActionSpec,
  {
    id: 'execution.run.stream.cancel', executionPlacement: 'machine', approval: {result: 'optional',flow: 'deferred'},
    title: 'Cancel execution run stream',
    description: `Cancel a bounded streaming turn for an execution run. ${EXECUTION_RUN_SESSION_SCOPE_DESCRIPTION}`,
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_CANCEL },
    sideEffectClass: 'write',
    surfaces: {
      ui: false,
      voice: false,
      agent: true,
      mcp: false,
      cli: true,
      rpc: true,
    },
    cli: EXECUTION_RUN_STREAM_CANCEL_CLI_PROJECTION,
    inputHints: {
      title: 'Cancel a run stream',
      fields: [
        EXECUTION_RUN_SESSION_SCOPE_HINT,
        { path: 'runId', title: 'Run id', widget: 'text', required: true },
        { path: 'streamId', title: 'Stream id', widget: 'text', required: true },
      ],
    },
    outputSchema: lazyZodSchema(() => z.lazy(() => ExecutionRunTurnStreamCancelResponseSchema)),
    inputSchema: ExecutionRunStreamCancelInputSchema,
  } satisfies PreNormalizedActionSpec,
  {
    id: 'execution.run.stop', executionPlacement: 'machine', approval: {result: 'optional',flow: 'deferred'},
    title: 'Stop execution run',
    description: `Stop one execution run in the selected scope. ${EXECUTION_RUN_SESSION_SCOPE_DESCRIPTION}`,
    safety: 'safe',
    placements: ['run_card', 'run_list'],
    bindings: { rpcMethod: SESSION_RPC_METHODS.EXECUTION_RUN_STOP, voiceClientToolName: 'stopExecutionRun', mcpToolName: 'execution_run_stop' },
    sideEffectClass: 'write',
    examples: {
      voice: { argsExample: '{"sessionId":"{{sessionId}}","runId":"run_123"}' },
    },
	    surfaces: {
	      ui: true,
	      voice: true,
	      agent: true,
	      mcp: true,
	      cli: true,
	      rpc: true,
	      },
	    cli: EXECUTION_RUN_STOP_CLI_PROJECTION,
	    inputHints: {
	      title: 'Stop a run',
	      fields: [
          EXECUTION_RUN_SESSION_SCOPE_HINT,
          { path: 'runId', title: 'Run id', widget: 'text', required: true },
        ],
	    },
	    outputSchema: ExecutionRunStopResponseSchema,
	    inputSchema: ExecutionRunIdInputSchema,
	  } satisfies PreNormalizedActionSpec,
  {
    id: 'execution.run.cancel_turn', executionPlacement: 'machine', approval: {result: 'optional',flow: 'deferred'},
    title: 'Cancel this response',
    description: `Cancel the addressed active response without stopping its execution run. ${EXECUTION_RUN_SESSION_SCOPE_DESCRIPTION}`,
    safety: 'safe',
    placements: ['run_card'],
    bindings: { rpcMethod: SESSION_RPC_METHODS.EXECUTION_RUN_CANCEL_TURN_V1, mcpToolName: 'execution_run_cancel_turn' },
    sideEffectClass: 'write',
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: true },
    inputHints: {
      title: 'Cancel this response',
      fields: [
        EXECUTION_RUN_SESSION_SCOPE_HINT,
        { path: 'runId', title: 'Run id', widget: 'text', required: true },
        { path: 'occurrenceId', title: 'Occurrence id', widget: 'text', required: true },
        { path: 'turnId', title: 'Turn id', widget: 'text', required: true },
      ],
    },
    outputSchema: ExecutionRunCancelTurnResponseSchema,
    inputSchema: lazyZodSchema(() => z.extend(ExecutionRunCancelTurnRequestSchema, { sessionId: ExecutionRunScopeSessionIdSchema })),
  } satisfies PreNormalizedActionSpec,
  {
    id: 'execution.run.action', executionPlacement: 'machine', approval: {result: 'optional',flow: 'deferred'},
    title: 'Apply execution run action',
    description: `Apply an action to one execution run in the selected scope. ${EXECUTION_RUN_SESSION_SCOPE_DESCRIPTION}`,
    safety: 'safe',
    placements: ['run_card'],
    bindings: { rpcMethod: SESSION_RPC_METHODS.EXECUTION_RUN_ACTION, voiceClientToolName: 'actionExecutionRun', mcpToolName: 'execution_run_action' },
    sideEffectClass: 'write',
    examples: {
      voice: { argsExample: '{"sessionId":"{{sessionId}}","runId":"run_123","actionId":"voice_agent.commit","input":{"maxChars":1200}}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: true,
      },
    inputHints: {
      title: 'Run action',
      fields: [
        EXECUTION_RUN_SESSION_SCOPE_HINT,
        { path: 'runId', title: 'Run id', widget: 'text', required: true },
        { path: 'actionId', title: 'Action id', widget: 'text', required: true },
        { path: 'input', title: 'Input (JSON)', widget: 'textarea' },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: ExecutionRunActionInputSchema,
  } satisfies PreNormalizedActionSpec,
  {
    id: 'execution.run.permission.respond', executionPlacement: 'machine', approval: {result: 'optional',flow: 'deferred'},
    title: 'Answer detached run request',
    description: 'Approve or deny a permission request, or answer a structured question, on an exact detached execution run. Only a present user may answer; autonomous callers can discover this operation but cannot execute it.',
    safety: 'safe',
    requiredAuthority: 'present_user',
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.DAEMON_EXECUTION_RUN_PERMISSION_RESPOND },
    sideEffectClass: 'write',
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: true },
    inputHints: { title: 'Answer a detached run request', fields: [
      { path: 'runId', title: 'Run id', widget: 'text', required: true },
      { path: 'requestId', title: 'Request id', widget: 'text', required: true },
      { path: 'approved', title: 'Approve permission', widget: 'boolean' },
      { path: 'answers', title: 'Question answers (JSON)', widget: 'textarea' },
    ] },
    inputSchema: ExecutionRunPermissionRespondInputSchema,
    outputSchema: lazyZodSchema(() => z.strictObject({ ok: z.literal(true) })),
  } satisfies PreNormalizedActionSpec,
  {
    id: 'execution.run.wait', executionPlacement: 'machine', toolExposure: { agent: 'direct', mcp: 'direct' }, approval: {result: 'required'},
    title: 'Wait for execution run',
    description: `Observe an execution run until terminal by default, or select permission attention, either condition, or a changed snapshot. Pass timeoutSeconds to bound the observation; omit it for no Happier-side deadline. ${EXECUTION_RUN_WAIT_OBSERVATION_DESCRIPTION} ${EXECUTION_RUN_SESSION_SCOPE_DESCRIPTION}`,
    safety: 'safe',
    placements: [],
    bindings: {
      rpcMethod: SESSION_RPC_METHODS.EXECUTION_RUN_WAIT,
      mcpToolName: 'execution_run_wait',
    },
    sideEffectClass: 'read',
    examples: {
      mcp: { argsExample: '{"sessionId":null,"runId":"run_123"}' },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: true,
    },
    cli: EXECUTION_RUN_WAIT_CLI_PROJECTION,
    inputHints: {
      title: 'Wait for a run',
      fields: [
        EXECUTION_RUN_SESSION_SCOPE_HINT,
        { path: 'runId', title: 'Run id', widget: 'text', required: true },
        { path: 'timeoutSeconds', title: 'Timeout seconds (optional)', widget: 'text' },
      ],
    },
    outputSchema: ExecutionRunWaitResultSchema,
    inputSchema: ExecutionRunWaitInputSchema,
    surfaceBindings: {
      api: {
        inputSchema: ExecutionRunWaitPublicInputSchema,
        outputSchema: ExecutionRunWaitResultSchema,
      },
    } satisfies ActionSpecSurfaceBindings,
  } satisfies PreNormalizedActionSpec,
] as const);

