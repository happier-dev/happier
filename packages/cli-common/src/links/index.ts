export type TerminalConnectLinks = Readonly<{
  webUrl: string;
  mobileUrl: string;
}>;

export type ConfigureServerLinks = Readonly<{
  webUrl: string;
  mobileUrl: string;
}>;

function stripTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

const SAFE_SERVER_PROTOCOLS = new Set(['http:', 'https:']);

function isLoopbackHostname(hostname: string): boolean {
  const host = String(hostname ?? '').trim().toLowerCase();
  if (!host) return false;
  if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host === '::1') return true;
  if (host.endsWith('.localhost')) return true;
  return false;
}

function sanitizeServerUrlForShareableLink(raw: string): string | null {
  const value = String(raw ?? '').trim();
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (!SAFE_SERVER_PROTOCOLS.has(parsed.protocol)) return null;
    if (isLoopbackHostname(parsed.hostname)) return null;
    if (parsed.username || parsed.password) {
      parsed.username = '';
      parsed.password = '';
    }
    parsed.search = '';
    parsed.hash = '';
    return stripTrailingSlash(parsed.toString());
  } catch {
    return null;
  }
}

export function buildTerminalConnectLinks(params: Readonly<{
  webappUrl: string;
  serverUrl: string;
  publicKeyB64Url: string;
}>): TerminalConnectLinks {
  const webappUrl = stripTrailingSlash(String(params.webappUrl ?? '').trim());
  const serverUrl = sanitizeServerUrlForShareableLink(params.serverUrl);
  const publicKeyB64Url = String(params.publicKeyB64Url ?? '').trim();
  const encodedServerUrl = serverUrl ? encodeURIComponent(serverUrl) : '';

  return {
    webUrl: serverUrl
      ? `${webappUrl}/terminal/connect#key=${publicKeyB64Url}&server=${encodedServerUrl}`
      : `${webappUrl}/terminal/connect#key=${publicKeyB64Url}`,
    mobileUrl: serverUrl
      ? `happier://terminal?key=${publicKeyB64Url}&server=${encodedServerUrl}`
      : `happier://terminal?key=${publicKeyB64Url}`,
  };
}

export function buildConfigureServerLinks(params: Readonly<{
  webappUrl: string;
  serverUrl: string;
}>): ConfigureServerLinks {
  const webappUrl = stripTrailingSlash(String(params.webappUrl ?? '').trim());
  const serverUrl = sanitizeServerUrlForShareableLink(params.serverUrl);
  const encodedServerUrl = serverUrl ? encodeURIComponent(serverUrl) : '';
  if (!serverUrl) {
    return { webUrl: webappUrl, mobileUrl: `happier://server` };
  }

  return {
    // Prefer setting the server on any screen via `?server=` so callers don't need to navigate
    // to a dedicated server selection route first.
    webUrl: `${webappUrl}/?server=${encodedServerUrl}`,
    mobileUrl: `happier://server?url=${encodedServerUrl}`,
  };
}
