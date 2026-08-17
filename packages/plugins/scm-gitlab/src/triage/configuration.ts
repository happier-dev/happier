/**
 * The source-private configured-instance token.
 *
 * GitLab's configured deployment origin is the source-native instance scope and
 * therefore travels as `localInstanceKey`; the source contract forbids a token
 * that duplicates a configured origin, so it is deliberately absent here. What
 * remains is a strict versioned envelope: this source mints it, this source is
 * the only decoder, and a token it did not mint — another version, another
 * source's bytes, an oversize string — is rejected rather than tolerated.
 *
 * The envelope is the seam a genuinely per-instance GitLab fact would land in.
 * Nothing is placed in it speculatively, and it can never carry a credential,
 * a header, an account ref, a filesystem path, or a target timestamp.
 */

import {
  MAX_TRIAGE_CONFIGURATION_TOKEN_UTF8_BYTES_V1,
  type TriageSourceInstanceConfigurationV1,
} from '@happier-dev/triage-protocol/v1';

/** The closed source-owned configured-instance record. */
export type GitlabConfigurationRecord = Readonly<{ v: 1 }>;

export const GITLAB_CONFIGURATION_RECORD_V1: GitlabConfigurationRecord = Object.freeze({ v: 1 });

export function encodeGitlabConfiguration(
  record: GitlabConfigurationRecord,
): TriageSourceInstanceConfigurationV1 {
  return { v: 1, token: JSON.stringify({ v: record.v }) };
}

/**
 * Returns `null` for every token this source cannot prove it owns. The caller
 * turns that into a typed `unsupportedContract` failure; it never falls back to
 * a default configuration, because a default would let one instance's scan run
 * under another instance's intent.
 */
export function decodeGitlabConfiguration(
  configuration: TriageSourceInstanceConfigurationV1,
): GitlabConfigurationRecord | null {
  if (configuration.v !== 1) return null;
  if (new TextEncoder().encode(configuration.token).length
    > MAX_TRIAGE_CONFIGURATION_TOKEN_UTF8_BYTES_V1) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(configuration.token);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;

  const record = parsed as Readonly<Record<string, unknown>>;
  const keys = Object.keys(record);
  if (keys.length !== 1 || keys[0] !== 'v' || record.v !== 1) return null;
  return GITLAB_CONFIGURATION_RECORD_V1;
}
