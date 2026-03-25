import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

import { renderScreen } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const machineCapabilitiesInvokeMock = vi.fn(async (_machineId: any, _request: any, _options: any) => ({
    supported: true as const,
    response: {
        ok: true as const,
        result: {
            provider: 'codex',
            configOptions: [
                { id: 'opt1', name: 'Option 1', type: 'boolean', currentValue: true },
            ],
            source: 'dynamic',
        },
    },
}));

vi.mock('@/sync/ops/capabilities', () => ({
    machineCapabilitiesInvoke: machineCapabilitiesInvokeMock,
}));

describe('useNewSessionPreflightConfigOptionsState (cache)', () => {
    it('does not re-probe when a fresh config options result is cached', async () => {
        vi.resetModules();
        machineCapabilitiesInvokeMock.mockClear();

        const { resetDynamicConfigOptionsProbeCacheForTests } = await import('@/sync/acp/dynamicConfigOptionsProbeCache');
        resetDynamicConfigOptionsProbeCacheForTests();

        const { useNewSessionPreflightConfigOptionsState } = await import('./useNewSessionPreflightConfigOptionsState');

        function Harness() {
            useNewSessionPreflightConfigOptionsState({
                backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
                selectedMachineId: 'machine-1',
                capabilityServerId: 'server-1',
                cwd: '/repo',
            } as any);
            return null;
        }

        let root1!: renderer.ReactTestRenderer;
        root1 = (await renderScreen(React.createElement(Harness))).tree;
        await act(async () => {
            root1.unmount();
        });

        let root2!: renderer.ReactTestRenderer;
        root2 = (await renderScreen(React.createElement(Harness))).tree;
        await act(async () => {
            root2.unmount();
        });

        expect(machineCapabilitiesInvokeMock).toHaveBeenCalledTimes(1);
    });
});

