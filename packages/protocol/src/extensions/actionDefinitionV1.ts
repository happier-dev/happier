import { z } from 'zod';

import { ActionUiPlacementSchema } from '../actions/actionUiPlacements.js';
import { ActionInputHintsSchema, ActionSafetySchema, ActionSurfaceSchema } from '../actions/actionSpecs.js';
import { LooseJsonObjectSchema, OptionalStringSchema } from './_shared.js';

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
  })
  .passthrough()
  .nullable();
export type ActionDefinitionExamplesV1 = z.infer<typeof ActionDefinitionExamplesV1Schema>;

export const ActionExecutionDescriptorV1Schema = z
  .object({
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
    placements: z.array(ActionUiPlacementSchema),
    slash: ActionDefinitionSlashV1Schema,
    bindings: ActionDefinitionBindingsV1Schema,
    examples: ActionDefinitionExamplesV1Schema,
    surfaces: ActionSurfaceSchema,
    inputHints: ActionInputHintsSchema.nullable(),
  })
  .passthrough();
export type ActionDefinitionSummaryV1 = z.infer<typeof ActionDefinitionSummaryV1Schema>;

export const ActionDefinitionV1Schema = ActionDefinitionSummaryV1Schema.extend({
  kindVersion: z.literal(1).default(1),
  inputSchema: LooseJsonObjectSchema,
  outputSchema: LooseJsonObjectSchema.optional(),
  execution: ActionExecutionDescriptorV1Schema.optional(),
  compatibility: LooseJsonObjectSchema.optional(),
}).passthrough();
export type ActionDefinitionV1 = z.infer<typeof ActionDefinitionV1Schema>;

export const SerializedActionDefinitionV1Schema = ActionDefinitionV1Schema;
export type SerializedActionDefinitionV1 = z.infer<typeof SerializedActionDefinitionV1Schema>;
