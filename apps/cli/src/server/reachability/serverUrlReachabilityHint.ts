import {
  isInsecureRemoteHttpServerUrl,
  isLocalishServerUrl,
  isLoopbackServerHost,
} from '@/server/serverUrlClassification';

/**
 * What to tell someone about a server URL that their phone probably cannot reach.
 *
 * One wording, shared by every surface that hands a server URL to a user: sign-in
 * (`happier auth login`) and relay installation both end with "here is your
 * server URL", and both have to be honest about who can actually reach it.
 *
 * Returns the lines to print, or an empty list when the URL needs no caveat.
 */
export function buildServerUrlReachabilityHintLines(serverUrl: string): readonly string[] {
  let url: URL | null = null;
  try {
    url = new URL(serverUrl);
  } catch {
    url = null;
  }

  if (isInsecureRemoteHttpServerUrl(serverUrl)) {
    return [
      'Warning: your server URL uses HTTP on a non-local host.',
      'This is insecure, and many web flows require HTTPS. Prefer an https:// URL (Tailscale Serve or a reverse proxy).',
    ];
  }

  if (isLoopbackServerHost(serverUrl) && url?.protocol !== 'https:') {
    return [
      'Note: your server URL is a localhost/loopback URL.',
      'This will work only on this same machine.',
      'For remote/phone access, use an HTTPS URL (Tailscale Serve or a reverse proxy) as your server URL.',
    ];
  }

  if (isLocalishServerUrl(serverUrl) && url?.protocol !== 'https:') {
    return [
      'Note: your server URL looks like a LAN-only URL.',
      'This will work only when your phone/laptop are on the same LAN/VPN.',
      'For remote/phone access, use an HTTPS URL (Tailscale Serve or a reverse proxy) as your server URL.',
    ];
  }

  return [];
}
