import { describe, expect, it, vi } from 'vitest';

import { createDaemonControlApp } from './controlServer';
import type { SshTunnelHealth, SshTunnelLease } from './ssh/tunnels';

describe('daemon control server: SSH tunnel endpoints', () => {
  it('routes ensure/list/probe/release/stop to the daemon-owned tunnel supervisor', async () => {
    const lease: SshTunnelLease = {
      leaseId: 'lease-1',
      tunnelKey: 'ssh-tunnel:abc',
      httpBaseUrl: 'http://127.0.0.1:49152',
      localPort: 49152,
      remoteHost: '127.0.0.1',
      remotePort: 8787,
      expiresAt: null,
      status: 'available',
    };
    const health: SshTunnelHealth = {
      state: 'healthy',
      checkedAt: '2026-05-06T00:00:00.000Z',
    };
    const sshTunnels = {
      ensureTunnel: vi.fn(async () => lease),
      listTunnels: vi.fn(async () => []),
      probeTunnel: vi.fn(async () => health),
      releaseTunnel: vi.fn(async () => undefined),
      stopTunnel: vi.fn(async () => undefined),
    };
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine_local',
      stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession: async () => ({ type: 'success', sessionId: 'happy-test-123' }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'test-token',
      sshTunnels,
    });

    try {
      await app.ready();
      const headers = { 'x-happier-daemon-token': 'test-token' };
      const ensure = await app.inject({
        method: 'POST',
        url: '/ssh-tunnels/ensure',
        headers,
        payload: {
          ssh: { target: 'dev@example.test', auth: 'agent' },
          remoteHost: '127.0.0.1',
          remotePort: 8787,
          purpose: 'remote-host-access',
        },
      });
      expect(ensure.statusCode).toBe(200);
      expect(ensure.json()).toEqual(expect.objectContaining({ ok: true, lease: expect.any(Object) }));

      expect((await app.inject({ method: 'POST', url: '/ssh-tunnels/list', headers })).statusCode).toBe(200);
      expect((await app.inject({ method: 'POST', url: '/ssh-tunnels/probe', headers, payload: { tunnelKey: 'ssh-tunnel:abc' } })).statusCode).toBe(200);
      expect((await app.inject({ method: 'POST', url: '/ssh-tunnels/release', headers, payload: { leaseId: 'lease-1' } })).statusCode).toBe(200);
      expect((await app.inject({ method: 'POST', url: '/ssh-tunnels/stop', headers, payload: { tunnelKey: 'ssh-tunnel:abc' } })).statusCode).toBe(200);
    } finally {
      await app.close();
    }

    expect(sshTunnels.ensureTunnel).toHaveBeenCalledTimes(1);
    expect(sshTunnels.listTunnels).toHaveBeenCalledTimes(1);
    expect(sshTunnels.probeTunnel).toHaveBeenCalledWith('ssh-tunnel:abc');
    expect(sshTunnels.releaseTunnel).toHaveBeenCalledWith('lease-1');
    expect(sshTunnels.stopTunnel).toHaveBeenCalledWith('ssh-tunnel:abc');
  });

  it('returns structured SSH tunnel setup errors instead of opaque handler failures', async () => {
    const sshTunnels = {
      ensureTunnel: vi.fn(async () => {
        const error = new Error('Host key verification failed.');
        Object.assign(error, {
          errorCode: 'ssh_tunnel_host_key_untrusted',
          health: {
            state: 'host_key_untrusted',
            checkedAt: '2026-05-06T00:00:00.000Z',
          },
        });
        throw error;
      }),
      listTunnels: vi.fn(async () => []),
      probeTunnel: vi.fn(),
      releaseTunnel: vi.fn(),
      stopTunnel: vi.fn(),
    };
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine_local',
      stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession: async () => ({ type: 'success', sessionId: 'happy-test-123' }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'test-token',
      sshTunnels,
    });

    try {
      await app.ready();
      const response = await app.inject({
        method: 'POST',
        url: '/ssh-tunnels/ensure',
        headers: { 'x-happier-daemon-token': 'test-token' },
        payload: {
          ssh: { target: 'dev@example.test', auth: 'agent' },
          remoteHost: '127.0.0.1',
          remotePort: 8787,
          purpose: 'remote-host-access',
        },
      });

      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({
        ok: false,
        errorCode: 'ssh_tunnel_host_key_untrusted',
        error: 'ssh_tunnel_host_key_untrusted',
        health: expect.objectContaining({ state: 'host_key_untrusted' }),
      });
    } finally {
      await app.close();
    }
  });
});
