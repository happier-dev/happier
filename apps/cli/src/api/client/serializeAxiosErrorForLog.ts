import axios from 'axios';

function redactUrlForLog(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const value = raw.trim();
  if (!value) return undefined;
  const redactTelegramBotTokenPath = (input: string): string => input.replace(
    /\/bot[^/?#]+(?=\/|$)/u,
    '/<redacted>',
  );
  const redactUrlUserInfo = (input: string): string => input
    .replace(/^([a-z][a-z\d+.-]*:\/\/)([^/?#@]+@)+/iu, '$1')
    .replace(/^(\/\/)([^/?#@]+@)+/u, '$1')
    .replace(/^([^/?#:@\s]+:)([^/?#@]+@)+/u, '')
    .replace(
      /^([^/?#:@\s]+@)+(?=(?:localhost|\[[^\]]+\]|[^/?#@]+\.[^/?#@]+|[^/?#@]+:\d+)(?:[/?#]|$))/iu,
      '',
    );
  try {
    const parsed = new URL(value);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return redactTelegramBotTokenPath(redactUrlUserInfo(parsed.toString()));
  } catch {
    if (value.startsWith('//')) {
      try {
        const parsed = new URL(`https:${value}`);
        parsed.username = '';
        parsed.password = '';
        parsed.search = '';
        parsed.hash = '';
        return `//${parsed.host}${redactTelegramBotTokenPath(parsed.pathname)}`;
      } catch {
        // Fall through to the generic best-effort path below.
      }
    }
    // Best-effort: strip query/hash to avoid leaking secrets in URLs.
    return redactTelegramBotTokenPath(redactUrlUserInfo(value.split('?')[0]?.split('#')[0] ?? value));
  }
}

const LOG_URL_TOKEN_PATTERN = /\b[a-z][a-z\d+.-]*:\/\/[^\s"'<>]+|(?<!:)\/\/[^\s"'<>]+|\b[^/?#:@\s]+(?::[^/?#@\s]+)?@(?:localhost|\[[^\]\s]+\]|[^/?#@\s]+\.[^/?#@\s]+|[^/?#@\s]+:\d+)[^\s"'<>]*/giu;

function redactAuthorizationTokensForLog(value: string): string {
  return value
    .replace(/\b(Authorization\s*[:=]\s*)(?:Bearer|Basic)?\s*[^\s,;]+/giu, '$1<redacted>')
    .replace(/\b(Bearer|Basic)\s+[^\s,;]+/giu, '$1 <redacted>');
}

function redactMessageForLog(raw: unknown): string {
  return redactAuthorizationTokensForLog(
    String(raw).replace(LOG_URL_TOKEN_PATTERN, (match) => redactUrlForLog(match) ?? '<redacted>'),
  );
}

// IMPORTANT: Do not log axios error.config.headers.Authorization or request body, which may contain secrets.
export function serializeAxiosErrorForLog(error: unknown): Record<string, unknown> {
  if (axios.isAxiosError(error)) {
    return {
      name: error.name,
      message: redactMessageForLog(error.message),
      code: error.code,
      status: error.response?.status,
      method: typeof error.config?.method === 'string' ? error.config.method.toUpperCase() : undefined,
      url: redactUrlForLog(error.config?.url),
    };
  }

  if (error instanceof Error) {
    return { name: error.name, message: redactMessageForLog(error.message) };
  }

  return { message: redactMessageForLog(error) };
}
