import { z } from 'zod';

import { BackendDefinitionV1Schema } from '../backendDefinitionV1.js';
import { ProviderDefinitionV1Schema } from '../providerDefinitionV1.js';
import { ExtensionActionContributionV2Schema, ExtensionDaemonHandlerRefV1Schema } from '../actions/v2.js';
import {
  ActionDefinitionExamplesV1Schema,
} from '../actionDefinitionV1.js';
import {
  ActionInputHintsSchema,
  ActionSafetySchema,
} from '../../actions/actionSpecs.js';
import {
  HookCategoryV1Schema,
} from '../../hooks/hookCategories.js';
import {
  HookExecutionKindV1Schema,
} from '../../hooks/hookExecutionSemantics.js';
import {
  HookHandlerRefV1Schema,
  HookRegistrationFilterV1Schema,
} from '../hookRegistrationV1.js';
import {
  ExtensionHookScopeV1Schema,
} from '../hooks/catalog.js';
import { LooseJsonObjectSchema, OptionalStringSchema } from '../_shared.js';

/**
 * Backend target provenance/source model (V2).
 *
 * This vocabulary must not preserve the legacy builtIn/plugin architecture split.
 *
 * - `first_party`: backend is provided by a bundled first-party extension package.
 * - `external`: backend is provided by an externally installed extension package.
 * - `configured`: legacy/configured target ingress (compat only; runtime lane governs long-term fate).
 */
export const ExtensionBackendTargetSourceKindV2Schema = z.enum(['first_party', 'external', 'configured']);
export type ExtensionBackendTargetSourceKindV2 = z.infer<typeof ExtensionBackendTargetSourceKindV2Schema>;

export const ExtensionBackendTargetV2Schema = z.object({
  sourceKind: ExtensionBackendTargetSourceKindV2Schema,
  id: z.string().trim().min(1),
}).strict();
export type ExtensionBackendTargetV2 = z.infer<typeof ExtensionBackendTargetV2Schema>;

export const ExtensionProviderContributionV2Schema = ProviderDefinitionV1Schema.extend({
  kind: z.literal('provider'),
}).strict();
export type ExtensionProviderContributionV2 = z.infer<typeof ExtensionProviderContributionV2Schema>;

export const ExtensionBackendContributionV2Schema = BackendDefinitionV1Schema.extend({
  kind: z.literal('backend'),
  target: ExtensionBackendTargetV2Schema.optional(),
}).strict();
export type ExtensionBackendContributionV2 = z.infer<typeof ExtensionBackendContributionV2Schema>;

export const ExtensionToolContributionV2Schema = z.object({
  kind: z.literal('tool'),
  id: z.string().trim().min(1),
  name: z.string().trim().min(1),
  title: z.string().trim().min(1),
  description: OptionalStringSchema,
  safety: ActionSafetySchema.default('safe'),
  surfaces: z.object({
    cli: z.boolean().default(false),
    mcp: z.boolean().default(false),
    session_agent: z.boolean().default(false),
  }).strict().default({
    cli: false,
    mcp: false,
    session_agent: false,
  }),
  inputSchema: LooseJsonObjectSchema.optional(),
  outputSchema: LooseJsonObjectSchema.optional(),
  inputHints: ActionInputHintsSchema.nullable().optional(),
  compatibility: LooseJsonObjectSchema.optional(),
  examples: ActionDefinitionExamplesV1Schema.nullable().optional(),
  handler: ExtensionDaemonHandlerRefV1Schema,
}).strict();
export type ExtensionToolContributionV2 = z.infer<typeof ExtensionToolContributionV2Schema>;

export const ExtensionCommandVisibilityV2Schema = z.enum(['default', 'advanced', 'internal']);
export type ExtensionCommandVisibilityV2 = z.infer<typeof ExtensionCommandVisibilityV2Schema>;

export const ExtensionCommandContributionV2Schema = z.object({
  kind: z.literal('command'),
  id: z.string().trim().min(1),
  command: z.string().trim().min(1),
  rootHelpLabel: OptionalStringSchema,
  rootHelpDescription: OptionalStringSchema,
  rootHelpDetail: OptionalStringSchema,
  allowTmux: z.boolean().default(false),
  visibility: ExtensionCommandVisibilityV2Schema.optional(),
  featureGate: OptionalStringSchema,
  handler: ExtensionDaemonHandlerRefV1Schema,
}).strict();
export type ExtensionCommandContributionV2 = z.infer<typeof ExtensionCommandContributionV2Schema>;

export const ExtensionResourceKindV2Schema = z.enum(['prompt', 'skill', 'template', 'asset', 'config']);
export type ExtensionResourceKindV2 = z.infer<typeof ExtensionResourceKindV2Schema>;

export const ExtensionResourceContributionV2Schema = z.object({
  kind: z.literal('resource'),
  id: z.string().trim().min(1),
  resourceKind: ExtensionResourceKindV2Schema,
  path: z.string().trim().min(1),
  digest: z.string().trim().min(1).optional(),
  contentType: OptionalStringSchema,
}).strict();
export type ExtensionResourceContributionV2 = z.infer<typeof ExtensionResourceContributionV2Schema>;

