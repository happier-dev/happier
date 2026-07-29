/**
 * Canonical order for persisted Provider identities and fingerprint inputs.
 * Relational string comparison is specified in UTF-16 code units and is not
 * affected by the host locale or ICU data.
 */
export function compareProviderCanonicalStringsV1(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
