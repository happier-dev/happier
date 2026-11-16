import { satisfies as semverSatisfies, valid as semverValid, validRange as semverValidRange } from 'semver';
import { PLUGIN_UI_HOST_API_VERSIONS_V1 } from './hostApiDefinition.js';
import { readMissingPluginUiHostModulesV1 } from './hostModuleAdmission.js';

export * from './hostApiDefinition.js';

/**
 * Compares one explicitly supplied host version with an authored Host API
 * range using ordinary semver prerelease rules.
 */
export function isPluginUiHostApiVersionCompatibleWithVersionV1(
  hostVersion: unknown,
  range: unknown,
): boolean {
  if (typeof hostVersion !== 'string' || typeof range !== 'string') return false;
  const normalizedHostVersion = hostVersion.trim();
  const normalizedRange = range.trim();
  if (
    semverValid(normalizedHostVersion) === null
    || normalizedRange.length === 0
    || semverValidRange(normalizedRange) === null
  ) return false;
  return semverSatisfies(normalizedHostVersion, normalizedRange);
}

/**
 * Current-host artifact admission accepts any supported semantic generation.
 * Explicit older-host checks still compare only the supplied host version.
 */
export function isPluginUiHostApiVersionCompatibleV1(range: unknown): boolean {
  return resolvePluginUiHostApiVersionV1(range) !== null;
}

/**
 * Select the oldest supported generation satisfying the client's declaration.
 * A broad 1.0 range cannot prove that an installed SDK knows later enum members.
 */
export function resolvePluginUiHostApiVersionV1(range: unknown): (typeof PLUGIN_UI_HOST_API_VERSIONS_V1)[number] | null {
  return PLUGIN_UI_HOST_API_VERSIONS_V1.find(version =>
    isPluginUiHostApiVersionCompatibleWithVersionV1(version, range)) ?? null;
}

/**
 * Current-host admission of an executable artifact: its Host API range, and
 * every module it left external for the host (`executable.hostModules`). An
 * artifact built against newer host-provided Protocol subpaths is refused here
 * instead of failing inside evaluation.
 */
export function isPluginUiExecutableArtifactHostCompatibleV1(artifact: Readonly<{
  hostUiApiRange: string;
  executable: Readonly<{ hostModules?: readonly string[] }>;
}>): boolean {
  return isPluginUiHostApiVersionCompatibleV1(artifact.hostUiApiRange)
    && readMissingPluginUiHostModulesV1(artifact.executable.hostModules).length === 0;
}
