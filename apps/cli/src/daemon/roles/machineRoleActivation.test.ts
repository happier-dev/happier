import { describe, expect, it, vi } from 'vitest';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';

import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { registerMachineRpcHandlers } from '@/api/machine/rpcHandlers';
import type { MemoryWorkerHandle } from '@/daemon/memory/memoryWorker';
import { buildUnavailableMemoryEmbeddingsDiagnostics } from '@/daemon/memory/resolveOperationalMemoryEmbeddingsSettings';
import { DEFAULT_MEMORY_SETTINGS } from '@/settings/memorySettings';

import { createMachineRoleActivationRuntime, type MachineRoleContexts } from './machineRoleActivation';
import { MACHINE_ROLE_RPC_NAMESPACES } from './machineRoleRpcNamespaces';
import { createMachineRolesRuntime } from './machineRolesRuntime';

// Process boundary: the memory worker front owns a child indexer process; its handle is a fixture here.
function memoryWorkerFixture(): MemoryWorkerHandle {
  return {
    stop: vi.fn(async () => {}), waitForReady: async () => {}, reloadSettings: vi.fn(async () => {}),
    clearIndex: vi.fn(async () => {}), ensureUpToDate: vi.fn(async () => {}), removeSessions: vi.fn(async () => {}),
    reconcileRetainedSessionAccess: vi.fn(async () => {}), listIndexedSessionIds: vi.fn(() => []),
    applySessionArchivedState: vi.fn(async () => {}), getSettings: vi.fn(() => DEFAULT_MEMORY_SETTINGS),
    getEmbeddingsDiagnostics: vi.fn(() => buildUnavailableMemoryEmbeddingsDiagnostics(DEFAULT_MEMORY_SETTINGS.embeddings)),
    getWorkerStatus: vi.fn(() => ({ state: 'idle' as const, lastTickAtMs: null, lastInventoryAtMs: null, currentSessionId: null, currentPhase: null })),
    getTier1DbPath: vi.fn(() => null), getDeepDbPath: vi.fn(() => null),
  };
}

// Server boundary: the Machine's encrypted metadata as the daemon has opened it.
function machineMetadata(initial: Record<string, unknown>) {
  let metadata = initial;
  let metadataVersion = 1;
  return {
    port: {
      read: async () => ({ status: 'ready' as const, metadata, metadataVersion }),
      compareAndSwap: async () => ({ status: 'conflict' as const, metadata, metadataVersion }),
    },
    edit(next: Record<string, unknown>) { metadata = next; metadataVersion++; },
  };
}

const subscribeNothing = () => () => {};
type ConnectionRoleContext = MachineRoleContexts['memory'] & MachineRoleContexts['voice'];
/** The Machine-connection roles (memory, voice) share one context; devices has its own owner. */
function contextWith(overrides: Partial<ConnectionRoleContext>): Pick<MachineRoleContexts, 'memory' | 'voice'> {
  const context: ConnectionRoleContext = {
    machineId: 'machine', accountId: null,
    startMemoryWorkerForMachine: vi.fn(async () => null),
    startVoiceInferenceWorkerForMachine: vi.fn(async () => null),
    memorySessionEvents: { onSessionDeletedChange: subscribeNothing, onSessionAccessRevoked: subscribeNothing,
      onSessionAccessReset: subscribeNothing, onSessionArchivedStateChange: subscribeNothing },
    ...overrides,
  };
  return { memory: context, voice: context };
}

