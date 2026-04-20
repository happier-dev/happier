import { describe, expect, it, vi } from 'vitest';

import { HOST_SESSION_RUNTIME_PLAN_KIND, type HostSessionRuntimePlan } from '@/agent/runtime/sessionLoop/lifecycle';
import type { Credentials } from '@/persistence';

import { createCatalogBindings } from './catalog';

describe('createCatalogBindings', () => {
  it('returns an explicit binding envelope instead of a bare runtime object', async () => {
    const credentials: Credentials = {
      token: 'test-token',
      encryption: {
        type: 'legacy',
        secret: new Uint8Array([1, 2, 3]),
      },
    };
    const sessionParams = {
      credentials,
      directory: '/tmp/qwen',
    };
    const plan: HostSessionRuntimePlan = {
      kind: HOST_SESSION_RUNTIME_PLAN_KIND,
      providerId: 'qwen',
      opts: sessionParams as never,
      config: {} as never,
    };
    const createHostSessionRuntimePlan = vi.fn(async () => plan);

    const factory = createCatalogBindings({
      providerId: 'qwen',
      createHostSessionRuntimePlan,
      createRuntime: vi.fn(),
    });

    const binding = await factory({
      backend: { id: 'qwen', providerId: 'qwen', source: 'built_in' },
      provider: { id: 'qwen', source: 'built_in' },
      executionSurfaces: {
        terminalRuntime: null,
        directSessions: null,
        attach: null,
        sessionHandoff: null,
      },
    } as never);

    expect('bindings' in binding).toBe(true);
    expect('createSessionRuntime' in binding).toBe(false);
    if (!('bindings' in binding)) {
      throw new Error('expected createCatalogBindings to return a bindings envelope');
    }

    await expect(binding.bindings.createSessionRuntime(sessionParams)).resolves.toEqual(plan);
    expect(createHostSessionRuntimePlan).toHaveBeenCalledWith(sessionParams);
  });
});
