import { createServer } from 'node:net';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { type PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';

import { resolveRelayRuntimeDefaults } from './relayRuntime.js';
import { parseEnvText } from './selfHostServerEnv.js';

const RELAY_RUNTIME_CHANNELS: readonly PublicReleaseRingId[] = ['stable', 'preview', 'publicdev'];
const MAX_EPHEMERAL_PORT_ATTEMPTS = 10;

async function readRelayPortForChannel(params: Readonly<{
  platform: NodeJS.Platform;
  mode: 'user' | 'system';
  channel: PublicReleaseRingId;
  homeDir: string;
}>): Promise<number | null> {
  const defaults = resolveRelayRuntimeDefaults({
    platform: params.platform,
    mode: params.mode,
    channel: params.channel,
    homeDir: params.homeDir,
  });
  const envPath = join(defaults.configDir, 'server.env');
  if (!existsSync(envPath)) return null;
  const text = await readFile(envPath, 'utf8').catch(() => '');
  const port = Number.parseInt(String(parseEnvText(text).PORT ?? '').trim(), 10);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : null;
}

export async function readSiblingRelayPorts(params: Readonly<{
  platform: NodeJS.Platform;
  mode: 'user' | 'system';
  channel: PublicReleaseRingId;
  homeDir: string;
}>): Promise<ReadonlySet<number>> {
  const ports = new Set<number>();
  for (const channel of RELAY_RUNTIME_CHANNELS) {
    if (channel === params.channel) continue;
    const port = await readRelayPortForChannel({ ...params, channel });
    if (port !== null) ports.add(port);
  }
  return ports;
}

async function pickEphemeralLocalhostPort(): Promise<number | null> {
  return await new Promise((resolve) => {
    const server = createServer();
    const finish = (port: number | null) => {
      server.close(() => resolve(port));
    };
    server.once('error', () => finish(null));
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      finish(address && typeof address === 'object' ? address.port : null);
    });
  });
}

export async function resolveNonCollidingRelayPort(params: Readonly<{
  platform: NodeJS.Platform;
  mode: 'user' | 'system';
  channel: PublicReleaseRingId;
  homeDir: string;
  defaultPort: number;
  configuredPort: number | null;
  explicitConfiguredPort?: boolean;
}>): Promise<number> {
  const siblingPorts = await readSiblingRelayPorts(params);
  const preferredPort = params.configuredPort ?? params.defaultPort;
  if (!siblingPorts.has(preferredPort)) return preferredPort;

  if (params.explicitConfiguredPort === true && params.configuredPort !== null) {
    throw new Error(
      `Explicit relay PORT=${params.configuredPort} collides with another installed local relay. `
      + 'Choose a different --env PORT=<free-port> or uninstall the sibling relay first.',
    );
  }

  for (let attempt = 0; attempt < MAX_EPHEMERAL_PORT_ATTEMPTS; attempt += 1) {
    const candidate = await pickEphemeralLocalhostPort();
    if (candidate !== null && !siblingPorts.has(candidate)) return candidate;
  }

  throw new Error(
    `Unable to pick a relay port that does not collide with another installed local relay `
    + `(siblings: ${[...siblingPorts].join(', ')}). Pass --env PORT=<free-port> to choose one explicitly.`,
  );
}
