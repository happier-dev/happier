import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { renderScreen } from '@/dev/testkit';
import { installNewSessionScreenModelCommonModuleMocks } from '../newSessionScreenModelTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const machineCapabilitiesInvokeMock = vi.fn(async (_machineId: any, _request: any, _options: any) => ({
  supported: true as const,
  response: { ok: true as const, result: { availableModes: [{ id: 'plan', name: 'Plan' }] } },
}));

vi.mock('@/sync/ops/capabilities', () => ({
  machineCapabilitiesInvoke: machineCapabilitiesInvokeMock,
}));

installNewSessionScreenModelCommonModuleMocks({
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({
            translateLoose: (key: string) => `t:${key}`,
        });
    },
});

vi.mock('@/agents/catalog/catalog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/agents/catalog/catalog')>();
  return {
    ...actual,
    getAgentCore: () => ({
      sessionModes: {
        kind: 'staticAgentModes',
        staticOptions: [
          { id: 'default', nameKey: 'agentInput.mode.build', descriptionKey: 'agentInput.mode.buildDescription' },
          { id: 'plan', nameKey: 'agentInput.mode.plan', descriptionKey: 'agentInput.mode.planDescription' },
        ],
      },
    }),
  };
});

describe('useNewSessionPreflightSessionModesState (staticAgentModes)', () => {
  it('returns static mode options without probing capabilities', async () => {
    vi.resetModules();
    machineCapabilitiesInvokeMock.mockClear();

    const { useNewSessionPreflightSessionModesState } = await import('./useNewSessionPreflightSessionModesState');

    let latest: any = null;
    function Harness() {
      latest = useNewSessionPreflightSessionModesState({
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        selectedMachineId: null,
        capabilityServerId: 'server-1',
        cwd: '/repo',
      });
      return null;
    }

    let root!: renderer.ReactTestRenderer;
    root = (await renderScreen(React.createElement(Harness))).tree;

    expect(machineCapabilitiesInvokeMock).toHaveBeenCalledTimes(0);
    expect(latest.probe.phase).toBe('idle');
    expect(latest.probe.onRefresh).toBeUndefined();
    expect((latest.modeOptions ?? []).map((o: any) => o.id)).toEqual(['default', 'plan']);
    expect((latest.modeOptions ?? [])[0]?.name).toBe('t:agentInput.mode.build');

    await act(async () => {
      root.unmount();
    });
  });
});
