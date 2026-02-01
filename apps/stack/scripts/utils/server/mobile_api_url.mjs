import { pickLanIpv4 } from '../net/lan_ip.mjs';
import { normalizeUrlNoTrailingSlash } from '../net/url.mjs';

function resolveLanIp({ env = process.env } = {}) {
  const raw = (env.HAPPIER_STACK_LAN_IP ?? '').toString().trim();
  return raw || pickLanIpv4() || '';
}

function isLocalHostName(hostname) {
  const h = String(hostname ?? '').trim().toLowerCase();
  if (!h) return false;
  if (h === 'localhost' || h === '127.0.0.1' || h === '0.0.0.0') return true;
  if (h.endsWith('.localhost')) return true;
  return false;
}

/**
 * For mobile devices, `localhost` and `*.localhost` are not reachable.
 *
 * This helper rewrites any local server URL to a LAN-reachable URL using the machine's LAN IPv4.
 * It preserves protocol, port, and path/query.
 *
 * Notes:
 * - If the URL is already non-local (e.g. Tailscale HTTPS), it is returned unchanged.
 * - If LAN IP cannot be determined, it returns the original URL unchanged.
 */
export function resolveMobileReachableServerUrl({
  env = process.env,
  serverUrl,
  serverPort,
} = {}) {
  const raw = String(serverUrl ?? '').trim();
  const fallbackPort = Number(serverPort);
  const fallback = Number.isFinite(fallbackPort) && fallbackPort > 0 ? `http://localhost:${fallbackPort}` : '';
  const base = raw || fallback;
  if (!base) return '';

  let parsed;
  try {
    parsed = new URL(base);
  } catch {
    return base;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return base;
  }

  if (!isLocalHostName(parsed.hostname)) {
    return normalizeUrlNoTrailingSlash(parsed.toString());
  }

  const lanIp = resolveLanIp({ env });
  if (!lanIp) {
    return normalizeUrlNoTrailingSlash(parsed.toString());
  }

  parsed.hostname = lanIp;
  return normalizeUrlNoTrailingSlash(parsed.toString());
}
