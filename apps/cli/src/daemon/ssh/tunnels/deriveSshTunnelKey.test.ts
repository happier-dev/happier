import { describe, expect, it } from 'vitest';

async function loadModule() {
  return await import('./deriveSshTunnelKey').catch(() => null);
}

const baseRequest = {
  remoteHostId: 'remote-host-1',
  ssh: {
    target: 'Dev@Example.test',
    port: 2202,
    auth: 'keyfile',
    identityFile: '/Users/alex/.ssh/id_ed25519',
    password: 'hunter2',
    sshConfigFile: '/Users/alex/.ssh/config',
    knownHostsPath: '/Users/alex/.happier/ssh/known_hosts',
  },
  remoteHost: '127.0.0.1',
  remotePort: 8787,
  requestedLocalPort: 49152,
  purpose: 'remote-host-access',
  leaseId: 'lease-secret',
} as const;

describe('deriveSshTunnelKey', () => {
  it('derives a stable key from the remote identity and forward target', async () => {
    const mod = await loadModule();
    expect(mod?.deriveSshTunnelKey).toEqual(expect.any(Function));

    const first = mod!.deriveSshTunnelKey(baseRequest);
    const second = mod!.deriveSshTunnelKey({
      ...baseRequest,
      ssh: { ...baseRequest.ssh, target: 'Dev@Example.test' },
    });

    expect(first).toBe(second);
    expect(first).toMatch(/^ssh-tunnel:[a-f0-9]{64}$/u);
  });

  it('excludes secrets, local ports, and lease ids from the key material', async () => {
    const mod = await loadModule();
    expect(mod?.deriveSshTunnelKey).toEqual(expect.any(Function));

    const baseline = mod!.deriveSshTunnelKey(baseRequest);
    const changedSecretOnly = mod!.deriveSshTunnelKey({
      ...baseRequest,
      requestedLocalPort: 50123,
      leaseId: 'lease-other',
      ssh: {
        ...baseRequest.ssh,
        password: 'correct-horse-battery-staple',
        askpassEnv: { SSH_ASKPASS: '/tmp/secret-askpass' },
      },
    });

    expect(changedSecretOnly).toBe(baseline);
    expect(baseline).not.toContain('hunter2');
    expect(baseline).not.toContain('correct-horse');
    expect(baseline).not.toContain('49152');
    expect(baseline).not.toContain('lease-secret');
  });

  it('changes when the reusable tunnel identity changes', async () => {
    const mod = await loadModule();
    expect(mod?.deriveSshTunnelKey).toEqual(expect.any(Function));

    const baseline = mod!.deriveSshTunnelKey(baseRequest);

    expect(mod!.deriveSshTunnelKey({ ...baseRequest, remoteHostId: 'remote-host-2' })).not.toBe(baseline);
    expect(mod!.deriveSshTunnelKey({ ...baseRequest, remoteHost: '10.0.0.5' })).not.toBe(baseline);
    expect(mod!.deriveSshTunnelKey({ ...baseRequest, remotePort: 9999 })).not.toBe(baseline);
    expect(mod!.deriveSshTunnelKey({ ...baseRequest, purpose: 'diagnostic' })).not.toBe(baseline);
    expect(mod!.deriveSshTunnelKey({
      ...baseRequest,
      ssh: { ...baseRequest.ssh, target: 'other@example.test' },
    })).not.toBe(baseline);
  });
});
