import semver from 'semver';
import { PLUGIN_UI_HOST_API_VERSION_V1 } from './hostApiDefinition.js';

export * from './hostApiDefinition.js';

/**
 * The sole range-satisfaction decision for Host API negotiation.
 *
 * The wire carries a semver range, not one spelling of the current range. A
 * host with this initial API therefore accepts every valid range containing
 * the canonical version and refuses malformed or incompatible ranges before
 * advertising any methods.
 */
export function isPluginUiHostApiVersionCompatibleV1(range: unknown): boolean {
  if (typeof range !== 'string') return false;
  const normalized = range.trim();
  if (normalized.length === 0 || semver.validRange(normalized) === null) return false;
  return semver.satisfies(PLUGIN_UI_HOST_API_VERSION_V1, normalized);
}
