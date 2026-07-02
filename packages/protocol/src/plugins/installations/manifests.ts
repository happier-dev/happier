import { z } from 'zod';

import { PluginIdSchema } from '../pluginId.js';
import { PluginPermissionDeclarationV1Schema } from '../permissions/v1.js';
import { PluginSourceSpecV1Schema } from '../sourceSpecV1.js';

export const PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1 = 'x-happier-plugin-installation-manifest-publisher' as const;

export const PluginInstallationManifestPublisherProofV1Schema = z.object({
  v: z.literal(1),
  alg: z.literal('ed25519-machine-installation-v1'),
  machineId: z.string().trim().min(1),
  installationId: z.string().trim().min(1),
  issuedAt: z.number().int().nonnegative(),
  nonce: z.string().trim().min(1),
  method: z.enum(['POST']),
  path: z.string().trim().min(1),
  bodySha256Base64Url: z.string().trim().min(1),
  signatureBase64Url: z.string().trim().min(1),
}).strict();
export type PluginInstallationManifestPublisherProofV1 = z.infer<typeof PluginInstallationManifestPublisherProofV1Schema>;

export const PluginInstallationManifestPublisherHeaderV1Schema = z.object({
  proof: PluginInstallationManifestPublisherProofV1Schema,
}).strict();
export type PluginInstallationManifestPublisherHeaderV1 = z.infer<typeof PluginInstallationManifestPublisherHeaderV1Schema>;

function normalizeCanonicalJsonValue(value: unknown): unknown {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) {
    return value.map((item) => {
      const normalized = normalizeCanonicalJsonValue(item);
      return typeof normalized === 'undefined' ? null : normalized;
    });
  }
  if (typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const normalized = normalizeCanonicalJsonValue((value as Record<string, unknown>)[key]);
      if (typeof normalized !== 'undefined') output[key] = normalized;
    }
    return output;
  }
  return undefined;
}

export function stringifyPluginInstallationManifestCanonicalJsonV1(value: unknown): string {
  return JSON.stringify(normalizeCanonicalJsonValue(value) ?? null);
}

export function createPluginInstallationManifestPublisherSigningInputV1(params: Readonly<{
  proof: Omit<PluginInstallationManifestPublisherProofV1, 'signatureBase64Url'>;
}>): Uint8Array {
  return new TextEncoder().encode(`happier.pluginInstallationManifestPublisher.v1\u0000${stringifyPluginInstallationManifestCanonicalJsonV1({
    proof: params.proof,
  })}`);
}

export const PluginInstallationManifestProjectionV1Schema = z.object({
  v: z.literal(1),
  accountId: z.string().trim().min(1),
  machineId: z.string().trim().min(1),
  pluginId: PluginIdSchema,
  manifestVersion: z.string().trim().min(1),
  manifestDigest: z.string().trim().min(1),
  displayName: z.string().trim().min(1),
  source: PluginSourceSpecV1Schema.optional(),
  requiredPermissions: z.array(PluginPermissionDeclarationV1Schema).default([]),
  optionalPermissions: z.array(PluginPermissionDeclarationV1Schema).default([]),
  enabled: z.boolean(),
  disabledAt: z.number().int().nonnegative().optional(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
}).strict();
export type PluginInstallationManifestProjectionV1 = z.infer<typeof PluginInstallationManifestProjectionV1Schema>;

export const PluginInstallationManifestListActionInputV1Schema = z.object({
  machineId: z.string().trim().min(1).optional(),
  pluginId: PluginIdSchema.optional(),
  includeDisabled: z.boolean().default(false),
  limit: z.number().int().positive().max(200).default(50),
}).strict();
export type PluginInstallationManifestListActionInputV1 = z.infer<typeof PluginInstallationManifestListActionInputV1Schema>;

export const PluginInstallationManifestUpsertActionInputV1Schema = z.object({
  pluginId: PluginIdSchema,
  manifestVersion: z.string().trim().min(1),
  manifestDigest: z.string().trim().min(1),
  displayName: z.string().trim().min(1),
  source: PluginSourceSpecV1Schema.optional(),
  requiredPermissions: z.array(PluginPermissionDeclarationV1Schema).default([]),
  optionalPermissions: z.array(PluginPermissionDeclarationV1Schema).default([]),
  enabled: z.boolean().default(true),
}).strict();
export type PluginInstallationManifestUpsertActionInputV1 = z.infer<typeof PluginInstallationManifestUpsertActionInputV1Schema>;

export const PluginInstallationManifestDeleteActionInputV1Schema = z.object({
  pluginId: PluginIdSchema,
}).strict();
export type PluginInstallationManifestDeleteActionInputV1 = z.infer<typeof PluginInstallationManifestDeleteActionInputV1Schema>;

export const PluginInstallationManifestListActionOutputV1Schema = z.object({
  manifests: z.array(PluginInstallationManifestProjectionV1Schema),
}).strict();
export type PluginInstallationManifestListActionOutputV1 = z.infer<typeof PluginInstallationManifestListActionOutputV1Schema>;

export const PluginInstallationManifestUpsertActionOutputV1Schema = z.object({
  manifest: PluginInstallationManifestProjectionV1Schema,
}).strict();
export type PluginInstallationManifestUpsertActionOutputV1 = z.infer<typeof PluginInstallationManifestUpsertActionOutputV1Schema>;

export const PluginInstallationManifestDeleteActionOutputV1Schema = z.object({
  pluginId: PluginIdSchema,
  deleted: z.boolean(),
}).strict();
export type PluginInstallationManifestDeleteActionOutputV1 = z.infer<typeof PluginInstallationManifestDeleteActionOutputV1Schema>;
