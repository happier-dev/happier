export function resolveLoopbackHttpUrl(raw: string): string {
  const value = String(raw ?? '').trim();
  if (!value) return raw;

  try {
    const parsed = new URL(value);
    // Only rewrite http localhost. For https, hostname matters for TLS cert validation.
    if (parsed.protocol === 'http:' && parsed.hostname === 'localhost') {
      parsed.hostname = '127.0.0.1';
      return parsed.toString();
    }
    return value;
  } catch {
    return raw;
  }
}

