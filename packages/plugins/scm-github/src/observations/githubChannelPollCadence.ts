import { MAX_CONVERSATION_RETRY_AFTER_MS, type ConversationPollResultV1 } from '@happier-dev/channels-protocol/v1';
import { readTriageResponseHeaderV1 } from '@happier-dev/triage-protocol/v1';
import { readGithubRetryAfterMs, type GithubApiClientV1 } from './githubApiClient.js';
import { requestGithubConditionalRead } from './githubConditionalRead.js';

function integerHeader(headers: Readonly<Record<string, string>>, name: string): number | null {
  const raw = readTriageResponseHeaderV1(headers, name)?.trim();
  if (!raw || !/^\d+$/u.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

/** Provider hints own cadence; the approved headerless fallback is 60 seconds.
 * Each consumer schedules only its own live demand. The account request owner
 * independently retains rate parking and cancellation at HTTP admission.
 */
export function createGithubReadCadence(
  client: GithubApiClientV1,
  nowMs: number,
): Readonly<{
  client: GithubApiClientV1;
  refreshAfterMs(): number | undefined;
}> {
  let acquired = false;
  let providerDelayMs: number | null = null;
  const cadenceClient: GithubApiClientV1 = {
    ...client,
    async request(request) {
      const response = await requestGithubConditionalRead(client, request, cadenceClient);
      acquired = true;
      const interval = integerHeader(response.headers, 'x-poll-interval');
      const retryAfter = readTriageResponseHeaderV1(response.headers, 'retry-after');
      const retry = retryAfter === null ? null : readGithubRetryAfterMs({ 'retry-after': retryAfter }, nowMs);
      if (interval !== null || retry !== null) {
        providerDelayMs = Math.max(providerDelayMs ?? 0, (interval ?? 0) * 1_000, retry ?? 0);
      }
      return response;
    },
  };
  return {
    client: cadenceClient,
    refreshAfterMs: () => acquired ? providerDelayMs ?? 60_000 : undefined,
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
  const delay = cadence.refreshAfterMs();
  return delay === undefined ? result : {
    ...result,
    retryHint: { retryAfterMs: Math.min(delay, MAX_CONVERSATION_RETRY_AFTER_MS) },
  };
}
