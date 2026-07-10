import { describe, expect, it, vi } from 'vitest';

import { HOST_SESSION_RUNTIME_PLAN_KIND, type HostSessionRuntimePlan } from '@/agent/runtime/session/loop/lifecycle';
import type { Credentials } from '@/persistence';

import { createCatalogRuntimeCore } from './catalog';

describe('createCatalogRuntimeCore', () => {
  it('returns an explicit runtimeCore envelope instead of a bare runtime object', async () => {
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
      agentId: 'qwen',
      opts: sessionParams as never,
      config: {} as never,
    };
    const createHostSessionRuntimePlan = vi.fn(async () => plan);

    const factory = createCatalogRuntimeCore({
      agentId: 'qwen',
      createHostSessionRuntimePlan,
      createRuntime: vi.fn(),
    });

    const runtimeCore = await factory({
      backend: { id: 'qwen', agentId: 'qwen', source: 'built_in' },
      provider: { id: 'qwen', source: 'built_in' },
      executionSurfaces: {
        terminalRuntime: null,
        externalSession: null,
        attach: null,
        handoff: null,
        fork: null,
        checkpoint: null,
      },
    } as never);

    expect('runtimeCore' in runtimeCore).toBe(true);
    expect('createSessionRuntime' in runtimeCore).toBe(false);
    if (!('runtimeCore' in runtimeCore)) {
      throw new Error('expected createCatalogRuntimeCore to return a runtimeCore envelope');
    }

    await expect(runtimeCore.runtimeCore.createSessionRuntime(sessionParams)).resolves.toEqual(plan);
    expect(createHostSessionRuntimePlan).toHaveBeenCalledWith(sessionParams);
  });
});
