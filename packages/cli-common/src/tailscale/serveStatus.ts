function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
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

  const re = new RegExp(String.raw`\\bproxy\\s+https?:\\/\\/(?:127\\.0\\.0\\.1|localhost|0\\.0\\.0\\.0):${port}\\b`, 'i');
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
