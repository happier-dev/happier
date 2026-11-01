import { lazyZodSchema } from '../../lazyZodSchema.js';
import { PluginLocalizedStringV2Schema } from '../../plugins/contributions/publicTypes.js';
import { ActionSessionTargetDeclarationV1Schema } from '../sessionTargetV1.js';
import { ActionPromptingSchema } from '../metadata.js';
import { z } from 'zod/mini';
import type { ApprovalNarrowing } from '../../approvals/approvalNarrowing.js';
import type { ActionCompletionDeclaration } from '../actionCompletion.js';
import { ActionOperationDeclarationV1Schema, ActionOperationReentryPolicyV1Schema } from '../operations/v1.js';
import { ActionCliProjectionSchema, readActionSchemaTopLevelFieldNames } from '../actionCliProjection.js';
import { ActionExecutionPlacementSchema, ActionInputHintsSchema, ActionRequiredAuthoritySchema, ActionPermissionChangingSchema, ActionSurfaceSchema, ActionToolExposureSchema, type ActionExecutionPlacement, type ActionRequiredAuthority, type ActionSurfaces } from '../metadata.js';
import type { ActionCaller } from '../executor/types.js';
import type { ExternalActionTargetV1 } from '../externalActionApi.js';
import { ActionSafetySchema } from '../safety.js';
import { ActionIdSchema, type ActionId } from '../actionIds.js';
import { ActionUiPlacementSchema, type ActionUiPlacement } from '../actionUiPlacements.js';
import { PluginContributionLocalIdSchema } from '../../plugins/contributionIdentity.js';
import { PluginIdSchema } from '../../plugins/pluginId.js';
import { ActionApprovalSchema, ActionApprovalPolicySchema, resolveActionApprovalFlow } from '../actionApprovalMetadata.js';
import { asProtocolZod } from '../../plugins/actions/internalProtocolZodAdapter.js';
import { ActionContextualDefaultsSchema } from '../contextualDefaults.js';


/** What a presenting app knows that an approval summary may use; every field is optional. */
export type ApprovalPresentationContext = Readonly<{
  /** The target Machine's readable form of a path (home-relative). */
  formatPath?: (path: string) => string;
  /** Names captured from the admitted widget/catalog owners; presentation only, never routing. */
  widgetPresentation?: Readonly<{ widgetName?: string; pageName?: string; areaName?: string }>;
  /** The presenting client's canonical quantity formatter; never changes executable input. */
  formatDataBytes?: (bytes: number, options: Readonly<{ kind: 'memory' | 'storage' }>) => string;
  /** Available RAM from the resource-summary owner, scoped to the reviewed Machine. */
  machineMemory?: Readonly<{ machineId: string; availableBytes: number | null; totalBytes: number | null }>;
}>;

export const ZodSchemaLike = lazyZodSchema(() => z.custom<z.ZodMiniType>((value) => {
  if (!value || typeof value !== 'object') return false;
  const v = value as any;
  return typeof v.safeParse === 'function' && typeof v.parse === 'function';
}, { message: 'Expected a Zod schema' }));

export type ActionSurfaceBindingCaller = ActionCaller;

export type ActionSurfaceBindingContext = Readonly<{
  actionId: ActionId;
  surface: 'api' | 'rpc' | 'plugin';
  caller: ActionSurfaceBindingCaller;
  defaultSessionId?: string | null;
  serverId?: string | null;
  externalActionTarget?: ExternalActionTargetV1;
  signal?: AbortSignal;
  input?: unknown;
}>;

export type ActionSurfaceBindingTransform = (
  value: unknown,
  context: ActionSurfaceBindingContext,
) => unknown | Promise<unknown>;

export const ActionSurfaceBindingTransformSchema = lazyZodSchema(() => z.custom<ActionSurfaceBindingTransform>(
  (value) => typeof value === 'function',
  { message: 'Expected an Action surface binding transform' },
));

