import { describe, expect, it, vi } from 'vitest';

import {
  createProviderModelLoadRpcHandler,
} from './rpc';

describe('provider model-management RPC boundary', () => {
  it('exposes a focused machine-RPC handler with no continuation or extension fields', async () => {
    const loadNow = vi.fn(async () => ({ status: 'loaded' as const, source: 'requested' as const }));
    const cancelNow = vi.fn(async () => ({ status: 'cancelled' as const, providerMayContinue: true as const }));
    const handler = createProviderModelLoadRpcHandler({ machineId: 'machine-a', loadNow, cancelNow });
    const request = { action: 'load', connectionId: 'connection-a', machineId: 'machine-a', modelId: 'model-a' };
    await expect(handler(request)).resolves.toEqual({ status: 'loaded', source: 'requested' });
    await expect(handler({ ...request, pendingSessionId: 'session-a' })).rejects.toThrow();
    await expect(handler({ ...request, descriptor: { path: '/unsafe' } })).rejects.toThrow();
    await expect(handler({ ...request, machineId: 'machine-b' })).resolves.toMatchObject({
      status: 'error', error: { code: 'provider_not_enabled_on_machine', machineId: 'machine-b' },
    });
    expect(loadNow).toHaveBeenCalledWith({
      connectionId: 'connection-a', machineId: 'machine-a', modelId: 'model-a',
    });
    await expect(handler({ ...request, action: 'cancel' })).resolves.toEqual({
      status: 'cancelled', providerMayContinue: true,
    });
    expect(cancelNow).toHaveBeenCalledWith({
      connectionId: 'connection-a', machineId: 'machine-a', modelId: 'model-a',
    });
  });

  it('accepts only explicit fixed-shape actions and rejects descriptor/body/credential injection', async () => {
    const loadNow = vi.fn(async () => ({ status: 'loaded' as const, source: 'requested' as const }));
    const cancelNow = vi.fn(async () => ({ status: 'cancelled' as const, providerMayContinue: true as const }));
    const handler = createProviderModelLoadRpcHandler({ machineId: 'machine-a', loadNow, cancelNow });
    const request = { action: 'load', connectionId: 'connection-a', machineId: 'machine-a', modelId: 'model-a' };
    await expect(handler({ ...request, body: { gpu: 'all' }, credential: 'secret' })).rejects.toThrow();
    await expect(handler({ ...request, action: 'unload' })).rejects.toThrow();
    await expect(handler({ ...request, action: 'download' })).rejects.toThrow();
    await expect(handler({ ...request, path: '/arbitrary', config: { gpu: 'all' } })).rejects.toThrow();
    await expect(handler(request)).resolves.toEqual({ status: 'loaded', source: 'requested' });
    expect(loadNow).toHaveBeenCalledWith(expect.objectContaining({
      connectionId: 'connection-a', machineId: 'machine-a', modelId: 'model-a',
    }));
  });
});
