function stripTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

function formatHost(hostname: string): string {
  // URL.hostname for IPv6 returns without brackets.
  return hostname.includes(':') ? `[${hostname}]` : hostname;
}

export function normalizeProxyUrl(raw: string | undefined | null): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const withScheme = trimmed.includes('://') ? trimmed : `http://${trimmed}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

  const port = url.port
    ? url.port
    : url.protocol === 'http:'
      ? '80'
      : '443';

  const auth = url.username
    ? `${encodeURIComponent(url.username)}${url.password ? `:${encodeURIComponent(url.password)}` : ''}@`
    : '';

  const host = formatHost(url.hostname);
  return stripTrailingSlash(`${url.protocol}//${auth}${host}:${port}`);
}

