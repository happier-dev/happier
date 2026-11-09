export type ConnectedServiceAuthGroupQuotaProbeIncompleteReason =
  | 'deadline_exceeded'
  | 'probe_unavailable';

export type ConnectedServiceAuthGroupQuotaProbeResult = Readonly<{
  /** Provider-owned backoff is known per-member evidence, not an incomplete group probe. */
  deferredProfiles?: ReadonlyArray<Readonly<{ profileId: string; retryAtMs: number }>>;
}> & Readonly<
  | {
      status: 'complete';
      requestedProfileCount: number;
      completedProfileCount: number;
    }
  | {
      status: 'incomplete';
      requestedProfileCount: number;
      completedProfileCount: number;
      reason: ConnectedServiceAuthGroupQuotaProbeIncompleteReason;
      retryAtMs?: number;
    }
>;

export const CONNECTED_SERVICE_AUTH_GROUP_QUOTA_PROBE_INCOMPLETE_ERROR_CODE = 'connected_service_auth_group_quota_probe_incomplete';

export class ConnectedServiceAuthGroupQuotaProbeIncompleteError extends Error {
  readonly code = CONNECTED_SERVICE_AUTH_GROUP_QUOTA_PROBE_INCOMPLETE_ERROR_CODE;

  constructor(readonly result: Extract<ConnectedServiceAuthGroupQuotaProbeResult, { status: 'incomplete' }>) {
    super('Connected-service group quota evidence is incomplete');
    this.name = 'ConnectedServiceAuthGroupQuotaProbeIncompleteError';
  }
}

/** One wait decision for classified, pre-turn, observation and spawn callers. */
export function resolveConnectedServiceAuthGroupQuotaProbeWait(input: Readonly<{
  probeResult?: ConnectedServiceAuthGroupQuotaProbeResult;
  hasSelectedProfile: boolean;
  nowMs: number;
}>): Readonly<{ retryAtMs?: number }> | null {
  const result = input.probeResult;
  if (!result) return null;
  const boundaries = (result.deferredProfiles ?? []).map(member => member.retryAtMs)
    .filter(boundary => boundary > input.nowMs);
  if (result.status === 'incomplete') {
    if (result.retryAtMs !== undefined && result.retryAtMs > input.nowMs) boundaries.push(result.retryAtMs);
  } else if (input.hasSelectedProfile || boundaries.length === 0) {
    return null;
  }
  return boundaries.length > 0 ? { retryAtMs: Math.min(...boundaries) } : {};
}
