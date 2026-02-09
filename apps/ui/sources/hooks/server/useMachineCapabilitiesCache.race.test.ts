import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { CHECKLIST_IDS } from '@happier-dev/protocol/checklists';
import type { CapabilitiesDetectRequest } from '@/sync/api/capabilities/capabilitiesProtocol';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('useMachineCapabilitiesCache (race)', () => {
  it('does not let older requests overwrite newer loaded state', async () => {
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

    const request: CapabilitiesDetectRequest = { checklistId: CHECKLIST_IDS.NEW_SESSION, requests: [] };

    const p1 = prefetchMachineCapabilities({ machineId: 'm1', request, timeoutMs: 10_000 });
    const p2 = prefetchMachineCapabilities({ machineId: 'm1', request, timeoutMs: 10_000 });

    expect(resolvers).toHaveLength(2);

    // Resolve the newer request first (version 2).
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

    // Resolve the older request last (version 1).
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

    const latestRef: { current: ReturnType<typeof useMachineCapabilitiesCache>['state'] | null } = { current: null };
    function Test() {
      latestRef.current = useMachineCapabilitiesCache({
        machineId: 'm1',
        enabled: false,
        request,
        timeoutMs: 1,
      }).state;
      return React.createElement('View');
    }

    act(() => {
      renderer.create(React.createElement(Test));
    });

    if (!latestRef.current) {
      throw new Error('Expected cache state');
    }
    expect(latestRef.current.status).toBe('loaded');
    if (latestRef.current.status !== 'loaded') {
      throw new Error('Expected loaded cache state');
    }
    const result = latestRef.current.snapshot?.response?.results?.['dep.test'];
    const version = result && result.ok ? (result.data as { version?: string }).version : null;
    expect(version).toBe('2');
  });
});
