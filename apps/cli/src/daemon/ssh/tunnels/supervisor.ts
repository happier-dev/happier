import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  clearTimeout as clearNodeTimeout,
  setTimeout as setNodeTimeout,
} from 'node:timers';

import {
  closeOpenSshLocalPortForward,
  openSshLocalPortForward,
  type OpenSshAuth,
} from '@happier-dev/cli-common/ssh';

import { findAvailableLoopbackPort, isLoopbackPortAvailable } from '@/cloud/loopbackPort';
import { configuration } from '@/configuration';

import { deriveSshTunnelKey } from './deriveKey';
import { createSshTunnelHealthError, createSshTunnelSetupError } from './errorMapping';
import { probeSshTunnelUrl } from './probe';
import { createSshTunnelRegistry } from './registry';
import type {
  SshTunnelCloseForward,
  SshTunnelEnsureRequest,
  SshTunnelForwardHandle,
  SshTunnelHealth,
  SshTunnelLease,
  SshTunnelOpenForward,
  SshTunnelRegistry,
  SshTunnelRegistryEntry,
  SshTunnelSnapshot,
  SshTunnelStatus,
  SshTunnelSupervisor,
} from './types';

const DEFAULT_IDLE_TTL_MS = 5 * 60_000;

type TimerHandle = number | ReturnType<typeof setNodeTimeout>;

type ActiveTunnel = {
  tunnelKey: string;
  handle: SshTunnelForwardHandle | null;
  localPort: number;
  remoteHost: string;
  remotePort: number;
  purpose: SshTunnelEnsureRequest['purpose'];
  remoteHostId?: string;
  httpBaseUrl: string;
  wsBaseUrl?: string;
  controlPath: string;
  ownerPid: number;
  sshTarget: string;
  sshPort?: number;
  sshConfigFile?: string;
  knownHostsPath?: string;
  createdAt: string;
  lastProbeAt: string | null;
  leases: Map<string, { expiresAt: string | null; idleTtlMs: number }>;
  idleTimer: TimerHandle | null;
  status: SshTunnelStatus;
};

export type SshTunnelSupervisorDeps = Readonly<{
  registry?: SshTunnelRegistry;
  openForward?: SshTunnelOpenForward;
  allocateLocalPort?: () => Promise<number>;
  isLocalPortAvailable?: (port: number) => Promise<boolean>;
  probeUrl?: (httpBaseUrl: string) => Promise<SshTunnelHealth>;
  nowMs?: () => number;
  nextLeaseId?: () => string;
  setTimeout?: (fn: () => void, ms: number) => TimerHandle;
  clearTimeout?: (timer: TimerHandle) => void;
  isProcessAlive?: (pid: number) => boolean;
  controlPathExists?: (path: string) => Promise<boolean>;
  closeForward?: SshTunnelCloseForward;
  controlDir?: string;
  ownerPid?: number;
}>;

function nowIso(deps: SshTunnelSupervisorDeps): string {
  return new Date((deps.nowMs ?? Date.now)()).toISOString();
}

function toHttpBaseUrl(localPort: number): string {
  return `http://127.0.0.1:${localPort}`;
}

function toWsBaseUrl(localPort: number): string {
  return `ws://127.0.0.1:${localPort}`;
}

function resolveOpenSshAuth(request: SshTunnelEnsureRequest): OpenSshAuth {
  if (request.ssh.auth === 'keyfile') {
    const identityFile = String(request.ssh.identityFile ?? '').trim();
    if (!identityFile) {
      throw new Error('identityFile is required for keyfile SSH tunnel auth');
    }
    return { mode: 'keyFile', privateKeyPath: identityFile };
  }
  if (request.ssh.auth === 'password') {
    const password = String(request.ssh.password ?? '').trim();
    if (!password) {
      throw new Error('password is required for password SSH tunnel auth');
    }
    return { mode: 'password', password };
  }
  return { mode: 'agent' };
}

