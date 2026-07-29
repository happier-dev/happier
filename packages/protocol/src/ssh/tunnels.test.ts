import { describe, expect, it } from 'vitest';

async function loadModule() {
  return await import('./tunnels.js').catch(() => null);
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

  it('exports daemon SSH tunnel system task kind constants for host capability wiring', async () => {
    const mod = await loadModule();

    expect(mod?.SSH_TUNNEL_SYSTEM_TASK_KINDS).toEqual({
      ensure: 'daemon.sshTunnel.ensure.v1',
      list: 'daemon.sshTunnel.list.v1',
      release: 'daemon.sshTunnel.release.v1',
      stop: 'daemon.sshTunnel.stop.v1',
    });
    expect(mod?.SSH_TUNNEL_SYSTEM_TASK_KIND_IDS).toEqual([
      'daemon.sshTunnel.ensure.v1',
      'daemon.sshTunnel.list.v1',
      'daemon.sshTunnel.release.v1',
      'daemon.sshTunnel.stop.v1',
    ]);
    expect(new Set(mod!.SSH_TUNNEL_SYSTEM_TASK_KIND_IDS).size).toBe(mod!.SSH_TUNNEL_SYSTEM_TASK_KIND_IDS.length);
  });
});
