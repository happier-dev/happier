import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { resetDynamicSessionModeProbeCacheForTests } from '@/sync/domains/sessionModes/dynamicSessionModeProbeCache';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const machineCapabilitiesInvokeMock = vi.fn(async (_machineId: any, _request: any, _options: any) => ({
  supported: true as const,
  response: {
    ok: true as const,
    result: { availableModes: [{ id: 'plan', name: 'Plan' }] },
  },
}));

vi.mock('@/sync/ops/capabilities', () => ({
  machineCapabilitiesInvoke: machineCapabilitiesInvokeMock,
}));

vi.mock('@/agents/catalog/catalog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/agents/catalog/catalog')>();
  return {
    ...actual,
    getAgentCore: () => ({ sessionModes: { kind: 'acpAgentModes' } }),
  };
});

describe('useNewSessionPreflightSessionModesState (cwd)', () => {
  it('passes params.cwd through to capabilities.invoke(cli.* probeModes)', async () => {
    vi.resetModules();
    machineCapabilitiesInvokeMock.mockClear();
    resetDynamicSessionModeProbeCacheForTests();

    const { useNewSessionPreflightSessionModesState } = await import('./useNewSessionPreflightSessionModesState');

    const captured: any[] = [];
    machineCapabilitiesInvokeMock.mockImplementationOnce(async (_machineId: any, request: any, _options: any) => {
      captured.push(request);
      return {
        supported: true as const,
        response: { ok: true as const, result: { availableModes: [{ id: 'plan', name: 'Plan' }] } },
      };
    });

    function Harness() {
      useNewSessionPreflightSessionModesState({
        agentType: 'opencode' as any,
        selectedMachineId: 'machine-1',
        capabilityServerId: 'server-1',
        cwd: '/repo',
      });
      return null;
    }

    let root!: renderer.ReactTestRenderer;
    await act(async () => {
      root = renderer.create(React.createElement(Harness));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      root.unmount();
    });

    expect(captured.length).toBeGreaterThan(0);
    expect(captured[0]).toMatchObject({
      method: 'probeModes',
      params: expect.objectContaining({ timeoutMs: 15_000, cwd: '/repo' }),
    });
  });
});