function entryFromActive(tunnel: ActiveTunnel): SshTunnelRegistryEntry {
  return {
    tunnelKey: tunnel.tunnelKey,
    controlPath: tunnel.controlPath,
    localPort: tunnel.localPort,
    remoteHost: tunnel.remoteHost,
    remotePort: tunnel.remotePort,
    ownerPid: tunnel.ownerPid,
    createdAt: tunnel.createdAt,
    lastProbeAt: tunnel.lastProbeAt ?? tunnel.createdAt,
    purpose: tunnel.purpose,
    ...(tunnel.remoteHostId ? { remoteHostId: tunnel.remoteHostId } : {}),
    httpBaseUrl: tunnel.httpBaseUrl,
    ...(tunnel.wsBaseUrl ? { wsBaseUrl: tunnel.wsBaseUrl } : {}),
    sshTarget: tunnel.sshTarget,
    ...(tunnel.sshPort ? { sshPort: tunnel.sshPort } : {}),
    ...(tunnel.sshConfigFile ? { sshConfigFile: tunnel.sshConfigFile } : {}),
    ...(tunnel.knownHostsPath ? { knownHostsPath: tunnel.knownHostsPath } : {}),
  };
}

function snapshotFromActive(tunnel: ActiveTunnel): SshTunnelSnapshot {
  return {
    tunnelKey: tunnel.tunnelKey,
    httpBaseUrl: tunnel.httpBaseUrl,
    ...(tunnel.wsBaseUrl ? { wsBaseUrl: tunnel.wsBaseUrl } : {}),
    localPort: tunnel.localPort,
    remoteHost: tunnel.remoteHost,
    remotePort: tunnel.remotePort,
    purpose: tunnel.purpose,
    ...(tunnel.remoteHostId ? { remoteHostId: tunnel.remoteHostId } : {}),
    status: tunnel.status,
    leaseCount: tunnel.leases.size,
    createdAt: tunnel.createdAt,
    lastProbeAt: tunnel.lastProbeAt,
  };
}

function leaseFromActive(tunnel: ActiveTunnel, leaseId: string): SshTunnelLease {
  const lease = tunnel.leases.get(leaseId);
  return {
    leaseId,
    tunnelKey: tunnel.tunnelKey,
    httpBaseUrl: tunnel.httpBaseUrl,
    ...(tunnel.wsBaseUrl ? { wsBaseUrl: tunnel.wsBaseUrl } : {}),
    localPort: tunnel.localPort,
    remoteHost: tunnel.remoteHost,
    remotePort: tunnel.remotePort,
    expiresAt: lease?.expiresAt ?? null,
    status: tunnel.status,
  };
}

function healthToStatus(health: SshTunnelHealth): SshTunnelStatus {
  if (health.state === 'healthy') return 'available';
  if (health.state === 'starting') return 'starting';
  if (health.state === 'auth_required' || health.state === 'host_key_untrusted') return 'needs-auth';
  if (health.state === 'unknown') return 'unknown';
  return 'unavailable';
}

function isReusableTunnelHealth(health: SshTunnelHealth): boolean {
  return health.state === 'healthy' || health.state === 'auth_required';
}

function createActiveFromRegistryEntry(entry: SshTunnelRegistryEntry): ActiveTunnel {
  return {
    tunnelKey: entry.tunnelKey,
    handle: null,
    localPort: entry.localPort,
    remoteHost: entry.remoteHost,
    remotePort: entry.remotePort,
    purpose: entry.purpose,
    ...(entry.remoteHostId ? { remoteHostId: entry.remoteHostId } : {}),
    httpBaseUrl: entry.httpBaseUrl,
    ...(entry.wsBaseUrl ? { wsBaseUrl: entry.wsBaseUrl } : {}),
    controlPath: entry.controlPath,
    ownerPid: entry.ownerPid,
    sshTarget: entry.sshTarget ?? '127.0.0.1',
    ...(entry.sshPort ? { sshPort: entry.sshPort } : {}),
    ...(entry.sshConfigFile ? { sshConfigFile: entry.sshConfigFile } : {}),
    ...(entry.knownHostsPath ? { knownHostsPath: entry.knownHostsPath } : {}),
    createdAt: entry.createdAt,
    lastProbeAt: entry.lastProbeAt,
    leases: new Map(),
    idleTimer: null,
    status: 'available',
  };
}

async function closeTunnel(tunnel: ActiveTunnel, deps: SshTunnelSupervisorDeps): Promise<void> {
  if (tunnel.handle) {
    await tunnel.handle.close();
    return;
  }
  const closeForward = deps.closeForward ?? closeOpenSshLocalPortForward;
  await closeForward({
    target: tunnel.sshTarget,
    ...(tunnel.sshPort ? { port: tunnel.sshPort } : {}),
    ...(tunnel.sshConfigFile ? { sshConfigFile: tunnel.sshConfigFile } : {}),
    ...(tunnel.knownHostsPath ? { knownHostsPath: tunnel.knownHostsPath, knownHostsMode: 'app' as const } : {}),
    auth: { mode: 'agent' },
    controlPath: tunnel.controlPath,
  });
}

