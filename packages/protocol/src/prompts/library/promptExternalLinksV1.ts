import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

import { PromptAssetExternalRefV1Schema, PromptAssetScopeV1Schema } from './promptAssetsV1.js';
import { MachineAdministrationTargetV1Schema, type MachineAdministrationTargetV1 } from '../../account/settings/machineAdministrationSelectionsV1.js';

export const PromptExternalLinkSyncModeV1Schema = lazyZodSchema(() => z.enum(['manual', 'export_on_save', 'read_only']));
export type PromptExternalLinkSyncModeV1 = z.infer<typeof PromptExternalLinkSyncModeV1Schema>;

export const PromptExternalLinkEntryV1Schema = lazyZodSchema(() => z.object({
  id: z.string().min(1),
  artifactId: z.string().min(1),
  assetTypeId: z.string().min(1),
  scope: PromptAssetScopeV1Schema,
  machineId: z.string().min(1),
  serverIdentityId: MachineAdministrationTargetV1Schema.shape.serverIdentityId.optional(),
  workspacePath: z.string().nullable().optional(),
  externalRef: PromptAssetExternalRefV1Schema,
  syncMode: PromptExternalLinkSyncModeV1Schema.optional(),
  baseDigest: z.string().min(1).nullable().optional(),
  lastLibraryDigest: z.string().min(1).nullable().optional(),
  lastExternalDigest: z.string().min(1).nullable().optional(),
  lastSyncAtMs: z.number().int().min(0).optional(),
}).passthrough());
export type PromptExternalLinkEntryV1 = z.infer<typeof PromptExternalLinkEntryV1Schema>;

export const PromptExternalLinksV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  links: z.array(PromptExternalLinkEntryV1Schema).default([]),
}).passthrough());
export type PromptExternalLinksV1 = z.infer<typeof PromptExternalLinksV1Schema>;

/** Bare predecessor links belong only to their original library Home. */
export function isPromptExternalLinkForMachine(
  link: PromptExternalLinkEntryV1,
  context: Readonly<{ target: MachineAdministrationTargetV1; libraryServerIdentityId: string }>,
): boolean {
  return link.machineId === context.target.machineId
    && (link.serverIdentityId !== undefined
      ? link.serverIdentityId === context.target.serverIdentityId
      : context.libraryServerIdentityId === context.target.serverIdentityId);
}
