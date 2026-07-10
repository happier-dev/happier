import type { FetchRuntimeServiceV1 } from '@happier-dev/plugin-sdk';

export const OPENAI_CODEX_DEFAULT_RATE_LIMIT_RESET_CREDITS_URL =
  'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits';

export const OPENAI_CODEX_DEFAULT_RATE_LIMIT_RESET_CREDIT_CONSUME_URL =
  'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume';

export type CodexRateLimitResetCreditsClientParams = Readonly<{
  accessToken: string;
  accountId?: string | null;
  userAgent?: string;
  signal?: AbortSignal;
  runtimeFetch: FetchRuntimeServiceV1;
}>;

function buildHeaders(params: Readonly<{
  accessToken: string;
  accountId?: string | null;
  userAgent?: string;
  idempotencyKey?: string | null;
}>): Readonly<Record<string, string>> {
  return {
    Authorization: `Bearer ${params.accessToken}`,
    ...(params.accountId ? { 'ChatGPT-Account-Id': params.accountId } : {}),
    ...(params.idempotencyKey ? { 'Idempotency-Key': params.idempotencyKey } : {}),
    Accept: 'application/json',
    ...(params.userAgent ? { 'User-Agent': params.userAgent } : {}),
  };
}

function buildProviderError(status: number, statusText: string | undefined): Error {
  return new Error(`OpenAI reset-credit fetch failed (${status}): ${statusText || 'HTTP error'}`);
}

export async function fetchCodexRateLimitResetCredits(
  params: CodexRateLimitResetCreditsClientParams & Readonly<{ resetCreditsUrl?: string }>,
): Promise<unknown> {
  const response = await params.runtimeFetch({
    url: params.resetCreditsUrl ?? OPENAI_CODEX_DEFAULT_RATE_LIMIT_RESET_CREDITS_URL,
    method: 'GET',
    headers: buildHeaders(params),
    signal: params.signal,
  });
  if (!response.ok) {
    throw buildProviderError(response.status, response.statusText);
  }
  return await response.json();
}

export async function consumeCodexRateLimitResetCredit(
  params: CodexRateLimitResetCreditsClientParams & Readonly<{
    consumeUrl?: string;
    idempotencyKey: string;
    providerCreditId?: string | null;
  }>,
): Promise<unknown> {
  const idempotencyKey = params.idempotencyKey.trim();
  if (!idempotencyKey) {
    throw new Error('OpenAI reset-credit consume failed: missing idempotency key');
  }
  const response = await params.runtimeFetch({
    url: params.consumeUrl ?? OPENAI_CODEX_DEFAULT_RATE_LIMIT_RESET_CREDIT_CONSUME_URL,
    method: 'POST',
    headers: buildHeaders({ ...params, idempotencyKey }),
    body: {
      idempotency_key: idempotencyKey,
      ...(params.providerCreditId ? { reset_credit_id: params.providerCreditId } : {}),
    },
    signal: params.signal,
  });
  if (!response.ok) {
    throw buildProviderError(response.status, response.statusText);
  }
  return await response.json();
}
