const TELEGRAM_WEBHOOK_SECRET_TOKEN_PATTERN = /^[A-Za-z0-9_-]+$/;
export const TELEGRAM_WEBHOOK_SECRET_TOKEN_MAX_LENGTH = 256;

export function readTelegramWebhookSecretToken(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const token = value.trim();
  if (token.length === 0) return null;
  if (token.length > TELEGRAM_WEBHOOK_SECRET_TOKEN_MAX_LENGTH) return null;
  if (!TELEGRAM_WEBHOOK_SECRET_TOKEN_PATTERN.test(token)) return null;
  return token;
}

export function assertTelegramWebhookSecretToken(
  value: string,
  errors: Readonly<{ empty: string; invalid: string; tooLong: string }>,
): string {
  if (value.trim().length === 0) {
    throw new Error(errors.empty);
  }
  if (value.trim().length > TELEGRAM_WEBHOOK_SECRET_TOKEN_MAX_LENGTH) {
    throw new Error(errors.tooLong);
  }
  const token = readTelegramWebhookSecretToken(value);
  if (!token) {
    throw new Error(errors.invalid);
  }
  return token;
}
