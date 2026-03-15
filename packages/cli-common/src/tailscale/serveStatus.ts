function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

export function extractTailscaleServeHttpsUrl(serveStatusText: string): string | null {
  const line = String(serveStatusText ?? '')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.toLowerCase().includes('https://'));
  if (!line) return null;
  const m = line.match(/https:\/\/\S+/i);
  if (!m) return null;
  return stripTrailingSlash(m[0]);
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
  const https = extractTailscaleServeHttpsUrl(serveStatusText);
  if (!https) return null;
  return tailscaleServeStatusMatchesInternalServerUrl(serveStatusText, internalServerUrl) ? https : null;
}

