import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import net from 'node:net';
import { getTailscaleStatus } from '../tailscale/ip.mjs';
import { pickLanIpv4 } from '../net/lan_ip.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Resolve whether Tailscale forwarding for Expo is enabled.
 *
 * Can be enabled via:
 * - --expo-tailscale flag (passed as expoTailscale option)
 * - HAPPIER_STACK_EXPO_TAILSCALE=1 env var
 */
export function resolveExpoTailscaleEnabled({ env = process.env, expoTailscale = false } = {}) {
  if (expoTailscale) return true;
  const envVal = (env.HAPPIER_STACK_EXPO_TAILSCALE ?? '').toString().trim();
  return envVal === '1' || envVal.toLowerCase() === 'true';
}

function buildExpoTailscaleProxyUrl({ tailscaleIp, metroPort } = {}) {
  const ip = String(tailscaleIp ?? '').trim();
  const port = Number(metroPort);
  if (!ip || !Number.isFinite(port) || port <= 0) return '';
  return `http://${ip}:${Math.floor(port)}`;
}

function resolveExpoTailscaleTargetHost({ expoHost } = {}) {
  if (expoHost === 'lan') {
    return pickLanIpv4() || '127.0.0.1';
  }
  return '127.0.0.1';
}

/**
 * Start a TCP forwarder process for Expo Tailscale access.
 *
 * Forwards from Tailscale IP:port to the host:port where Expo actually binds.
 *
 * @param {Object} options
 * @param {number} options.metroPort - The Metro bundler port
 * @param {Object} options.baseEnv - Base environment variables
 * @param {string} options.stackName - Stack name for logging
 * @param {Array} options.children - Array to track child processes
 * @returns {Promise<{ ok: boolean, pid?: number, tailscaleIp?: string, lanIp?: string, error?: string }>}
 */
export async function startExpoTailscaleForwarder({
  metroPort,
  baseEnv,
  stackName,
  children,
  tailscaleStatus = null,
  expoHost = 'localhost',
}) {
  const ts = tailscaleStatus ?? await getTailscaleStatus({ env: baseEnv });
  if (!ts.available || !ts.ip) {
    // Common case: Tailscale app installed but toggle is off / not connected.
    // This must never fail stack startup; just skip with a clear message.
    return { ok: false, error: ts.error || 'Tailscale is not connected' };
  }
  const tailscaleIp = ts.ip;

  // Some platforms / Tailscale variants report an IP but do not allow binding to it (EADDRNOTAVAIL).
  // If we can't bind at all, don't spawn the forwarder process because it will just error noisily.
  const canBind = await new Promise((resolve) => {
    const srv = net.createServer();
    const done = (ok, err) => {
      try {
        srv.close(() => resolve({ ok, err }));
      } catch {
        resolve({ ok, err });
      }
    };
    srv.once('error', (err) => done(false, err));
    srv.listen(0, tailscaleIp, () => done(true, null));
  });
  if (!canBind.ok) {
    const code = canBind.err && typeof canBind.err === 'object' ? canBind.err.code : '';
    const msg = canBind.err instanceof Error ? canBind.err.message : String(canBind.err ?? '');
    const hint =
      code === 'EADDRNOTAVAIL'
        ? `Tailscale IP ${tailscaleIp} is not bindable on this machine (EADDRNOTAVAIL).`
        : `Tailscale IP ${tailscaleIp} is not bindable (${code || 'error'}).`;
    return { ok: false, error: `${hint}${msg ? ` ${msg}` : ''}`.trim() };
  }

  const targetHost = resolveExpoTailscaleTargetHost({ expoHost });
  const label = `expo-ts-fwd${stackName ? `-${stackName}` : ''}`;
  const forwarderScript = join(__dirname, '..', 'net', 'tcp_forward.mjs');

  const forwarderProc = fork(forwarderScript, [
    `--listen-host=${tailscaleIp}`,
    `--listen-port=${metroPort}`,
    `--target-host=${targetHost}`,
    `--target-port=${metroPort}`,
    `--label=${label}`,
  ], {
    env: { ...baseEnv },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    detached: process.platform !== 'win32',
  });

  const outPrefix = `[${label}] `;
  forwarderProc.stdout?.on('data', (d) => process.stdout.write(outPrefix + d.toString()));
  forwarderProc.stderr?.on('data', (d) => process.stderr.write(outPrefix + d.toString()));

  const ready = await new Promise((resolve) => {
    const t = setTimeout(() => resolve({ ok: false, error: 'forwarder startup timed out' }), 2000);
    const done = (res) => {
      clearTimeout(t);
      resolve(res);
    };
    forwarderProc.once('message', (m) => {
      if (m && typeof m === 'object' && m.type === 'ready') {
        done({ ok: true });
      } else if (m && typeof m === 'object' && m.type === 'error') {
        done({ ok: false, error: m.message ? String(m.message) : 'failed to start' });
      }
    });
    forwarderProc.once('exit', (code, sig) => {
      done({ ok: false, error: `exited (code=${code}, sig=${sig})` });
    });
    forwarderProc.once('error', (e) => {
      done({ ok: false, error: e instanceof Error ? e.message : String(e) });
    });
  });

  if (!ready.ok) {
    try {
      forwarderProc.kill('SIGKILL');
    } catch {
      // ignore
    }
    return { ok: false, error: ready.error || 'failed to start forwarder' };
  }

  children.push(forwarderProc);

  // eslint-disable-next-line no-console
  console.log(`[local] expo: Tailscale forwarder started (${tailscaleIp}:${metroPort} -> ${targetHost}:${metroPort})`);

  return {
    ok: true,
    pid: forwarderProc.pid,
    tailscaleIp,
    lanIp: targetHost,
    proc: forwarderProc,
    proxyUrl: buildExpoTailscaleProxyUrl({ tailscaleIp, metroPort }),
  };
}
