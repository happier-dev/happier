import { describe, expect, it, vi } from 'vitest';
import { CHECKLIST_IDS } from '@happier-dev/protocol/checklists';
import type { CapabilitiesDetectRequest } from '@/sync/api/capabilities/capabilitiesProtocol';
import { flushHookEffects, renderHook } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('useMachineCapabilitiesCache (race)', () => {
  it('serializes overlapping requests and keeps the newest loaded state', async () => {
    vi.resetModules();

    type DetectResponse = {
      supported: true;
      response: {
        protocolVersion: 1;
        results: Record<string, { ok: true; data: { version: string } }>;
      };
    };
    const resolvers: Array<(value: DetectResponse) => void> = [];
    const machineCapabilitiesDetect = vi.fn(async () => {
      return await new Promise((resolve) => {
        resolvers.push(resolve as (value: DetectResponse) => void);
      });
    });

    vi.doMock('@/sync/ops', () => {
      return { machineCapabilitiesDetect };
    });

    const { prefetchMachineCapabilities, useMachineCapabilitiesCache } = await import('./useMachineCapabilitiesCache');

    const request1: CapabilitiesDetectRequest = {
      checklistId: CHECKLIST_IDS.NEW_SESSION,
      requests: [{ id: 'dep.test', params: { includeRegistry: false } } as any],
    };
    const request2: CapabilitiesDetectRequest = {
      checklistId: CHECKLIST_IDS.NEW_SESSION,
      requests: [{ id: 'dep.test', params: { includeRegistry: true } } as any],
    };

    const p1 = prefetchMachineCapabilities({ machineId: 'm1', request: request1, timeoutMs: 10_000 });
    const p2 = prefetchMachineCapabilities({ machineId: 'm1', request: request2, timeoutMs: 10_000 });

    // Flush queued fetch start (serialized per machine cache key).
    await flushHookEffects({ cycles: 1, turns: 0 });

    // Second request should not start until the first one settles.
    expect(resolvers).toHaveLength(1);

    resolvers[0]!({
      supported: true,
      response: {
        protocolVersion: 1,
        results: {
          'dep.test': { ok: true, data: { version: '1' } },
        },
      },
    });
    await p1;

    // Flush queued start of the follow-up request.
    await flushHookEffects({ cycles: 1, turns: 0 });
    expect(resolvers).toHaveLength(2);
    resolvers[1]!({
      supported: true,
      response: {
        protocolVersion: 1,
        results: {
          'dep.test': { ok: true, data: { version: '2' } },
        },
      },
    });
    await p2;

    const hook = await renderHook(() => useMachineCapabilitiesCache({
        machineId: 'm1',
        enabled: false,
        request: request2,
        timeoutMs: 1,
      }).state, {
        flushOptions: { cycles: 0 },
    });

    const state = hook.getCurrent();
    expect(state.status).toBe('loaded');
    if (state.status !== 'loaded') {
      throw new Error('Expected loaded cache state');
    }
    const result = state.snapshot?.response?.results?.['dep.test'];
    const version = result && result.ok ? (result.data as { version?: string }).version : null;
    expect(version).toBe('2');
    await hook.unmount();
  });
});
