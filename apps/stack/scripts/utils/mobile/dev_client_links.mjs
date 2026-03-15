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
    getEnvValueAny(env, ['HAPPIER_STACK_MOBILE_HOST']) ||
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

function normalizeExpoSlug(raw) {
  const v = String(raw ?? '').trim().toLowerCase();
  if (!v) return '';
  // Expo slug should be safe for use in a URL scheme segment (`exp+<slug>`).
  return v.replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
}

export function resolveMobileQrPayload({ env = process.env, port }) {
  const metroUrl = resolveMetroUrlForMobile({ env, port });
  const scheme = resolveMobileScheme(env);
  const slug = normalizeExpoSlug(env.EXPO_APP_SLUG);
  const expoDevClientScheme = slug ? `exp+${slug}` : '';

  // Prefer the configured app scheme for dev-client links so we can isolate dev/prod apps without
  // needing to change Expo slug (which must match the EAS project id configuration).
  const deepLink = resolveDevClientDeepLink({ scheme, metroUrl });
  const payload = deepLink || metroUrl;
  return { scheme, metroUrl, deepLink, payload, expoDevClientScheme, slug };
}