export const ActionSpecSurfaceBindingsSchema = lazyZodSchema(() => z.strictObject({
  mcp: z.optional(z.strictObject({ inputSchema: ZodSchemaLike })),
  api: z.optional(z.strictObject({
    inputSchema: ZodSchemaLike,
    bindInput: z.optional(ActionSurfaceBindingTransformSchema),
    outputSchema: z.optional(ZodSchemaLike),
    inputHints: z.optional(ActionInputHintsSchema),
  })),
  rpc: z.optional(z.strictObject({
    inputSchema: ZodSchemaLike,
    decodeInput: ActionSurfaceBindingTransformSchema,
    outputSchema: ZodSchemaLike,
    encodeOutput: ActionSurfaceBindingTransformSchema,
  })),
  plugin: z.optional(z.strictObject({
    inputSchema: z.optional(ZodSchemaLike),
    bindInput: z.optional(ActionSurfaceBindingTransformSchema),
    outputSchema: z.optional(ZodSchemaLike),
    projectOutput: z.optional(ActionSurfaceBindingTransformSchema),
  })),
}));
export type ActionSpecSurfaceBindings = z.infer<typeof ActionSpecSurfaceBindingsSchema>;

export const ActionPluginCallerAdministrativeSelectorSchema = lazyZodSchema(() => z.strictObject({
  pluginId: asProtocolZod(PluginIdSchema),
  contributionLocalId: asProtocolZod(PluginContributionLocalIdSchema),
}));

/**
 * A host Action's explicit authority contract when it is callable by a
 * plugin. `caller` requires a current host-stamped plugin caller at the
 * canonical executor: the host proves the call really came from the claimed
 * plugin materialization. Further identity projection occurs only where an
 * incumbent domain owner has caller-dependent authorization — for example the
 * Account-scoped Automation owner, which fences its own reads by Account and
 * current materialization rather than by which plugin is asking — and it never
 * grants authority over another plugin. `self_or_inspector_admin` is reserved
 * for the one plugin-targeted host Action and makes its exceptional Inspector
 * administration visible at the Action declaration owner.
 */
export const ActionPluginCallerPolicySchema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('caller'),
  }),
  z.strictObject({
    kind: z.literal('self_or_inspector_admin'),
    targetPluginIdField: z.literal('pluginId'),
    administrativeCallers: z.array(ActionPluginCallerAdministrativeSelectorSchema).check(z.minLength(1)),
  }),
]));
export type ActionPluginCallerPolicy = z.infer<typeof ActionPluginCallerPolicySchema>;

/** What a person approving a Session visual will see appear, and where. */
export function describeSessionVisualApprovalSummary(input: unknown): string | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  const item = value.item && typeof value.item === 'object' ? value.item as Record<string, unknown> : null;
  const title = typeof item?.title === 'string' && item.title.trim() ? `“${item.title.trim()}”` : 'a visual';
  const where = value.destination === 'board' ? 'on the Board'
    : value.destination === 'both' ? 'in the conversation and on the Board' : 'in the conversation';
  if (value.copySource !== undefined && value.copySource !== null) return `Copy a visual into this Session, ${where}.`;
  return `${typeof value.expectedItemRevision === 'string' ? 'Update' : 'Show'} ${title} ${where}.`;
}

/** Local declaration only; domain routes retain wire validation and authorization. */
export const ActionServerTransportSchema = lazyZodSchema(() => z.strictObject({
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  /** Existing resource routes may validate the addressed identity again in the mutation body. */
  preservePathFieldsInBody: z.optional(z.literal(true)),
  path: z.string().check(z.startsWith('/'), z.refine((path) => !path.startsWith('//'), {
    message: 'Action transport must be a relative Home path',
  })),
}));
export type ActionServerTransport = z.infer<typeof ActionServerTransportSchema>;

