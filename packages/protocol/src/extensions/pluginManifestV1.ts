import { z } from 'zod';

import { BackendDefinitionV1Schema } from './backendDefinitionV1.js';
import { ExtensionSourceSpecV1Schema } from './extensionSourceSpecV1.js';
import { HookRegistrationV1Schema } from './hookRegistrationV1.js';
import { ProviderDefinitionV1Schema } from './providerDefinitionV1.js';

export const PluginTargetDescriptorV1Schema = z.object({
  entry: z.string().trim().min(1),
}).passthrough();
export type PluginTargetDescriptorV1 = z.infer<typeof PluginTargetDescriptorV1Schema>;

export const PluginTargetsV1Schema = z.object({
  daemon: PluginTargetDescriptorV1Schema.optional(),
}).passthrough().superRefine((value, ctx) => {
  for (const unsupportedTarget of ['uiDescriptor', 'serverDescriptor'] as const) {
    if (!Object.prototype.hasOwnProperty.call(value, unsupportedTarget)) {
      continue;
    }

    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [unsupportedTarget],
      message: `Plugin target '${unsupportedTarget}' is unsupported in PluginManifestV1`,
    });
  }
});
export type PluginTargetsV1 = z.infer<typeof PluginTargetsV1Schema>;

export const PluginContributionsV1Schema = z.object({
  providers: z.array(ProviderDefinitionV1Schema).default([]),
  backends: z.array(BackendDefinitionV1Schema).default([]),
  hooks: z.array(HookRegistrationV1Schema).default([]),
}).passthrough();
export type PluginContributionsV1 = z.infer<typeof PluginContributionsV1Schema>;

export const PluginManifestV1Schema = z.object({
  schemaVersion: z.literal(1).default(1),
  id: z.string().trim().min(1),
  version: z.string().trim().min(1),
  displayName: z.string().trim().min(1),
  description: z.string().trim().min(1),
  engines: z.object({
    happier: z.string().trim().min(1),
  }).passthrough(),
  targets: PluginTargetsV1Schema,
  contributions: PluginContributionsV1Schema,
  assets: z.record(z.string(), z.string()).optional(),
  author: z.string().trim().min(1).optional(),
  homepage: z.string().trim().min(1).optional(),
  support: z.object({
    url: z.string().trim().min(1).optional(),
    email: z.string().trim().min(1).optional(),
  }).passthrough().optional(),
  source: ExtensionSourceSpecV1Schema.optional(),
}).passthrough();
export type PluginManifestV1 = z.infer<typeof PluginManifestV1Schema>;
