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
  timeoutMs: number;
  homeDir: string | null;
  rateLimitMaxAttempts: number;
}>;

export function readCodeRabbitReviewConfigFromEnv(env: NodeJS.ProcessEnv): CodeRabbitReviewConfig {
  // Prefer explicit override for deterministic testing / custom installs, but default
  // to the standard `coderabbit` binary name so a normal install "just works".
  const command = normalizeNonEmptyString(env.HAPPIER_CODERABBIT_REVIEW_CMD) ?? 'coderabbit';

  const timeoutMs =
    parsePositiveInt(env.HAPPIER_CODERABBIT_REVIEW_TIMEOUT_MS) ??
    120_000;

  const homeDir = normalizeNonEmptyString(env.HAPPIER_CODERABBIT_HOME_DIR);

  const rateLimitMaxAttempts =
    parsePositiveInt(env.HAPPIER_CODERABBIT_REVIEW_RATE_LIMIT_MAX_ATTEMPTS) ??
    10;

  return { command, timeoutMs, homeDir, rateLimitMaxAttempts };
}
