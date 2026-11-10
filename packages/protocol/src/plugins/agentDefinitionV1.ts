import { z } from '../zodRuntimePolicy.js';

import {
  PluginAssetRefV1Schema,
  PluginLooseJsonObjectSchema,
  PluginOptionalStringSchema,
  PluginStringArraySchema,
} from './_shared.js';

export const AgentDisplayV1Schema = z.looseObject({
  name: z.string().check(z.trim(), z.minLength(1)),
  subtitle: PluginOptionalStringSchema,
  iconAsset: z.optional(PluginAssetRefV1Schema),
  logoAsset: z.optional(PluginAssetRefV1Schema),
  tags: PluginStringArraySchema,
});
export type AgentDisplayV1 = z.infer<typeof AgentDisplayV1Schema>;

export const AgentInstallV1Schema = z.looseObject({
  manualGuidance: PluginOptionalStringSchema,
  docsUrl: PluginOptionalStringSchema,
  managedInstallBehavior: PluginOptionalStringSchema,
});
export type AgentInstallV1 = z.infer<typeof AgentInstallV1Schema>;

export const AgentAuthV1Schema = z.looseObject({
  machineLoginSupport: PluginOptionalStringSchema,
  connectedServiceCompatibility: z.optional(PluginStringArraySchema),
  configSchema: z.optional(PluginLooseJsonObjectSchema),
});
export type AgentAuthV1 = z.infer<typeof AgentAuthV1Schema>;

export const AgentSessionResumeV1Schema = z.looseObject({
  supportLevel: PluginOptionalStringSchema,
  vendorResumeIdField: PluginOptionalStringSchema,
});
export type AgentSessionResumeV1 = z.infer<typeof AgentSessionResumeV1Schema>;

export const AgentSessionHandoffV1Schema = z.looseObject({
  supportLevel: PluginOptionalStringSchema,
});
export type AgentSessionHandoffV1 = z.infer<typeof AgentSessionHandoffV1Schema>;

export const AgentTerminalRuntimeV1Schema = z.looseObject({
  supported: z._default(z.boolean(), false),
  topology: PluginOptionalStringSchema,
  attachStrategy: PluginOptionalStringSchema,
});
export type AgentTerminalRuntimeV1 = z.infer<typeof AgentTerminalRuntimeV1Schema>;

export const AgentSessionV1Schema = z.looseObject({
  storage: PluginOptionalStringSchema,
  resume: z.optional(AgentSessionResumeV1Schema),
  handoff: z.optional(AgentSessionHandoffV1Schema),
  terminalRuntime: z.optional(AgentTerminalRuntimeV1Schema),
  sessionCapabilities: z.optional(PluginLooseJsonObjectSchema),
});
export type AgentSessionV1 = z.infer<typeof AgentSessionV1Schema>;

export const AgentUiV1Schema = z.looseObject({
  modeSelection: PluginOptionalStringSchema,
  modelSelection: PluginOptionalStringSchema,
  agentInputControls: z.optional(PluginStringArraySchema),
  browseSourceLabels: z.optional(PluginLooseJsonObjectSchema),
  setupDescriptors: z.optional(z.array(PluginLooseJsonObjectSchema)),
  preflightDescriptors: z.optional(z.array(PluginLooseJsonObjectSchema)),
});
export type AgentUiV1 = z.infer<typeof AgentUiV1Schema>;

export const AgentDefinitionV1Schema = z.looseObject({
  kindVersion: z._default(z.literal(1), 1),
  id: z.string().check(z.trim(), z.minLength(1)),
  catalogAgentId: PluginOptionalStringSchema,
  iconAgentId: PluginOptionalStringSchema,
  settingsBackendId: PluginOptionalStringSchema,
  display: AgentDisplayV1Schema,
  install: z.optional(AgentInstallV1Schema),
  auth: z.optional(AgentAuthV1Schema),
  session: z.optional(AgentSessionV1Schema),
  tools: z.optional(PluginLooseJsonObjectSchema),
  ui: z.optional(AgentUiV1Schema),
  ownedBackendIds: PluginStringArraySchema,
}).check(z.superRefine((value, ctx) => {
  if (Object.prototype.hasOwnProperty.call(value, 'agentCliRuntime')) {
    ctx.addIssue({
      code: "custom",
      path: ['agentCliRuntime'],
      message: 'Legacy agentCliRuntime authoring is not supported; use contributes.agents[].cli.',
    });
  }
}));
export type AgentDefinitionV1 = z.infer<typeof AgentDefinitionV1Schema>;
