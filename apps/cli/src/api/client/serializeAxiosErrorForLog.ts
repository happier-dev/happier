import axios from 'axios';

function redactUrlForLog(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const value = raw.trim();
  if (!value) return undefined;
  const redactTelegramBotTokenPath = (input: string): string => input.replace(
    /\/bot[^/?#]+(?=\/|$)/u,
    '/<redacted>',
  );
  try {
    const parsed = new URL(value);
    parsed.search = '';
    parsed.hash = '';
    return redactTelegramBotTokenPath(parsed.toString());
  } catch {
    // Best-effort: strip query/hash to avoid leaking secrets in URLs.
    return redactTelegramBotTokenPath(value.split('?')[0]?.split('#')[0] ?? value);
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
