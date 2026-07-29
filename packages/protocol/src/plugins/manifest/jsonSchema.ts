import type { core } from 'zod';

import { PluginManifestV2Schema } from './v2.js';

export const PLUGIN_MANIFEST_JSON_SCHEMA_V2_ID = 'https://happier.dev/schemas/plugin-manifest-v2.json';

/**
 * Produces the public authoring schema from the same strict Zod owner used by
 * host ingestion. Keep this as a generator rather than a second maintained
 * schema so editor and runtime validation cannot drift independently.
 */
export function createPluginManifestJsonSchemaV2(): Readonly<core.JSONSchema.JSONSchema> {
  return {
    ...PluginManifestV2Schema.toJSONSchema({
      io: 'input',
      target: 'draft-2020-12',
      unrepresentable: 'any',
    }),
    $id: PLUGIN_MANIFEST_JSON_SCHEMA_V2_ID,
    title: 'Happier Plugin Manifest v2',
  };
}
