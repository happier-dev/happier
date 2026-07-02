import { z } from 'zod';

import { PluginOptionalStringSchema } from '../_shared.js';
import { PluginContributesV2Schema } from '../contributions/v2.js';
import { PluginIdSchema } from '../pluginId.js';
import { PluginSourceSpecV1Schema } from '../sourceSpecV1.js';
import { PluginManifestMarketplaceMetadataV1Schema } from '../marketplace/catalog.js';
import { PluginPermissionDeclarationV1Schema } from '../permissions/v1.js';
import { PluginRuntimeApiV1Schema } from '../runtime/api.js';

export const PluginDaemonTargetV2Schema = z.object({
  entry: z.string().trim().min(1),
}).strict();
export type PluginDaemonTargetV2 = z.infer<typeof PluginDaemonTargetV2Schema>;

export const PluginEnginesV2Schema = z.object({
  happier: z.string().trim().min(1),
}).strict();
export type PluginEnginesV2 = z.infer<typeof PluginEnginesV2Schema>;

export const PluginTargetsV2Schema = z.object({
  daemon: PluginDaemonTargetV2Schema.optional(),
}).strict();
export type PluginTargetsV2 = z.infer<typeof PluginTargetsV2Schema>;

const PLUGIN_CAPABILITIES_PERMISSIONS_FIELD = 'permissions' as const;
const PLUGIN_CAPABILITIES_OPTIONAL_PERMISSIONS_FIELD = 'optionalPermissions' as const;

export const PluginCapabilitiesV2Schema = z.object({
  [PLUGIN_CAPABILITIES_PERMISSIONS_FIELD]: z.array(PluginPermissionDeclarationV1Schema).default([]),
  [PLUGIN_CAPABILITIES_OPTIONAL_PERMISSIONS_FIELD]: z.array(PluginPermissionDeclarationV1Schema).default([]),
}).passthrough().default({ permissions: [], optionalPermissions: [] });
export type PluginCapabilitiesV2 = z.input<typeof PluginCapabilitiesV2Schema>;
export type ParsedPluginCapabilitiesV2 = z.output<typeof PluginCapabilitiesV2Schema>;

export const PluginManifestV2Schema = z.object({
  schemaVersion: z.literal(2),
  id: PluginIdSchema,
  version: z.string().trim().min(1),
  displayName: z.string().trim().min(1),
  description: PluginOptionalStringSchema,
  engines: PluginEnginesV2Schema,
  runtime: PluginRuntimeApiV1Schema,
  targets: PluginTargetsV2Schema.default({}),
  capabilities: PluginCapabilitiesV2Schema,
  contributes: PluginContributesV2Schema,
  source: PluginSourceSpecV1Schema.optional(),
  marketplace: PluginManifestMarketplaceMetadataV1Schema.optional(),
}).strict();
export type PluginManifestV2 = z.input<typeof PluginManifestV2Schema>;
export type ParsedPluginManifestV2 = z.output<typeof PluginManifestV2Schema>;
