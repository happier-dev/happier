import { z } from 'zod';

import { AssetRefV1Schema, LooseJsonObjectSchema, OptionalStringSchema, StringArraySchema } from './_shared.js';
import { ProviderCliRuntimeV1Schema } from './providerCliRuntimeV1.js';

export const ProviderDisplayV1Schema = z.object({
  name: z.string().trim().min(1),
  subtitle: OptionalStringSchema,
  iconAsset: AssetRefV1Schema.optional(),
  logoAsset: AssetRefV1Schema.optional(),
  tags: StringArraySchema,
}).passthrough();
export type ProviderDisplayV1 = z.infer<typeof ProviderDisplayV1Schema>;

export const ProviderInstallV1Schema = z.object({
  manualGuidance: OptionalStringSchema,
  docsUrl: OptionalStringSchema,
  managedInstallBehavior: OptionalStringSchema,
}).passthrough();
export type ProviderInstallV1 = z.infer<typeof ProviderInstallV1Schema>;

export const ProviderAuthV1Schema = z.object({
  machineLoginSupport: OptionalStringSchema,
  connectedServiceCompatibility: StringArraySchema.optional(),
  configSchema: LooseJsonObjectSchema.optional(),
}).passthrough();
export type ProviderAuthV1 = z.infer<typeof ProviderAuthV1Schema>;

export const ProviderSessionResumeV1Schema = z.object({
  supportLevel: OptionalStringSchema,
  vendorResumeIdField: OptionalStringSchema,
}).passthrough();
export type ProviderSessionResumeV1 = z.infer<typeof ProviderSessionResumeV1Schema>;

export const ProviderSessionHandoffV1Schema = z.object({
  supportLevel: OptionalStringSchema,
}).passthrough();
export type ProviderSessionHandoffV1 = z.infer<typeof ProviderSessionHandoffV1Schema>;

export const ProviderTerminalRuntimeV1Schema = z.object({
  supported: z.boolean().default(false),
  topology: OptionalStringSchema,
  attachStrategy: OptionalStringSchema,
}).passthrough();
export type ProviderTerminalRuntimeV1 = z.infer<typeof ProviderTerminalRuntimeV1Schema>;

export const ProviderSessionV1Schema = z.object({
  storage: OptionalStringSchema,
  resume: ProviderSessionResumeV1Schema.optional(),
  handoff: ProviderSessionHandoffV1Schema.optional(),
  terminalRuntime: ProviderTerminalRuntimeV1Schema.optional(),
  sessionCapabilities: LooseJsonObjectSchema.optional(),
}).passthrough();
export type ProviderSessionV1 = z.infer<typeof ProviderSessionV1Schema>;

export const ProviderUiV1Schema = z.object({
  modeSelection: OptionalStringSchema,
  modelSelection: OptionalStringSchema,
  agentInputControls: StringArraySchema.optional(),
  browseSourceLabels: LooseJsonObjectSchema.optional(),
  setupDescriptors: z.array(LooseJsonObjectSchema).optional(),
  preflightDescriptors: z.array(LooseJsonObjectSchema).optional(),
}).passthrough();
export type ProviderUiV1 = z.infer<typeof ProviderUiV1Schema>;

export const ProviderDefinitionV1Schema = z.object({
  kindVersion: z.literal(1).default(1),
  id: z.string().trim().min(1),
  display: ProviderDisplayV1Schema,
  providerCliRuntime: ProviderCliRuntimeV1Schema.optional(),
  install: ProviderInstallV1Schema.optional(),
  auth: ProviderAuthV1Schema.optional(),
  session: ProviderSessionV1Schema.optional(),
  tools: LooseJsonObjectSchema.optional(),
  ui: ProviderUiV1Schema.optional(),
  ownedBackendIds: StringArraySchema,
}).passthrough();
export type ProviderDefinitionV1 = z.infer<typeof ProviderDefinitionV1Schema>;
