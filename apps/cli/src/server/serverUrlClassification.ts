import net from 'node:net';

import {
  isLoopbackHostname as isProtocolLoopbackHostname,
  normalizeHostnameForLoopbackCheck,
} from '@happier-dev/protocol/server/urls';

function stripBrackets(hostname: string): string {
  const host = String(hostname ?? '').trim();
  if (host.startsWith('[') && host.endsWith(']')) {
    return host.slice(1, -1);
  }
  return host;
}

function isPrivateIpv4(hostname: string): boolean {
  const host = String(hostname ?? '').trim();
  const parts = host.split('.');
  if (parts.length !== 4) return false;
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = nums;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true; // link-local
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT (used by some VPNs like Tailscale)
  return false;
}

function isLocalishIpv6(hostname: string): boolean {
  const raw = stripBrackets(hostname).toLowerCase();
  if (!raw) return false;
  if (raw === '::1') return true;
  // ULA: fc00::/7 (typically fd00::/8)
  if (raw.startsWith('fc') || raw.startsWith('fd')) return true;
  // Link-local: fe80::/10
  if (raw.startsWith('fe8') || raw.startsWith('fe9') || raw.startsWith('fea') || raw.startsWith('feb')) return true;
  return false;
}

export function isLocalishHostname(hostname: string): boolean {
  const host = stripBrackets(String(hostname ?? '').trim().toLowerCase());
  if (!host) return false;

  if (host === 'localhost' || host === '0.0.0.0' || host === '::1') return true;
  if (host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (!host.includes('.')) return true; // likely a LAN hostname

  const ipVersion = net.isIP(host);
  if (ipVersion === 4) return isPrivateIpv4(host);
  if (ipVersion === 6) return isLocalishIpv6(host);

  return false;
}

/**
 * Hosts that only resolve back to the machine the URL is read on.
 *
 * Broader than `isLoopbackHostname`: a bind address of `0.0.0.0` is not a
 * loopback address, but a *URL* carrying it is just as useless to another
 * device, and so is a `*.localhost` name.
 */
export function isLoopbackServerHost(serverUrl: string): boolean {
  try {
    const rawHost = String(new URL(serverUrl).hostname ?? '');

    // Loopback itself belongs to `@happier-dev/protocol`: it owns the bracket
    // and trailing-dot parsing that private copies of this check kept getting
    // wrong. `new URL('http://[::1]:3005').hostname` is `"[::1]"`, so comparing
    // raw strings classified an IPv6 loopback relay as remote.
    if (isProtocolLoopbackHostname(rawHost)) return true;

    // Not loopback in the networking sense, but a relay that reports 0.0.0.0 as
    // its own address is not something another device can be pointed at either.
    return normalizeHostnameForLoopbackCheck(rawHost) === '0.0.0.0';
  } catch {
    return false;
  }
}

export function isLoopbackHttpServerUrl(serverUrl: string): boolean {
  try {
    if (new URL(serverUrl).protocol !== 'http:') return false;
  } catch {
    return false;
  }
  return isLoopbackServerHost(serverUrl);
}

export function isLocalishServerUrl(serverUrl: string): boolean {
  try {
    const url = new URL(serverUrl);
    return isLocalishHostname(url.hostname);
  } catch {
    return false;
  }
}

export function isInsecureRemoteHttpServerUrl(serverUrl: string): boolean {
  try {
    const url = new URL(serverUrl);
    if (url.protocol !== 'http:') return false;
    return !isLocalishHostname(url.hostname);
  } catch {
    return false;
  }
}
