import { AutomationSubjectKindV1Schema } from '../automations/automationSubjectV1.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { PluginSubjectKindContributionV1Schema } from '../plugins/contributions/subjectKinds.js';
import { PluginLocalizedStringV2Schema } from '../plugins/contributions/publicTypes.js';
import { z } from '../zodRuntimePolicy.js';

import { ActionUiPlacementSchema } from './actionUiPlacements.js';
import { ActionApprovalSchema } from './actionApprovalMetadata.js';
import {
  ActionInputHintsSchema,
  ActionExecutionPlacementSchema,
  ActionRequiredAuthoritySchema,
  ActionPermissionChangingSchema,
  ActionSurfaceSchema,
  ActionToolExposureSchema,
  ActionPromptingSchema,
} from './metadata.js';
import { ActionSafetySchema } from './safety.js';
import { ActionOperationDeclarationV1Schema } from './operations/v1.js';
import { ActionContextualDefaultsSchema } from './contextualDefaults.js';
import { ActionSessionTargetDeclarationV1Schema } from './sessionTargetV1.js';
import { PluginLooseJsonObjectSchema, PluginOptionalStringSchema } from '../plugins/_shared.js';
import { ActionCompletionContractV1Schema } from './actionCompletion.js';
import { PluginActionApprovalScopeV2Schema } from '../plugins/actions/v2.js';

const LooseJsonObjectSchema = PluginLooseJsonObjectSchema;
const OptionalStringSchema = PluginOptionalStringSchema;

function normalizeSerializedActionSurfaces(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const raw = value as Readonly<Record<string, unknown>>;
  return {
    ui: raw.ui === true || raw.ui_button === true || raw.ui_slash_command === true,
    voice: raw.voice === true || raw.voice_tool === true || raw.voice_action_block === true,
    agent: raw.agent === true || raw.session_agent === true,
    mcp: raw.mcp === true,
    cli: raw.cli === true,
    rpc: raw.rpc === true,
    api: raw.api === true,
    // Supported predecessor writers do not know this surface. Omission never
    // grants plugin invocation authority.
    plugin: raw.plugin === true,
  };
}

export const SerializedActionSurfaceSchema = lazyZodSchema(() => (<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform(normalizeSerializedActionSurfaces), ActionSurfaceSchema));

export const ActionDefinitionIdV1Schema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1)));
export type ActionDefinitionIdV1 = z.infer<typeof ActionDefinitionIdV1Schema>;

export const ActionDefinitionSlashV1Schema = lazyZodSchema(() => z.nullable(z.looseObject({
    tokens: z.array(z.string().check(z.minLength(1))),
  })));
export type ActionDefinitionSlashV1 = z.infer<typeof ActionDefinitionSlashV1Schema>;

export const ActionDefinitionBindingsV1Schema = lazyZodSchema(() => z.nullable(z.looseObject({
    voiceClientToolName: z.optional(z.string().check(z.minLength(1))),
    mcpToolName: z.optional(z.string().check(z.minLength(1))),
    sdkMethod: z.optional(z.string().check(z.minLength(1))),
    rpcMethod: z.optional(z.string().check(z.minLength(1))),
    rpcMethodAliases: z.optional(z.array(z.string().check(z.minLength(1)))),
  })));
export type ActionDefinitionBindingsV1 = z.infer<typeof ActionDefinitionBindingsV1Schema>;

export const ActionDefinitionExamplesV1Schema = lazyZodSchema(() => z.nullable(z.looseObject({
    voice: z.optional(z.nullable(z.looseObject({
        argsExample: z.optional(z.string().check(z.minLength(1))),
      }))),
    mcp: z.optional(z.nullable(z.looseObject({
        argsExample: z.optional(z.string().check(z.minLength(1))),
      }))),
    sdk: z.optional(z.nullable(z.looseObject({
        codeExample: z.optional(z.string().check(z.minLength(1))),
      }))),
  })));
export type ActionDefinitionExamplesV1 = z.infer<typeof ActionDefinitionExamplesV1Schema>;

export const ActionExecutionHandlerRefV1Schema = lazyZodSchema(() => z.union([
  z.string().check(z.minLength(1)),
  z.looseObject({
      target: z.enum(['host', 'plugin', 'daemon']),
      exportName: OptionalStringSchema,
      registrationId: OptionalStringSchema,
    }),
]));
export type ActionExecutionHandlerRefV1 = z.infer<typeof ActionExecutionHandlerRefV1Schema>;

export const ActionExecutionDescriptorV1Schema = lazyZodSchema(() => z.looseObject({
    handler: z.optional(ActionExecutionHandlerRefV1Schema),
    transport: z.optional(z.enum(['host', 'plugin', 'rpc', 'api'])),
    routing: OptionalStringSchema,
    approvalPolicy: OptionalStringSchema,
    resultSchema: z.optional(LooseJsonObjectSchema),
  }));
export type ActionExecutionDescriptorV1 = z.infer<typeof ActionExecutionDescriptorV1Schema>;

const ActionAutomationChoicesV1Schema = lazyZodSchema(() => z.strictObject({
    before: z.boolean(),
    after: z.boolean(),
    workflowStep: z.boolean(),
    /** Potential admitted kinds, including Session and profile context; never a permission claim. */
    subjectKinds: z.optional(z.array(AutomationSubjectKindV1Schema)),
  }));

