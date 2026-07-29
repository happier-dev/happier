import type { CodexRuntimeFetch } from '../runtimeFetch.js';

export const OPENAI_CODEX_DEFAULT_RATE_LIMIT_RESET_CREDITS_URL =
  'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits';

export const OPENAI_CODEX_DEFAULT_RATE_LIMIT_RESET_CREDIT_CONSUME_URL =
  'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume';

export type CodexRateLimitResetCreditsClientParams = Readonly<{
  accessToken: string;
  accountId?: string | null;
  userAgent?: string;
  signal?: AbortSignal;
  runtimeFetch: CodexRuntimeFetch;
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
): Promise<CodexRateLimitResetCreditOutcome> {
  const idempotencyKey = params.idempotencyKey.trim();
  const providerCreditId = typeof params.providerCreditId === 'string'
    ? params.providerCreditId.trim()
    : '';
  if (!idempotencyKey) {
    throw new Error('OpenAI reset-credit consume failed: missing redeem request id');
  }
  const response = await params.runtimeFetch({
    url: params.consumeUrl ?? OPENAI_CODEX_DEFAULT_RATE_LIMIT_RESET_CREDIT_CONSUME_URL,
    method: 'POST',
    headers: buildHeaders(params),
    body: {
      redeem_request_id: idempotencyKey,
      ...(providerCreditId ? { credit_id: providerCreditId } : {}),
    },
    signal: params.signal,
  });
  if (!response.ok) {
    throw buildProviderError(response.status, response.statusText);
  }
  return parseConsumeOutcome(await response.json());
}
