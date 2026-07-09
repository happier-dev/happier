import { z } from 'zod';

import { PluginOptionalStringSchema } from '../_shared.js';
import { PluginContributesV2Schema } from '../contributions/v2.js';
import { PluginIdSchema } from '../pluginId.js';
import { PluginSourceSpecV1Schema } from '../sourceSpecV1.js';
import { PluginManifestMarketplaceMetadataV1Schema } from '../marketplace/catalog.js';
import {
  PluginCapabilityDeclarationV1Schema,
  PluginPermissionDeclarationV1Schema,
} from '../permissions/v1.js';
import { PluginRuntimeCapabilityFamilyV1Schema } from '../runtime/api.js';

// Forward-compatibility policy: the manifest root and contribution rows preserve
// unknown fields. Retired contract keys are rejected explicitly below.
const ManifestVersionSemverPattern =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function hasOwn(value: Readonly<Record<string, unknown>>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function rejectForbiddenKey(
  ctx: z.RefinementCtx,
  key: string,
  message: string,
): void {
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: [key],
    message,
  });
}

function readRecordArray(value: unknown): readonly Readonly<Record<string, unknown>>[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is Readonly<Record<string, unknown>> => Boolean(entry && typeof entry === 'object'))
    : [];
}

function readStringField(value: Readonly<Record<string, unknown>>, key: string): string | null {
  const field = value[key];
  return typeof field === 'string' && field.trim().length > 0 ? field : null;
}

export const PluginEnginesV2Schema = z.object({
  happier: z.string().trim().min(1),
}).passthrough();
export type PluginEnginesV2 = z.infer<typeof PluginEnginesV2Schema>;

export const PluginEntrypointV2Schema = z.string().trim().min(1);
export type PluginEntrypointV2 = z.infer<typeof PluginEntrypointV2Schema>;

export const PluginEntrypointsV2Schema = z.object({
  main: PluginEntrypointV2Schema,
  dev: PluginEntrypointV2Schema.optional(),
}).passthrough();
export type PluginEntrypointsV2 = z.infer<typeof PluginEntrypointsV2Schema>;

export const PluginManifestPermissionsV2Schema = z.object({
  required: z.array(PluginPermissionDeclarationV1Schema).default([]),
  optional: z.array(PluginPermissionDeclarationV1Schema).default([]),
}).passthrough().default({ required: [], optional: [] });
export type PluginManifestPermissionsV2 = z.input<typeof PluginManifestPermissionsV2Schema>;
export type ParsedPluginManifestPermissionsV2 = z.output<typeof PluginManifestPermissionsV2Schema>;

export const PluginManifestDeclaresV2Schema = z.object({
  capabilities: z.array(PluginCapabilityDeclarationV1Schema).default([]),
}).passthrough().default({ capabilities: [] });
export type PluginManifestDeclaresV2 = z.input<typeof PluginManifestDeclaresV2Schema>;
export type ParsedPluginManifestDeclaresV2 = z.output<typeof PluginManifestDeclaresV2Schema>;

export const PluginManifestV2Schema = z.object({
  schemaVersion: z.literal(2),
  id: PluginIdSchema,
  version: z.string().trim().regex(
    ManifestVersionSemverPattern,
    'Plugin manifest version must be a valid semver version.',
  ),
  displayName: z.string().trim().min(1),
  description: PluginOptionalStringSchema,
  engines: PluginEnginesV2Schema,
  uses: z.array(PluginRuntimeCapabilityFamilyV1Schema).default([]),
  entrypoints: PluginEntrypointsV2Schema,
  declares: PluginManifestDeclaresV2Schema,
  permissions: PluginManifestPermissionsV2Schema,
  activationEvents: z.array(z.string().trim().min(1)).default(['startup']),
  contributes: PluginContributesV2Schema,
  source: PluginSourceSpecV1Schema.optional(),
  marketplace: PluginManifestMarketplaceMetadataV1Schema.optional(),
}).passthrough().superRefine((manifest, ctx) => {
  const retiredKeys = new Map([
    ['runtime', `Plugin manifest v2 uses top-level uses; runtime.${'apiVersion'}/runtime.${'capabilities'} are not supported.`],
    ['targets', `Plugin manifest v2 uses entrypoints; targets.${'daemon'} is not supported.`],
    ['capabilities', 'Plugin manifest v2 uses permissions.required/permissions.optional; capabilities permissions are not supported.'],
    ['contributions', 'Plugin manifest v2 uses contributes; flat contributions are not supported.'],
  ]);
  for (const [key, message] of retiredKeys) {
    if (hasOwn(manifest, key)) {
      rejectForbiddenKey(ctx, key, message);
    }
  }

  const contributes = manifest.contributes as Readonly<Record<string, unknown>>;
  const declaredAgentIds = new Set<string>();
  for (const agent of readRecordArray(contributes.agents)) {
    const agentId = readStringField(agent, 'id');
    if (agentId) {
      declaredAgentIds.add(agentId);
    }
  }

  for (const [index, contribution] of readRecordArray(contributes.agentSettings).entries()) {
    const agentId = readStringField(contribution, 'agentId');
    if (agentId && !declaredAgentIds.has(agentId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['contributes', 'agentSettings', index, 'agentId'],
        message: `Agent settings target "${agentId}" is not declared by this plugin manifest.`,
      });
    }
  }
});
export type PluginManifestV2 = z.input<typeof PluginManifestV2Schema>;
export type ParsedPluginManifestV2 = z.output<typeof PluginManifestV2Schema>;
