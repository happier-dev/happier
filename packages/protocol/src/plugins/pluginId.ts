import { defineProtocolString } from './actions/jsonSchemaValidation.js';
import type { PluginJsonSchemaV2 } from './contributions/publicTypes.js';

const RESERVED_HAPPIER_PLUGIN_NAMESPACE = 'happier.';

/**
 * Canonical Plugin and contribution-local identifiers are ASCII-only, so this
 * code-unit cap is also their wire/storage byte cap.
 */
export const MAX_PLUGIN_IDENTIFIER_BYTES = 256;

const PLUGIN_ID_JSON_SCHEMA_PATTERN = '^(?!.*(?:^|\\.)(?:__proto__|constructor|prototype)(?:\\.|$))[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$';

/** Canonical portable JSON-schema fragment for a fully qualified Plugin ID. */
export const PluginIdJsonSchema = {
  type: 'string',
  minLength: 3,
  maxLength: MAX_PLUGIN_IDENTIFIER_BYTES,
  pattern: PLUGIN_ID_JSON_SCHEMA_PATTERN,
} satisfies PluginJsonSchemaV2;

export const PluginIdSchema = defineProtocolString({
  minLength: 3,
  maxLength: MAX_PLUGIN_IDENTIFIER_BYTES,
  pattern: PLUGIN_ID_JSON_SCHEMA_PATTERN,
});
export type PluginId = ReturnType<typeof PluginIdSchema.parse>;

export function isReservedHappierPluginId(id: string): boolean {
  return id.startsWith(RESERVED_HAPPIER_PLUGIN_NAMESPACE);
}

export function encodePluginIdForFilesystem(id: string): string {
  return encodeURIComponent(id);
}
