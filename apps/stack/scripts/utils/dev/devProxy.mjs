import http from 'node:http';

import { isTcpPortFree, pickNextFreeTcpPort } from '../net/ports.mjs';
import { startTcpForwarder, stopTcpForwarder } from '../net/tcp_forward.mjs';

const DISABLED_ENV_VALUES = new Set(['0', 'false', 'no', 'off']);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

function normalizeProxyHost(raw) {
  const host = String(raw ?? '').trim();
  if (!host) return '';
  return host === '*' ? '0.0.0.0' : host;
}

export function shouldEnableStackDevProxy({ startServer = true, flags = new Set(), env = process.env } = {}) {
  if (!startServer) return false;
  if (flags?.has?.('--no-proxy')) return false;
  const raw = String(env?.HAPPIER_STACK_DEV_PROXY ?? '').trim().toLowerCase();
  return !(raw && DISABLED_ENV_VALUES.has(raw));
}

export function resolveDevProxyStableHost({ env = process.env } = {}) {
  const explicit = normalizeProxyHost(env?.HAPPIER_STACK_DEV_PROXY_HOST);
  if (explicit) return explicit;

  const bindMode = String(env?.HAPPIER_STACK_BIND_MODE ?? '').trim().toLowerCase();
  const host = normalizeProxyHost(env?.HOST).toLowerCase();
  if (bindMode === 'loopback' || LOOPBACK_HOSTS.has(host)) {
    return '127.0.0.1';
  }

  return '0.0.0.0';
}

export async function prepareDevProxyStartup({
  enabled,
  stablePort,
  host,
  stableHost = host ?? '127.0.0.1',
  targetHost = host ?? '127.0.0.1',
  label = 'server-proxy',
  logger = console,
  pickNextFreeTcpPortImpl = pickNextFreeTcpPort,
  startDevProxyImpl = startDevProxy,
  isTcpPortFreeImpl = isTcpPortFree,
} = {}) {
  const publicPort = Number(stablePort);
  if (!enabled) {
    return { mode: 'direct', stablePort: publicPort, backendPort: publicPort, proxyController: null, fallbackReason: null };
  }

  const backendPort = await pickNextFreeTcpPortImpl(publicPort + 1, {
    host: targetHost,
    reservedPorts: new Set([publicPort]),
  });

  try {
    const proxyController = await startDevProxyImpl({
      stableHost,
      stablePort: publicPort,
      targetHost,
      targetPort: backendPort,
      label,
    });
    return { mode: 'proxy', stablePort: publicPort, backendPort, proxyController, fallbackReason: null };
  } catch (error) {
    const fallbackReason = error instanceof Error ? error.message : String(error);
    const directSafe = await isTcpPortFreeImpl(publicPort, { host: stableHost }).catch(() => false);
    if (!directSafe) throw error;
    logger.warn?.(
      `[local] server proxy unavailable on port ${publicPort}; falling back to direct server bind (${fallbackReason}).`,
    );
    return { mode: 'directFallback', stablePort: publicPort, backendPort: publicPort, proxyController: null, fallbackReason };
  }
}

function normalizeRetryAfterSeconds(retryAfterMs) {
  const ms = Math.max(0, Number(retryAfterMs) || 0);
  return String(Math.max(1, Math.ceil(ms / 1000)));
}

export async function startDevProxyMaintenanceUpstream({
  host = '127.0.0.1',
  port = 0,
  retryAfterMs = 1000,
  message = 'Server reload in progress',
} = {}) {
  let currentRetryAfterMs = retryAfterMs;
  let currentMessage = message;

  const server = http.createServer((_req, res) => {
    const body = `${currentMessage}\n`;
    res.writeHead(503, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Retry-After': normalizeRetryAfterSeconds(currentRetryAfterMs),
      'X-Happier-Retry-Reason': 'server_restarting',
      'Cache-Control': 'no-store',
      Connection: 'close',
    });
    res.end(body);
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host, port }, resolve);
  });

  const addr = server.address();
  const address = typeof addr === 'object' && addr ? addr.address : host;
  const resolvedPort = typeof addr === 'object' && addr ? addr.port : port;
  let stopped = false;

  return {
    server,
    address,
    port: resolvedPort,
    update({ retryAfterMs: nextRetryAfterMs = currentRetryAfterMs, message: nextMessage = currentMessage } = {}) {
      currentRetryAfterMs = nextRetryAfterMs;
      currentMessage = nextMessage;
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

export async function startDevProxy({
  stableHost = '127.0.0.1',
  stablePort,
  targetHost = '127.0.0.1',
  targetPort,
  label = 'server-proxy',
} = {}) {
  const forwarder = await startTcpForwarder({
    listenHost: stableHost,
    listenPort: Number(stablePort),
    targetHost,
    targetPort: Number(targetPort),
    label,
  });
  let maintenance = null;
  let stopped = false;

  return {
    pid: process.pid,
    host: forwarder.address,
    port: forwarder.port,
    get targetPort() {
      return forwarder.server.getUpstream?.().targetPort ?? null;
    },
    flipUpstream({ targetHost: nextTargetHost = targetHost, targetPort: nextTargetPort } = {}) {
      return forwarder.server.setUpstream({
        targetHost: nextTargetHost,
        targetPort: Number(nextTargetPort),
      });
    },
    async enterMaintenance({ retryAfterMs = 2000, message = 'Server reload in progress' } = {}) {
      if (!maintenance) {
        maintenance = await startDevProxyMaintenanceUpstream({
          host: '127.0.0.1',
          port: 0,
          retryAfterMs,
          message,
        });
      } else {
        maintenance.update({ retryAfterMs, message });
      }
      forwarder.server.setUpstream({ targetHost: maintenance.address, targetPort: maintenance.port });
      return { targetHost: maintenance.address, targetPort: maintenance.port, port: maintenance.port };
    },
    async drainConnections({ graceMs = 0, targetHost: drainTargetHost, targetPort: drainTargetPort } = {}) {
      if (typeof forwarder.server.closeConnectionsAfterGrace === 'function') {
        const target = normalizeDrainTarget({
          targetHost: drainTargetHost,
          targetPort: drainTargetPort,
        });
        await forwarder.server.closeConnectionsAfterGrace({ graceMs, target });
        return;
      }
      if (typeof forwarder.server.closeIdleOrAllConnectionsAfterGrace === 'function' && !drainTargetPort) {
        await forwarder.server.closeIdleOrAllConnectionsAfterGrace({ graceMs });
      }
    },
    async drainOldConnections({ graceMs = 0 } = {}) {
      await this.drainConnections({ graceMs });
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      await stopTcpForwarder(forwarder.server, label);
      if (maintenance) {
        await maintenance.stop();
        maintenance = null;
      }
    },
  };
}

function normalizeDrainTarget({ targetHost, targetPort }) {
  const port = Number(targetPort);
  if (!Number.isInteger(port) || port <= 0) return null;
  return {
    targetHost: String(targetHost || '127.0.0.1'),
    targetPort: port,
  };
}
