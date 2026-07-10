import type {
  ConnectedServiceCredentialRecordV1,
  ConnectedServiceQuotaMeterV1,
  ConnectedServiceQuotaSnapshotV1,
} from '@happier-dev/plugin-sdk/experimental/cloud/auth';

const GEMINI_QUOTA_STALE_AFTER_MS = 5 * 60_000;

function buildQuotaUnknownMeter(): ConnectedServiceQuotaMeterV1 {
  return {
    meterId: 'quota_unknown',
    label: 'Quota',
    used: null,
    limit: null,
    unit: 'unknown',
    utilizationPct: null,
    resetsAt: null,
    status: 'unavailable',
    details: { code: 'quota_unknown' },
  };
}

export function createGeminiQuotaFetcher() {
  return {
    serviceId: 'gemini' as const,
    loadQuota: async ({ record, now }: Readonly<{
      record: ConnectedServiceCredentialRecordV1;
      now: number;
      signal: AbortSignal;
    }>): Promise<ConnectedServiceQuotaSnapshotV1 | null> => {
      if (record.kind !== 'token') return null;

      return {
        v: 1 as const,
        serviceId: 'gemini',
        profileId: record.profileId,
        fetchedAt: now,
        staleAfterMs: GEMINI_QUOTA_STALE_AFTER_MS,
        planLabel: null,
        accountLabel: null,
        meters: [buildQuotaUnknownMeter()],
      };
    },
  };
}

export const geminiConnectedServiceQuotaFetcherContribution = {
  id: 'gemini',
  createFetcher: () => createGeminiQuotaFetcher(),
} as const;
