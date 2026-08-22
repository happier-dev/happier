export type ConnectedServiceAuthGroupQuotaProbeIncompleteReason =
  | 'deadline_exceeded'
  | 'probe_unavailable';

export type ConnectedServiceAuthGroupQuotaProbeResult = Readonly<
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
    }
>;

export class ConnectedServiceAuthGroupQuotaProbeIncompleteError extends Error {
  readonly code = 'connected_service_auth_group_quota_probe_incomplete';

  constructor(readonly result: Extract<ConnectedServiceAuthGroupQuotaProbeResult, { status: 'incomplete' }>) {
    super('Connected-service group quota evidence is incomplete');
    this.name = 'ConnectedServiceAuthGroupQuotaProbeIncompleteError';
  }
}
