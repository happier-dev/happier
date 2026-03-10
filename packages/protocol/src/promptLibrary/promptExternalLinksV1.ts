import { z } from 'zod';

import { PromptAssetExternalRefV1Schema, PromptAssetScopeV1Schema } from './promptAssetsV1.js';

export const PromptExternalLinkSyncModeV1Schema = z.enum(['manual', 'export_on_save', 'read_only']);
export type PromptExternalLinkSyncModeV1 = z.infer<typeof PromptExternalLinkSyncModeV1Schema>;

export const PromptExternalLinkEntryV1Schema = z.object({
  id: z.string().min(1),
  artifactId: z.string().min(1),
  assetTypeId: z.string().min(1),
  scope: PromptAssetScopeV1Schema,
  machineId: z.string().min(1),
  workspacePath: z.string().nullable().optional(),
  externalRef: PromptAssetExternalRefV1Schema,
  syncMode: PromptExternalLinkSyncModeV1Schema.optional(),
  baseDigest: z.string().min(1).nullable().optional(),
  lastLibraryDigest: z.string().min(1).nullable().optional(),
  lastExternalDigest: z.string().min(1).nullable().optional(),
  lastSyncAtMs: z.number().int().min(0).optional(),
}).strict();
export type PromptExternalLinkEntryV1 = z.infer<typeof PromptExternalLinkEntryV1Schema>;

export const PromptExternalLinksV1Schema = z.object({
  v: z.literal(1),
  links: z.array(PromptExternalLinkEntryV1Schema).default([]),
}).strict();
export type PromptExternalLinksV1 = z.infer<typeof PromptExternalLinksV1Schema>;
