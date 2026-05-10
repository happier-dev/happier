import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

async function loadModule() {
    return await import('./registry').catch(() => null);
}

const registryEntry = {
  tunnelKey: 'ssh-tunnel:abc',
  controlPath: '/tmp/happier-ssh-control/tunnel.sock',
  localPort: 49152,
  remoteHost: '127.0.0.1',
  remotePort: 8787,
  ownerPid: 1234,
  createdAt: '2026-05-06T00:00:00.000Z',
  lastProbeAt: '2026-05-06T00:00:01.000Z',
  purpose: 'remote-host-access',
  remoteHostId: 'remote-1',
  httpBaseUrl: 'http://127.0.0.1:49152',
  wsBaseUrl: 'ws://127.0.0.1:49152',
} as const;

describe('sshTunnelRegistry', () => {
  it('persists advisory tunnel snapshots without secret material', async () => {
    const mod = await loadModule();
    expect(mod?.createSshTunnelRegistry).toEqual(expect.any(Function));

    const dir = await mkdtemp(join(tmpdir(), 'happier-ssh-registry-'));
    const registryPath = join(dir, 'registry.json');
    const registry = mod!.createSshTunnelRegistry({ registryPath });

    await registry.write([registryEntry]);
    const stored = await readFile(registryPath, 'utf8');
    expect(stored).toContain('ssh-tunnel:abc');
    expect(stored).not.toContain('hunter2');
    expect(stored).not.toContain('privateKey');

    await expect(registry.read()).resolves.toEqual([registryEntry]);
  });

  it('treats malformed persisted state as advisory and returns an empty registry', async () => {
    const mod = await loadModule();
    expect(mod?.createSshTunnelRegistry).toEqual(expect.any(Function));

    const dir = await mkdtemp(join(tmpdir(), 'happier-ssh-registry-'));
    const registryPath = join(dir, 'registry.json');
    await import('node:fs/promises').then((fs) => fs.writeFile(registryPath, '{"entries":[{"tunnelKey":""}]}', 'utf8'));

    const registry = mod!.createSshTunnelRegistry({ registryPath });
    await expect(registry.read()).resolves.toEqual([]);
  });
});