/** A declaration projects its own qualified Home; unrelated nested references are not routes. */
export function actionInputServerId<TSchema extends z.ZodMiniType>(schema: TSchema, project: (input: z.output<TSchema>) => string | undefined): (input: unknown) => string | undefined {
  return (input: unknown): string | undefined => {
    const parsed = z.safeParse(schema, input);
    return parsed.success ? project(parsed.data) : undefined;
  };
}

export const ActionSpecSchema = lazyZodSchema(() => z.looseObject({
  id: ActionIdSchema,
  title: z.string().check(z.minLength(1)),
  /** Presentation only: a localized verb; omission uses the host's generic approval label. */
  confirmVerb: z.optional(PluginLocalizedStringV2Schema),
  /** The effect cannot be undone; independent of safety and approval policy. */
  irreversible: z.optional(z.literal(true)),
  permissionChanging: z.optional(ActionPermissionChangingSchema),
  permissionChangingForInput: z.optional(z.custom<(input: unknown) => boolean>((value) => typeof value === 'function')),
  /**
   * The host admits this operand's scope before confirmation. Environment scopes may
   * inherit a current preview-template preference without changing child authority.
   */
  approvalScope: z.optional(z.enum(['machine', 'environment'])),
  description: z.optional(z.string().check(z.minLength(1))),
  safety: ActionSafetySchema,
  safetyForInput: z.optional(z.custom<(input: unknown) => z.infer<typeof ActionSafetySchema> | undefined>((value) => typeof value === 'function')),
  approval: ActionApprovalSchema,
  approvalPolicy: z.optional(ActionApprovalPolicySchema),
  // UI placements where the action can appear when the relevant surface is enabled.
  placements: z._default(z.array(ActionUiPlacementSchema), []),
  // Optional stable slash command token for UI slash-command placement.
  slash: z.optional(z.looseObject({
    tokens: z.array(z.string().check(z.minLength(1))),
  })),
  bindings: z.optional(z.looseObject({
    // Tool name the voice client is allowed to expose (surface.voice).
    voiceClientToolName: z.optional(z.string().check(z.minLength(1))),
    // Optional direct MCP tool name; generic action_execute invokes by Action id.
    mcpToolName: z.optional(z.string().check(z.minLength(1))),
    // Optional generated SDK method-name override. Most public Actions derive
    // their path from the canonical Action id; overrides only resolve a real
    // namespace collision.
    sdkMethod: z.optional(z.string().check(z.minLength(1))),
    // RPC method exposed when surface.rpc is true.
    rpcMethod: z.optional(z.string().check(z.minLength(1))),
    // Wire aliases accepted alongside the canonical method until their owning compatibility packet removes them.
    rpcMethodAliases: z.optional(z.array(z.string().check(z.minLength(1)))),
  })),
  surfaceBindings: z.optional(ActionSpecSurfaceBindingsSchema),
  sessionTarget: z.optional(ActionSessionTargetDeclarationV1Schema),
  outputSchema: z.optional(ZodSchemaLike),
  /** The deciding person's reduced operands; never an approval policy. */
  approvalNarrowing: z.optional(z.strictObject({
    narrow: z.custom<ApprovalNarrowing['narrow']>((value) => typeof value === 'function'),
  })),
  /** Host-private launch/terminal projection. Only its schema and awaits marker are frozen. */
  completion: z.optional(z.discriminatedUnion('awaits', [
    z.strictObject({
      awaits: z.literal('execution_runs'),
      terminalOutputSchema: ZodSchemaLike,
      launched: z.custom<Extract<ActionCompletionDeclaration, { awaits: 'execution_runs' }>['launched']>(
        (value) => typeof value === 'function',
      ),
      terminal: z.custom<Extract<ActionCompletionDeclaration, { awaits: 'execution_runs' }>['terminal']>(
        (value) => typeof value === 'function',
      ),
    }),
    z.strictObject({
      awaits: z.literal('action_operations'),
      immediateResultSchema: z.optional(ZodSchemaLike),
      terminalOutputSchema: ZodSchemaLike,
      launched: z.custom<Extract<ActionCompletionDeclaration, { awaits: 'action_operations' }>['launched']>(
        (value) => typeof value === 'function',
      ),
      terminal: z.custom<Extract<ActionCompletionDeclaration, { awaits: 'action_operations' }>['terminal']>(
        (value) => typeof value === 'function',
      ),
    }),
  ])),
  /** Host-private input projection for observers; secrets must never enter Action history. */
  projectObservationInput: z.optional(z.custom<(value: unknown) => unknown>(
    (value) => typeof value === 'function',
  )),
  /** Domain-owned, value-free human description of the exact effect under review. */
  approvalPresentation: z.optional(z.strictObject({
    /**
     * The presenting app may pass what only it knows (a Machine's home, to read paths `~/work/app`); without it the
     * summary still reads, so every surface (agent, CLI, MCP) gets the same contract.
     */
    summary: z.custom<(input: unknown, context?: ApprovalPresentationContext) => string | null>((value) => typeof value === 'function'),
    /**
     * Input paths that identify or correlate the request (command, view and session ids, fixed discriminators,
     * client plumbing) rather than say what it does. Approval reads them under Technical details; a path
     * `field.member` marks that direct member of a structured value.
     */
    technicalInputPaths: z.optional(z.readonly(z.array(z.string().check(z.minLength(1))))),
    /** Private approval review can disclose operands that must stay out of shared Action observations. */
    projectInput: z.optional(z.custom<(input: unknown, context?: ApprovalPresentationContext) => unknown>((value) => typeof value === 'function')),
    /** Admits private review/history operands when they intentionally differ from executable input. */
    inputSchema: z.optional(ZodSchemaLike),
    /** Private review field labels may differ from the executable authoring form. */
    inputHints: z.optional(ActionInputHintsSchema),
    /** Private history may retain this declared review after replay; live-only custody still wins. */
    retainInputOnSettlement: z.optional(z.literal(true)),
  })),
  /** Host-private output projection for observers; never changes the intentional caller result. */
  projectObservationOutput: z.optional(z.custom<(value: unknown) => unknown>(
    (value) => typeof value === 'function',
  )),
  /**
   * Host-private custody rule for one-shot results that must never become
   * durable Approval Artifact result state. A present-user UI invocation keeps
   * the existing blocking waiter alive and receives the result directly; if
   * that live invocation is lost, the result is intentionally unrecoverable.
   */
  approvalResultCustody: z.optional(z.literal('live_only')),
  /** Successful self-retirement permits only a live, value-free receipt when this Account can no longer settle history. */
  accountAuthorityRetirementStatuses: z.optional(z.readonly(z.array(z.string().check(z.minLength(1))).check(z.minLength(1)))),
  /**
   * The input-side sibling of `approvalResultCustody`. Host-private custody rule
   * for secret-bearing input — credentials, verification bearers, reauthentication
   * proofs — that must never become durable Approval Artifact state. The admitted
   * invocation stays the blocking waiter and keeps the raw input; the Artifact
   * carries only this Action's own `projectObservationInput` projection, so a
   * replay that no longer has the live invocation fails closed instead of
   * recovering the secret from durable approval state.
   */
  approvalInputCustody: z.optional(z.literal('live_only')),
  /** Domain-owned disclosure of this exact operation to its Session participants. */
  projectSessionConfirmation: z.optional(z.custom<(
    input: unknown,
    context: Readonly<{ sessionId: string }>,
  ) => unknown | null>((value) => typeof value === 'function')),
  execution: z.optional(z.looseObject({
      handler: z.optional(z.string().check(z.minLength(1))),
      transport: z.optional(z.enum(['host', 'plugin', 'rpc', 'api'])),
    })),
  sideEffectClass: z.optional(z.enum(['none', 'read', 'write', 'external', 'danger'])),
  /** This Action mutates workspace files or repository state. Coordination writes do not. */
  workspaceWrite: z.optional(z.literal(true)),
  examples: z.optional(z.looseObject({
      voice: z.optional(z.looseObject({
          argsExample: z.optional(z.string().check(z.minLength(1))),
        })),
      mcp: z.optional(z.looseObject({
          argsExample: z.optional(z.string().check(z.minLength(1))),
        })),
      sdk: z.optional(z.looseObject({
          codeExample: z.optional(z.string().check(z.minLength(1))),
        })),
    })),
  prompting: z.optional(ActionPromptingSchema),
  toolExposure: z.optional(ActionToolExposureSchema),
  contextualDefaults: z.optional(ActionContextualDefaultsSchema),
  operation: z.optional(ActionOperationDeclarationV1Schema),
  /** Host-local exact-request policy; intentionally omitted from serialized Action discovery. */
  operationReentry: z.optional(ActionOperationReentryPolicyV1Schema),
  /** Host-owned admission floor; public callers never supply this in Action input. */
  requiredAuthority: z.optional(ActionRequiredAuthoritySchema),
  /** Host-owned routing placement; public callers never supply this in Action input. */
  executionPlacement: z.optional(ActionExecutionPlacementSchema),
  /** Host-only selector for an admitted input whose owner varies; never serialized as caller authority. */
  executionPlacementForInput: z.optional(z.custom<(input: unknown) => ActionExecutionPlacement>((value) => typeof value === 'function')),
  /** Host-private Home projection; domain schemas admit its operands before Account capture. Never serialized. */
  invocationServerIdForInput: z.optional(z.custom<(input: unknown) => string | undefined>((value) => typeof value === 'function')),
  /** Placements producible by this input selector; ingress cannot open encrypted operands. */
  executionPlacements: z.optional(z.readonly(z.array(ActionExecutionPlacementSchema).check(z.minLength(1)))),
  /** Host ingress exceptions belong to the declaration, never consumer-maintained ID groups. */
  originalExecution: z.optional(z.strictObject({
    accountRoot: z.optional(z.enum(['allowed', 'separate'])),
    terminalRoot: z.optional(z.enum(['allowed', 'host'])),
    nativePurpose: z.optional(z.enum(['quota_read', 'session_board_write', 'pending_reset_start'])),
  })),
  /** Explicit host-stamped caller authority for a Plugin Action. */
  pluginCallerPolicy: z.optional(ActionPluginCallerPolicySchema),
  surfaces: ActionSurfaceSchema,
  inputSchema: ZodSchemaLike,
  inputHints: z.optional(ActionInputHintsSchema),
  /** Internal domain parser, before the catalog adds the delivery selector. Never serialized. */
  clientActionDomainInputSchema: z.optional(ZodSchemaLike),
  /**
   * Friendly CLI command projection for this packaged binary. Intentionally
   * omitted by `serializeActionSpec`/`actionSpecToActionDefinitionV1`: it is not
   * a cross-version wire contract and its binder cannot be serialized.
   */
  cli: z.optional(ActionCliProjectionSchema),
  /** Not serialized; the bound domain adapter supplies encryption and Home identity. */
  serverTransport: z.optional(ActionServerTransportSchema),
}).check(z.superRefine((value, ctx) => {
  if (value.operationReentry && !value.operation) {
    ctx.addIssue({
      code: "custom",
      message: 'operationReentry requires a tracked operation declaration',
      path: ['operationReentry'],
    });
  }
  if ((value.placements?.length ?? 0) > 0 && !value.surfaces.ui) {
    ctx.addIssue({
      code: "custom",
      message: 'placements require surface.ui',
      path: ['surfaces', 'ui'],
    });
  }
  if (value.approvalResultCustody === 'live_only') {
    if (value.approval.result !== 'required') {
      ctx.addIssue({
        code: "custom",
        message: 'live-only approval custody requires a required result',
        path: ['approvalResultCustody'],
      });
    }
    if (!value.projectObservationOutput) {
      ctx.addIssue({
        code: "custom",
        message: 'live-only approval custody requires a safe observation projection',
        path: ['projectObservationOutput'],
      });
    }
  }
  if (value.approvalInputCustody === 'live_only') {
    if (resolveActionApprovalFlow(value.approval) !== 'blocking') {
      ctx.addIssue({
        code: "custom",
        message: 'live-only approval input custody requires a blocking approval flow',
        path: ['approvalInputCustody'],
      });
    }
    if (!value.projectObservationInput) {
      ctx.addIssue({
        code: "custom",
        message: 'live-only approval input custody requires a safe observation projection',
        path: ['projectObservationInput'],
      });
    }
  }
  if (value.surfaces.rpc && !value.bindings?.rpcMethod) {
    ctx.addIssue({
      code: "custom",
      message: 'surface.rpc requires bindings.rpcMethod',
      path: ['bindings', 'rpcMethod'],
    });
  }
  if (value.surfaces.mcp && !value.outputSchema) {
    ctx.addIssue({
      code: "custom",
      message: 'surface.mcp requires outputSchema',
      path: ['outputSchema'],
    });
  }
  if (value.surfaces.plugin && !value.outputSchema) {
    ctx.addIssue({
      code: "custom",
      message: 'surface.plugin requires outputSchema',
      path: ['outputSchema'],
    });
  }
  if (value.surfaces.plugin && value.inputSchema instanceof z.ZodMiniUnknown) {
    ctx.addIssue({
      code: "custom",
      message: 'surface.plugin requires a representable input schema',
      path: ['inputSchema'],
    });
  }
  if (value.surfaces.plugin && value.outputSchema instanceof z.ZodMiniUnknown) {
    ctx.addIssue({
      code: "custom",
      message: 'surface.plugin requires a representable output schema',
      path: ['outputSchema'],
    });
  }
  const nonSafePluginAction = value.surfaces.plugin && value.safety !== 'safe';
  if (nonSafePluginAction && !value.pluginCallerPolicy) {
    ctx.addIssue({
      code: "custom",
      message: 'non-safe surface.plugin requires pluginCallerPolicy',
      path: ['pluginCallerPolicy'],
    });
  }
  if (!value.surfaces.plugin && value.pluginCallerPolicy) {
    ctx.addIssue({
      code: "custom",
      message: 'pluginCallerPolicy requires a surface.plugin Action',
      path: ['pluginCallerPolicy'],
    });
  }
  if (value.surfaceBindings?.rpc && !value.surfaces.rpc) {
    ctx.addIssue({
      code: "custom",
      message: 'surfaceBindings.rpc requires surface.rpc',
      path: ['surfaceBindings', 'rpc'],
    });
  }
  if (value.surfaceBindings?.plugin && !value.surfaces.plugin) {
    ctx.addIssue({
      code: "custom",
      message: 'surfaceBindings.plugin requires surface.plugin',
      path: ['surfaceBindings', 'plugin'],
    });
  }
  if (value.cli && !value.surfaces.cli) {
    ctx.addIssue({
      code: "custom",
      message: 'cli requires surface.cli',
      path: ['surfaces', 'cli'],
    });
  }
  if (value.cli) {
    // Positionals name the effective CLI caller shape, which is the declared
    // caller schema when one exists and the canonical Action input otherwise.
    const callerShape = value.cli.inputSchema ?? value.inputSchema;
    const declaredFields = readActionSchemaTopLevelFieldNames(callerShape);
    if (declaredFields) {
      for (const [index, command] of value.cli.commands.entries()) {
        for (const [positionalIndex, positional] of (command.positionals ?? []).entries()) {
          if (!declaredFields.has(positional)) {
            ctx.addIssue({
              code: "custom",
              message: `cli positional "${positional}" is not a field of the effective CLI caller schema`,
              path: ['cli', 'commands', index, 'positionals', positionalIndex],
            });
          }
        }
        if (command.variadicPositional && !declaredFields.has(command.variadicPositional)) {
          ctx.addIssue({
            code: "custom",
            message: `cli variadic positional "${command.variadicPositional}" is not a field of the effective CLI caller schema`,
            path: ['cli', 'commands', index, 'variadicPositional'],
          });
        }
      }
      for (const [index, entry] of (value.cli.flagAliases ?? []).entries()) {
        if (!declaredFields.has(entry.path)) {
          ctx.addIssue({
            code: "custom",
            message: `cli flag alias target "${entry.path}" is not a field of the effective CLI caller schema`,
            path: ['cli', 'flagAliases', index, 'path'],
          });
        }
      }
    }
  }
  if (value.surfaceBindings?.plugin?.bindInput && !value.surfaceBindings.plugin.inputSchema) {
    ctx.addIssue({
      code: "custom",
      message: 'surfaceBindings.plugin.bindInput requires a caller input schema',
      path: ['surfaceBindings', 'plugin', 'inputSchema'],
    });
  }
})));

