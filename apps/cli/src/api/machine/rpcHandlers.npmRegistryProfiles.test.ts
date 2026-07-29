import { describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { registerMachineNpmRegistryProfileRpcHandlers } from './rpcHandlers.npmRegistryProfiles';

function harness() {
  const handlers = new Map<string, (raw: unknown) => Promise<unknown>>();
  const service = {
    snapshot: vi.fn(async () => ({ protocolVersion: 1 as const, revision: 0, profiles: [], pausedSources: [] })),
    mutate: vi.fn(async () => ({
      status: 'success' as const,
      snapshot: { protocolVersion: 1 as const, revision: 1, profiles: [], pausedSources: [] },
    })),
  };
  registerMachineNpmRegistryProfileRpcHandlers({
    rpcHandlerManager: { registerHandler(method: string, handler: (raw: unknown) => Promise<unknown>) { handlers.set(method, handler); } } as never,
    machineId: 'machine-a',
    service,
  });
  return { handlers, service };
}

describe('machine npm registry profile RPC registration', () => {
  it('projects secret-free snapshots only for the addressed machine', async () => {
    const h = harness();
    await expect(h.handlers.get(RPC_METHODS.DAEMON_NPM_REGISTRY_PROFILES_GET)!({ machineId: 'machine-a' }))
      .resolves.toEqual({ status: 'success', snapshot: { protocolVersion: 1, revision: 0, profiles: [], pausedSources: [] } });
    await expect(h.handlers.get(RPC_METHODS.DAEMON_NPM_REGISTRY_PROFILES_GET)!({ machineId: 'machine-b' }))
      .resolves.toMatchObject({ status: 'error', code: 'unavailable' });
    expect(h.service.snapshot).toHaveBeenCalledTimes(1);
  });

  it('delegates a validated mutation without retaining or echoing credential input', async () => {
    const h = harness();
    const request = {
      action: 'login' as const,
      machineId: 'machine-a',
      profileId: 'registry_acme',
      expectedRevision: 0,
      mutationId: 'mutation-login-acme',
      credential: { kind: 'bearer_token' as const, secret: 'boundary-secret' },
    };
    const result = await h.handlers.get(RPC_METHODS.DAEMON_NPM_REGISTRY_PROFILES_MUTATE)!(request);
    expect(h.service.mutate).toHaveBeenCalledWith(request);
    expect(JSON.stringify(result)).not.toContain('boundary-secret');
  });

  it('contains malformed requests and service failures as typed secret-free RPC errors', async () => {
    const h = harness();
    const get = h.handlers.get(RPC_METHODS.DAEMON_NPM_REGISTRY_PROFILES_GET)!;
    const mutate = h.handlers.get(RPC_METHODS.DAEMON_NPM_REGISTRY_PROFILES_MUTATE)!;

    await expect(get({ machineId: '' })).resolves.toEqual({
      status: 'error', code: 'invalid_request', retryable: false,
    });
    await expect(mutate({ action: 'login', machineId: 'machine-a', credential: { secret: 'boundary-secret' } }))
      .resolves.toEqual({ status: 'error', code: 'invalid_request', retryable: false });

    h.service.snapshot.mockRejectedValueOnce(new Error('filesystem path with boundary-secret'));
    await expect(get({ machineId: 'machine-a' })).resolves.toEqual({
      status: 'error', code: 'unavailable', retryable: true,
    });

    h.service.mutate.mockRejectedValueOnce(new Error('filesystem path with boundary-secret'));
    const result = await mutate({
      action: 'logout', machineId: 'machine-a', profileId: 'registry_acme',
      expectedRevision: 0, mutationId: 'mutation-logout-acme',
    });
    expect(result).toEqual({ status: 'error', code: 'unavailable', retryable: true });
    expect(JSON.stringify(result)).not.toContain('boundary-secret');
  });
});
