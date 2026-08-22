import { extname } from 'node:path';
import semver from 'semver';

import {
  derivePluginDaemonContributionRegistrationRights,
  isReservedHappierPluginId,
  PluginManifestV2Schema,
  type ParsedPluginManifestV2,
} from '@happier-dev/protocol';

import { configuration } from '../../configuration';
import type { PluginCompatibilityDiagnostic } from '@/plugins/validation/diagnostics/types';
import { normalizeParsedPluginManifestV2 } from './normalize';
import type { CanonicalPluginManifest } from './types';

const SUPPORTED_PLUGIN_DAEMON_ENTRY_EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);
const INCOMPATIBLE_HAPPIER_ENGINE_DIAGNOSTIC = 'Plugin manifest requires a compatible Happier CLI version';

export type PluginManifestValidationResult =
  | Readonly<{ ok: true; manifest: CanonicalPluginManifest }>
  | Readonly<{ ok: false; diagnostics: readonly PluginCompatibilityDiagnostic[] }>;
export type PluginManifestValidationOptions = Readonly<{
  manifestAuthority?: 'external' | 'bundled_first_party';
  enforceEngineCompatibility?: boolean;
  parsedManifest?: ParsedPluginManifestV2;
}>;

export function validatePluginManifest(input: unknown, options: PluginManifestValidationOptions = {}): PluginManifestValidationResult {
  const parsed = options.parsedManifest ? { success: true as const, data: options.parsedManifest } : PluginManifestV2Schema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      diagnostics: parsed.error.issues.map((issue) => ({
        code: 'plugin_manifest_invalid',
        message: `${issue.path.join('.') || '<manifest>'}: ${issue.message}`,
      })),
    };
  }

  const manifest = normalizeParsedPluginManifestV2(parsed.data);
  const diagnostics: PluginCompatibilityDiagnostic[] = [];
  const manifestAuthority = options.manifestAuthority ?? 'external';
  if (isReservedHappierPluginId(manifest.id) && manifestAuthority !== 'bundled_first_party') {
    diagnostics.push({ code: 'plugin_manifest_semantic_invalid', message: `Plugin id '${manifest.id}' uses the reserved happier.* namespace` });
  }
  if (derivePluginDaemonContributionRegistrationRights(manifest.contributes as Readonly<Record<string, unknown>>).length > 0
    && !manifest.entrypoints?.daemon && !manifest.entrypoints?.development) {
    diagnostics.push({ code: 'plugin_manifest_semantic_invalid', message: 'A daemon or development entrypoint is required for executable contributions' });
  }
  const declaredHappierEngine = manifest.engines?.happier;
  const currentVersion = semver.valid(configuration.currentCliVersion);
  // A bundled first-party manifest carries a build-time engine placeholder that
  // is stamped at release, so its declared range never describes the running
  // host. That authority is only granted by an owner that already resolved the
  // manifest from the canonical bundled source, which is the compatibility
  // decision this gate would otherwise repeat.
  if (declaredHappierEngine !== undefined
    && options.enforceEngineCompatibility !== false
    && manifestAuthority !== 'bundled_first_party'
    && (!currentVersion || !semver.satisfies(currentVersion, declaredHappierEngine, { includePrerelease: true }))) {
    diagnostics.push({ code: 'plugin_manifest_semantic_invalid', message: INCOMPATIBLE_HAPPIER_ENGINE_DIAGNOSTIC });
  }
  const daemonEntry = manifest.entrypoints?.daemon;
  if (daemonEntry && !SUPPORTED_PLUGIN_DAEMON_ENTRY_EXTENSIONS.has(extname(daemonEntry).toLowerCase())) {
    diagnostics.push({ code: 'plugin_manifest_semantic_invalid', message: 'Plugin daemon entry uses an unsupported extension' });
  }
  return diagnostics.length > 0 ? { ok: false, diagnostics } : { ok: true, manifest };
}
