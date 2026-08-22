import { isLoopbackHostname, normalizeHostnameForLoopbackCheck } from '@happier-dev/protocol';

export type TerminalConnectLinks = Readonly<{
  webUrl: string;
  mobileUrl: string;
}>;

export type ConfigureServerLinks = Readonly<{
  webUrl: string;
  mobileUrl: string;
}>;

export type TerminalConnectPairingContext = Readonly<{
  secretB64Url: string;
  createdAtMs: number;
  expiresAtMs: number;
}>;

function stripTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

const SAFE_SERVER_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * Whether this host is unusable as an address handed to another device.
 *
 * Loopback itself is `@happier-dev/protocol`'s to decide — it owns the bracket
 * and trailing-dot parsing that a private copy here kept getting wrong, which
 * put `http://[::1]:3005` into mobile QR and deep links as if it were remote.
 * The extra case is local: a relay reporting `0.0.0.0` is not loopback, but it
 * is not something a phone can be pointed at either.
 */
function isUnreachableFromOtherDevices(hostname: string): boolean {
  if (isLoopbackHostname(hostname)) return true;
  return normalizeHostnameForLoopbackCheck(hostname) === '0.0.0.0';
}

function parseSafeServerUrl(raw: string): URL | null {
  const value = String(raw ?? '').trim();
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (!SAFE_SERVER_PROTOCOLS.has(parsed.protocol)) return null;
    if (parsed.username || parsed.password) {
      parsed.username = '';
      parsed.password = '';
    }
    parsed.search = '';
    parsed.hash = '';
    return parsed;
  } catch {
    return null;
  }
}

function isLocalWebappUrl(raw: string): boolean {
  const parsed = parseSafeServerUrl(raw);
  if (!parsed) return false;
  return isUnreachableFromOtherDevices(parsed.hostname);
}

function sanitizeServerUrlForWebLink(raw: string, webappUrl: string): string | null {
  const parsed = parseSafeServerUrl(raw);
  if (!parsed) return null;
  if (isUnreachableFromOtherDevices(parsed.hostname) && !isLocalWebappUrl(webappUrl)) return null;
  return stripTrailingSlash(parsed.toString());
}

function sanitizeServerUrlForMobileLink(raw: string): string | null {
  const parsed = parseSafeServerUrl(raw);
  if (!parsed) return null;
  if (isUnreachableFromOtherDevices(parsed.hostname)) return null;
  return stripTrailingSlash(parsed.toString());
}

export function buildTerminalConnectLinks(params: Readonly<{
  webappUrl: string;
  serverUrl: string;
  publicKeyB64Url: string;
  pairing?: TerminalConnectPairingContext | null;
  supportsTokenOnly?: boolean;
}>): TerminalConnectLinks {
  const webappUrl = stripTrailingSlash(String(params.webappUrl ?? '').trim());
  const webServerUrl = sanitizeServerUrlForWebLink(params.serverUrl, webappUrl);
  const mobileServerUrl = sanitizeServerUrlForMobileLink(params.serverUrl);
  const publicKeyB64Url = String(params.publicKeyB64Url ?? '').trim();
  const encodedWebServerUrl = webServerUrl ? encodeURIComponent(webServerUrl) : '';
  const encodedMobileServerUrl = mobileServerUrl ? encodeURIComponent(mobileServerUrl) : '';
  const pairingSuffix =
    params.pairing
    && String(params.pairing.secretB64Url ?? '').trim()
    && Number.isSafeInteger(params.pairing.createdAtMs)
    && Number.isSafeInteger(params.pairing.expiresAtMs)
    && params.pairing.createdAtMs >= 0
    && params.pairing.expiresAtMs > params.pairing.createdAtMs
      ? `&pairingSecret=${encodeURIComponent(params.pairing.secretB64Url.trim())}`
        + `&createdAt=${params.pairing.createdAtMs}`
        + `&expiresAt=${params.pairing.expiresAtMs}`
      : '';
  const tokenOnlyCapabilitySuffix =
    pairingSuffix && params.supportsTokenOnly === true
      ? '&supportsTokenOnly=1'
      : '';

  return {
    webUrl: webServerUrl
      ? `${webappUrl}/terminal/connect#key=${publicKeyB64Url}&server=${encodedWebServerUrl}${pairingSuffix}${tokenOnlyCapabilitySuffix}`
      : `${webappUrl}/terminal/connect#key=${publicKeyB64Url}${pairingSuffix}${tokenOnlyCapabilitySuffix}`,
    mobileUrl: mobileServerUrl
      ? `happier://terminal?key=${publicKeyB64Url}&server=${encodedMobileServerUrl}${pairingSuffix}${tokenOnlyCapabilitySuffix}`
      : `happier://terminal?key=${publicKeyB64Url}${pairingSuffix}${tokenOnlyCapabilitySuffix}`,
  };
}

export function buildConfigureServerLinks(params: Readonly<{
  webappUrl: string;
  serverUrl: string;
}>): ConfigureServerLinks {
  const webappUrl = stripTrailingSlash(String(params.webappUrl ?? '').trim());
  const webServerUrl = sanitizeServerUrlForWebLink(params.serverUrl, webappUrl);
  const mobileServerUrl = sanitizeServerUrlForMobileLink(params.serverUrl);
  const encodedWebServerUrl = webServerUrl ? encodeURIComponent(webServerUrl) : '';
  const encodedMobileServerUrl = mobileServerUrl ? encodeURIComponent(mobileServerUrl) : '';
  if (!webServerUrl && !mobileServerUrl) {
    return { webUrl: webappUrl, mobileUrl: `happier://server` };
  }

  return {
    // Prefer setting the server on any screen via `?server=` so callers don't need to navigate
    // to a dedicated server selection route first.
    webUrl: webServerUrl ? `${webappUrl}/?server=${encodedWebServerUrl}` : webappUrl,
    mobileUrl: mobileServerUrl ? `happier://server?url=${encodedMobileServerUrl}` : `happier://server`,
  };
}
