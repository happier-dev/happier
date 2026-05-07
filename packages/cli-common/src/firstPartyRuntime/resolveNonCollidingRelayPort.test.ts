import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveNonCollidingRelayPort, readSiblingRelayPorts } from './resolveNonCollidingRelayPort.js';

function setupFakeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'happier-relay-port-'));
  return home;
}

function writeSiblingServerEnv(home: string, channelSuffix: string, port: number): void {
  // Mirror resolveRelayRuntimeDefaults layout: <home>/.happier/self-host[-<channel>]/config/server.env
  const suffix = channelSuffix ? `-${channelSuffix}` : '';
  const configDir = join(home, '.happier', `self-host${suffix}`, 'config');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'server.env'), `PORT=${port}\n`, 'utf8');
}

describe('resolveNonCollidingRelayPort', () => {
  it('returns the default port when no other channels are installed', async () => {
    const home = setupFakeHome();
    const port = await resolveNonCollidingRelayPort({
      platform: 'darwin',
      mode: 'user',
      channel: 'publicdev',
      homeDir: home,
      defaultPort: 3005,
      configuredPort: null,
    });
    expect(port).toBe(3005);
  });

  it('honors the configured port when it does not collide with siblings', async () => {
    const home = setupFakeHome();
    writeSiblingServerEnv(home, 'preview', 4321);
    const port = await resolveNonCollidingRelayPort({
      platform: 'darwin',
      mode: 'user',
      channel: 'publicdev',
      homeDir: home,
      defaultPort: 3005,
      configuredPort: 9999,
    });
    expect(port).toBe(9999);
  });

  it('picks an ephemeral port when the default collides with a sibling channel', async () => {
    const home = setupFakeHome();
    // stable is installed on 3005 — installing dev should avoid it
    writeSiblingServerEnv(home, '', 3005);
    const port = await resolveNonCollidingRelayPort({
      platform: 'darwin',
      mode: 'user',
      channel: 'publicdev',
      homeDir: home,
      defaultPort: 3005,
      configuredPort: null,
    });
    expect(port).not.toBe(3005);
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThanOrEqual(65535);
  });

  it('ignores the current channel when scanning for collisions', async () => {
    const home = setupFakeHome();
    // dev is already installed on 3005 — reinstalling dev should honor 3005
    writeSiblingServerEnv(home, 'dev', 3005);
    const ports = await readSiblingRelayPorts({
      platform: 'darwin',
      mode: 'user',
      channel: 'publicdev',
      homeDir: home,
    });
    expect([...ports]).toEqual([]);
  });

  it('reads PORT from every other channel\'s server.env', async () => {
    const home = setupFakeHome();
    writeSiblingServerEnv(home, '', 3005);
    writeSiblingServerEnv(home, 'preview', 4327);
    const ports = await readSiblingRelayPorts({
      platform: 'darwin',
      mode: 'user',
      channel: 'publicdev',
      homeDir: home,
    });
    expect(new Set(ports)).toEqual(new Set([3005, 4327]));
  });
});
