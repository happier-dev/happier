import {
  createPluginCompatibilityProjectionV1,
  PluginCompatibilityProjectionV1Schema,
  type PluginCompatibilityProjectionV1,
} from '@happier-dev/protocol';

import { validatePluginManifest } from '@/plugins/manifest/validate';
import { generatedUiArtifactDefaultHostCompatibilityFailure } from '@/plugins/projection/registry/ui/artifactCompatibility';
import type { PluginCompatibilityDiagnostic } from '@/plugins/validation/diagnostics/types';

const INVALID_COMPATIBILITY_PROJECTION_DIAGNOSTIC = 'Plugin compatibility projection is invalid.';

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
 * incumbent manifest validator. The projection grammar only supplies the
 * bounded generated facts needed before archive acquisition; specialist
 * runtime/UI adoption remains owned by its existing activation owners.
 */
export function evaluatePluginCompatibilityProjection(
  input: unknown,
): PluginCompatibilityProjectionEvaluation {
  const parsed = PluginCompatibilityProjectionV1Schema.safeParse(input);
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
  const manifestValidation = validatePluginManifest(parsed.data.manifest, {
    sourceProvenance: 'registryCustodied',
  });
  const projection = createPluginCompatibilityProjectionV1({
    manifest: manifestValidation.ok ? manifestValidation.manifest : parsed.data.manifest,
    uiArtifacts: parsed.data.uiArtifacts,
  });
  if (!manifestValidation.ok) {
    return Object.freeze({
      kind: 'incompatible',
      projection,
      diagnostics: Object.freeze([...manifestValidation.diagnostics]),
    });
  }
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
