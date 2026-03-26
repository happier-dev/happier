import net from 'node:net';

function stripBrackets(hostname: string): string {
  const host = String(hostname ?? '').trim();
  if (host.startsWith('[') && host.endsWith(']')) {
    return host.slice(1, -1);
  }
  return host;
}

export function isLoopbackHostname(hostname: string): boolean {
  const host = stripBrackets(String(hostname ?? '').trim().toLowerCase()).replace(/\.$/, '');
  if (!host) return false;
  if (host === 'localhost') return true;

  const ipVersion = net.isIP(host);
  if (ipVersion === 4) {
    return host.startsWith('127.');
  }
  if (ipVersion === 6) {
    return host === '::1';
  }

  return false;
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

export function isLoopbackHttpServerUrl(serverUrl: string): boolean {
  try {
    const url = new URL(serverUrl);
    if (url.protocol !== 'http:') return false;
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    return (
      host === '127.0.0.1'
      || host === 'localhost'
      || host === '0.0.0.0'
      || host === '::1'
      || host.endsWith('.localhost')
    );
  } catch {
    return false;
  }
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
