import { getEnvValueAny } from '../env/values.mjs';
import { pickLanIpv4 } from '../net/lan_ip.mjs';
import { resolveMobileExpoConfig } from './config.mjs';

function normalizeHostMode(raw) {
  const v = String(raw ?? '').trim().toLowerCase();
  if (v === 'localhost' || v === 'local') return 'localhost';
  if (v === 'lan' || v === 'ip') return 'lan';
  if (v === 'tunnel') return 'tunnel';
  return v || 'lan';
}

export function resolveMobileHostMode(env = process.env) {
  // Prefer explicit host vars (so TUI/setup-pr match the same knobs Expo uses).
  const raw =
    getEnvValueAny(env, ['HAPPY_STACKS_MOBILE_HOST', 'HAPPY_LOCAL_MOBILE_HOST']) ||
    resolveMobileExpoConfig({ env }).host ||
    'lan';
  return normalizeHostMode(raw);
}

export function resolveMobileScheme(env = process.env) {
  return String(resolveMobileExpoConfig({ env }).scheme || '').trim();
}

export function resolveMetroUrlForMobile({ env = process.env, port }) {
  const p = Number(port);
  if (!Number.isFinite(p) || p <= 0) return '';

  const mode = resolveMobileHostMode(env);
  if (mode === 'localhost') {
    return `http://localhost:${p}`;
  }
  if (mode === 'lan') {
    const ip = pickLanIpv4();
    return `http://${ip || 'localhost'}:${p}`;
  }
  // Tunnel URLs are controlled by Expo; we can't reliably derive them locally.
  // Fall back to localhost so the URL is at least correct for the host machine.
  return `http://localhost:${p}`;
}

export function resolveDevClientDeepLink({ scheme, metroUrl }) {
  const s = String(scheme ?? '').trim();
  const url = String(metroUrl ?? '').trim();
  if (!url) return '';
  if (!s) return url;
  return `${s}://expo-development-client/?url=${encodeURIComponent(url)}`;
}

export function resolveMobileQrPayload({ env = process.env, port }) {
  const metroUrl = resolveMetroUrlForMobile({ env, port });
  const scheme = resolveMobileScheme(env);
  const deepLink = resolveDevClientDeepLink({ scheme, metroUrl });
  // Match Expo CLI / @expo/cli UrlCreator: QR encodes the dev-client deep link.
  // Note: iOS Camera will still offer to open custom schemes when the app is installed.
  const payload = deepLink || metroUrl;
  return { scheme, metroUrl, deepLink, payload };
}