describe('Machine role activation', () => {
  it('registers a role\'s RPC family only while the role is active and refuses it typed once inactive', async () => {
    const rpcHandlerManager = new RpcHandlerManager({ scopePrefix: 'machine', localMachineId: 'machine', encryptionMode: 'plain' });
    const metadata = machineMetadata({ host: 'laptop' });
    const roles = createMachineRolesRuntime({ port: metadata.port });
    await roles.reload();
    const worker = memoryWorkerFixture();
    const startMemoryWorkerForMachine = vi.fn(async () => worker);
    const runtime = createMachineRoleActivationRuntime({
      rpcHandlerManager, roles,
      // Voice inference is feature-gated off here: the role is active but runs nothing.
      contexts: contextWith({ startMemoryWorkerForMachine }),
    });
    const registered = () => Object.values(RPC_METHODS).filter(method => rpcHandlerManager.hasHandler(method)).sort();
    try {
      // Missing setting = every core role (today): memory runs and serves its whole family.
      await runtime.start();
      expect(startMemoryWorkerForMachine).toHaveBeenCalledOnce();
      expect(registered().length).toBeGreaterThan(0);
      expect(registered().filter(method => !MACHINE_ROLE_RPC_NAMESPACES.memory.some(prefix => method.startsWith(prefix)))).toEqual([]);
      expect(await rpcHandlerManager.invokeLocal(RPC_METHODS.DAEMON_VOICE_INFERENCE_STATUS, {}))
        .toMatchObject({ errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND });

      // The owner turns memory and voice off: handlers unregister, the worker stops, and the
      // one dispatcher refusal names the inactive role.
      metadata.edit({ host: 'laptop', rolesV1: { active: ['sessions'] } });
      await roles.reload();
      await vi.waitFor(() => expect(worker.stop).toHaveBeenCalledOnce());
      expect(registered()).toEqual([]);
      expect(await rpcHandlerManager.invokeLocal(RPC_METHODS.DAEMON_MEMORY_STATUS, {}))
        .toEqual({ error: expect.any(String), errorCode: RPC_ERROR_CODES.MACHINE_ROLE_INACTIVE, roleId: 'memory' });
      expect(await rpcHandlerManager.invokeLocal(RPC_METHODS.DAEMON_VOICE_DIAGNOSTICS_STATUS, {}))
        .toMatchObject({ errorCode: RPC_ERROR_CODES.MACHINE_ROLE_INACTIVE, roleId: 'voice' });
      // Devices activates with the daemon, not this connection, but the refusal is the role set's.
      expect(await rpcHandlerManager.invokeLocal(RPC_METHODS.DAEMON_SIMULATOR_PREVIEW_SNAPSHOT, {}))
        .toMatchObject({ errorCode: RPC_ERROR_CODES.MACHINE_ROLE_INACTIVE, roleId: 'devices' });
      // Core methods outside every role namespace keep the ordinary unknown-method answer.
      expect(await rpcHandlerManager.invokeLocal('daemon.notARealMethod', {}))
        .toMatchObject({ errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND });

      // Turning memory back on loads the entry again and re-registers the family.
      metadata.edit({ host: 'laptop', rolesV1: { active: ['sessions', 'memory'] } });
      await roles.reload();
      await vi.waitFor(() => expect(startMemoryWorkerForMachine).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(rpcHandlerManager.hasHandler(RPC_METHODS.DAEMON_MEMORY_STATUS)).toBe(true));
    } finally {
      await runtime.stop();
      roles.stop();
    }
    expect(registered()).toEqual([]);
    expect(worker.stop).toHaveBeenCalledTimes(2);
  });

  it('reads the role set before activating at boot, so an excluded role never starts its worker', async () => {
    const rpcHandlerManager = new RpcHandlerManager({ scopePrefix: 'machine', localMachineId: 'machine', encryptionMode: 'plain' });
    // The role-set owner has not read yet (its own port is unavailable during the first machine attempt).
    const roles = createMachineRolesRuntime({ port: { read: async () => ({ status: 'unavailable' as const }),
      compareAndSwap: async () => ({ status: 'unavailable' as const }) } as never });
    const startMemoryWorkerForMachine = vi.fn(async () => memoryWorkerFixture());
    const runtime = createMachineRoleActivationRuntime({ rpcHandlerManager, roles, contexts: contextWith({ startMemoryWorkerForMachine }) });
    try {
      await runtime.start({ status: 'ready', metadata: { host: 'sandbox', rolesV1: { active: ['sessions'] } }, metadataVersion: 3 });
      expect(startMemoryWorkerForMachine).not.toHaveBeenCalled();
      expect(await rpcHandlerManager.invokeLocal(RPC_METHODS.DAEMON_MEMORY_STATUS, {}))
        .toMatchObject({ errorCode: RPC_ERROR_CODES.MACHINE_ROLE_INACTIVE, roleId: 'memory' });
    } finally {
      await runtime.stop();
      roles.stop();
    }
  });

  it('follows live role toggles for the external-Session feed into memory and for peer-tunnel voice media', async () => {
    const rpcHandlerManager = new RpcHandlerManager({ scopePrefix: 'machine', localMachineId: 'machine', encryptionMode: 'plain' });
    const metadata = machineMetadata({ host: 'laptop' });
    const roles = createMachineRolesRuntime({ port: metadata.port });
    await roles.reload();
    const detach = vi.fn();
    const worker = { ...memoryWorkerFixture(), attachExternalObservation: vi.fn(() => detach) };
    const runtime = createMachineRoleActivationRuntime({ rpcHandlerManager, roles,
      contexts: contextWith({ startMemoryWorkerForMachine: vi.fn(async () => worker) }) });
    // Bound once by the Session owner at registration; must keep feeding whichever memory worker runs.
    const observation = {} as Parameters<NonNullable<MemoryWorkerHandle['attachExternalObservation']>>[0];
    try {
      await runtime.start();
      const release = runtime.memoryExternalObservation.attachExternalObservation!(observation);
      expect(worker.attachExternalObservation).toHaveBeenCalledWith(observation);

      metadata.edit({ host: 'laptop', rolesV1: { active: ['sessions'] } });
      await roles.reload();
      await vi.waitFor(() => expect(detach).toHaveBeenCalledOnce());
      // Voice media arriving on an already-open peer tunnel is refused typed while voice is off.
      expect(await runtime.voiceBinaryConsumers.append({ streamId: 's', generation: 0, seq: 0, payloadBytes: new Uint8Array(1) } as never))
        .toMatchObject({ ok: false, errorCode: RPC_ERROR_CODES.MACHINE_ROLE_INACTIVE });

      metadata.edit({ host: 'laptop', rolesV1: { active: ['sessions', 'memory'] } });
      await roles.reload();
      await vi.waitFor(() => expect(worker.attachExternalObservation).toHaveBeenCalledTimes(2));
      release();
      expect(detach).toHaveBeenCalledTimes(2);
    } finally {
      await runtime.stop();
      roles.stop();
    }
  });
});

