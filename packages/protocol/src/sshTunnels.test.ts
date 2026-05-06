import { describe, expect, it } from 'vitest';

async function loadModule() {
  return await import('./sshTunnels.js').catch(() => null);
}

describe('ssh tunnel protocol schemas', () => {
  it('parses ensure requests and lease snapshots for daemon tunnel control', async () => {
    const mod = await loadModule();
    expect(mod?.SshTunnelEnsureRequestSchema).toEqual(expect.any(Object));
    expect(mod?.SshTunnelLeaseSchema).toEqual(expect.any(Object));

    const parsed = mod!.SshTunnelEnsureRequestSchema.safeParse({
      remoteHostId: 'remote-1',
      ssh: { target: 'dev@example.test', port: 2202, auth: 'agent' },
      remoteHost: '127.0.0.1',
      remotePort: 8787,
      requestedLocalPort: 49152,
      purpose: 'remote-host-access',
      idleTtlMs: 60_000,
    });

    expect(parsed.success).toBe(true);

    const lease = mod!.SshTunnelLeaseSchema.safeParse({
      leaseId: 'lease-1',
      tunnelKey: 'ssh-tunnel:abc',
      httpBaseUrl: 'http://127.0.0.1:49152',
      wsBaseUrl: 'ws://127.0.0.1:49152',
      localPort: 49152,
      remoteHost: '127.0.0.1',
      remotePort: 8787,
      expiresAt: null,
      status: 'available',
    });

    expect(lease.success).toBe(true);
  });

  it('rejects invalid tunnel purpose and health states', async () => {
    const mod = await loadModule();
    expect(mod?.SshTunnelHealthSchema).toEqual(expect.any(Object));

    expect(mod!.SshTunnelEnsureRequestSchema.safeParse({
      ssh: { target: 'dev@example.test', auth: 'agent' },
      remoteHost: '127.0.0.1',
      remotePort: 8787,
      purpose: 'plugin-sdk-public',
    }).success).toBe(false);

    expect(mod!.SshTunnelHealthSchema.safeParse({
      state: 'process_alive_only',
      checkedAt: '2026-05-06T00:00:00.000Z',
    }).success).toBe(false);
  });
});
