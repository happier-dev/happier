import type {
  ConnectedServiceCredentialRecordV1,
  ConnectedServiceId,
  ConnectedServiceQuotaSnapshotV1,
} from '@happier-dev/protocol';

export type ConnectedServiceQuotaFetcher = Readonly<{
  serviceId: ConnectedServiceId;
  loadQuota: (params: Readonly<{
    record: ConnectedServiceCredentialRecordV1;
    now: number;
    signal: AbortSignal;
  }>) => Promise<ConnectedServiceQuotaSnapshotV1 | null>;
}>;

export type ConnectedServiceQuotaFetcherDescriptorParams = Readonly<{
  env: NodeJS.ProcessEnv;
  staleAfterMs: number;
  userAgent?: string;
}>;

export type ConnectedServiceQuotaFetcherDescriptor = Readonly<{
  id: string;
  createFetcher: (params: ConnectedServiceQuotaFetcherDescriptorParams) => ConnectedServiceQuotaFetcher;
}>;
