import { z } from 'zod';

import {
  PluginAssetRefV1Schema,
  PluginLooseJsonObjectSchema,
  PluginOptionalStringSchema,
  PluginStringArraySchema,
} from './_shared.js';

export const AgentDisplayV1Schema = z.object({
  name: z.string().trim().min(1),
  subtitle: PluginOptionalStringSchema,
  iconAsset: PluginAssetRefV1Schema.optional(),
  logoAsset: PluginAssetRefV1Schema.optional(),
  tags: PluginStringArraySchema,
}).passthrough();
export type AgentDisplayV1 = z.infer<typeof AgentDisplayV1Schema>;

export const AgentInstallV1Schema = z.object({
  manualGuidance: PluginOptionalStringSchema,
  docsUrl: PluginOptionalStringSchema,
  managedInstallBehavior: PluginOptionalStringSchema,
}).passthrough();
export type AgentInstallV1 = z.infer<typeof AgentInstallV1Schema>;

export const AgentAuthV1Schema = z.object({
  machineLoginSupport: PluginOptionalStringSchema,
  connectedServiceCompatibility: PluginStringArraySchema.optional(),
  configSchema: PluginLooseJsonObjectSchema.optional(),
}).passthrough();
export type AgentAuthV1 = z.infer<typeof AgentAuthV1Schema>;

export const AgentSessionResumeV1Schema = z.object({
  supportLevel: PluginOptionalStringSchema,
  vendorResumeIdField: PluginOptionalStringSchema,
}).passthrough();
export type AgentSessionResumeV1 = z.infer<typeof AgentSessionResumeV1Schema>;

export const AgentSessionHandoffV1Schema = z.object({
  supportLevel: PluginOptionalStringSchema,
}).passthrough();
export type AgentSessionHandoffV1 = z.infer<typeof AgentSessionHandoffV1Schema>;

export const AgentTerminalRuntimeV1Schema = z.object({
  supported: z.boolean().default(false),
  topology: PluginOptionalStringSchema,
  attachStrategy: PluginOptionalStringSchema,
}).passthrough();
export type AgentTerminalRuntimeV1 = z.infer<typeof AgentTerminalRuntimeV1Schema>;

export const AgentSessionV1Schema = z.object({
  storage: PluginOptionalStringSchema,
  resume: AgentSessionResumeV1Schema.optional(),
  handoff: AgentSessionHandoffV1Schema.optional(),
  terminalRuntime: AgentTerminalRuntimeV1Schema.optional(),
  sessionCapabilities: PluginLooseJsonObjectSchema.optional(),
}).passthrough();
export type AgentSessionV1 = z.infer<typeof AgentSessionV1Schema>;

export const AgentUiV1Schema = z.object({
  modeSelection: PluginOptionalStringSchema,
  modelSelection: PluginOptionalStringSchema,
  agentInputControls: PluginStringArraySchema.optional(),
  browseSourceLabels: PluginLooseJsonObjectSchema.optional(),
  setupDescriptors: z.array(PluginLooseJsonObjectSchema).optional(),
  preflightDescriptors: z.array(PluginLooseJsonObjectSchema).optional(),
}).passthrough();
export type AgentUiV1 = z.infer<typeof AgentUiV1Schema>;

export const AgentDefinitionV1Schema = z.object({
  kindVersion: z.literal(1).default(1),
  id: z.string().trim().min(1),
  catalogAgentId: PluginOptionalStringSchema,
  iconAgentId: PluginOptionalStringSchema,
  settingsBackendId: PluginOptionalStringSchema,
  display: AgentDisplayV1Schema,
  install: AgentInstallV1Schema.optional(),
  auth: AgentAuthV1Schema.optional(),
  session: AgentSessionV1Schema.optional(),
  tools: PluginLooseJsonObjectSchema.optional(),
  ui: AgentUiV1Schema.optional(),
  ownedBackendIds: PluginStringArraySchema,
}).passthrough().superRefine((value, ctx) => {
  if (Object.prototype.hasOwnProperty.call(value, 'agentCliRuntime')) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['agentCliRuntime'],
      message: 'Legacy agentCliRuntime authoring is not supported; use contributes.agents[].cli.',
    });
  }
});
export type AgentDefinitionV1 = z.infer<typeof AgentDefinitionV1Schema>;
