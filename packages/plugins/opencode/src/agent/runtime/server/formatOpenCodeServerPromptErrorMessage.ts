const PROVIDER_PROMPT_ERROR_MAX_CHARS = 4_000;
const QUOTED_SECRET_FIELD_PATTERN =
  /(["'])(api[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|id[_-]?token|jwt|session(?:id)?|password|token|secret)\1\s*:\s*(["'])(?:\\.|(?!\3).)*\3/gi;

function redactOpenCodeServerPromptErrorText(input: string): string {
  return String(input ?? '')
    .replace(
      QUOTED_SECRET_FIELD_PATTERN,
      (_match, keyQuote: string, key: string, valueQuote: string) =>
        `${keyQuote}${key}${keyQuote}: ${valueQuote}[REDACTED]${valueQuote}`,
    )
    .replace(/\bauthorization\s*:\s*bearer\s+[^\r\n]+/gi, 'authorization: bearer [REDACTED]')
    .replace(/\bauthorization\s*:\s*basic\s+[^\r\n]+/gi, 'authorization: basic [REDACTED]')
    .replace(/\b(cookie|set-cookie)\s*:\s*[^\r\n]+/gi, (_match, key: string) => `${key.toLowerCase()}: [REDACTED]`)
    .replace(/\bx-api-key\s*:\s*[^\r\n]+/gi, 'x-api-key: [REDACTED]')
    .replace(/\b(api[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|id[_-]?token|jwt|session(?:id)?)\s*[:=]\s*['"]?\S+/gi, (_match, key: string) => `${key}: [REDACTED]`)
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9._-]{10,}\.[A-Za-z0-9._-]{10,}\b/g, '[REDACTED]')
    .replace(/\b(A3T[A-Z0-9]{16}|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16})\b/g, '[REDACTED]')
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[REDACTED]')
    .replace(/\bsk-[A-Za-z0-9]{20,}\b/g, '[REDACTED]')
    .replace(/\b(password|token|secret)\s*[:=]\s*\S+/gi, (_match, key: string) => `${key}: [REDACTED]`);
}

function formatOpenCodeServerPromptErrorSummary(error: unknown): string {
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

function trimOpenCodeServerPromptErrorMessage(text: string): string {
  return text.length > PROVIDER_PROMPT_ERROR_MAX_CHARS
    ? `${text.slice(0, PROVIDER_PROMPT_ERROR_MAX_CHARS)}\n...[truncated]`
    : text;
}

export function formatOpenCodeServerPromptErrorMessage(error: unknown): string {
  const formatted = trimOpenCodeServerPromptErrorMessage(
    redactOpenCodeServerPromptErrorText(formatOpenCodeServerPromptErrorSummary(error)),
  ).trim();

  if (formatted.length === 0) {
    return 'Error: Unknown error';
  }
  return /^error:/i.test(formatted) ? formatted : `Error: ${formatted}`;
}
