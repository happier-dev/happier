import { z } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { RegistryProvenanceV1Schema } from '../../registries/registryItemsV1.js';
import { RegistryUpstreamV1Schema } from '../../registries/registryUpstreamV1.js';
import { BrowserExtensionIdV1Schema, BrowserExtensionWebStoreSourceV1Schema } from './extensionSourceV1.js';

export {
  BrowserExtensionIdV1Schema,
  BrowserExtensionWebStoreSourceV1Schema,
  type BrowserExtensionIdV1,
  type BrowserExtensionWebStoreSourceV1,
} from './extensionSourceV1.js';

const Text = lazyZodSchema(() => z.string().check(z.minLength(1)));

export const BrowserExtensionSourceV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  BrowserExtensionWebStoreSourceV1Schema,
  z.strictObject({ kind: z.literal('unpacked'), directory: Text }),
]));
export type BrowserExtensionSourceV1 = z.infer<typeof BrowserExtensionSourceV1Schema>;

export const BrowserExtensionPermissionReviewV1Schema = lazyZodSchema(() => z.strictObject({
  version: Text,
  permissions: z.array(Text),
  hostPermissions: z.array(Text),
}));
export type BrowserExtensionPermissionReviewV1 = z.infer<typeof BrowserExtensionPermissionReviewV1Schema>;

/** Package paths belong to the execution Machine and remain under the profile's purge root. */
export const BrowserExtensionRecordV1Schema = lazyZodSchema(() => z.strictObject({
  id: BrowserExtensionIdV1Schema,
  name: Text,
  version: Text,
  enabled: z.boolean(),
  source: BrowserExtensionSourceV1Schema,
  directory: Text,
  permissions: z.array(Text),
  hostPermissions: z.array(Text),
  actionPopup: z.optional(Text),
  optionsPage: z.optional(Text),
  provenance: z.optional(RegistryProvenanceV1Schema),
  upstream: z.optional(RegistryUpstreamV1Schema),
}).check(z.superRefine((record, context) => {
  if (record.source.kind === 'webStore' && record.source.extensionId !== record.id) {
    context.addIssue({ code: 'custom', path: ['source', 'extensionId'], message: 'Extension source identity does not match the installed package.' });
  }
})));
export type BrowserExtensionRecordV1 = z.infer<typeof BrowserExtensionRecordV1Schema>;