export const ActionDefinitionSummaryV1Schema = lazyZodSchema(() => z.looseObject({
    id: ActionDefinitionIdV1Schema,
    title: z.string().check(z.minLength(1)),
    confirmVerb: z.optional(PluginLocalizedStringV2Schema),
    irreversible: z.optional(z.literal(true)),
    permissionChanging: z.optional(ActionPermissionChangingSchema),
    description: z.nullable(z.string().check(z.minLength(1))),
    safety: ActionSafetySchema,
    approval: z.optional(ActionApprovalSchema),
    approvalScope: z.optional(z.union([z.literal('machine'), PluginActionApprovalScopeV2Schema])),
    subjectKindDefinition: z.optional(PluginSubjectKindContributionV1Schema),
    requiredAuthority: z.optional(ActionRequiredAuthoritySchema),
    executionPlacement: z.optional(ActionExecutionPlacementSchema),
    placements: z.array(ActionUiPlacementSchema),
    slash: ActionDefinitionSlashV1Schema,
    bindings: ActionDefinitionBindingsV1Schema,
    examples: ActionDefinitionExamplesV1Schema,
    surfaces: SerializedActionSurfaceSchema,
    toolExposure: z.optional(ActionToolExposureSchema),
    prompting: z.optional(ActionPromptingSchema),
    contextualDefaults: z.optional(ActionContextualDefaultsSchema),
    sessionTarget: z.optional(ActionSessionTargetDeclarationV1Schema),
    inputHints: z.nullable(ActionInputHintsSchema),
    outputSchema: z.optional(LooseJsonObjectSchema),
    execution: z.optional(ActionExecutionDescriptorV1Schema),
    sideEffectClass: z.optional(z.enum(['none', 'read', 'write', 'external', 'danger'])),
    automation: z.optional(ActionAutomationChoicesV1Schema),
    operation: z.optional(ActionOperationDeclarationV1Schema),
  }));
export type ActionDefinitionSummaryV1 = z.infer<typeof ActionDefinitionSummaryV1Schema>;

export const ActionDefinitionV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.extend(ActionDefinitionSummaryV1Schema, {
  kindVersion: z._default(z.literal(1), 1),
  inputSchema: LooseJsonObjectSchema,
  completion: z.optional(ActionCompletionContractV1Schema),
  compatibility: z.optional(LooseJsonObjectSchema),
})));
export type ActionDefinitionV1 = z.infer<typeof ActionDefinitionV1Schema>;

export const SerializedActionDefinitionV1Schema = ActionDefinitionV1Schema;
export type SerializedActionDefinitionV1 = z.infer<typeof SerializedActionDefinitionV1Schema>;

const ActionDiscoverySlashV1Schema = lazyZodSchema(() => z.nullable(z.strictObject({
    tokens: z.array(z.string().check(z.minLength(1))),
  })));

const ActionDiscoveryBindingsV1Schema = lazyZodSchema(() => z.nullable(z.strictObject({
    voiceClientToolName: z.optional(z.string().check(z.minLength(1))),
    mcpToolName: z.optional(z.string().check(z.minLength(1))),
    sdkMethod: z.optional(z.string().check(z.minLength(1))),
    rpcMethod: z.optional(z.string().check(z.minLength(1))),
    rpcMethodAliases: z.optional(z.array(z.string().check(z.minLength(1)))),
  })));

const ActionDiscoveryExamplesV1Schema = lazyZodSchema(() => z.nullable(z.strictObject({
    voice: z.optional(z.nullable(z.strictObject({
      argsExample: z.optional(z.string().check(z.minLength(1))),
    }))),
    mcp: z.optional(z.nullable(z.strictObject({
      argsExample: z.optional(z.string().check(z.minLength(1))),
    }))),
    sdk: z.optional(z.nullable(z.strictObject({
      codeExample: z.optional(z.string().check(z.minLength(1))),
    }))),
  })));

const ActionDiscoveryExecutionHandlerRefV1Schema = lazyZodSchema(() => z.union([
  z.string().check(z.minLength(1)),
  z.strictObject({
    target: z.enum(['host', 'plugin', 'daemon']),
    exportName: OptionalStringSchema,
    registrationId: OptionalStringSchema,
  }),
]));

const ActionDiscoveryExecutionDescriptorV1Schema = lazyZodSchema(() => z.strictObject({
    handler: z.optional(ActionDiscoveryExecutionHandlerRefV1Schema),
    transport: z.optional(z.enum(['host', 'plugin', 'rpc', 'api'])),
    routing: OptionalStringSchema,
    approvalPolicy: OptionalStringSchema,
    resultSchema: z.optional(LooseJsonObjectSchema),
  }));

export const ActionDiscoveryDefinitionSummaryV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(ActionDefinitionSummaryV1Schema, {
  slash: ActionDiscoverySlashV1Schema,
  bindings: ActionDiscoveryBindingsV1Schema,
  examples: ActionDiscoveryExamplesV1Schema,
  execution: z.optional(ActionDiscoveryExecutionDescriptorV1Schema),
})));
export type ActionDiscoveryDefinitionSummaryV1 = z.infer<typeof ActionDiscoveryDefinitionSummaryV1Schema>;

export const ActionDiscoveryDefinitionV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(ActionDiscoveryDefinitionSummaryV1Schema, {
  kindVersion: z._default(z.literal(1), 1),
  inputSchema: LooseJsonObjectSchema,
  completion: z.optional(ActionCompletionContractV1Schema),
  compatibility: z.optional(LooseJsonObjectSchema),
})));
export type ActionDiscoveryDefinitionV1 = z.infer<typeof ActionDiscoveryDefinitionV1Schema>;
