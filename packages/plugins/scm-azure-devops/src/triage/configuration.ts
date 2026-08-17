import type { TriageSourceInstanceConfigurationV1 } from '@happier-dev/triage-protocol/v1';

import { normalizeAzureDevOpsBaseUrl } from './origin.js';
import type { AzureDevOpsOrigin } from './types.js';

/**
 * The one source-private configured-instance record this plugin encodes.
 *
 * `CONTRACT.md` §3.2 makes each source the sole owner of a strict versioned encoder/decoder
 * for its own token bytes; the target bounds, copies and returns the string without parsing it.
 * Azure needs exactly one routing fact — the normalized configured service organization base or
 * Server collection base — because every REST path is built beneath it.
 */
export type AzureSourceConfiguration = Readonly<{ baseUrl: string }>;

const CONFIGURATION_VERSION = 1;
const CONFIGURATION_KEYS: readonly string[] = ['v', 'baseUrl'];

/**
 * The relative-only instance/scope key.
 *
 * `CONTRACT.md` §3.1: it encodes only the source-native instance/scope and must never
 * re-encode the purpose or the account ref, because the exact binding is already a separate
 * member of the target's matching tuple. Two Azure accounts pointed at the same base therefore
 * stay two configured instances while observing one canonical entry identity.
 */
export function buildAzureLocalInstanceKey(origin: AzureDevOpsOrigin): string {
  return origin.baseUrl;
}

export function encodeAzureSourceConfiguration(
  origin: AzureDevOpsOrigin,
): TriageSourceInstanceConfigurationV1 {
  return {
    v: 1,
    token: JSON.stringify({ v: CONFIGURATION_VERSION, baseUrl: origin.baseUrl }),
  };
}

/**
 * Decode a configured-instance token back into this source's own record.
 *
 * The decoder is strict in both directions: an unknown field, a second version, a
 * non-normalizable base, or an embedded credential yields `null`, which every caller reports as
 * `unsupportedContract` rather than guessing a route. The normalizer is the same one that
 * produced the token, so a value that would not round-trip is rejected instead of accepted with
 * a silently different meaning.
 */
export function decodeAzureSourceConfiguration(
  configuration: TriageSourceInstanceConfigurationV1,
): AzureSourceConfiguration | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(configuration.token);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;

  const record = parsed as Readonly<Record<string, unknown>>;
  if (record.v !== CONFIGURATION_VERSION) return null;
  for (const key of Object.keys(record)) {
    if (!CONFIGURATION_KEYS.includes(key)) return null;
  }
  if (typeof record.baseUrl !== 'string') return null;

  const normalized = normalizeAzureDevOpsBaseUrl(record.baseUrl);
  if (!normalized.ok) return null;
  if (normalized.origin.baseUrl !== record.baseUrl) return null;
  return { baseUrl: normalized.origin.baseUrl };
}

/** Decode a token straight to the normalized origin every read path routes through. */
export function resolveAzureConfiguredOrigin(
  configuration: TriageSourceInstanceConfigurationV1,
): AzureDevOpsOrigin | null {
  const decoded = decodeAzureSourceConfiguration(configuration);
  if (decoded === null) return null;
  const normalized = normalizeAzureDevOpsBaseUrl(decoded.baseUrl);
  return normalized.ok ? normalized.origin : null;
}
