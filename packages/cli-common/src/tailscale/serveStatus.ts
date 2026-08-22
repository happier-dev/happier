function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

function normalizeServePath(value: string | undefined): string {
  const raw = String(value ?? '').trim();
  if (!raw || raw === '/') {
    return '/';
  }
  const prefixed = raw.startsWith('/') ? raw : `/${raw}`;
  return prefixed.replace(/\/+$/, '') || '/';
}

function normalizeHttpsUrl(raw: string): string | null {
  const value = String(raw ?? '').trim();
  if (!value) return null;

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'https:') return null;
  if (parsed.username || parsed.password) {
    parsed.username = '';
    parsed.password = '';
  }
  parsed.search = '';
  parsed.hash = '';
  return stripTrailingSlash(parsed.toString());
}

function tryParseProxyTargetFromLine(line: string): URL | null {
  const trimmed = String(line ?? '').trim();
  const match = trimmed.match(/\bproxy\s+(\S+)/i);
  const raw = match?.[1] ? String(match[1]).trim() : '';
  if (!raw) return null;

  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

export type TailscaleServeRootSlot =
  | Readonly<{ kind: 'free' }>
  | Readonly<{ kind: 'exact'; httpsUrl: string | null }>
  | Readonly<{ kind: 'conflict'; exposure: 'serve' | 'funnel'; httpsUrl: string | null }>;

function isRootProxyLine(line: string): boolean {
  return /^\|?--\s+\/\s+proxy\s+/iu.test(String(line ?? '').trim());
}

function proxyTargetMatchesInternalServerUrl(target: URL, internalServerUrl: string): boolean {
  let wanted: URL;
  try {
    wanted = new URL(internalServerUrl);
  } catch {
    return false;
  }
  if (target.toString().replace(/\/+$/u, '') === wanted.toString().replace(/\/+$/u, '')) return true;
  const loopbackSpellings = new Set(['127.0.0.1', 'localhost', '0.0.0.0', '[::1]', '::1']);
  return Boolean(
    wanted.port
    && target.port === wanted.port
    && loopbackSpellings.has(target.hostname.toLowerCase())
    && loopbackSpellings.has(wanted.hostname.toLowerCase()),
  );
}

/**
 * Classify only the root HTTPS mount that `tailscale serve --bg <upstream>`
 * would replace. Other paths may coexist and are therefore not conflicts.
 */
export function classifyTailscaleServeRootSlot(
  statusText: string,
  internalServerUrl: string,
): TailscaleServeRootSlot {
  let currentHttpsUrl: string | null = null;
  const lines = String(statusText ?? '').split(/\r?\n/u);
  for (const rawLine of lines) {
    const line = String(rawLine ?? '').trim();
    if (!line) continue;

    const maybeHttps = line.match(/^(https:\/\/\S+)/iu)?.[1];
    if (maybeHttps && !line.toLowerCase().includes('proxy')) {
      currentHttpsUrl = normalizeHttpsUrl(maybeHttps);
      continue;
    }
    if (!isRootProxyLine(line)) continue;

    const target = tryParseProxyTargetFromLine(line);
    if (target && proxyTargetMatchesInternalServerUrl(target, internalServerUrl)) {
      return { kind: 'exact', httpsUrl: currentHttpsUrl };
    }
    return {
      kind: 'conflict',
      exposure: /\bfunnel\b/iu.test(statusText) ? 'funnel' : 'serve',
      httpsUrl: currentHttpsUrl,
    };
  }
  return { kind: 'free' };
}

function tryParseServePathFromLine(line: string): string | null {
  const trimmed = String(line ?? '').trim();
  const match = trimmed.match(/^\|--\s+(\S+)\s+proxy\s+\S+/i);
  if (!match?.[1]) {
    return null;
  }
  return normalizeServePath(match[1]);
}

function normalizeHttpsPort(value: number | undefined): string {
  const normalized = Number.isFinite(value) ? Math.trunc(value as number) : 443;
  return normalized > 0 ? String(normalized) : '443';
}

function httpsUrlMatchesPort(baseUrl: string, httpsPort: number | undefined): boolean {
  try {
    const parsed = new URL(baseUrl);
    const actualPort = parsed.port || (parsed.protocol === 'https:' ? '443' : '');
    return actualPort === normalizeHttpsPort(httpsPort);
  } catch {
    return false;
  }
}

export function extractTailscaleServeHttpsUrl(serveStatusText: string): string | null {
  const line = String(serveStatusText ?? '')
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find((value) => value.toLowerCase().includes('https://'));
  if (!line) return null;

  const match = line.match(/https:\/\/\S+/i);
  if (!match) return null;
  return normalizeHttpsUrl(match[0]);
}

export function parseTailscaleServeHttpsBaseUrlForPort(statusText: string, port: number): string | null {
  const wantedPort = Number.isFinite(port) && port > 0 ? String(Math.trunc(port)) : '';
  if (!wantedPort) return null;

  let currentBase: string | null = null;
  const lines = String(statusText ?? '').split(/\r?\n/);
  for (const rawLine of lines) {
    const line = String(rawLine ?? '').trim();
    if (!line) continue;

    const maybeHttps = line.match(/^(https:\/\/\S+)/i)?.[1];
    if (maybeHttps && !line.toLowerCase().includes('proxy')) {
      currentBase = normalizeHttpsUrl(maybeHttps);
      continue;
    }

    if (!currentBase) continue;
    const proxyTarget = tryParseProxyTargetFromLine(line);
    if (!proxyTarget) continue;
    if (proxyTarget.port === wantedPort) {
      return currentBase;
    }
  }

  return null;
}

export function tailscaleServeHttpsUrlForOwnedConfigFromStatus(params: Readonly<{
  serveStatusText: string;
  internalServerUrl: string;
  servePath?: string;
  httpsPort?: number;
}>): string | null {
  const rawInternalServerUrl = String(params.internalServerUrl ?? '').trim();
  if (!rawInternalServerUrl) {
    return null;
  }

  let wantedPort = '';
  try {
    wantedPort = new URL(rawInternalServerUrl).port;
  } catch {
    wantedPort = '';
  }
  if (!wantedPort) {
    return null;
  }

  const wantedServePath = normalizeServePath(params.servePath);
  let currentBase: string | null = null;
  const lines = String(params.serveStatusText ?? '').split(/\r?\n/);
  for (const rawLine of lines) {
    const line = String(rawLine ?? '').trim();
    if (!line) {
      continue;
    }

    const maybeHttps = line.match(/^(https:\/\/\S+)/i)?.[1];
    if (maybeHttps && !line.toLowerCase().includes('proxy')) {
      currentBase = normalizeHttpsUrl(maybeHttps);
      continue;
    }

    if (!currentBase || !httpsUrlMatchesPort(currentBase, params.httpsPort)) {
      continue;
    }

    const proxyTarget = tryParseProxyTargetFromLine(line);
    if (!proxyTarget || proxyTarget.port !== wantedPort) {
      continue;
    }

    const servedPath = tryParseServePathFromLine(line);
    if (servedPath !== wantedServePath) {
      continue;
    }

    return currentBase;
  }

  return null;
}

export function tailscaleServeStatusMatchesInternalServerUrl(
  serveStatusText: string,
  internalServerUrl: string,
): boolean {
  const raw = String(internalServerUrl ?? '').trim();
  if (!raw) return true;

  // Fast path.
  if (serveStatusText.includes(raw)) return true;

  // Tailscale typically prints proxy targets like:
  //   |-- / proxy http://127.0.0.1:3005
  let port = '';
  try {
    port = new URL(raw).port;
  } catch {
    port = '';
  }
  if (!port) return false;

  const re = new RegExp(String.raw`\bproxy\s+https?:\/\/(?:127\.0\.0\.1|localhost|0\.0\.0\.0):${port}\b`, 'i');
  return re.test(serveStatusText);
}

export function tailscaleServeHttpsUrlForInternalServerUrlFromStatus(
  serveStatusText: string,
  internalServerUrl: string,
): string | null {
  const raw = String(internalServerUrl ?? '').trim();
  if (!raw) {
    return extractTailscaleServeHttpsUrl(serveStatusText);
  }

  try {
    const port = new URL(raw).port;
    if (port) {
      return (
        parseTailscaleServeHttpsBaseUrlForPort(serveStatusText, Number(port)) ??
        (tailscaleServeStatusMatchesInternalServerUrl(serveStatusText, internalServerUrl)
          ? extractTailscaleServeHttpsUrl(serveStatusText)
          : null)
      );
    }
  } catch {
    // fall through to the looser match below
  }

  const https = extractTailscaleServeHttpsUrl(serveStatusText);
  if (!https) return null;
  return tailscaleServeStatusMatchesInternalServerUrl(serveStatusText, internalServerUrl) ? https : null;
}
