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

export function buildTerminalConnectLinks(params: Readonly<{
  webappUrl: string;
  serverUrl: string;
  publicKeyB64Url: string;
}>): TerminalConnectLinks {
  const webappUrl = stripTrailingSlash(String(params.webappUrl ?? '').trim());
  const serverUrl = String(params.serverUrl ?? '').trim();
  const publicKeyB64Url = String(params.publicKeyB64Url ?? '').trim();
  const encodedServerUrl = encodeURIComponent(serverUrl);

  return {
    webUrl: `${webappUrl}/terminal/connect#key=${publicKeyB64Url}&server=${encodedServerUrl}`,
    mobileUrl: `happier://terminal?key=${publicKeyB64Url}&server=${encodedServerUrl}`,
  };
}

export function buildConfigureServerLinks(params: Readonly<{
  webappUrl: string;
  serverUrl: string;
}>): ConfigureServerLinks {
  const webappUrl = stripTrailingSlash(String(params.webappUrl ?? '').trim());
  const serverUrl = String(params.serverUrl ?? '').trim();
  const encodedServerUrl = encodeURIComponent(serverUrl);
  return {
    // Prefer setting the server on any screen via `?server=` so callers don't need to navigate
    // to a dedicated server selection route first.
    webUrl: `${webappUrl}/?server=${encodedServerUrl}`,
    mobileUrl: `happier://server?url=${encodedServerUrl}`,
  };
}
