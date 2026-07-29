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

export type PluginManifestValidationResult =
  | Readonly<{ ok: true; manifest: CanonicalPluginManifest }>
  | Readonly<{ ok: false; diagnostics: readonly PluginCompatibilityDiagnostic[] }>;
export type PluginManifestValidationOptions = Readonly<{
  manifestAuthority?: 'external' | 'bundled_first_party';
  enforceEngineCompatibility?: boolean;
  parsedManifest?: ParsedPluginManifestV2;
}>;

function validateExternalVoiceAccountMediation(
  manifest: CanonicalPluginManifest,
): readonly PluginCompatibilityDiagnostic[] {
  const diagnostics: PluginCompatibilityDiagnostic[] = [];

  for (const provider of manifest.contributes.voiceProviders) {
    const credentialRequired = provider.capabilities.readiness.requirements.includes('credential');
    const mediation = provider.kind === 'conversation' ? provider.accountMediation : undefined;
    if (!credentialRequired && mediation === undefined) continue;
    if (!credentialRequired || mediation === undefined) {
      diagnostics.push({
        code: 'plugin_manifest_semantic_invalid',
        message: `External Voice provider '${provider.id}' is credentialless unless credential readiness and account mediation are declared together`,
      });
    }
  }
  return Object.freeze(diagnostics);
}

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
  if (manifestAuthority !== 'bundled_first_party') {
    diagnostics.push(...validateExternalVoiceAccountMediation(manifest));
  }
  if (derivePluginDaemonContributionRegistrationRights(manifest.contributes as Readonly<Record<string, unknown>>).length > 0
    && !manifest.entrypoints?.daemon && !manifest.entrypoints?.development) {
    diagnostics.push({ code: 'plugin_manifest_semantic_invalid', message: 'A daemon or development entrypoint is required for executable contributions' });
  }
  const currentVersion = semver.valid(configuration.currentCliVersion);
  if (options.enforceEngineCompatibility !== false
    && (!currentVersion || !semver.satisfies(currentVersion, manifest.engines.happier, { includePrerelease: true }))) {
    diagnostics.push({ code: 'plugin_manifest_semantic_invalid', message: `Plugin manifest requires happier ${manifest.engines.happier} but current CLI version is ${configuration.currentCliVersion}` });
  }
  const daemonEntry = manifest.entrypoints?.daemon;
  if (daemonEntry && !SUPPORTED_PLUGIN_DAEMON_ENTRY_EXTENSIONS.has(extname(daemonEntry).toLowerCase())) {
    diagnostics.push({ code: 'plugin_manifest_semantic_invalid', message: `Plugin daemon entry '${daemonEntry}' uses an unsupported extension` });
  }
  return diagnostics.length > 0 ? { ok: false, diagnostics } : { ok: true, manifest };
}
