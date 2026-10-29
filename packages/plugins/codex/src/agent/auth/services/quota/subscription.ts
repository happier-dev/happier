import type { AgentAccountUsageSubscription } from '@happier-dev/plugin-sdk/agents/runtime';
import type { HttpService } from '@happier-dev/plugin-sdk/http';
import { z } from 'zod/mini';

export const OPENAI_CODEX_DEFAULT_SUBSCRIPTION_URL =
  'https://chatgpt.com/backend-api/subscriptions';

// The 0.2 ChatGPT endpoint rejected the generic CLI user agent. This is a
// request-identity header, independent of the machine's operating system.
const SUBSCRIPTION_USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const subscriptionResponseSchema = z.lazy(() => z.object({
  active_until: z.pipe(z.string().check(z.iso.datetime({ offset: true })), z.transform((value) => Date.parse(value))),
  will_renew: z.optional(z.unknown()),
}));

type SubscriptionErrorCode = NonNullable<AgentAccountUsageSubscription['lastRefreshError']>['code'];

function unavailable(now: number, staleAfterMs: number, code: SubscriptionErrorCode, status?: number): AgentAccountUsageSubscription {
  return {
    status: 'unavailable',
    renewal: 'unknown',
    observedAtMs: now,
    staleAfterMs,
    lastRefreshError: { observedAtMs: now, code, ...(status ? { status } : {}) },
  };
}

/** Codex-owned provider observation; the host persists it with the account usage record. */
export async function fetchCodexSubscription(input: Readonly<{
  accessToken: string;
  accountId: string | null | undefined;
  now: number;
  staleAfterMs: number;
  subscriptionUrl: string;
  signal: AbortSignal;
  runtimeFetch: Pick<HttpService, 'request'>;
}>): Promise<AgentAccountUsageSubscription> {
  input.signal.throwIfAborted();
  const accountId = input.accountId?.trim();
  if (!accountId || !input.accessToken.trim()) {
    return unavailable(input.now, input.staleAfterMs, 'missing_auth');
  }
  const url = new URL(input.subscriptionUrl);
  url.searchParams.set('account_id', accountId);
  let response: Awaited<ReturnType<HttpService['request']>>;
  try {
    response = await input.runtimeFetch.request({
      url: url.toString(),
      method: 'GET',
      headers: {
        Authorization: `Bearer ${input.accessToken}`,
        Accept: 'application/json',
        Origin: 'https://chatgpt.com',
        Referer: 'https://chatgpt.com/',
        'User-Agent': SUBSCRIPTION_USER_AGENT,
      },
      redirect: 'error',
    }, { signal: input.signal });
  } catch {
    input.signal.throwIfAborted();
    return unavailable(input.now, input.staleAfterMs, 'network');
  }
  if (response.status < 200 || response.status >= 300) {
    return unavailable(input.now, input.staleAfterMs,
      response.status === 401 ? 'auth_failure' : 'provider_backoff', response.status);
  }
  let parsed: ReturnType<typeof subscriptionResponseSchema.safeParse>;
  try {
    parsed = subscriptionResponseSchema.safeParse(JSON.parse(new TextDecoder().decode(response.body)) as unknown);
  } catch {
    input.signal.throwIfAborted();
    return unavailable(input.now, input.staleAfterMs, 'malformed');
  }
  if (!parsed.success) return unavailable(input.now, input.staleAfterMs, 'malformed');
  return {
    status: 'subscribed',
    renewal: parsed.data.will_renew === true ? 'on' : parsed.data.will_renew === false ? 'off' : 'unknown',
    observedAtMs: input.now,
    staleAfterMs: input.staleAfterMs,
    currentPeriodEndAtMs: parsed.data.active_until,
  };
}
