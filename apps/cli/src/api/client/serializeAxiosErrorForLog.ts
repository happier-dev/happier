import axios from 'axios';

function redactTelegramBotTokenPathname(pathname: string): string {
  const raw = String(pathname ?? '');
  if (!raw) return raw;
  const parts = raw.split('/');
  const redacted = parts.map((part) => {
    const segment = String(part ?? '');
    if (segment.startsWith('bot') && segment.length > 3) {
      return 'botREDACTED';
    }
    return segment;
  });
  return redacted.join('/');
}

function redactUrlForLog(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const value = raw.trim();
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    parsed.pathname = redactTelegramBotTokenPathname(parsed.pathname);
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    // Best-effort: strip query/hash to avoid leaking secrets in URLs.
    const withoutQuery = value.split('?')[0]?.split('#')[0] ?? value;
    return withoutQuery.replace(/\/bot[^/]+\//g, '/botREDACTED/');
  }
}

// IMPORTANT: Do not log axios error.config.headers.Authorization or request body, which may contain secrets.
export function serializeAxiosErrorForLog(error: unknown): Record<string, unknown> {
  if (axios.isAxiosError(error)) {
    return {
      name: error.name,
      message: error.message,
      code: (error as any)?.code,
      status: error.response?.status,
      method: typeof error.config?.method === 'string' ? error.config.method.toUpperCase() : undefined,
      url: redactUrlForLog(error.config?.url),
    };
  }

  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }

  return { message: String(error) };
}
