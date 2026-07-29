import { describe, expect, it, vi } from 'vitest';

import type { TrackedSession } from '../types';
import { createSpawnLifecycleCallbacks } from './createSpawnLifecycleCallbacks';

describe('createSpawnLifecycleCallbacks runtime target registration', () => {
  it('registers connected-service runtime context with the canonical runtime target', () => {
    const registerConnectedServiceRuntimeTarget = vi.fn();
    const callbacks = createSpawnLifecycleCallbacks({
      connectedServicesBindingsRaw: { v: 1, bindingsByServiceId: {} },
      connectedServiceSelectionsEnv: {
        HAPPIER_TEST_CONNECTED_SERVICE_SELECTION_IDENTITY: 'selection-spawn',
      },
      connectedServiceSelectionsEnvRaw: '[]',
      catalogAgentId: 'opencode',
      sessionId: 'session-spawn',
      sessionDirectory: '/tmp/project',
      materializationKey: 'csm_spawn',
      connectedServiceMaterializationIdentityV1: {
        v: 1,
        id: 'csm_spawn',
        createdAt: 1,
      },
      hasConnectedServiceAuth: () => true,
      registerConnectedServiceRuntimeTarget,
      getSpawnResourceCleanupOnExit: () => null,
      onSpawnResourceCleanupArmed: vi.fn(),
      spawnResourceCleanupByPid: new Map(),
      getSessionAttachCleanup: () => null,
      setSessionAttachCleanup: vi.fn(),
      sessionAttachCleanupByPid: new Map(),
      persistAcceptedSpawnMarker: vi.fn(async () => {}),
    });

    callbacks.registerConnectedServiceSpawnTarget(1234);

    expect(registerConnectedServiceRuntimeTarget).toHaveBeenCalledWith({
      pid: 1234,
      agentId: 'opencode',
      sessionId: 'session-spawn',
      sessionDirectory: '/tmp/project',
      materializationKey: 'csm_spawn',
      connectedServiceMaterializationIdentityV1: {
        v: 1,
        id: 'csm_spawn',
        createdAt: 1,
      },
      connectedServicesBindingsRaw: { v: 1, bindingsByServiceId: {} },
      connectedServiceSelectionsEnv: {
        HAPPIER_TEST_CONNECTED_SERVICE_SELECTION_IDENTITY: 'selection-spawn',
      },
      connectedServiceSelectionsEnvRaw: '[]',
    });
  });

  it('defers qualified request-auth targets and cleanup until the canonical server session id is ready', async () => {
    const cleanupOnExit = vi.fn();
    const registerConnectedServiceRefreshTarget = vi.fn();
    const registerConnectedServiceQuotaTarget = vi.fn();
    const registerConnectedServiceRuntimeTarget = vi.fn();
    let resolveActivation!: () => void;
    const activation = new Promise<void>((resolve) => {
      resolveActivation = resolve;
    });
    const activateConnectedAccountSessionBinding = vi.fn(async () => {
      await activation;
      return null;
    });
    const spawnResourceCleanupByPid = new Map<number, () => void | Promise<void>>();
    const onSpawnResourceCleanupArmed = vi.fn();
    const tracked: TrackedSession = {
      pid: 1235,
      startedBy: 'daemon',
    };
    const callbacks = createSpawnLifecycleCallbacks({
      connectedServicesBindingsRaw: { v: 1, bindingsByServiceId: {} },
      catalogAgentId: 'pi',
      sessionDirectory: '/tmp/project',
      materializationKey: 'csm_fresh',
      hasConnectedServiceAuth: () => true,
      activateConnectedAccountSessionBindingOnCanonicalSession:
        activateConnectedAccountSessionBinding,
      registerConnectedServiceRefreshTarget,
      registerConnectedServiceQuotaTarget,
      registerConnectedServiceRuntimeTarget,
      getSpawnResourceCleanupOnExit: () => cleanupOnExit,
      onSpawnResourceCleanupArmed,
      spawnResourceCleanupByPid,
      getSessionAttachCleanup: () => null,
      setSessionAttachCleanup: vi.fn(),
      sessionAttachCleanupByPid: new Map(),
      persistAcceptedSpawnMarker: vi.fn(async () => {}),
    });

    await callbacks.persistAcceptedSpawnMarker(tracked);
    callbacks.registerConnectedServiceSpawnTarget(tracked.pid);
    callbacks.registerSpawnResourceCleanupForPid(tracked.pid);

    expect(registerConnectedServiceRefreshTarget).not.toHaveBeenCalled();
    expect(registerConnectedServiceQuotaTarget).not.toHaveBeenCalled();
    expect(registerConnectedServiceRuntimeTarget).not.toHaveBeenCalled();
    expect(spawnResourceCleanupByPid.size).toBe(0);

    const readiness = tracked.activateConnectedAccountSessionBindingOnCanonicalSession;
    expect(readiness).toEqual(expect.any(Function));
    const firstReadiness = readiness?.('session-from-server');
    const duplicateReadiness = readiness?.('session-from-server');
    expect(activateConnectedAccountSessionBinding).toHaveBeenCalledOnce();
    resolveActivation();
    await expect(firstReadiness).resolves.toBeNull();
    await expect(duplicateReadiness).resolves.toBeNull();

    expect(activateConnectedAccountSessionBinding).toHaveBeenCalledWith('session-from-server');
    expect(registerConnectedServiceRefreshTarget).toHaveBeenCalledWith(expect.objectContaining({
      pid: tracked.pid,
      sessionId: 'session-from-server',
    }));
    expect(registerConnectedServiceQuotaTarget).toHaveBeenCalledWith(expect.objectContaining({
      pid: tracked.pid,
      sessionId: 'session-from-server',
    }));
    expect(registerConnectedServiceRuntimeTarget).toHaveBeenCalledWith(expect.objectContaining({
      pid: tracked.pid,
      sessionId: 'session-from-server',
    }));
    expect(spawnResourceCleanupByPid.get(tracked.pid)).toBe(cleanupOnExit);
    expect(onSpawnResourceCleanupArmed).toHaveBeenCalledOnce();
    await expect(readiness?.('session-conflict')).resolves.toMatchObject({
      type: 'error',
      errorCode: 'SPAWN_VALIDATION_FAILED',
      errorMessage: 'connected_account_canonical_session_identity_conflict',
    });
    expect(activateConnectedAccountSessionBinding).toHaveBeenCalledOnce();
    expect(registerConnectedServiceRuntimeTarget).toHaveBeenCalledOnce();
    expect(onSpawnResourceCleanupArmed).toHaveBeenCalledOnce();
  });

  it('retires one exact PID-owned upstream authority before process disposition and retains failures', async () => {
    const cleanup = vi.fn(async () => undefined);
    const spawnResourceCleanupByPid =
      new Map<number, () => void | Promise<void>>([[1236, cleanup]]);
    const callbacks = createSpawnLifecycleCallbacks({
      connectedServicesBindingsRaw: { v: 1, bindingsByServiceId: {} },
      catalogAgentId: 'pi',
      materializationKey: 'csm_cleanup',
      hasConnectedServiceAuth: () => false,
      getSpawnResourceCleanupOnExit: () => null,
      onSpawnResourceCleanupArmed: vi.fn(),
      spawnResourceCleanupByPid,
      getSessionAttachCleanup: () => null,
      setSessionAttachCleanup: vi.fn(),
      sessionAttachCleanupByPid: new Map(),
      persistAcceptedSpawnMarker: vi.fn(async () => {}),
    });

    await expect(
      callbacks.cleanupSpawnResourcesForPid?.(1236),
    ).resolves.toBe(true);
    await expect(
      callbacks.cleanupSpawnResourcesForPid?.(1236),
    ).resolves.toBe(true);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(spawnResourceCleanupByPid.has(1236)).toBe(false);

    const failingCleanup = vi.fn(async () => {
      throw new Error('managed_provider_stop_unavailable');
    });
    spawnResourceCleanupByPid.set(1237, failingCleanup);
    await expect(
      callbacks.cleanupSpawnResourcesForPid?.(1237),
    ).resolves.toBe(false);
    expect(spawnResourceCleanupByPid.get(1237)).toBe(
      failingCleanup,
    );
  });
});
