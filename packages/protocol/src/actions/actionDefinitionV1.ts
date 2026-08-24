import { z } from 'zod';

import { ActionUiPlacementSchema } from './actionUiPlacements.js';
import { ActionApprovalSchema } from './actionApprovalMetadata.js';
import {
  ActionInputHintsSchema,
  ActionExecutionPlacementSchema,
  ActionRequiredAuthoritySchema,
  ActionSurfaceSchema,
  ActionToolExposureSchema,
} from './metadata.js';
import { ActionSafetySchema } from './safety.js';
import { ActionOperationDeclarationV1Schema } from './operations/v1.js';
import { ActionContextualDefaultsSchema } from './contextualDefaults.js';
import { PluginLooseJsonObjectSchema, PluginOptionalStringSchema } from '../plugins/_shared.js';

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

export const SerializedActionSurfaceSchema = z.preprocess(
  normalizeSerializedActionSurfaces,
  ActionSurfaceSchema,
);

export const ActionDefinitionIdV1Schema = z.string().trim().min(1);
export type ActionDefinitionIdV1 = z.infer<typeof ActionDefinitionIdV1Schema>;

export const ActionDefinitionSlashV1Schema = z
  .object({
    tokens: z.array(z.string().min(1)),
  })
  .passthrough()
  .nullable();
export type ActionDefinitionSlashV1 = z.infer<typeof ActionDefinitionSlashV1Schema>;

export const ActionDefinitionBindingsV1Schema = z
  .object({
    voiceClientToolName: z.string().min(1).optional(),
    mcpToolName: z.string().min(1).optional(),
    sdkMethod: z.string().min(1).optional(),
    rpcMethod: z.string().min(1).optional(),
  })
  .passthrough()
  .nullable();
export type ActionDefinitionBindingsV1 = z.infer<typeof ActionDefinitionBindingsV1Schema>;

export const ActionDefinitionExamplesV1Schema = z
  .object({
    voice: z
      .object({
        argsExample: z.string().min(1).optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    mcp: z
      .object({
        argsExample: z.string().min(1).optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    sdk: z
      .object({
        codeExample: z.string().min(1).optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough()
  .nullable();
export type ActionDefinitionExamplesV1 = z.infer<typeof ActionDefinitionExamplesV1Schema>;

export const ActionExecutionHandlerRefV1Schema = z.union([
  z.string().min(1),
  z
    .object({
      target: z.enum(['host', 'plugin', 'daemon']),
      exportName: OptionalStringSchema,
      registrationId: OptionalStringSchema,
    })
    .passthrough(),
]);
export type ActionExecutionHandlerRefV1 = z.infer<typeof ActionExecutionHandlerRefV1Schema>;

export const ActionExecutionDescriptorV1Schema = z
  .object({
    handler: ActionExecutionHandlerRefV1Schema.optional(),
    transport: z.enum(['host', 'plugin', 'rpc', 'api']).optional(),
    routing: OptionalStringSchema,
    approvalPolicy: OptionalStringSchema,
    resultSchema: LooseJsonObjectSchema.optional(),
  })
  .passthrough();
export type ActionExecutionDescriptorV1 = z.infer<typeof ActionExecutionDescriptorV1Schema>;

export const ActionDefinitionSummaryV1Schema = z
  .object({
    id: ActionDefinitionIdV1Schema,
    title: z.string().min(1),
    description: z.string().min(1).nullable(),
    safety: ActionSafetySchema,
    approval: ActionApprovalSchema.optional(),
    requiredAuthority: ActionRequiredAuthoritySchema.optional(),
    executionPlacement: ActionExecutionPlacementSchema.optional(),
    placements: z.array(ActionUiPlacementSchema),
    slash: ActionDefinitionSlashV1Schema,
    bindings: ActionDefinitionBindingsV1Schema,
    examples: ActionDefinitionExamplesV1Schema,
    surfaces: SerializedActionSurfaceSchema,
    toolExposure: ActionToolExposureSchema.optional(),
    contextualDefaults: ActionContextualDefaultsSchema.optional(),
    inputHints: ActionInputHintsSchema.nullable(),
    outputSchema: LooseJsonObjectSchema.optional(),
    execution: ActionExecutionDescriptorV1Schema.optional(),
    sideEffectClass: z.enum(['none', 'read', 'write', 'external', 'danger']).optional(),
    operation: ActionOperationDeclarationV1Schema.optional(),
  })
  .passthrough();
export type ActionDefinitionSummaryV1 = z.infer<typeof ActionDefinitionSummaryV1Schema>;

export const ActionDefinitionV1Schema = ActionDefinitionSummaryV1Schema.extend({
  kindVersion: z.literal(1).default(1),
  inputSchema: LooseJsonObjectSchema,
  compatibility: LooseJsonObjectSchema.optional(),
}).passthrough();
export type ActionDefinitionV1 = z.infer<typeof ActionDefinitionV1Schema>;

export const SerializedActionDefinitionV1Schema = ActionDefinitionV1Schema;
export type SerializedActionDefinitionV1 = z.infer<typeof SerializedActionDefinitionV1Schema>;
