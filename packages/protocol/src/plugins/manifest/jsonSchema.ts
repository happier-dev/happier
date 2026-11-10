import { forEachJsonSchemaChild, zodSchemaToJsonSchemaObject } from '../../actions/actionInputJsonSchema.js';
import type { core } from '../../zodRuntimePolicy.js';

import { PluginManifestV2Schema } from './v2.js';

export const PLUGIN_MANIFEST_JSON_SCHEMA_V2_ID = 'https://happier.dev/schemas/plugin-manifest-v2.json';

function completeStrictObjectTypes(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(completeStrictObjectTypes);
    return;
  }
  if (value === null || typeof value !== 'object') return;

  const schema = value as Record<string, unknown>;
  if (schema.properties !== undefined && schema.type === undefined) {
    schema.type = 'object';
  }
  forEachJsonSchemaChild(schema, completeStrictObjectTypes);
}

/**
 * Produces the public authoring schema from the same strict Zod owner used by
 * host ingestion. Keep this as a generator rather than a second maintained
 * schema so editor and runtime validation cannot drift independently.
 */
export function createPluginManifestJsonSchemaV2(): Readonly<core.JSONSchema.JSONSchema> {
  const schema: core.JSONSchema.JSONSchema = {
    ...zodSchemaToJsonSchemaObject(PluginManifestV2Schema, {
      target: 'draft-2020-12',
      unrepresentable: 'any',
      override: ({ zodSchema, jsonSchema }) => {
        // Zod can extract an array or string's parent into $defs and leave its bounds
        // beside $ref. Strict validators need the applicable type locally;
        // restore it from the canonical owner, not from keyword guesses.
        const schemaType = zodSchema._zod.def.type;
        if ((schemaType === 'array' || schemaType === 'string') && jsonSchema.type === undefined) {
          jsonSchema.type = schemaType;
        }
      },
    }),
    $id: PLUGIN_MANIFEST_JSON_SCHEMA_V2_ID,
    title: 'Happier Plugin Manifest v2',
  };
  // Zod refinements preserve the object shape but can omit its JSON Schema
  // `type`. Complete that representational detail so strict external validators
  // accept the generated authoring schema without maintaining a second schema.
  completeStrictObjectTypes(schema);
  return schema;
}
