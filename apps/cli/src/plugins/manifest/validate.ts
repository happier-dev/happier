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
import type { PluginSourceProvenance } from './sourceProvenance';
import type { CanonicalPluginManifest } from './types';

const SUPPORTED_PLUGIN_DAEMON_ENTRY_EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);
const INCOMPATIBLE_HAPPIER_ENGINE_DIAGNOSTIC = 'Plugin manifest requires a compatible Happier CLI version';

export type PluginManifestValidationResult =
  | Readonly<{ ok: true; manifest: CanonicalPluginManifest }>
  | Readonly<{ ok: false; diagnostics: readonly PluginCompatibilityDiagnostic[] }>;
export type PluginManifestValidationOptions = Readonly<{
  manifestAuthority?: 'external' | 'bundled_first_party';
  /**
   * Provenance of the record these bytes came from, derived by the discovery,
   * install, or generation owner from the record itself (see
   * `pluginSourceProvenanceForKind` / `pluginSourceProvenanceForDistribution`).
   * It scopes the two rules that only describe a *published* artifact — the
   * reserved `happier.*` namespace and the release-stamped engine range.
   *
   * Required, and deliberately not defaulted: a silent strict reading made
   * every caller a forget-me seam, and three owners disagreed about one
   * record because of it.
   */
  sourceProvenance: PluginSourceProvenance;
  enforceEngineCompatibility?: boolean;
  parsedManifest?: ParsedPluginManifestV2;
}>;

export function validatePluginManifest(input: unknown, options: PluginManifestValidationOptions): PluginManifestValidationResult {
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
  // The reserved namespace and the declared engine range are registry-lifecycle
  // rules: they exist because a published artifact's own metadata is an
  // unverifiable third-party claim. Neither describes a working tree on this
  // machine, where the author and the host operator are the same person, so
  // both are scoped to a record the host did not author. `bundled_first_party`
  // is the host's own bundled source and is likewise not a published claim.
  const enforcesRegistryLifecycleRules = options.sourceProvenance === 'registryCustodied'
    && manifestAuthority !== 'bundled_first_party';
  if (isReservedHappierPluginId(manifest.id) && enforcesRegistryLifecycleRules) {
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
  // host. The same is true of a local working tree: `happier plugins dev` on a
  // plugin whose manifest still holds its pre-release placeholder is the normal
  // author loop, not an incompatible install.
  if (declaredHappierEngine !== undefined
    && options.enforceEngineCompatibility !== false
    && enforcesRegistryLifecycleRules
    && (!currentVersion || !semver.satisfies(currentVersion, declaredHappierEngine, { includePrerelease: true }))) {
    diagnostics.push({ code: 'plugin_manifest_semantic_invalid', message: INCOMPATIBLE_HAPPIER_ENGINE_DIAGNOSTIC });
  }
  for (const diagnostic of collectAgentCliSystemToolDiagnostics(manifest)) {
    diagnostics.push(diagnostic);
  }
  const daemonEntry = manifest.entrypoints?.daemon;
  if (daemonEntry && !SUPPORTED_PLUGIN_DAEMON_ENTRY_EXTENSIONS.has(extname(daemonEntry).toLowerCase())) {
    diagnostics.push({ code: 'plugin_manifest_semantic_invalid', message: 'Plugin daemon entry uses an unsupported extension' });
  }
  return diagnostics.length > 0 ? { ok: false, diagnostics } : { ok: true, manifest };
}

/**
 * An Agent's `catalog.agentCliSystemTool` binding is the only cross-family
 * reference in the Agent contribution: it names a system tool the same plugin
 * declares and is resolved against that Agent's own `cli` metadata. Both facts
 * live in other contribution families, so the manifest schema cannot check
 * them. Rejecting an unresolvable binding here keeps the contribution
 * projection total — the catalog-entry hook owner throws on an undeclared
 * toolId, and the runtime registry throws when the Agent has no CLI runtime
 * descriptor, neither of which the plugin loader can attribute to one plugin.
 */
function collectAgentCliSystemToolDiagnostics(
  manifest: CanonicalPluginManifest,
): readonly PluginCompatibilityDiagnostic[] {
  const agents = manifest.contributes.agents;
  if (!Array.isArray(agents) || agents.length === 0) return [];
  const declaredToolIds = new Set(
    (manifest.contributes.systemTools ?? []).map((tool) => tool.id),
  );
  const diagnostics: PluginCompatibilityDiagnostic[] = [];
  for (const agent of agents) {
    const binding = agent.catalog?.agentCliSystemTool;
    if (!binding) continue;
    if (!declaredToolIds.has(binding.toolId)) {
      diagnostics.push({
        code: 'plugin_manifest_semantic_invalid',
        message: `Agent '${agent.id}' CLI system-tool binding '${binding.toolId}' names no declared system tool`,
      });
    }
    if (!agent.cli) {
      diagnostics.push({
        code: 'plugin_manifest_semantic_invalid',
        message: `Agent '${agent.id}' CLI system-tool binding requires declared CLI metadata`,
      });
    }
  }
  return diagnostics;
}
