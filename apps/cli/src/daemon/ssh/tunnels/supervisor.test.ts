import {
  clearTimeout as clearNodeTimeout,
  setTimeout as setNodeTimeout,
} from 'node:timers';

import { describe, expect, it, vi } from 'vitest';

import type {
  SshTunnelEnsureRequest,
  SshTunnelRegistry,
  SshTunnelRegistryEntry,
} from './types';

async function loadModule() {
  return await import('./supervisor').catch(() => null);
}

function createRequest(overrides: Partial<SshTunnelEnsureRequest> = {}): SshTunnelEnsureRequest {
  return {
    remoteHostId: 'remote-1',
    ssh: { target: 'dev@example.test', port: 2202, auth: 'agent' },
    remoteHost: '127.0.0.1',
    remotePort: 8787,
    purpose: 'remote-host-access',
    idleTtlMs: 50,
    ...overrides,
  };
}

function createRegistry(entries: readonly SshTunnelRegistryEntry[] = []) {
  let current = [...entries];
  return {
    read: vi.fn(async (): Promise<readonly SshTunnelRegistryEntry[]> => current),
    write: vi.fn(async (next: readonly SshTunnelRegistryEntry[]) => {
      current = [...next];
    }),
  } satisfies SshTunnelRegistry;
}

describe('createSshTunnelSupervisor', () => {
  it('deduplicates concurrent ensure calls by deterministic tunnel key', async () => {
    const mod = await loadModule();
    expect(mod?.createSshTunnelSupervisor).toEqual(expect.any(Function));

    const openForward = vi.fn(async () => ({
      localPort: 49152,
      remoteHost: '127.0.0.1',
      remotePort: 8787,
      controlPath: '/tmp/control.sock',
      close: vi.fn(),
    }));
    let releaseProbe: (() => void) | undefined;
    let leaseIdCounter = 0;
    const supervisor = mod!.createSshTunnelSupervisor({
      registry: createRegistry(),
      openForward,
      allocateLocalPort: async () => 49152,
      isLocalPortAvailable: async () => true,
      probeUrl: async () => await new Promise((resolve) => {
        releaseProbe = () => resolve({ state: 'healthy', checkedAt: '2026-05-06T00:00:00.000Z' });
      }),
      nowMs: () => 0,
      nextLeaseId: () => {
        leaseIdCounter += 1;
        return `lease-${leaseIdCounter}`;
      },
    });

    const first = supervisor.ensureTunnel(createRequest());
    const second = supervisor.ensureTunnel(createRequest());
    for (let attempt = 0; attempt < 5 && !releaseProbe; attempt += 1) {
      await Promise.resolve();
    }
    const release = releaseProbe;
    expect(release).toEqual(expect.any(Function));
    if (!release) throw new Error('expected probe release callback');
    release();
    const [firstLease, secondLease] = await Promise.all([first, second]);

    expect(openForward).toHaveBeenCalledTimes(1);
    expect(firstLease.tunnelKey).toBe(secondLease.tunnelKey);
    expect(firstLease.leaseId).toBe('lease-1');
    expect(secondLease.leaseId).toBe('lease-2');
    expect(firstLease.httpBaseUrl).toBe('http://127.0.0.1:49152');
  });

  it('reuses an existing tunnel only after forwarded URL health succeeds', async () => {
    const mod = await loadModule();
    expect(mod?.createSshTunnelSupervisor).toEqual(expect.any(Function));

    const close = vi.fn();
    const openForward = vi.fn(async () => ({
      localPort: 49152,
      remoteHost: '127.0.0.1',
      remotePort: 8787,
      controlPath: '/tmp/control.sock',
      close,
    }));
    const probeUrl = vi
      .fn()
      .mockResolvedValueOnce({ state: 'healthy', checkedAt: '2026-05-06T00:00:00.000Z' })
      .mockResolvedValueOnce({ state: 'healthy', checkedAt: '2026-05-06T00:00:01.000Z' });
    const supervisor = mod!.createSshTunnelSupervisor({
      registry: createRegistry(),
      openForward,
      allocateLocalPort: async () => 49152,
      isLocalPortAvailable: async () => true,
      probeUrl,
      nowMs: () => 0,
      nextLeaseId: () => 'lease-1',
    });

    const first = await supervisor.ensureTunnel(createRequest());
    const second = await supervisor.ensureTunnel(createRequest());

    expect(openForward).toHaveBeenCalledTimes(1);
    expect(probeUrl).toHaveBeenLastCalledWith(first.httpBaseUrl);
    expect(second.tunnelKey).toBe(first.tunnelKey);
  });

  it('reuses an existing tunnel when forwarded URL reaches an authenticated server', async () => {
    const mod = await loadModule();
    expect(mod?.createSshTunnelSupervisor).toEqual(expect.any(Function));

    const close = vi.fn();
    const openForward = vi.fn(async () => ({
      localPort: 49152,
      remoteHost: '127.0.0.1',
      remotePort: 8787,
      controlPath: '/tmp/control.sock',
      close,
    }));
    const probeUrl = vi
      .fn()
      .mockResolvedValueOnce({ state: 'healthy', checkedAt: '2026-05-06T00:00:00.000Z' })
      .mockResolvedValueOnce({ state: 'auth_required', checkedAt: '2026-05-06T00:00:01.000Z' })
      .mockResolvedValueOnce({ state: 'healthy', checkedAt: '2026-05-06T00:00:02.000Z' });
    const supervisor = mod!.createSshTunnelSupervisor({
      registry: createRegistry(),
      openForward,
      allocateLocalPort: async () => 49152,
      isLocalPortAvailable: async () => true,
      probeUrl,
      nowMs: () => 0,
      nextLeaseId: () => 'lease-1',
    });

    const first = await supervisor.ensureTunnel(createRequest());
    const second = await supervisor.ensureTunnel(createRequest());

    expect(openForward).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();
    expect(second.tunnelKey).toBe(first.tunnelKey);
    expect(second.status).toBe('needs-auth');
  });

  it('recreates a stale active tunnel when forwarded URL health fails', async () => {
    const mod = await loadModule();
    expect(mod?.createSshTunnelSupervisor).toEqual(expect.any(Function));

    const close = vi.fn();
    const openForward = vi
      .fn()
      .mockResolvedValueOnce({
        localPort: 49152,
        remoteHost: '127.0.0.1',
        remotePort: 8787,
        controlPath: '/tmp/first.sock',
        close,
      })
      .mockResolvedValueOnce({
        localPort: 49153,
        remoteHost: '127.0.0.1',
        remotePort: 8787,
        controlPath: '/tmp/second.sock',
        close: vi.fn(),
      });
    const supervisor = mod!.createSshTunnelSupervisor({
      registry: createRegistry(),
      openForward,
      allocateLocalPort: vi.fn(async () => 49153),
      isLocalPortAvailable: async (port: number) => port !== 49152,
      probeUrl: vi
        .fn()
        .mockResolvedValueOnce({ state: 'healthy', checkedAt: '2026-05-06T00:00:00.000Z' })
        .mockResolvedValueOnce({ state: 'local_port_unreachable', checkedAt: '2026-05-06T00:00:01.000Z' })
        .mockResolvedValueOnce({ state: 'healthy', checkedAt: '2026-05-06T00:00:02.000Z' }),
      nowMs: () => 0,
      nextLeaseId: () => 'lease-1',
    });

    await supervisor.ensureTunnel(createRequest({ requestedLocalPort: 49152 }));
    const recreated = await supervisor.ensureTunnel(createRequest({ requestedLocalPort: 49152 }));

    expect(close).toHaveBeenCalledTimes(1);
    expect(openForward).toHaveBeenCalledTimes(2);
    expect(recreated.localPort).toBe(49153);
  });

  it('rejects a newly opened tunnel when forwarded URL health is unusable', async () => {
    const mod = await loadModule();
    expect(mod?.createSshTunnelSupervisor).toEqual(expect.any(Function));

    const close = vi.fn();
    const supervisor = mod!.createSshTunnelSupervisor({
      registry: createRegistry(),
      openForward: vi.fn(async () => ({
        localPort: 49152,
        remoteHost: '127.0.0.1',
        remotePort: 8787,
        controlPath: '/tmp/control.sock',
        close,
      })),
      allocateLocalPort: async () => 49152,
      isLocalPortAvailable: async () => true,
      probeUrl: async () => ({
        state: 'remote_runtime_unavailable',
        checkedAt: '2026-05-06T00:00:00.000Z',
      }),
      nowMs: () => 0,
    });

    await expect(supervisor.ensureTunnel(createRequest())).rejects.toMatchObject({
      errorCode: 'ssh_tunnel_unavailable',
      health: expect.objectContaining({ state: 'remote_runtime_unavailable' }),
    });
    expect(close).toHaveBeenCalledTimes(1);
    expect(await supervisor.listTunnels()).toEqual([]);
  });

  it('cancels idle shutdown when a lease is reacquired and stops after the new final lease is released', async () => {
    const mod = await loadModule();
    expect(mod?.createSshTunnelSupervisor).toEqual(expect.any(Function));

    const close = vi.fn();
    const scheduled: Array<() => void> = [];
    const timers: Array<ReturnType<typeof setNodeTimeout>> = [];
    const clearTimer = vi.fn((timer: number | ReturnType<typeof setNodeTimeout>) => {
      clearNodeTimeout(timer);
    });
    let leaseIdCounter = 0;
    const supervisor = mod!.createSshTunnelSupervisor({
      registry: createRegistry(),
      openForward: vi.fn(async () => ({
        localPort: 49152,
        remoteHost: '127.0.0.1',
        remotePort: 8787,
        controlPath: '/tmp/control.sock',
        close,
      })),
      allocateLocalPort: async () => 49152,
      isLocalPortAvailable: async () => true,
      probeUrl: async () => ({ state: 'healthy', checkedAt: '2026-05-06T00:00:00.000Z' }),
      nowMs: () => 0,
      nextLeaseId: () => {
        leaseIdCounter += 1;
        return `lease-${leaseIdCounter}`;
      },
      setTimeout: (fn: () => void) => {
        scheduled.push(fn);
        const timer = setNodeTimeout(() => {}, 60_000);
        timer.unref?.();
        timers.push(timer);
        return timer;
      },
      clearTimeout: clearTimer,
    });

    const firstLease = await supervisor.ensureTunnel(createRequest({ idleTtlMs: 25 }));
    await supervisor.releaseTunnel(firstLease.leaseId);
    expect(close).not.toHaveBeenCalled();

    const secondLease = await supervisor.ensureTunnel(createRequest({ idleTtlMs: 25 }));
    expect(clearTimer).toHaveBeenCalledWith(timers[0]);
    expect(close).not.toHaveBeenCalled();

    await supervisor.releaseTunnel(secondLease.leaseId);
    expect(scheduled[1]).toEqual(expect.any(Function));
    scheduled[1]?.();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('adopts healthy advisory registry entries after daemon restart even when the old daemon pid is gone', async () => {
    const mod = await loadModule();
    expect(mod?.createSshTunnelSupervisor).toEqual(expect.any(Function));

    const healthyEntry: SshTunnelRegistryEntry = {
      tunnelKey: 'ssh-tunnel:healthy',
      controlPath: '/tmp/healthy.sock',
      localPort: 49152,
      remoteHost: '127.0.0.1',
      remotePort: 8787,
      ownerPid: 123,
      createdAt: '2026-05-06T00:00:00.000Z',
      lastProbeAt: '2026-05-06T00:00:00.000Z',
      purpose: 'remote-host-access',
      remoteHostId: 'remote-1',
      httpBaseUrl: 'http://127.0.0.1:49152',
    };
    const staleEntry: SshTunnelRegistryEntry = {
      ...healthyEntry,
      tunnelKey: 'ssh-tunnel:stale',
      controlPath: '/tmp/stale.sock',
      httpBaseUrl: 'http://127.0.0.1:49153',
      localPort: 49153,
    };
    const registry = createRegistry([healthyEntry, staleEntry]);
    const supervisor = mod!.createSshTunnelSupervisor({
      registry,
      openForward: vi.fn(),
      allocateLocalPort: async () => 49154,
      isLocalPortAvailable: async () => true,
      probeUrl: async (url: string) => ({
        state: url.includes('49152') ? 'healthy' : 'local_port_unreachable',
        checkedAt: '2026-05-06T00:00:00.000Z',
      }),
      isProcessAlive: () => false,
      controlPathExists: async (path: string) => path.includes('healthy'),
      nowMs: () => 0,
    });

    await supervisor.adoptPersistedTunnels();

    expect(await supervisor.listTunnels()).toEqual([
      expect.objectContaining({ tunnelKey: 'ssh-tunnel:healthy', status: 'available' }),
    ]);
    expect(registry.write).toHaveBeenLastCalledWith([
      expect.objectContaining({ tunnelKey: 'ssh-tunnel:healthy' }),
    ]);
  });

  it('does not adopt advisory registry entries still owned by a live daemon process', async () => {
    const mod = await loadModule();
    expect(mod?.createSshTunnelSupervisor).toEqual(expect.any(Function));

    const liveOwnedEntry: SshTunnelRegistryEntry = {
      tunnelKey: 'ssh-tunnel:live-owned',
      controlPath: '/tmp/live-owned.sock',
      localPort: 49152,
      remoteHost: '127.0.0.1',
      remotePort: 8787,
      ownerPid: 123,
      createdAt: '2026-05-06T00:00:00.000Z',
      lastProbeAt: '2026-05-06T00:00:00.000Z',
      purpose: 'remote-host-access',
      remoteHostId: 'remote-1',
      httpBaseUrl: 'http://127.0.0.1:49152',
    };
    const registry = createRegistry([liveOwnedEntry]);
    const supervisor = mod!.createSshTunnelSupervisor({
      registry,
      openForward: vi.fn(),
      allocateLocalPort: async () => 49154,
      isLocalPortAvailable: async () => true,
      probeUrl: async () => ({
        state: 'healthy',
        checkedAt: '2026-05-06T00:00:00.000Z',
      }),
      isProcessAlive: (pid: number) => pid === liveOwnedEntry.ownerPid,
      controlPathExists: async () => true,
      ownerPid: 456,
      nowMs: () => 0,
    });

    await supervisor.adoptPersistedTunnels();

    expect(await supervisor.listTunnels()).toEqual([]);
    expect(registry.write).toHaveBeenLastCalledWith([liveOwnedEntry]);
  });

  it('closes adopted restart entries through their persisted control path on stop', async () => {
    const mod = await loadModule();
    expect(mod?.createSshTunnelSupervisor).toEqual(expect.any(Function));

    const entry: SshTunnelRegistryEntry = {
      tunnelKey: 'ssh-tunnel:adopted',
      controlPath: '/tmp/adopted.sock',
      localPort: 49152,
      remoteHost: '127.0.0.1',
      remotePort: 8787,
      ownerPid: 123,
      createdAt: '2026-05-06T00:00:00.000Z',
      lastProbeAt: '2026-05-06T00:00:00.000Z',
      purpose: 'remote-host-access',
      remoteHostId: 'remote-1',
      httpBaseUrl: 'http://127.0.0.1:49152',
    };
    const registry = createRegistry([entry]);
    const closeForward = vi.fn(async () => undefined);
    const deps = {
      registry,
      openForward: vi.fn(),
      allocateLocalPort: async () => 49153,
      isLocalPortAvailable: async () => true,
      probeUrl: async () => ({ state: 'healthy' as const, checkedAt: '2026-05-06T00:00:01.000Z' }),
      isProcessAlive: () => false,
      controlPathExists: async () => true,
      closeForward,
      nowMs: () => 0,
    };
    const supervisor = mod!.createSshTunnelSupervisor(deps);

    await supervisor.adoptPersistedTunnels();
    await supervisor.stopTunnel('ssh-tunnel:adopted');

    expect(closeForward).toHaveBeenCalledWith(expect.objectContaining({
      controlPath: '/tmp/adopted.sock',
    }));
    expect(registry.write).toHaveBeenLastCalledWith([]);
  });

  it('maps OpenSSH setup failures into SSH tunnel health taxonomy', async () => {
    const mod = await loadModule();
    expect(mod?.createSshTunnelSupervisor).toEqual(expect.any(Function));

    const supervisor = mod!.createSshTunnelSupervisor({
      registry: createRegistry(),
      openForward: vi.fn(async () => {
        throw new Error('SSH tunnel failed: Host key verification failed.');
      }),
      allocateLocalPort: async () => 49152,
      isLocalPortAvailable: async () => true,
      probeUrl: async () => ({ state: 'healthy', checkedAt: '2026-05-06T00:00:00.000Z' }),
      nowMs: () => 0,
    });

    await expect(supervisor.ensureTunnel(createRequest())).rejects.toMatchObject({
      message: 'SSH tunnel failed: Host key verification failed.',
      errorCode: 'ssh_tunnel_host_key_untrusted',
      health: expect.objectContaining({ state: 'host_key_untrusted' }),
    });
  });
});
