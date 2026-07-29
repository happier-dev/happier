/**
 * Maps the canonical External Sessions error literal to the response shape
 * consumed by cli-v0.2.1, cli-v0.2.2-preview.1775586717.26498, and the
 * inspected remote-dev predecessor's legacy direct-session RPC readers.
 *
 * This remains a wire-boundary projection, not a second domain error owner.
 * Remove it when those UI/daemon rollback and coexistence directions are no
 * longer supported.
 */
export function mapCanonicalExternalSessionResponseToLegacyDirectSession(
  response: unknown,
): unknown {
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    return response;
  }
  const record = response as Record<string, unknown>;
  if (record.ok !== false || record.errorCode !== 'agent_unavailable') {
    return response;
  }
  return {
    ...record,
    errorCode: 'provider_unavailable',
  };
}
