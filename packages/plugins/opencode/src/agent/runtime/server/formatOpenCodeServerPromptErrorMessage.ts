import { redactBugReportSensitiveText } from '@happier-dev/plugin-sdk';

const PROVIDER_PROMPT_ERROR_MAX_CHARS = 4_000;

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
    redactBugReportSensitiveText(formatOpenCodeServerPromptErrorSummary(error)),
  ).trim();

  if (formatted.length === 0) {
    return 'Error: Unknown error';
  }
  return /^error:/i.test(formatted) ? formatted : `Error: ${formatted}`;
}
