import type { HttpService } from '@happier-dev/plugin-sdk/http';

export const OPENAI_CODEX_DEFAULT_RATE_LIMIT_RESET_CREDITS_URL =
  'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits';

export const OPENAI_CODEX_DEFAULT_RATE_LIMIT_RESET_CREDIT_CONSUME_URL =
  'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume';

export type CodexRateLimitResetCreditsClientParams = Readonly<{
  accessToken: string;
  accountId?: string | null;
  userAgent?: string;
  signal?: AbortSignal;
  runtimeFetch: Pick<HttpService, 'request'>;
}>;

function buildHeaders(params: Readonly<{
  accessToken: string;
  accountId?: string | null;
  userAgent?: string;
}>): Readonly<Record<string, string>> {
  return {
    Authorization: `Bearer ${params.accessToken}`,
    ...(params.accountId ? { 'ChatGPT-Account-Id': params.accountId } : {}),
    Accept: 'application/json',
    ...(params.userAgent ? { 'User-Agent': params.userAgent } : {}),
  };
}

export type CodexRateLimitResetCreditOutcomeCode =
  | 'reset'
  | 'nothing_to_reset'
  | 'no_credit'
  | 'already_redeemed';

export type CodexRateLimitResetCreditOutcome = Readonly<{
  code: CodexRateLimitResetCreditOutcomeCode;
  windowsReset: number;
}>;

function parseConsumeOutcome(value: unknown): CodexRateLimitResetCreditOutcome {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('OpenAI reset-credit consume failed: invalid consume response');
  }
  const record = value as Readonly<Record<string, unknown>>;
  const code = record.code;
  if (
    code !== 'reset'
    && code !== 'nothing_to_reset'
    && code !== 'no_credit'
    && code !== 'already_redeemed'
  ) {
    throw new Error('OpenAI reset-credit consume failed: invalid consume response');
  }
  const rawWindowsReset = record.windows_reset;
  if (
    rawWindowsReset !== undefined
    && (typeof rawWindowsReset !== 'number' || !Number.isFinite(rawWindowsReset))
  ) {
    throw new Error('OpenAI reset-credit consume failed: invalid consume response');
  }
  return {
    code,
    windowsReset: typeof rawWindowsReset === 'number'
      ? Math.max(0, Math.trunc(rawWindowsReset))
      : 0,
  };
}

function buildProviderError(status: number): Error {
  return new Error(`OpenAI reset-credit fetch failed (${status}): HTTP error`);
}

function readJsonBody(response: Awaited<ReturnType<HttpService['request']>>): unknown {
  return JSON.parse(new TextDecoder().decode(response.body)) as unknown;
}

export async function fetchCodexRateLimitResetCredits(
  params: CodexRateLimitResetCreditsClientParams & Readonly<{ resetCreditsUrl?: string }>,
): Promise<unknown> {
  const response = await params.runtimeFetch.request({
    url: params.resetCreditsUrl ?? OPENAI_CODEX_DEFAULT_RATE_LIMIT_RESET_CREDITS_URL,
    method: 'GET',
    headers: buildHeaders(params),
    redirect: 'error',
  }, { signal: params.signal });
  if (response.status < 200 || response.status >= 300) {
    throw buildProviderError(response.status);
  }
  return readJsonBody(response);
}

export async function consumeCodexRateLimitResetCredit(
  params: CodexRateLimitResetCreditsClientParams & Readonly<{
    consumeUrl?: string;
    idempotencyKey: string;
    providerCreditId?: string | null;
  }>,
): Promise<CodexRateLimitResetCreditOutcome> {
  const idempotencyKey = params.idempotencyKey.trim();
  const providerCreditId = typeof params.providerCreditId === 'string'
    ? params.providerCreditId.trim()
    : '';
  if (!idempotencyKey) {
    throw new Error('OpenAI reset-credit consume failed: missing redeem request id');
  }
  const response = await params.runtimeFetch.request({
    url: params.consumeUrl ?? OPENAI_CODEX_DEFAULT_RATE_LIMIT_RESET_CREDIT_CONSUME_URL,
    method: 'POST',
    headers: buildHeaders(params),
    body: new TextEncoder().encode(JSON.stringify({
      redeem_request_id: idempotencyKey,
      ...(providerCreditId ? { credit_id: providerCreditId } : {}),
    })),
    redirect: 'error',
  }, { signal: params.signal });
  if (response.status < 200 || response.status >= 300) {
    throw buildProviderError(response.status);
  }
  return parseConsumeOutcome(readJsonBody(response));
}
