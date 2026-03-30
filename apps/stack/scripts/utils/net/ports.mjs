import { setTimeout as delay } from 'node:timers/promises';
import net from 'node:net';
import { runCaptureIfCommandExists } from '../proc/commands.mjs';

export async function isTcpPortListening(port, { host = '127.0.0.1', timeoutMs = 250 } = {}) {
  if (!Number.isFinite(port) || port <= 0) return false;

  return await new Promise((resolvePromise) => {
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      resolvePromise(result);
    };

    let socket;
    try {
      socket = net.createConnection({ port, host }, () => {
        socket.destroy();
        done(true);
      });
    } catch {
      done(false);
      return;
    }

    socket.unref();
    socket.on('error', () => done(false));
    socket.setTimeout(timeoutMs, () => {
      socket.destroy();
      // Fail-closed: treat timeouts as "in use / unknown" rather than "free".
      done(true);
    });
  });
}

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

export async function isTcpPortFree(port, { host = '127.0.0.1', timeoutMs = 250 } = {}) {
  if (!Number.isFinite(port) || port <= 0) return false;

  // Prefer lsof-based detection to catch IPv6 listeners (e.g. TCP *:8081 (LISTEN))
  // which can make a "bind 127.0.0.1" probe incorrectly report "free" on macOS.
  const pids = await listListenPids(port);
  if (pids.length) return false;

  // Fallback: attempt to bind.
  return await new Promise((resolvePromise) => {
    let settled = false;
    let timeoutId;

    const done = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      resolvePromise(result);
    };

    let srv;
    try {
      srv = net.createServer((socket) => {
        // Tests use this as a port reservation primitive too; if something external connects
        // (e.g. a browser tab), immediately close the socket so server.close() cannot hang
        // waiting for long-lived connections to drain.
        try {
          socket.destroy();
        } catch {
          // ignore
        }
      });
    } catch {
      done(false);
      return;
    }

    srv.unref();

    timeoutId = setTimeout(() => {
      try {
        srv.close();
      } catch {
        // ignore
      }
      // Fail-closed: treat timeouts as "in use / unknown" rather than "free".
      done(false);
    }, timeoutMs);

    srv.on('error', () => done(false));
    try {
      srv.listen({ port, host }, () => {
        try {
          srv.close(() => done(true));
        } catch {
          done(false);
        }
      });
    } catch {
      done(false);
    }
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
