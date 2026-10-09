import { AGY_CLOUDCODE_API_BASE_URLS, createAgyApiHeaders } from '@happier-dev/agents';
import { ConnectedServiceQuotaSnapshotV1Schema, normalizeConnectedServiceOauthCredentialRawMetadata } from '@happier-dev/protocol';
import { ConnectedServiceQuotaFetchError, type ConnectedServiceQuotaFetcher, type ConnectedServiceQuotaFetcherDescriptor } from '@/daemon/connectedServices/quotas/types';
import { isRecord, resolveConnectedServiceQuotaAccountLabel } from '@/daemon/connectedServices/quotas/quotaNormalization';
import { parseRetryAfterHeader } from '@/daemon/connectedServices/quotas/normalization/parseRetryAfterHeader';
import { normalizeAgyQuota } from './normalizeQuota';

type QuotaRpc = 'retrieveUserQuota' | 'fetchAvailableModels' | 'retrieveUserQuotaSummary';

/** Reads a validated quota RPC across fallback hosts using the coordinator-owned abort signal. */
async function readQuota(input: Readonly<{ rpc: QuotaRpc; accessToken: string; projectId: string; signal: AbortSignal; now: number }>): Promise<unknown> {
  let lastError: ConnectedServiceQuotaFetchError | undefined;
  for (const base of AGY_CLOUDCODE_API_BASE_URLS) {
    input.signal.throwIfAborted();
    let response: Response;
    try {
      response = await fetch(`${base}/v1internal:${input.rpc}`, {
        method: 'POST', headers: createAgyApiHeaders(input.accessToken), body: JSON.stringify({ project: input.projectId }),
        // The quota coordinator owns the whole fetch deadline, including fallback hosts.
        signal: input.signal,
      });
    } catch {
      input.signal.throwIfAborted();
      lastError = new ConnectedServiceQuotaFetchError('Antigravity quota endpoint is unavailable', { quotaFetchErrorCode: 'network' });
      continue;
    }
    if (!response.ok) {
      lastError = new ConnectedServiceQuotaFetchError(`Antigravity quota request failed (HTTP ${response.status})`, {
        status: response.status, quotaFetchErrorCode: response.status === 401 ? 'auth_failure' : 'provider_backoff',
        retryAfterMs: parseRetryAfterHeader(response.headers.get('retry-after'), { nowMs: input.now }).retryAfterMs,
      });
      if (response.status === 404 || response.status >= 500) continue;
      throw lastError;
    }
    try {
      const value: unknown = await response.json();
      if (!isRecord(value)) throw new Error('Expected quota object');
      const summary = isRecord(value.quotaSummary) ? value.quotaSummary : value;
      const valid = input.rpc === 'retrieveUserQuota' ? Array.isArray(value.buckets)
        : input.rpc === 'fetchAvailableModels' ? isRecord(value.models) : Array.isArray(summary.groups);
      if (!valid) throw new Error('Unexpected quota shape');
      return value;
    } catch {
      input.signal.throwIfAborted();
      throw new ConnectedServiceQuotaFetchError('Antigravity quota response is malformed', { quotaFetchErrorCode: 'malformed' });
    }
  }
  throw lastError ?? new ConnectedServiceQuotaFetchError('Antigravity quota endpoint is unavailable', { quotaFetchErrorCode: 'network' });
}

