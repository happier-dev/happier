import { extname } from 'node:path';
import semver from 'semver';

import { derivePluginDaemonContributionRegistrationRights } from '@happier-dev/protocol/plugins/contributions/catalog';
import { isReservedHappierPluginId } from '@happier-dev/protocol/plugins/plugin-id';
import { ingestPluginManifestV2, validatePublicPluginManifestPolicy } from '@happier-dev/protocol/plugins/manifest/ingest';
import type { ParsedPluginManifestV2 } from '@happier-dev/protocol';

import { configuration } from '../../configuration';
import type { PluginCompatibilityDiagnostic } from '@/plugins/validation/diagnostics/types';
import { normalizeParsedPluginManifestV2 } from './normalize';
import type { PluginSourceProvenance } from './sourceProvenance';
import type { CanonicalPluginManifest } from './types';

const SUPPORTED_PLUGIN_DAEMON_ENTRY_EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);
const INCOMPATIBLE_HAPPIER_ENGINE_DIAGNOSTIC = 'Plugin manifest requires a compatible Happier CLI version';
const UNSUPPORTED_DAEMON_ENTRY_DIAGNOSTIC = 'Plugin daemon entry uses an unsupported extension';

export type PluginManifestValidationDiagnostic = PluginCompatibilityDiagnostic & Readonly<{
  /** Host-authored constant only; never derived from manifest values. */
  safeCompatibilityMessage?: typeof INCOMPATIBLE_HAPPIER_ENGINE_DIAGNOSTIC
    | typeof UNSUPPORTED_DAEMON_ENTRY_DIAGNOSTIC;
}>;

export type PluginManifestValidationResult =
  | Readonly<{ ok: true; manifest: CanonicalPluginManifest }>
  | Readonly<{ ok: false; diagnostics: readonly PluginManifestValidationDiagnostic[] }>;
export type PluginManifestValidationOptions = Readonly<{
  manifestAuthority?: 'external' | 'bundled_first_party';
  /**
   * Provenance of the record these bytes came from, derived by the discovery,
   * install, or generation owner from the record itself (see
   * `pluginSourceProvenanceForKind` / `pluginSourceProvenanceForDistribution`).
   * It scopes the reserved `happier.*` namespace rule for published artifacts.
   * Declared host-engine compatibility applies independently to every source.
   *
   * Required, and deliberately not defaulted: a silent strict reading made
   * every caller a forget-me seam, and three owners disagreed about one
   * record because of it.
   */
  sourceProvenance: PluginSourceProvenance;
  /** Author-time validation may opt out; host load ingestion always enforces it. */
  enforceEngineCompatibility?: boolean;
  parsedManifest?: ParsedPluginManifestV2;
}>;

export function validatePluginManifest(input: unknown, options: PluginManifestValidationOptions): PluginManifestValidationResult {
  const ingestion = options.parsedManifest ? { ok: true as const, manifest: options.parsedManifest } : ingestPluginManifestV2(input);
  const parsed = ingestion.ok ? { success: true as const, data: ingestion.manifest } : { success: false as const, diagnostics: ingestion.diagnostics };
  if (!parsed.success) {
    return {
      ok: false,
      diagnostics: parsed.diagnostics.map((issue) => ({
        code: 'plugin_manifest_invalid',
        message: `${issue.path?.join('.') || '<manifest>'}: ${issue.message}`,
      })),
    };
  }

  const manifest = normalizeParsedPluginManifestV2(parsed.data);
  const diagnostics: PluginManifestValidationDiagnostic[] = [];
  const manifestAuthority = options.manifestAuthority ?? 'external';
  // Bundled first-party manifests are internal Protocol consumers and retain
  // the broad HostAccess union. Public authoring and installed/packed plugin
  // paths use the shared policy; source-module authoring also invokes it
  // explicitly because it intentionally bypasses this host validator.
  if (manifestAuthority !== 'bundled_first_party') {
    diagnostics.push(...validatePublicPluginManifestPolicy(parsed.data).map((diagnostic) => ({
      code: 'plugin_manifest_semantic_invalid' as const,
      message: diagnostic.message,
    })));
  }
  // Namespace custody is distinct from host compatibility: local and bundled
  // declarations may use first-party ids but still must support this host.
  const enforcesRegistryNamespace = options.sourceProvenance === 'registryCustodied'
    && manifestAuthority !== 'bundled_first_party';
  if (isReservedHappierPluginId(manifest.id) && enforcesRegistryNamespace) {
    diagnostics.push({ code: 'plugin_manifest_semantic_invalid', message: `Plugin id '${manifest.id}' uses the reserved happier.* namespace` });
  }
  if (derivePluginDaemonContributionRegistrationRights(manifest.contributes as Readonly<Record<string, unknown>>).length > 0
    && !manifest.entrypoints?.daemon && !manifest.entrypoints?.development) {
    diagnostics.push({ code: 'plugin_manifest_semantic_invalid', message: 'A daemon or development entrypoint is required for executable contributions' });
  }
  const declaredHappierEngine = manifest.engines?.happier;
  const currentVersion = semver.valid(configuration.currentCliVersion);
  if (declaredHappierEngine !== undefined
    && options.enforceEngineCompatibility !== false
    && (!currentVersion || !semver.satisfies(currentVersion, declaredHappierEngine, { includePrerelease: true }))) {
    diagnostics.push({
      code: 'plugin_manifest_engine_incompatible',
      message: INCOMPATIBLE_HAPPIER_ENGINE_DIAGNOSTIC,
      safeCompatibilityMessage: INCOMPATIBLE_HAPPIER_ENGINE_DIAGNOSTIC,
    });
  }
  const daemonEntry = manifest.entrypoints?.daemon;
  if (daemonEntry && !SUPPORTED_PLUGIN_DAEMON_ENTRY_EXTENSIONS.has(extname(daemonEntry).toLowerCase())) {
    diagnostics.push({
      code: 'plugin_manifest_semantic_invalid',
      message: UNSUPPORTED_DAEMON_ENTRY_DIAGNOSTIC,
      safeCompatibilityMessage: UNSUPPORTED_DAEMON_ENTRY_DIAGNOSTIC,
    });
  }
  return diagnostics.length > 0 ? { ok: false, diagnostics } : { ok: true, manifest };
}
