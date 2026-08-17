import type {
    AgentAccountUsageMeter,
    AgentAccountUsageSnapshot,
} from '@happier-dev/plugin-sdk/agents/runtime';
import type {
    OauthCredentialRecord,
    TokenCredentialRecord,
} from '@happier-dev/plugin-sdk/connected-accounts';

const GEMINI_QUOTA_STALE_AFTER_MS = 5 * 60_000;

function readProviderAccountId(record: TokenCredentialRecord | OauthCredentialRecord): string | null {
  const value = record.kind === 'token'
    ? record.token.providerAccountId
    : record.oauth.providerAccountId;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function buildQuotaUnknownMeter(): AgentAccountUsageMeter {
  return {
    meterId: 'quota_unknown',
    label: 'Quota',
    used: null,
    limit: null,
    unit: 'unknown',
    utilizationPct: null,
    resetsAt: null,
    status: 'unavailable',
    source: 'provider_api',
    scope: 'unknown',
    limitScope: 'account',
    confidence: 'unknown',
    details: { code: 'quota_unknown' },
  };
}

function buildGeminiQuotaUnknownSnapshot(input: Readonly<{
  record: TokenCredentialRecord | OauthCredentialRecord;
  now: number;
}>): AgentAccountUsageSnapshot {
  const providerAccountId = readProviderAccountId(input.record);
  const accountSubjectId = providerAccountId ?? `provisional:gemini:${input.record.profileId}`;
  return {
    v: 1,
    recordKey: {
      providerId: 'gemini',
      accountSubjectId,
      subjectKind: providerAccountId ? 'account' : 'unknown',
      quotaScope: 'account',
    },
    providerId: 'gemini',
    accountSubject: providerAccountId
      ? { kind: 'providerSubject', id: providerAccountId }
      : {
          kind: 'provisionalLocalSubject',
          id: accountSubjectId,
          mergeKey: `gemini:${input.record.profileId}`,
        },
    observedAtMs: input.now,
    fetchedAtMs: input.now,
    staleAfterMs: GEMINI_QUOTA_STALE_AFTER_MS,
    source: 'connectedServiceProbe',
    confidence: providerAccountId ? 'confirmed' : 'unknown',
    state: 'loaded_data',
    planLabel: null,
    accountLabel: null,
    meters: [buildQuotaUnknownMeter()],
  };
}

export function createGeminiQuotaFetcher() {
  return {
    serviceId: 'gemini' as const,
    loadQuota: async ({ record, now }: Readonly<{
      record: TokenCredentialRecord | OauthCredentialRecord;
      now: number;
      signal: AbortSignal;
    }>) => {
      if (record.kind !== 'token') return null;

      return buildGeminiQuotaUnknownSnapshot({ record, now });
    },
  };
}

export const geminiConnectedServiceQuotaFetcherContribution = {
  id: 'gemini',
  createFetcher: () => createGeminiQuotaFetcher(),
} as const;