async function allocateLocalPortForRequest(
  request: SshTunnelEnsureRequest,
  deps: SshTunnelSupervisorDeps,
): Promise<number> {
  const requested = request.requestedLocalPort;
  if (typeof requested === 'number' && await (deps.isLocalPortAvailable ?? isLoopbackPortAvailable)(requested)) {
    return requested;
  }
  return await (deps.allocateLocalPort ?? findAvailableLoopbackPort)();
}

export function createSshTunnelSupervisor(deps: SshTunnelSupervisorDeps = {}): SshTunnelSupervisor {
  const registry = deps.registry ?? createSshTunnelRegistry({
    registryPath: join(configuration.happyHomeDir, 'daemon', 'ssh-tunnels', 'registry.json'),
  });
  const active = new Map<string, ActiveTunnel>();
  const pending = new Map<string, Promise<ActiveTunnel>>();
  const leaseToTunnelKey = new Map<string, string>();
  const schedule = deps.setTimeout ?? setNodeTimeout;
  const unschedule = deps.clearTimeout ?? clearNodeTimeout;

  const persist = async (): Promise<void> => {
    await registry.write(Array.from(active.values()).map(entryFromActive));
  };

  const stopTunnel = async (tunnelKey: string): Promise<void> => {
    const tunnel = active.get(tunnelKey);
    if (!tunnel) return;
    if (tunnel.idleTimer) {
      unschedule(tunnel.idleTimer);
      tunnel.idleTimer = null;
    }
    active.delete(tunnelKey);
    for (const leaseId of tunnel.leases.keys()) {
      leaseToTunnelKey.delete(leaseId);
    }
    await closeTunnel(tunnel, deps);
    await persist();
  };

  const addLease = async (
    tunnel: ActiveTunnel,
    idleTtlMs: number = DEFAULT_IDLE_TTL_MS,
  ): Promise<SshTunnelLease> => {
    const leaseId = deps.nextLeaseId?.() ?? randomUUID();
    tunnel.leases.set(leaseId, { expiresAt: null, idleTtlMs });
    leaseToTunnelKey.set(leaseId, tunnel.tunnelKey);
    if (tunnel.idleTimer) {
      unschedule(tunnel.idleTimer);
      tunnel.idleTimer = null;
    }
    await persist();
    return leaseFromActive(tunnel, leaseId);
  };

  const ensureTunnelCore = async (request: SshTunnelEnsureRequest, tunnelKey: string): Promise<ActiveTunnel> => {
    const existing = active.get(tunnelKey);
    if (existing) {
      const health = await (deps.probeUrl ?? probeSshTunnelUrl)(existing.httpBaseUrl);
      existing.lastProbeAt = health.checkedAt;
      existing.status = healthToStatus(health);
      if (isReusableTunnelHealth(health)) {
        return existing;
      }
      await stopTunnel(tunnelKey);
    }

    const localPort = await allocateLocalPortForRequest(request, deps);
    const openForward = deps.openForward ?? openSshLocalPortForward;
    const knownHostsMode = request.ssh.knownHostsPath ? 'app' : 'system';
    let handle: SshTunnelForwardHandle;
    try {
      handle = await openForward({
        sshBin: 'ssh',
        target: request.ssh.target,
        port: request.ssh.port,
        sshConfigFile: request.ssh.sshConfigFile,
        knownHostsPath: request.ssh.knownHostsPath,
        knownHostsMode,
        auth: resolveOpenSshAuth(request),
        localPort,
        remoteHost: request.remoteHost,
        remotePort: request.remotePort,
        ...(deps.controlDir ? { controlDir: deps.controlDir } : {}),
        connectTimeoutSec: 10,
        serverAliveIntervalSec: 15,
        serverAliveCountMax: 2,
      });
    } catch (error) {
      throw createSshTunnelSetupError(error, nowIso(deps));
    }
    const health = await (deps.probeUrl ?? probeSshTunnelUrl)(toHttpBaseUrl(handle.localPort));
    if (!isReusableTunnelHealth(health)) {
      await handle.close();
      throw createSshTunnelHealthError(health);
    }
    const createdAt = nowIso(deps);
    const tunnel: ActiveTunnel = {
      tunnelKey,
      handle,
      localPort: handle.localPort,
      remoteHost: handle.remoteHost,
      remotePort: handle.remotePort,
      purpose: request.purpose,
      ...(request.remoteHostId ? { remoteHostId: request.remoteHostId } : {}),
      httpBaseUrl: toHttpBaseUrl(handle.localPort),
      wsBaseUrl: toWsBaseUrl(handle.localPort),
      controlPath: handle.controlPath,
      ownerPid: deps.ownerPid ?? process.pid,
      sshTarget: request.ssh.target,
      ...(request.ssh.port ? { sshPort: request.ssh.port } : {}),
      ...(request.ssh.sshConfigFile ? { sshConfigFile: request.ssh.sshConfigFile } : {}),
      ...(request.ssh.knownHostsPath ? { knownHostsPath: request.ssh.knownHostsPath } : {}),
      createdAt,
      lastProbeAt: health.checkedAt,
      leases: new Map(),
      idleTimer: null,
      status: healthToStatus(health),
    };
    active.set(tunnelKey, tunnel);
    await persist();
    return tunnel;
  };

  return {
    async ensureTunnel(request): Promise<SshTunnelLease> {
      const tunnelKey = deriveSshTunnelKey(request);
      const pendingTunnel = pending.get(tunnelKey);
      if (pendingTunnel) {
        return await addLease(await pendingTunnel, request.idleTtlMs ?? DEFAULT_IDLE_TTL_MS);
      }
      const tunnelPromise = ensureTunnelCore(request, tunnelKey);
      pending.set(tunnelKey, tunnelPromise);
      try {
        return await addLease(await tunnelPromise, request.idleTtlMs ?? DEFAULT_IDLE_TTL_MS);
      } finally {
        pending.delete(tunnelKey);
      }
    },
    async listTunnels(): Promise<readonly SshTunnelSnapshot[]> {
      return Array.from(active.values()).map(snapshotFromActive);
    },
    async probeTunnel(tunnelKey: string): Promise<SshTunnelHealth> {
      const tunnel = active.get(tunnelKey);
      if (!tunnel) {
        return {
          state: 'ssh_process_unavailable',
          checkedAt: nowIso(deps),
        };
      }
      const health = await (deps.probeUrl ?? probeSshTunnelUrl)(tunnel.httpBaseUrl);
      tunnel.lastProbeAt = health.checkedAt;
      tunnel.status = healthToStatus(health);
      await persist();
      return health;
    },
    async releaseTunnel(leaseId: string): Promise<void> {
      const tunnelKey = leaseToTunnelKey.get(leaseId);
      if (!tunnelKey) return;
      const tunnel = active.get(tunnelKey);
      leaseToTunnelKey.delete(leaseId);
      if (!tunnel) return;
      const lease = tunnel.leases.get(leaseId);
      tunnel.leases.delete(leaseId);
      if (tunnel.leases.size === 0) {
        const idleTtlMs = lease?.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
        tunnel.idleTimer = schedule(() => {
          void stopTunnel(tunnelKey);
        }, idleTtlMs);
      }
      await persist();
    },
    stopTunnel,
    async stopAllTunnels(): Promise<void> {
      const keys = Array.from(active.keys());
      for (const key of keys) {
        await stopTunnel(key);
      }
    },
    async adoptPersistedTunnels(): Promise<void> {
      const entries = await registry.read();
      const retained: SshTunnelRegistryEntry[] = [];
      const adopted: SshTunnelRegistryEntry[] = [];
      for (const entry of entries) {
        const ownerPid = deps.ownerPid ?? process.pid;
        if (entry.ownerPid !== ownerPid && deps.isProcessAlive?.(entry.ownerPid)) {
          retained.push(entry);
          continue;
        }
        const hasControlPath = deps.controlPathExists
          ? await deps.controlPathExists(entry.controlPath)
          : existsSync(entry.controlPath);
        if (!hasControlPath) continue;
        const health = await (deps.probeUrl ?? probeSshTunnelUrl)(entry.httpBaseUrl);
        if (!isReusableTunnelHealth(health)) continue;
        const tunnel = createActiveFromRegistryEntry({ ...entry, lastProbeAt: health.checkedAt });
        active.set(entry.tunnelKey, tunnel);
        adopted.push(entryFromActive(tunnel));
      }
      await registry.write([...retained, ...adopted]);
    },
  };
}
