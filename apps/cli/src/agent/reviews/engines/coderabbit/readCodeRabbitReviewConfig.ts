function normalizeNonEmptyString(value: unknown): string | null {
  const trimmed = String(value ?? '').trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parsePositiveInt(value: unknown): number | null {
  const raw = typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

export type CodeRabbitReviewConfig = Readonly<{
  command: string;
  timeoutMs: number | null;
  homeDir: string | null;
  rateLimitMaxAttempts: number;
  maxEligibleFiles: number;
}>;

export function readCodeRabbitReviewConfigFromEnv(env: NodeJS.ProcessEnv): CodeRabbitReviewConfig {
  // Prefer explicit override for deterministic testing / custom installs, but default
  // to the standard `coderabbit` binary name so a normal install "just works".
  const command = normalizeNonEmptyString(env.HAPPIER_CODERABBIT_REVIEW_CMD) ?? 'coderabbit';

  // Intentionally unset by default so provider-local behavior cannot silently reintroduce a shorter
  // review timeout than the execution-run policy. Operators can still opt in with an explicit override.
  const timeoutMs = parsePositiveInt(env.HAPPIER_CODERABBIT_REVIEW_TIMEOUT_MS);

  const homeDir = normalizeNonEmptyString(env.HAPPIER_CODERABBIT_HOME_DIR);

  const rateLimitMaxAttempts =
    parsePositiveInt(env.HAPPIER_CODERABBIT_REVIEW_RATE_LIMIT_MAX_ATTEMPTS) ??
    10;

  const maxEligibleFiles =
    parsePositiveInt(env.HAPPIER_CODERABBIT_REVIEW_MAX_ELIGIBLE_FILES) ??
    300;

  return { command, timeoutMs, homeDir, rateLimitMaxAttempts, maxEligibleFiles };
}
