import * as React from 'react';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { afterEach, expect, it, vi } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';
import type { SessionAgentTransitionSelectionV1 } from '@happier-dev/protocol/sessions/agentTransition';

const transport = vi.hoisted(() => ({ holdFirst: true, calls: [] as { signal?: AbortSignal; method: string }[] }));
// Transport is the external boundary; the hook and single/batch query adapters stay real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: (request: { signal?: AbortSignal; method: string }) => {
        transport.calls.push(request);
        if (transport.holdFirst && transport.calls.length === 1) return new Promise((_resolve, reject) => {
            request.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
        return Promise.resolve({ v: 1, inspections: [{ type: 'available', protocolVersion: 1, sameSessionTransition: true }] });
    },
}));

const { useSessionContinuationInspections } = await import('./useSessionContinuationInspections');
const selection: SessionAgentTransitionSelectionV1 = { v: 1, agentId: 'codex' };
afterEach(() => { standardCleanup(); transport.calls.length = 0; transport.holdFirst = true; });

it('cancels an unanswered inspection when the picker closes and retries the same target when reopened', async () => {
    const hook = await renderHook((demanded: boolean) => useSessionContinuationInspections({
        demanded, sessionId: 'session-one', machine: { machineId: 'machine-one', serverId: 'home-one',
            connectionGeneration: 1, daemonGeneration: 1 },
        machinePresence: 'online', targetSelections: [selection],
    }), { initialProps: true });
    expect(hook.getCurrent().read(selection).status).toBe('checking');
    await hook.rerender(false);
    expect(transport.calls[0]?.signal?.aborted).toBe(true);
    await hook.rerender(true);
    expect(hook.getCurrent().read(selection)).toMatchObject({ status: 'answered', inspection: { type: 'available' } });
    await hook.unmount();
});


it('does not inspect a retained hidden picker until its layout becomes visible', async () => {
    transport.holdFirst = false;
    let visible = false;
    const wrapper = ({ children }: React.PropsWithChildren) => React.createElement(
        PluginSurfaceFocusEligibilityProvider, { active: visible, children });
    const hook = await renderHook((daemonGeneration: number) => useSessionContinuationInspections({
        demanded: true, sessionId: 'session-one', machine: { machineId: 'machine-one', serverId: 'home-one',
            connectionGeneration: 1, daemonGeneration },
        machinePresence: 'online', targetSelections: [selection],
    }), { initialProps: 1, wrapper });
    expect(transport.calls).toHaveLength(0);
    await hook.rerender(2);
    expect(transport.calls).toHaveLength(0);
    visible = true;
    await hook.rerender(2);
    expect(transport.calls).toHaveLength(1);
    visible = false;
    await hook.rerender(3);
    expect(transport.calls).toHaveLength(1);
    visible = true;
    await hook.rerender(3);
    expect(transport.calls).toHaveLength(2);
    expect(hook.getCurrent().read(selection).status).toBe('answered');
});
