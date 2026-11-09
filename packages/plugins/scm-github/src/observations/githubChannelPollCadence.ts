import { MAX_CONVERSATION_RETRY_AFTER_MS, type ConversationPollResultV1 } from '@happier-dev/channels-protocol/v1';
import { readTriageResponseHeaderV1 } from '@happier-dev/triage-protocol/v1';
import { PluginError } from '@happier-dev/plugin-sdk';
import { decodeGithubJsonResponse, readGithubRetryAfterMs, type GithubApiClientV1 } from './githubApiClient.js';
import { GithubApiResponseError } from './githubRepositoryResolution.js';
import { GITHUB_API_ORIGIN } from './githubProviderContracts.js';

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readCoreBudget(value: unknown, nowMs: number): { remaining: number; resetAtMs: number } {
  const core = isRecord(value) && isRecord(value.resources) && isRecord(value.resources.core)
    ? value.resources.core : undefined;
  if (core === undefined || typeof core.remaining !== 'number' || !Number.isSafeInteger(core.remaining) || core.remaining < 0
    || typeof core.reset !== 'number' || !Number.isSafeInteger(core.reset) || !Number.isSafeInteger(core.reset * 1_000) || core.reset * 1_000 <= nowMs) {
    throw new PluginError({ code: 'github_api_response_invalid', message: 'GitHub did not provide a current REST request budget.' });
  }
  return { remaining: core.remaining, resetAtMs: core.reset * 1_000 };
}

function integerHeader(headers: Readonly<Record<string, string>>, name: string): number | null {
  const raw = readTriageResponseHeaderV1(headers, name)?.trim();
  if (!raw || !/^\d+$/u.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * GitHub comments have no documented default X-Poll-Interval. Spread the next
 * poll's REST acquisitions over the remaining primary window instead of
 * borrowing Channels' transport-recovery cadence. Conditional 304s still count
 * here because the next poll may return changed representations (200s).
 * https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api
 * Explicit provider poll/retry instructions remain lower bounds. GraphQL has
 * a separate points budget, so its responses cannot replace the REST budget.
 * This collects facts only for the admitted read; the existing account request
 * owner still owns rate parking. Channels, Forge CI and the Session PR Resource each
 * schedule their own demand from this same derivation, without a timer here.
 */
export function createGithubReadCadence(
  client: GithubApiClientV1,
  nowMs: number,
): Readonly<{
  client: GithubApiClientV1;
  refreshAfterMs(): number | undefined;
  acquireMissingBudget(): Promise<void>;
}> {
  let restRequests = 0;
  let budget: { remaining: number; resetAtMs: number } | undefined;
  let providerDelayMs: number | null = null;
  const cadenceClient: GithubApiClientV1 = {
    ...client,
    async request(request) {
      const response = await client.request(request);
      const interval = integerHeader(response.headers, 'x-poll-interval');
      const retry = readGithubRetryAfterMs(response.headers, nowMs);
      if (interval !== null || retry !== null) {
        providerDelayMs = Math.max(providerDelayMs ?? 0, (interval ?? 0) * 1_000, retry ?? 0);
      }
      const path = new URL(request.url).pathname;
      if (path !== '/graphql') {
        // GitHub documents GET /rate_limit as exempt from the primary bucket.
        if (path !== '/rate_limit') restRequests += 1;
        const remaining = integerHeader(response.headers, 'x-ratelimit-remaining');
        const reset = integerHeader(response.headers, 'x-ratelimit-reset');
        if (remaining !== null && reset !== null && Number.isSafeInteger(reset * 1_000)) {
          budget = { remaining, resetAtMs: reset * 1_000 };
        }
      }
      return response;
    },
  };
  const acquireMissingBudget = async () => {
    if (restRequests === 0 || providerDelayMs !== null || budget !== undefined && budget.resetAtMs > nowMs) return;
    // Without response timing facts, acquire the documented account overview
    // once. Do not guess a cadence, retain a second budget cache, or count this
    // primary-exempt acquisition as part of the next poll's REST cost.
    // https://docs.github.com/en/rest/rate-limit/rate-limit
    const response = await cadenceClient.request({ url: `${GITHUB_API_ORIGIN}/rate_limit` });
    if (response.status !== 200) throw new GithubApiResponseError(response);
    // Headers remain authoritative when present; the body covers their absence.
    if (budget === undefined || budget.resetAtMs <= nowMs) budget = readCoreBudget(decodeGithubJsonResponse(response), nowMs);
  };
  return {
    client: cadenceClient,
    acquireMissingBudget,
    refreshAfterMs() {
      let delay = providerDelayMs;
      if (budget !== undefined && budget.resetAtMs > nowMs) {
        const remainingWindowMs = budget.resetAtMs - nowMs;
        delay = Math.max(delay ?? 0, budget.remaining < restRequests
          ? remainingWindowMs : Math.ceil(restRequests * remainingWindowMs / budget.remaining));
      }
      return delay ?? undefined;
    },
  };
}

export async function pollWithGithubChannelCadence(
  client: GithubApiClientV1,
  nowMs: number,
  poll: (client: GithubApiClientV1) => Promise<ConversationPollResultV1>,
): Promise<ConversationPollResultV1> {
  const cadence = createGithubReadCadence(client, nowMs);
  const result = await poll(cadence.client);
  if (result.kind !== 'batch' && result.kind !== 'checkpointOnly') return result;
  await cadence.acquireMissingBudget();
  const delay = cadence.refreshAfterMs();
  return delay === undefined ? result : {
    ...result,
    retryHint: { retryAfterMs: Math.min(delay, MAX_CONVERSATION_RETRY_AFTER_MS) },
  };
}