describe('sessions role (P03-SESSIONS-SPLIT)', () => {
  it('registers the new-Session family only while sessions is active; Stop stays in machine core', async () => {
    const rpcHandlerManager = new RpcHandlerManager({ scopePrefix: 'machine', localMachineId: 'machine', encryptionMode: 'plain' });
    const metadata = machineMetadata({ host: 'laptop' });
    const roles = createMachineRolesRuntime({ port: metadata.port });
    await roles.reload();
    // The Machine client's real RPC composition (core families) on the same dispatcher.
    const core = registerMachineRpcHandlers({ rpcHandlerManager, handlers: {
      spawnSession: async () => ({ type: 'error', errorCode: 'UNEXPECTED', errorMessage: 'Unavailable fixture Agent' }),
      stopSession: async () => true, requestShutdown: () => {},
    } as Parameters<typeof registerMachineRpcHandlers>[0]['handlers'] });
    const runtime = createMachineRoleActivationRuntime({ rpcHandlerManager, roles, contexts: {} });
    const sessionMethods = Object.values(RPC_METHODS)
      .filter(method => MACHINE_ROLE_RPC_NAMESPACES.sessions.some(prefix => method.startsWith(prefix)));
    try {
      await runtime.start();
      // Machine core alone registers none of them.
      expect(sessionMethods.filter(method => rpcHandlerManager.hasHandler(method))).toEqual([]);
      await runtime.provide('sessions', { family: core.sessionsRoleFamily });
      expect(rpcHandlerManager.hasHandler(RPC_METHODS.SPAWN_HAPPY_SESSION)).toBe(true);
      expect(rpcHandlerManager.hasHandler(RPC_METHODS.SESSION_SPAWN_NEW)).toBe(true);

      metadata.edit({ host: 'laptop', rolesV1: { active: ['memory'] } });
      await roles.reload();
      await vi.waitFor(() => expect(rpcHandlerManager.hasHandler(RPC_METHODS.SPAWN_HAPPY_SESSION)).toBe(false));
      expect(sessionMethods.filter(method => rpcHandlerManager.hasHandler(method))).toEqual([]);
      for (const method of sessionMethods) {
        expect(await rpcHandlerManager.invokeLocal(method, {}), method)
          .toMatchObject({ errorCode: RPC_ERROR_CODES.MACHINE_ROLE_INACTIVE, roleId: 'sessions' });
      }
      // Running Sessions can still be stopped: Stop is machine core.
      expect(rpcHandlerManager.hasHandler(RPC_METHODS.STOP_SESSION)).toBe(true);

      metadata.edit({ host: 'laptop' });
      await roles.reload();
      await vi.waitFor(() => expect(rpcHandlerManager.hasHandler(RPC_METHODS.SPAWN_HAPPY_SESSION)).toBe(true));
    } finally {
      await runtime.stop();
      roles.stop();
      await core.dispose();
    }
    expect(rpcHandlerManager.hasHandler(RPC_METHODS.SPAWN_HAPPY_SESSION)).toBe(false);
  });
});

describe('Machine role activation boot edges (P03-ROLES-POLICY)', () => {
  it('registers with no role set wired: every role starts, as today', async () => {
    const rpcHandlerManager = new RpcHandlerManager({ scopePrefix: 'machine', localMachineId: 'machine', encryptionMode: 'plain' });
    const startMemoryWorkerForMachine = vi.fn(async () => memoryWorkerFixture());
    const runtime = createMachineRoleActivationRuntime({ rpcHandlerManager, contexts: contextWith({ startMemoryWorkerForMachine }) });
    try {
      await expect(runtime.start()).resolves.toBeUndefined();
      expect(startMemoryWorkerForMachine).toHaveBeenCalledTimes(1);
    } finally { await runtime.stop(); }
  });

  it('boots offline from the last applied role set, so an excluded role never starts its worker', async () => {
    const rpcHandlerManager = new RpcHandlerManager({ scopePrefix: 'machine', localMachineId: 'machine', encryptionMode: 'plain' });
    // Offline: the Home cannot be read and the boot snapshot is unavailable; the persisted set stands.
    const roles = createMachineRolesRuntime({ initialStoredRoles: ['sessions'], port: { read: async () => ({ status: 'unavailable' as const }),
      compareAndSwap: async () => ({ status: 'unavailable' as const }) } as never });
    const startMemoryWorkerForMachine = vi.fn(async () => memoryWorkerFixture());
    const runtime = createMachineRoleActivationRuntime({ rpcHandlerManager, roles, contexts: contextWith({ startMemoryWorkerForMachine }) });
    try {
      await runtime.start({ status: 'unavailable' });
      expect(startMemoryWorkerForMachine).not.toHaveBeenCalled();
    } finally {
      await runtime.stop();
      roles.stop();
    }
  });
});
