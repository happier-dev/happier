import { SYSTEM_TASK_PROTOCOL_VERSION } from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import { createSystemTasksRunner } from '../systemTasksRunner';

async function waitForResult(
  runner: ReturnType<typeof createSystemTasksRunner>,
  taskId: string,
): Promise<Readonly<{ result: { ok: boolean; data?: unknown } | null }>> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const polled = await runner.poll({ taskId, cursor: 0 });
    if (polled.result) {
      return { result: polled.result as { ok: boolean; data?: unknown } };
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Timed out waiting for system task result: ${taskId}`);
}

describe('daemon SSH tunnel system tasks', () => {
  it('routes ensure/list/release/stop through the local daemon control client surface', async () => {
    const loaded = await import('./daemonSshTunnelSystemTasks').catch(() => null);
    expect(loaded?.createDaemonSshTunnelEnsureTaskKind).toEqual(expect.any(Function));
    expect(loaded?.createDaemonSshTunnelListTaskKind).toEqual(expect.any(Function));
    expect(loaded?.createDaemonSshTunnelReleaseTaskKind).toEqual(expect.any(Function));
    expect(loaded?.createDaemonSshTunnelStopTaskKind).toEqual(expect.any(Function));

    const ensureDaemonSshTunnel = vi.fn(async () => ({
      ok: true as const,
      lease: {
        leaseId: 'lease-1',
        tunnelKey: 'ssh-tunnel:host-a',
        httpBaseUrl: 'http://127.0.0.1:49152',
        wsBaseUrl: 'ws://127.0.0.1:49152',
        localPort: 49152,
        remoteHost: '127.0.0.1',
        remotePort: 3005,
        expiresAt: null,
        status: 'available' as const,
      },
    }));
    const listDaemonSshTunnels = vi.fn(async () => ({
      ok: true as const,
      tunnels: [{
        tunnelKey: 'ssh-tunnel:host-a',
        httpBaseUrl: 'http://127.0.0.1:49152',
        wsBaseUrl: 'ws://127.0.0.1:49152',
        localPort: 49152,
        remoteHost: '127.0.0.1',
        remotePort: 3005,
        purpose: 'remote-host-access' as const,
        remoteHostId: 'host-a',
        status: 'available' as const,
        leaseCount: 1,
        createdAt: '2026-05-06T10:00:00.000Z',
        lastProbeAt: '2026-05-06T10:01:00.000Z',
      }],
    }));
    const releaseDaemonSshTunnel = vi.fn(async () => ({ ok: true as const }));
    const stopDaemonSshTunnel = vi.fn(async () => ({ ok: true as const }));

    const runner = createSystemTasksRunner({
      kinds: {
        'daemon.sshTunnel.ensure.v1': loaded!.createDaemonSshTunnelEnsureTaskKind({ ensureDaemonSshTunnel }),
        'daemon.sshTunnel.list.v1': loaded!.createDaemonSshTunnelListTaskKind({ listDaemonSshTunnels }),
        'daemon.sshTunnel.release.v1': loaded!.createDaemonSshTunnelReleaseTaskKind({ releaseDaemonSshTunnel }),
        'daemon.sshTunnel.stop.v1': loaded!.createDaemonSshTunnelStopTaskKind({ stopDaemonSshTunnel }),
      },
    });

    await runner.start({
      taskId: 'ensure',
      kind: 'daemon.sshTunnel.ensure.v1',
      params: {
        remoteHostId: 'host-a',
        serverId: 'server-1',
        ssh: { target: 'dev@10.0.0.1', port: 2222, auth: 'agent' },
        remoteHost: '127.0.0.1',
        remotePort: 3005,
        purpose: 'remote-host-access',
      },
    });
    await runner.start({
      taskId: 'list',
      kind: 'daemon.sshTunnel.list.v1',
      params: { protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION },
    });
    await runner.start({
      taskId: 'release',
      kind: 'daemon.sshTunnel.release.v1',
      params: { leaseId: 'lease-1' },
    });
    await runner.start({
      taskId: 'stop',
      kind: 'daemon.sshTunnel.stop.v1',
      params: { tunnelKey: 'ssh-tunnel:host-a' },
    });

    await expect(waitForResult(runner, 'ensure')).resolves.toEqual({
      result: expect.objectContaining({
        ok: true,
        data: expect.objectContaining({
          ok: true,
          lease: expect.objectContaining({ tunnelKey: 'ssh-tunnel:host-a' }),
        }),
      }),
    });
    await expect(waitForResult(runner, 'list')).resolves.toEqual({
      result: expect.objectContaining({
        ok: true,
        data: expect.objectContaining({
          ok: true,
          tunnels: [expect.objectContaining({ tunnelKey: 'ssh-tunnel:host-a' })],
        }),
      }),
    });
    await expect(waitForResult(runner, 'release')).resolves.toEqual({
      result: expect.objectContaining({
        ok: true,
        data: { ok: true },
      }),
    });
    await expect(waitForResult(runner, 'stop')).resolves.toEqual({
      result: expect.objectContaining({
        ok: true,
        data: { ok: true },
      }),
    });
    expect(ensureDaemonSshTunnel).toHaveBeenCalledWith(expect.objectContaining({
      remoteHostId: 'host-a',
      purpose: 'remote-host-access',
    }));
    expect(listDaemonSshTunnels).toHaveBeenCalledWith();
    expect(releaseDaemonSshTunnel).toHaveBeenCalledWith('lease-1');
    expect(stopDaemonSshTunnel).toHaveBeenCalledWith('ssh-tunnel:host-a');
  });
});
