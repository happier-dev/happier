import { formatErrorForUi } from '@/ui/formatErrorForUi';

const AUTH_ERROR_KEYWORDS = ['unauthorized', 'authentication', 'api key', 'token', '401'] as const;

function looksLikeAuthError(text: string): boolean {
  const lower = text.toLowerCase();
  return AUTH_ERROR_KEYWORDS.some((kw) => lower.includes(kw));
}

export function formatProviderPromptErrorMessage(error: unknown, opts?: { authHint?: string }): string {
  const formatted = formatErrorForUi(error, { maxChars: 4_000 }).trim();
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
