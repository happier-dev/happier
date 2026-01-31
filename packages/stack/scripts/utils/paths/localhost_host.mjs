import { getStackName } from './paths.mjs';
import { networkInterfaces } from 'node:os';
import { sanitizeDnsLabel } from '../net/dns.mjs';

function resolveBindMode(env) {
  const raw = (env.HAPPY_STACKS_BIND_MODE ?? env.HAPPY_LOCAL_BIND_MODE ?? '').toString().trim().toLowerCase();
  return raw === 'lan' ? 'lan' : raw === 'loopback' ? 'loopback' : '';
}

function detectLanHost({ env = process.env } = {}) {
  const override = (env.HAPPY_STACKS_LAN_HOST ?? env.HAPPY_LOCAL_LAN_HOST ?? '').toString().trim();
  if (override) return override;

  const nets = networkInterfaces();
  const candidates = [];
  for (const [ifName, addrs] of Object.entries(nets)) {
    for (const a of addrs ?? []) {
      if (!a || a.family !== 'IPv4' || a.internal) continue;
      const ip = String(a.address ?? '').trim();
      if (!ip) continue;
      if (ip.startsWith('127.')) continue;
      // Drop link-local IPv4 (usually not host-reachable).
      if (ip.startsWith('169.254.')) continue;
      let score = 0;
      if (ifName === 'lima0' || ifName.startsWith('lima')) score += 50;
      if (ifName.startsWith('en') || ifName.startsWith('eth')) score += 10;
      candidates.push({ ip, ifName, score });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]?.ip ?? '';
}

export function resolveLocalhostHost({ stackMode, stackName = null, env = process.env } = {}) {
  const name = (stackName ?? '').toString().trim() || getStackName(env);
  if (!stackMode) return 'localhost';
  const bindMode = resolveBindMode(env);
  if (bindMode === 'lan') {
    const lanHost = detectLanHost({ env });
    if (lanHost) return lanHost;
  }
  if (!name || name === 'main') return 'localhost';
  return `happy-${sanitizeDnsLabel(name)}.localhost`;
}

export async function preferStackLocalhostHost({ stackName = null, env = process.env } = {}) {
  const name = (stackName ?? '').toString().trim() || getStackName(env);
  if (!name || name === 'main') return 'localhost';
  // IMPORTANT:
  // We intentionally do NOT gate on `dns.lookup()` here.
  //
  // On some systems (notably macOS), Node's DNS resolver may return ENOTFOUND for `*.localhost`
  // even though browsers treat `*.localhost` as loopback and will load it fine.
  //
  // Since this hostname is primarily used for browser-facing URLs and origin isolation, we
  // prefer the stable `happy-<stack>.localhost` form by default and allow opting out via env.
  const modeRaw = (env.HAPPY_STACKS_LOCALHOST_SUBDOMAINS ?? env.HAPPY_LOCAL_LOCALHOST_SUBDOMAINS ?? '')
    .toString()
    .trim()
    .toLowerCase();
  const disabled = modeRaw === '0' || modeRaw === 'false' || modeRaw === 'no' || modeRaw === 'off';
  if (disabled) return 'localhost';

  const preferredHost = resolveLocalhostHost({ stackMode: true, stackName: name, env });
  return preferredHost || 'localhost';
}

// Best-effort: for stacks, prefer `happy-<stack>.localhost` over `localhost` when it's reachable.
// This keeps URLs stable and stack-scoped while still failing closed to plain localhost.
export async function preferStackLocalhostUrl(url, { stackName = null, env = process.env } = {}) {
  const raw = String(url ?? '').trim();
  if (!raw) return '';
  const name = (stackName ?? '').toString().trim() || getStackName(env);
  if (!name || name === 'main') return raw;

  let u = null;
  try {
    u = new URL(raw);
  } catch {
    return raw;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return raw;

  const bindMode = resolveBindMode(env);
  const isLoopbackHost =
    u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname.toLowerCase().endsWith('.localhost');
  if (!isLoopbackHost) return raw;

  // In LAN bind mode, prefer an IP address that is reachable from other devices/hosts.
  // This is especially useful inside VMs (e.g. Lima vzNAT) where host-local `*.localhost`
  // URLs are not reachable without explicit port forwarding.
  if (bindMode === 'lan') {
    const lanHost = detectLanHost({ env });
    if (lanHost) return raw.replace(`://${u.hostname}`, `://${lanHost}`);
    return raw;
  }

  const preferredHost = await preferStackLocalhostHost({ stackName: name, env });
  if (!preferredHost || preferredHost === 'localhost') return raw;
  return raw.replace(`://${u.hostname}`, `://${preferredHost}`);
}