export const ExtensionUiDescriptorSurfaceV2Schema = z.enum([
  'settings',
  'setup',
  'status',
  'providerSettings',
  'backendSettings',
]);
export type ExtensionUiDescriptorSurfaceV2 = z.infer<typeof ExtensionUiDescriptorSurfaceV2Schema>;

const NullableOptionalStringSchema = z.string().trim().min(1).nullable().optional();

export const ExtensionUiDescriptorToneV2Schema = z.enum(['neutral', 'info', 'success', 'warning', 'danger']);
export type ExtensionUiDescriptorToneV2 = z.infer<typeof ExtensionUiDescriptorToneV2Schema>;

export const ExtensionUiFieldTypeV2Schema = z.enum([
  'text',
  'boolean',
  'select',
  'secret',
  'number',
  'markdown',
  'action',
]);
export type ExtensionUiFieldTypeV2 = z.infer<typeof ExtensionUiFieldTypeV2Schema>;

export const ExtensionUiFieldOptionV2Schema = z.object({
  value: z.string().trim().min(1),
  label: z.string().trim().min(1),
}).strict();
export type ExtensionUiFieldOptionV2 = z.infer<typeof ExtensionUiFieldOptionV2Schema>;

export const ExtensionUiFieldV2Schema = z.object({
  id: z.string().trim().min(1),
  type: ExtensionUiFieldTypeV2Schema,
  title: z.string().trim().min(1),
  description: OptionalStringSchema,
  order: z.number().int().optional(),
  groupId: NullableOptionalStringSchema,
  featureGate: NullableOptionalStringSchema,
  actionId: NullableOptionalStringSchema,
  options: z.array(ExtensionUiFieldOptionV2Schema).default([]),
}).strict().superRefine((value, ctx) => {
  if (value.type === 'action') {
    if (typeof value.actionId !== 'string' || value.actionId.trim().length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'actionId is required when type is action',
        path: ['actionId'],
      });
    }
  }
});
export type ExtensionUiFieldV2 = z.infer<typeof ExtensionUiFieldV2Schema>;

export const ExtensionUiDescriptorContributionV2Schema = z.object({
  kind: z.literal('uiDescriptor'),
  id: z.string().trim().min(1),
  surface: ExtensionUiDescriptorSurfaceV2Schema,
  title: z.string().trim().min(1),
  description: OptionalStringSchema,
  order: z.number().int().optional(),
  tone: ExtensionUiDescriptorToneV2Schema.optional(),
  featureGate: NullableOptionalStringSchema,
  helpUrl: NullableOptionalStringSchema,
  fields: z.array(ExtensionUiFieldV2Schema).default([]),
}).strict();
export type ExtensionUiDescriptorContributionV2 = z.infer<typeof ExtensionUiDescriptorContributionV2Schema>;

export const ExtensionHookContributionV2Schema = z.object({
  kind: z.literal('hook'),
  id: z.string().trim().min(1),
  hookApiVersion: z.literal(1).default(1),
  category: HookCategoryV1Schema,
  scope: ExtensionHookScopeV1Schema,
  filters: HookRegistrationFilterV1Schema.optional(),
  executionKind: HookExecutionKindV1Schema,
  handler: HookHandlerRefV1Schema,
  priority: z.number().int().optional(),
  compatibility: z.record(z.string(), z.unknown()).optional(),
}).strict();
export type ExtensionHookContributionV2 = z.infer<typeof ExtensionHookContributionV2Schema>;

export const ExtensionLifecycleEventV2Schema = z.enum(['activated', 'deactivating']);
export type ExtensionLifecycleEventV2 = z.infer<typeof ExtensionLifecycleEventV2Schema>;

export const ExtensionLifecycleHandlerContributionV2Schema = z.object({
  kind: z.literal('lifecycleHandler'),
  id: OptionalStringSchema,
  event: ExtensionLifecycleEventV2Schema,
  priority: z.number().int().optional(),
  handler: ExtensionDaemonHandlerRefV1Schema,
}).strict();
export type ExtensionLifecycleHandlerContributionV2 = z.infer<typeof ExtensionLifecycleHandlerContributionV2Schema>;

export const ExtensionContributionV2Schema = z.discriminatedUnion('kind', [
  ExtensionActionContributionV2Schema,
  ExtensionToolContributionV2Schema,
  ExtensionCommandContributionV2Schema,
  ExtensionResourceContributionV2Schema,
  ExtensionUiDescriptorContributionV2Schema,
  ExtensionHookContributionV2Schema,
  ExtensionLifecycleHandlerContributionV2Schema,
  ExtensionProviderContributionV2Schema,
  ExtensionBackendContributionV2Schema,
]);
export type ExtensionContributionV2 = z.infer<typeof ExtensionContributionV2Schema>;
