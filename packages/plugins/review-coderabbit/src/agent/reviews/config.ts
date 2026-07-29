function parsePositiveInt(value: unknown): number | null {
  const raw = typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.floor(parsed);
}

export type CodeRabbitReviewConfig = Readonly<{
  timeoutMs: number | null;
  rateLimitMaxAttempts: number;
  maxEligibleFiles: number;
}>;

export function readCodeRabbitReviewConfigFromEnv(
  env: Readonly<Record<string, unknown>>,
): CodeRabbitReviewConfig {
  const timeoutMs = parsePositiveInt(env.HAPPIER_CODERABBIT_REVIEW_TIMEOUT_MS);
  const rateLimitMaxAttempts = parsePositiveInt(env.HAPPIER_CODERABBIT_REVIEW_RATE_LIMIT_MAX_ATTEMPTS) ?? 10;
  const maxEligibleFiles = parsePositiveInt(env.HAPPIER_CODERABBIT_REVIEW_MAX_ELIGIBLE_FILES) ?? 300;

  return { timeoutMs, rateLimitMaxAttempts, maxEligibleFiles };
}
