import { redactBugReportSensitiveText } from '@happier-dev/protocol';

const AUTH_ERROR_KEYWORDS = ['unauthorized', 'authentication', 'api key', 'token', '401'] as const;
const PROVIDER_PROMPT_ERROR_MAX_CHARS = 4_000;

function looksLikeAuthError(text: string): boolean {
  const lower = text.toLowerCase();
  return AUTH_ERROR_KEYWORDS.some((kw) => lower.includes(kw));
}

function formatProviderPromptErrorSummary(error: unknown): string {
  if (error instanceof Error) {
    const name = error.name && error.name !== 'Error' ? `${error.name}: ` : '';
    return `${name}${error.message || String(error)}`;
  }

  if (typeof error === 'object' && error !== null) {
    const seen = new WeakSet<object>();
    try {
      return JSON.stringify(
        error,
        (key, value) => {
          if (key === 'stack') return undefined;
          if (value instanceof Error) {
            return {
              name: value.name,
              message: value.message,
            };
          }
          if (typeof value === 'bigint') return value.toString();
          if (typeof value === 'object' && value !== null) {
            if (seen.has(value)) return '[Circular]';
            seen.add(value);
          }
          return value;
        },
        2,
      );
    } catch {
      return String(error);
    }
  }

  return String(error);
}

function trimProviderPromptError(text: string): string {
  return text.length > PROVIDER_PROMPT_ERROR_MAX_CHARS
    ? `${text.slice(0, PROVIDER_PROMPT_ERROR_MAX_CHARS)}\n…[truncated]`
    : text;
}

export function formatProviderPromptErrorMessage(error: unknown, opts?: { authHint?: string }): string {
  const formatted = trimProviderPromptError(redactBugReportSensitiveText(formatProviderPromptErrorSummary(error))).trim();
  const base = formatted.length === 0
    ? 'Error: Unknown error'
    : /^error:/i.test(formatted)
      ? formatted
      : `Error: ${formatted}`;

  if (opts?.authHint && looksLikeAuthError(formatted)) {
    return `${base}\n\n${opts.authHint}`;
  }
  return base;
}