export type ActionSpec = z.infer<typeof ActionSpecSchema> & Readonly<{
  placements: readonly ActionUiPlacement[];
  requiredAuthority: ActionRequiredAuthority;
  executionPlacement: ActionExecutionPlacement;
}>;

/**
 * Evaluates the declaration-owned policy against host-stamped caller
 * provenance. Action input never manufactures, widens, or narrows caller
 * authority: it is read only to name the plugin the call *targets*, and the
 * target is then compared against the stamped caller.
 */
export function isPluginActionCallerPolicySatisfied(
  policy: ActionPluginCallerPolicy | undefined,
  input: unknown,
  caller: ActionCaller | undefined,
): boolean {
  if (!policy || caller?.kind !== 'plugin') return false;
  if (policy.kind === 'caller') return true;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;

  const targetPluginId = (input as Readonly<Record<string, unknown>>)[policy.targetPluginIdField];
  if (typeof targetPluginId !== 'string') return false;
  if (targetPluginId === caller.pluginId) return true;

  return policy.administrativeCallers.some((administrator) => (
    administrator.pluginId === caller.pluginId
    && administrator.contributionLocalId === caller.contributionLocalId
  ));
}

export type ParsedActionSpec = z.infer<typeof ActionSpecSchema>;
export type ActionSpecWithoutApproval = Readonly<{
  id: ParsedActionSpec['id'];
  approval: ParsedActionSpec['approval'];
  approvalPolicy?: ParsedActionSpec['approvalPolicy'];
  title: ParsedActionSpec['title'];
  confirmVerb?: ParsedActionSpec['confirmVerb'];
  irreversible?: ParsedActionSpec['irreversible'];
  permissionChanging?: ParsedActionSpec['permissionChanging'];
  permissionChangingForInput?: ParsedActionSpec['permissionChangingForInput'];
  approvalScope?: ParsedActionSpec['approvalScope'];
  description?: ParsedActionSpec['description'];
  safety: ParsedActionSpec['safety'];
  safetyForInput?: ParsedActionSpec['safetyForInput'];
  placements: readonly ActionUiPlacement[];
  slash?: ParsedActionSpec['slash'];
  bindings?: ParsedActionSpec['bindings'];
  surfaceBindings?: ParsedActionSpec['surfaceBindings'];
  outputSchema?: ParsedActionSpec['outputSchema'];
  completion?: ParsedActionSpec['completion'];
  projectObservationInput?: ParsedActionSpec['projectObservationInput'];
  approvalPresentation?: ParsedActionSpec['approvalPresentation'];
  projectObservationOutput?: ParsedActionSpec['projectObservationOutput'];
  approvalResultCustody?: ParsedActionSpec['approvalResultCustody'];
  accountAuthorityRetirementStatuses?: ParsedActionSpec['accountAuthorityRetirementStatuses'];
  approvalInputCustody?: ParsedActionSpec['approvalInputCustody'];
  approvalNarrowing?: ParsedActionSpec['approvalNarrowing'];
  projectSessionConfirmation?: ParsedActionSpec['projectSessionConfirmation'];
  execution?: ParsedActionSpec['execution'];
  sideEffectClass?: ParsedActionSpec['sideEffectClass'];
  workspaceWrite?: ParsedActionSpec['workspaceWrite'];
  examples?: ParsedActionSpec['examples'];
  prompting?: ParsedActionSpec['prompting'];
  toolExposure?: ParsedActionSpec['toolExposure'];
  contextualDefaults?: ParsedActionSpec['contextualDefaults'];
  sessionTarget?: ParsedActionSpec['sessionTarget'];
  operation?: ParsedActionSpec['operation'];
  operationReentry?: ParsedActionSpec['operationReentry'];
  requiredAuthority?: ParsedActionSpec['requiredAuthority'];
  executionPlacement?: ParsedActionSpec['executionPlacement'];
  executionPlacementForInput?: ParsedActionSpec['executionPlacementForInput'];
  invocationServerIdForInput?: ParsedActionSpec['invocationServerIdForInput'];
  executionPlacements?: ParsedActionSpec['executionPlacements'];
  originalExecution?: ParsedActionSpec['originalExecution'];
  pluginCallerPolicy?: ParsedActionSpec['pluginCallerPolicy'];
  surfaces: ParsedActionSpec['surfaces'];
  inputSchema: ParsedActionSpec['inputSchema'];
  clientActionDomainInputSchema?: ParsedActionSpec['clientActionDomainInputSchema'];
  inputHints?: ParsedActionSpec['inputHints'];
  cli?: ParsedActionSpec['cli'];
  serverTransport?: ParsedActionSpec['serverTransport'];
}>;

