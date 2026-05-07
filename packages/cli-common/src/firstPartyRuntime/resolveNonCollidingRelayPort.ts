import { createServer } from 'node:net';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { type PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';

import { parseEnvText } from './selfHostServerEnv.js';
import { resolveRelayRuntimeDefaults } from './relayRuntime.js';

const ALL_CHANNELS: readonly PublicReleaseRingId[] = ['stable', 'preview', 'publicdev'];
const MAX_EPHEMERAL_ATTEMPTS = 10;

/**
 * Read the configured PORT from a sibling channel's server.env, if installed.
 * Returns null when the file doesn't exist or doesn't contain a valid port.
 */
async function readRelayPortForChannel(params: Readonly<{
  platform: NodeJS.Platform;
  mode: 'user' | 'system';
  channel: PublicReleaseRingId;
  homeDir: string;
}>): Promise<number | null> {
  const defaults = resolveRelayRuntimeDefaults({
    platform: params.platform as 'linux' | 'darwin' | 'win32',
    mode: params.mode,
    channel: params.channel,
    homeDir: params.homeDir,
  });
  const envPath = join(defaults.configDir, 'server.env');
  if (!existsSync(envPath)) return null;
  try {
    const text = await readFile(envPath, 'utf8');
    const parsed = parseEnvText(text);
    const port = Number.parseInt(String(parsed.PORT ?? ''), 10);
    return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : null;
  } catch {
    return null;
  }
}

/**
 * Enumerate the ports baked into every OTHER channel's installed relay
 * server.env on this machine. Used to avoid picking a port that would
 * collide with a sibling relay's configured port — regardless of whether
 * that sibling is currently running.
 *
 * Port collisions across channels produce confusing daemon-ownership state
 * because a server profile is keyed by host+port, so two relays sharing a
 * port end up sharing a profile id and accumulating each other's daemon
 * state over time.
 */
export async function readSiblingRelayPorts(params: Readonly<{
  platform: NodeJS.Platform;
  mode: 'user' | 'system';
  channel: PublicReleaseRingId;
  homeDir: string;
}>): Promise<ReadonlySet<number>> {
  const ports = new Set<number>();
  for (const candidate of ALL_CHANNELS) {
    if (candidate === params.channel) continue;
    const port = await readRelayPortForChannel({ ...params, channel: candidate });
    if (port !== null) ports.add(port);
  }
  return ports;
}

/**
 * Ask the kernel for a free ephemeral port by binding to port 0 and reading
 * what it gave us, then releasing the socket. The port is "reserved" only
 * for the brief window between release and our caller writing the env file —
 * it's still a soft reservation, but a near-term collision with another
 * process is highly unlikely on localhost.
 */
async function pickEphemeralPort(): Promise<number | null> {
  return await new Promise((resolve) => {
    const server = createServer();
    const finish = (value: number | null) => {
      try { server.close(); } catch { /* ignore */ }
      resolve(value);
    };
    server.on('error', () => finish(null));
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object' && typeof addr.port === 'number') {
        finish(addr.port);
      } else {
        finish(null);
      }
    });
  });
}

/**
 * Resolve a relay port that does not collide with any other channel's
 * installed relay on this machine.
 *
 * Policy:
 *  - If `configuredPort` (from existing server.env or an override) is set
 *    and doesn't collide, honor it.
 *  - If `configuredPort` collides, fall back to an ephemeral port that
 *    also doesn't collide.
 *  - If `configuredPort` isn't set, prefer the `defaultPort` when free.
 *  - If nothing works within `MAX_EPHEMERAL_ATTEMPTS` rebinds, throw.
 */
export async function resolveNonCollidingRelayPort(params: Readonly<{
  platform: NodeJS.Platform;
  mode: 'user' | 'system';
  channel: PublicReleaseRingId;
  homeDir: string;
  defaultPort: number;
  configuredPort: number | null;
}>): Promise<number> {
  const siblings = await readSiblingRelayPorts(params);
  const preferred = params.configuredPort ?? params.defaultPort;

  if (!siblings.has(preferred)) {
    return preferred;
  }

  for (let attempt = 0; attempt < MAX_EPHEMERAL_ATTEMPTS; attempt += 1) {
    const candidate = await pickEphemeralPort();
    if (candidate === null) continue;
    if (!siblings.has(candidate)) return candidate;
  }

  throw new Error(
    `Unable to pick a relay port that doesn't collide with another installed relay on this machine `
    + `(siblings: ${[...siblings].join(', ')}). Pass --env PORT=<free-port> to choose one explicitly.`,
  );
}