/** Fetches quota under the coordinator’s deadline, retaining acquired readings when optional RPCs stall or fail. */
export function createAgyQuotaFetcher(input: Readonly<{ staleAfterMs: number }>): ConnectedServiceQuotaFetcher {
  // Optional RPC limits must not discard a successful live quota observation.
  const optionalRetryAt = new Map<string, number>();
  return {
    serviceId: 'antigravity', pollPolicy: { minPollIntervalMs: 5 * 60_000 },
    fetch: async ({ record, now, signal, onPartialSnapshot }) => {
      signal.throwIfAborted();
      if (record.kind !== 'oauth') throw new ConnectedServiceQuotaFetchError('Antigravity quota requires Google sign-in', { quotaFetchErrorCode: 'missing_auth' });
      const metadata = normalizeConnectedServiceOauthCredentialRawMetadata(record.oauth.raw)?.antigravity;
      if (!metadata?.projectId) throw new ConnectedServiceQuotaFetchError('Antigravity project is missing; reconnect this account', { quotaFetchErrorCode: 'missing_auth', reconnectRequired: true });
      /** Isolates provider Retry-After hints by account, project and optional RPC. */
      const retryKey = (rpc: QuotaRpc) => JSON.stringify([record.oauth.providerAccountId ?? record.profileId, metadata.projectId, rpc]);
      /** Skips only an RPC still covered by its provider-supplied backoff. */
      const request = (rpc: QuotaRpc) => (optionalRetryAt.get(retryKey(rpc)) ?? 0) > now
        ? Promise.resolve(null)
        : readQuota({ rpc, accessToken: record.oauth.accessToken, projectId: metadata.projectId!, signal, now });
      let live: unknown = null;
      let catalog: unknown = null;
      let summary: unknown = null;
      let unavailable: ConnectedServiceQuotaFetchError | undefined;
      /** Builds both partial and complete snapshots through the same schema, preserving unknown quota. */
      const buildSnapshot = (meters: ReturnType<typeof normalizeAgyQuota>) => ConnectedServiceQuotaSnapshotV1Schema.parse({
        v: 1, serviceId: 'antigravity', profileId: record.profileId, fetchedAt: now, staleAfterMs: input.staleAfterMs,
        planLabel: metadata.tierId ?? null, accountLabel: resolveConnectedServiceQuotaAccountLabel(record),
        source: 'provider_api', confidence: meters.some((meter) => meter.confidence === 'estimated') ? 'estimated' : meters.some((meter) => meter.confidence === 'exact') ? 'exact' : 'unknown', meters: meters.length ? meters : [{
          meterId: 'quota', label: 'Antigravity quota', used: null, limit: null, remainingPct: null,
          utilizationPct: null, resetsAt: null, unit: 'unknown', status: 'unavailable', details: { code: 'quota_unknown' },
        }],
      });
      /** Offers acquired meters for deadline fallback; the coordinator still owns publication and cancellation. */
      const reportAcquiredSnapshot = () => {
        if (!onPartialSnapshot || signal.aborted) return;
        const meters = normalizeAgyQuota({ live, catalog, summary });
        if (meters.length) onPartialSnapshot(buildSnapshot(meters));
      };
      try { live = await request('retrieveUserQuota'); }
      catch (error) {
        if (!(error instanceof ConnectedServiceQuotaFetchError) || error.status === 401 || error.status === 403 || error.status === 429) throw error;
        unavailable = error;
      }
      reportAcquiredSnapshot();
      try { catalog = await request('fetchAvailableModels'); }
      catch (error) {
        if (!(error instanceof ConnectedServiceQuotaFetchError) || error.status === 401 || !live) throw error;
        if (error.status === 429) optionalRetryAt.set(retryKey('fetchAvailableModels'), now + (error.retryAfterMs ?? 5 * 60_000));
        unavailable = error;
      }
      reportAcquiredSnapshot();
      try { summary = await request('retrieveUserQuotaSummary'); }
      catch (error) {
        if (!(error instanceof ConnectedServiceQuotaFetchError) || error.status === 401 || (error.status === 429 && !live && !catalog)) throw error;
        if (error.status === 429) optionalRetryAt.set(retryKey('retrieveUserQuotaSummary'), now + (error.retryAfterMs ?? 5 * 60_000));
      }
      const meters = normalizeAgyQuota({ live, catalog, summary });
      if (!meters.length && unavailable) throw unavailable;
      return buildSnapshot(meters);
    },
  };
}

export const agyQuotaFetcherDescriptor: ConnectedServiceQuotaFetcherDescriptor = {
  loadQuota: ({ staleAfterMs }) => createAgyQuotaFetcher({ staleAfterMs }),
};
