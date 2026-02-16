import type {
  ConnectedServiceCredentialRecordV1,
  ConnectedServiceId,
  ConnectedServiceQuotaSnapshotV1,
} from '@happier-dev/protocol';

export type ConnectedServiceQuotaFetcher = Readonly<{
  serviceId: ConnectedServiceId;
  fetch: (params: Readonly<{
    record: ConnectedServiceCredentialRecordV1;
    now: number;
    signal: AbortSignal;
  }>) => Promise<ConnectedServiceQuotaSnapshotV1 | null>;
}>;

