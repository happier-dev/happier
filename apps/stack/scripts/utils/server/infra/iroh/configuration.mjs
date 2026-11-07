import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

// Dedicated to the relay: Home/UI HTTPS remains on its existing Serve listener.
export const DEFAULT_RELAY_HTTPS_PORT = 8443;
// Iroh 1.1.0 clients use the stock QAD port independently of the relay URL port.
export const RELAY_QUIC_PORT = 7842;

export function relayFunnelEnabled(state) {
  // Existing host records predate the explicit decision. Their public route or
  // retained enable refusal records the opt-in until an explicit opt-out.
  return state?.relayFunnel?.enabled ?? (state?.irohRelay?.exposure === 'public'
    || state?.irohRelay?.failure?.phase === 'funnel_enable');
}

export function resolveRelayFunnelDecision(state, env = {}) {
  const current = state?.relayFunnel ?? { enabled: relayFunnelEnabled(state), stack: null };
  const request = String(env.HAPPIER_STACK_IROH_RELAY_FUNNEL ?? '').trim();
  const stack = String(env.HAPPIER_STACK_STACK ?? '').trim() || null;
  if (request === '1' && (!current.enabled || current.stack === null)) return { enabled: true, stack };
  if (request === '0' && current.stack === stack) return { enabled: false, stack: null };
  return current;
}

export async function readRelayProfile(repoDir) {
  const directory = join(repoDir, 'deploy', 'iroh-relay');
  const [template, dockerfile] = await Promise.all([
    readFile(join(directory, 'relay.toml'), 'utf8'),
    readFile(join(directory, 'Dockerfile'), 'utf8'),
  ]);
  const version = dockerfile.match(/^ARG IROH_RELAY_VERSION=(\d+\.\d+\.\d+)$/mu)?.[1];
  if (!version) throw Object.assign(new Error('The deployment relay version is unavailable'), { code: 'relay_profile_invalid' });
  return { template, version };
}

export function resolveRelayRequest(env = {}) {
  if (env.HAPPIER_STACK_SANDBOX_DIR && !['1', 'true', 'yes', 'y'].includes(
    String(env.HAPPIER_STACK_SANDBOX_ALLOW_GLOBAL ?? '').trim().toLowerCase(),
  )) return 'sandbox';
  if (String(env.HAPPIER_STACK_IROH_RELAY ?? '1').trim() === '0'
    || String(env.HAPPIER_IROH_RELAY_POLICY ?? '').trim().toLowerCase() === 'disabled') return 'disabled';
  if (String(env.HAPPIER_IROH_RELAY_URLS ?? '').trim()) return 'external';
  return 'managed';
}

export function projectRelayEnvironment(env, relay) {
  if (relay.status === 'external') return { ...env };
  const next = { ...env };
  delete next.HAPPIER_IROH_RELAY_URLS;
  const available = relay.status === 'ready' || (relay.reason === 'funnel_unavailable' && Boolean(relay.httpsUrl));
  next.HAPPIER_IROH_RELAY_POLICY = available ? 'automatic' : 'disabled';
  if (available) next.HAPPIER_IROH_RELAY_URLS = relay.httpsUrl;
  return next;
}

export function projectRetainedRelayEnvironment(env, relay) {
  if (!relay) return { ...env };
  const request = resolveRelayRequest(env);
  if (request === 'external') return { ...env };
  return projectRelayEnvironment(env, request === 'disabled' || request === 'sandbox' ? { status: 'disabled' } : relay);
}

function replaceSetting(template, key, value) {
  const expression = new RegExp(`^${key} = .+$`, 'gmu');
  if ([...template.matchAll(expression)].length !== 1) {
    throw Object.assign(new Error('The deployment relay profile changed'), { code: 'relay_profile_invalid' });
  }
  return template.replace(expression, `${key} = ${JSON.stringify(value)}`);
}

export function renderRelayConfiguration({ template, httpPort, httpsPort, metricsPort, certDir, tailnetIp,
  receiveBytesPerSecond, receiveBurstBytes }) {
  let rendered = template;
  for (const [key, value] of Object.entries({
    http_bind_addr: `127.0.0.1:${httpPort}`,
    https_bind_addr: `127.0.0.1:${httpsPort}`,
    metrics_bind_addr: `127.0.0.1:${metricsPort}`,
    quic_bind_addr: `${tailnetIp.includes(':') ? `[${tailnetIp}]` : tailnetIp}:${RELAY_QUIC_PORT}`,
    cert_dir: certDir,
  })) rendered = replaceSetting(rendered, key, value);

  // No guessed development bandwidth quota. Optional operator values retain
  // the deployment profile's upstream token-bucket contract and validation.
  if (!String(receiveBytesPerSecond ?? '').trim() && !String(receiveBurstBytes ?? '').trim()) {
    rendered = rendered.replace(/^\[limits\.client\.rx\]\nbytes_per_second = [^\n]+\nmax_burst_bytes = [^\n]+\n/mu, '');
  } else {
    for (const [placeholder, value, minimum] of [
      ['__HAPPIER_IROH_RELAY_RX_BYTES_PER_SECOND__', receiveBytesPerSecond, 10n],
      ['__HAPPIER_IROH_RELAY_RX_MAX_BURST_BYTES__', receiveBurstBytes, 1n],
    ]) {
      const raw = String(value ?? '');
      if (!/^\d+$/u.test(raw) || BigInt(raw) < minimum || BigInt(raw) > 4294967295n) {
        throw Object.assign(new Error('Invalid deployment relay receive settings'), { code: 'relay_rate_invalid' });
      }
      rendered = rendered.replaceAll(placeholder, String(BigInt(raw)));
    }
  }
  return rendered;
}