/**
 * API and Plugin admission are derived by normalizeActionPublicExposure. A
 * declaration may retain an API exclusion, but cannot grant API admission.
 */
export type PreNormalizedActionSurfaces = Omit<ActionSurfaces, 'api' | 'plugin'> & Readonly<{
  api?: false;
  plugin?: never;
}>;
export type ActionSpecDefinition = Omit<ActionSpecWithoutApproval, 'surfaces'> & Readonly<{
  surfaces: PreNormalizedActionSurfaces;
}>;
export type PreNormalizedActionSpec = ActionSpecDefinition;
export type NormalizedActionSpec = ActionSpecWithoutApproval;

export type ActionSpecProjectionKey = 'id' | 'approval' | 'inputSchema' | 'outputSchema' | 'surfaceBindings' | 'requiredAuthority';
export type ActionSpecProjectionMetadata = Omit<PreNormalizedActionSpec, ActionSpecProjectionKey>;

/**
 * Keeps each registry row's literal id and concrete Zod schema types intact.
 * Runtime validation still goes through ActionSpecSchema; this helper exists so
 * generated author projections do not widen back to ActionId/ZodTypeAny.
 * Validate each declaration with satisfies before projection: an array-wide
 * constraint/check lets one bad row widen or contaminate its healthy siblings.
 */
export function defineActionSpecs<const TSpecs extends readonly unknown[]>(
  specs: TSpecs,
): {
  readonly [Index in keyof TSpecs]: ActionSpecProjectionMetadata & {
    readonly [Key in keyof TSpecs[Index] as Key extends ActionSpecProjectionKey ? Key : never]: TSpecs[Index][Key];
  } & (TSpecs[Index] extends Readonly<{ surfaces: Readonly<{ api: false }> }> ? Readonly<{
    // API exclusions affect public type membership; other surface metadata may stay broad.
    surfaces: PreNormalizedActionSurfaces & Readonly<{ api: false }>;
  }> : unknown);
};
export function defineActionSpecs(
  specs: readonly PreNormalizedActionSpec[],
): readonly PreNormalizedActionSpec[] {
  return specs;
}
