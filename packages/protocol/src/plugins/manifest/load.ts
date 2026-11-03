import { z } from 'zod/mini';
import { defineStoredReadProjection } from '../../json/storedReadSchema.js';

import { lazyZodSchema } from '../../lazyZodSchema.js';
import { admitDecodedPluginManifestV2 } from './ingest.js';
import { PluginManifestV2Schema } from './v2.js';

/** Named schema contract keeps enclosing public declarations portable. */
type ManifestSchema = typeof PluginManifestV2Schema;
export interface PluginManifestLoadSchemaV2 extends ManifestSchema {}

/**
 * Stored/installed schema boundary; authoring keeps PluginManifestV2Schema.
 * All admission decisions belong to the ingester. Call it directly when the
 * consumer also projects its successful-load contribution diagnostics.
 */
export const PluginManifestV2LoadSchema: PluginManifestLoadSchemaV2 = defineStoredReadProjection(lazyZodSchema(() => {
  // Keep the canonical output definition for declarations and JSON Schema.
  // Only parsing changes: the same admission owner withdraws unsupported leaves.
  const schema = z.core.clone(PluginManifestV2Schema);
  schema._zod.parse = payload => {
    const result = admitDecodedPluginManifestV2(payload.value, { mode: 'load' });
    if (result.ok) payload.value = result.manifest;
    else for (const diagnostic of result.diagnostics) {
      payload.issues.push({ code: 'custom', path: [...(diagnostic.path ?? [])],
        message: diagnostic.message, input: payload.value });
    }
    return payload;
  };
  return schema;
}), () => PluginManifestV2LoadSchema);
