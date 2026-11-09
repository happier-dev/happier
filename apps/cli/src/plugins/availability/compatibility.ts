import { createPluginCompatibilityProjectionV1, PluginCompatibilityProjectionV1Schema } from '@happier-dev/protocol/plugins/availability/compatibilityProjectionV1';
import type { PluginCompatibilityProjectionV1 } from '@happier-dev/protocol';
import { z } from 'zod/mini';

import { ingestCanonicalPluginManifest } from '@/plugins/manifest/ingest';
import { projectPluginManifestCompatibilityDiagnostic } from '@/plugins/manifest/diagnostics';
import { generatedUiArtifactDefaultHostCompatibilityFailure } from '@/plugins/projection/registry/ui/artifactCompatibility';
import type { PluginCompatibilityDiagnostic } from '@/plugins/validation/diagnostics/types';

const INVALID_COMPATIBILITY_PROJECTION_DIAGNOSTIC = 'Plugin compatibility projection is invalid.';
// Validate generated facts here; only the canonical admission owner interprets
// the manifest. Parsing the author schema first would reject healthy siblings.
const CompatibilityProjectionEnvelopeSchema = z.extend(PluginCompatibilityProjectionV1Schema, {
  manifest: z.unknown(),
});

export type PluginCompatibilityProjectionEvaluation =
  | Readonly<{
      kind: 'compatible';
      projection: PluginCompatibilityProjectionV1;
    }>
  | Readonly<{
      kind: 'invalid';
      diagnostics: readonly PluginCompatibilityDiagnostic[];
    }>
  | Readonly<{
      kind: 'incompatible';
      projection: PluginCompatibilityProjectionV1;
      diagnostics: readonly PluginCompatibilityDiagnostic[];
    }>;

/**
 * Compatibility selection deliberately delegates manifest semantics to the
 * canonical manifest ingestion owner. The projection grammar only supplies the
 * bounded generated facts needed before archive acquisition; specialist
 * runtime/UI adoption remains owned by its existing activation owners.
 */
export function evaluatePluginCompatibilityProjection(
  input: unknown,
): PluginCompatibilityProjectionEvaluation {
  const parsed = CompatibilityProjectionEnvelopeSchema.safeParse(input);
  if (!parsed.success) {
    return Object.freeze({
      kind: 'invalid',
      diagnostics: Object.freeze([Object.freeze({
        code: 'plugin_compatibility_projection_invalid',
        message: INVALID_COMPATIBILITY_PROJECTION_DIAGNOSTIC,
      })]),
    });
  }

  // A compatibility projection only ever describes an acquirable published
  // artifact; nothing local reaches this evaluation.
  const manifestValidation = ingestCanonicalPluginManifest(parsed.data.manifest, {
    sourceProvenance: 'registryCustodied',
    purpose: 'admission',
  });
  if (!manifestValidation.ok) {
    // Author diagnostics may restate unverified manifest content. Only the
    // host validator's explicitly value-free reason can replace the closed
    // ingestion code; identical safe projections collapse.
    const diagnostics = [...new Map(manifestValidation.diagnostics.map((entry) => {
      const diagnostic = projectPluginManifestCompatibilityDiagnostic(entry);
      return [JSON.stringify(diagnostic), diagnostic] as const;
    })).values()];
    const failure = { diagnostics: Object.freeze(diagnostics.map((diagnostic) => Object.freeze(diagnostic))) };
    return manifestValidation.manifest
      ? Object.freeze({ kind: 'incompatible', ...failure, projection: createPluginCompatibilityProjectionV1({
        manifest: manifestValidation.manifest, uiArtifacts: parsed.data.uiArtifacts,
      }) })
      : Object.freeze({ kind: 'invalid', ...failure });
  }
  const projection = createPluginCompatibilityProjectionV1({
    manifest: manifestValidation.manifest,
    uiArtifacts: parsed.data.uiArtifacts,
  });
  for (const artifact of projection.uiArtifacts.entries) {
    const failure = generatedUiArtifactDefaultHostCompatibilityFailure(artifact);
    if (!failure) continue;
    return Object.freeze({
      kind: 'incompatible',
      projection,
      diagnostics: Object.freeze([Object.freeze({
        code: 'plugin_compatibility_projection_invalid' as const,
        message: `Generated UI artifact compatibility check failed: ${failure}.`,
      })]),
    });
  }
  return Object.freeze({ kind: 'compatible', projection });
}
