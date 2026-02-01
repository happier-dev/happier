import { setTimeout as delay } from 'node:timers/promises';
import net from 'node:net';
import { runCaptureIfCommandExists } from '../proc/commands.mjs';

export async function listListenPids(port) {
  if (!Number.isFinite(port) || port <= 0) return [];
  if (process.platform === 'win32') return [];

  let raw = '';
  try {
    // `lsof` exits non-zero if no matches; normalize to empty output.
    raw = await runCaptureIfCommandExists('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']);
    if (!raw && process.platform === 'darwin') {
      // Some non-interactive shells (launchd/GUI apps) have a PATH that omits /usr/sbin,
      // which makes `command -v lsof` fail even though lsof exists. Fall back to absolute paths.
      raw =
        (await runCaptureIfCommandExists('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'])) ||
        (await runCaptureIfCommandExists('/usr/bin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'])) ||
        '';
    }
  } catch {
    raw = '';
  }

  return Array.from(
    new Set(
      raw
        .split(/\s+/g)
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => Number(s))
        .filter((n) => Number.isInteger(n) && n > 1)
    )
  );
}

/**
 * Best-effort: kill any processes LISTENing on a TCP port.
 * Used to avoid EADDRINUSE when a previous run left a server behind.
 */
export async function killPortListeners(port, { label = 'port' } = {}) {
  if (!Number.isFinite(port) || port <= 0) {
    return [];
  }
  if (process.platform === 'win32') {
    return [];
  }

  const pids = await listListenPids(port);

  if (!pids.length) {
    return [];
  }

  // eslint-disable-next-line no-console
  console.log(`[local] ${label}: freeing tcp:${port} (killing pids: ${pids.join(', ')})`);

  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // ignore
    }
  }

  await delay(500);

  for (const pid of pids) {
    try {
      process.kill(pid, 0);
      process.kill(pid, 'SIGKILL');
    } catch {
      // not running / no permission
    }
  }

  return pids;
}

export async function isTcpPortFree(port, { host = '127.0.0.1' } = {}) {
  if (!Number.isFinite(port) || port <= 0) return false;

  // Prefer lsof-based detection to catch IPv6 listeners (e.g. TCP *:8081 (LISTEN))
  // which can make a "bind 127.0.0.1" probe incorrectly report "free" on macOS.
  const pids = await listListenPids(port);
  if (pids.length) return false;

  // Fallback: attempt to bind.
  return await new Promise((resolvePromise) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', () => resolvePromise(false));
    srv.listen({ port, host }, () => {
      srv.close(() => resolvePromise(true));
    });
  });
}

export async function pickNextFreeTcpPort(startPort, { reservedPorts = new Set(), host = '127.0.0.1', tries = 200 } = {}) {
  let port = startPort;
  for (let i = 0; i < tries; i++) {
    // eslint-disable-next-line no-await-in-loop
    if (!reservedPorts.has(port) && (await isTcpPortFree(port, { host }))) {
      return port;
    }
    port += 1;
  }
  throw new Error(`[local] unable to find a free TCP port starting at ${startPort}`);
}

