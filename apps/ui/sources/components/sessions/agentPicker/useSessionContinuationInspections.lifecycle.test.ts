import * as React from 'react';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';
import type { SessionAgentTransitionSelectionV1 } from '@happier-dev/protocol/sessions/agentTransition';
import { createHomeHubArtifactHttpBoundary } from '@/dev/testkit/harness/homeHubArtifactHttpBoundary';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { publishSessionDraftPickerFixture } from '@/dev/testkit/harness/sessionDraftPickerPresentation';
import { storage } from '@/sync/domains/state/storage';

vi.mock('socket.io-client', async (importOriginal) => (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
).createSocketIoClientBoundary(importOriginal));

const transport = vi.hoisted(() => ({ holdFirst: true, failureCode: null as string | null, calls: [] as { signal?: AbortSignal; method: string }[] }));
// Transport is the external boundary; the hook and single/batch query adapters stay real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: (request: { signal?: AbortSignal; method: string; payload: { selections?: unknown[] } }) => {
        transport.calls.push(request);
        if (transport.failureCode) return Promise.reject(Object.assign(new Error('discovery unavailable'), {
            rpcErrorCode: transport.failureCode,
        }));
        if (transport.holdFirst && transport.calls.length === 1) return new Promise((_resolve, reject) => {
            request.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
        return Promise.resolve({ v: 1, inspections: (request.payload.selections ?? [selection]).map(() => ({ type: 'available', protocolVersion: 1, sameSessionTransition: true })) });
    },
}));

const { useSessionContinuationInspections } = await import('./useSessionContinuationInspections');
const selection: SessionAgentTransitionSelectionV1 = { v: 1, agentId: 'codex' };
let account: Awaited<ReturnType<typeof restoreServerAccountForTest>>;
let sync: Awaited<ReturnType<typeof loadSyncSingletonForTests>>;
const initialStorage = storage.getState();
beforeEach(async () => {
    sync = await loadSyncSingletonForTests();
    const http = createHomeHubArtifactHttpBoundary('inspection-account');
    account = await restoreServerAccountForTest({ serverUrl: 'https://inspection-lifecycle.test', accountId: 'inspection-account',
        request: http.request });
    publishSessionDraftPickerFixture({ serverId: account.home.id, accountId: 'inspection-account' }, 'session-1');
});
afterEach(async () => {
    await standardCleanup();
    await account.dispose();
    sync.dispose();
    storage.setState(initialStorage, true);
    transport.calls.length = 0; transport.holdFirst = true; transport.failureCode = null;
});

it.each(['RPC_TRANSPORT_UNAVAILABLE', 'RPC_METHOD_NOT_AVAILABLE'])(
    'reopening retries a failed %s read without a connection change or background retry',
    async (failureCode) => {
        transport.holdFirst = false;
        const hook = await renderHook((props: { demanded: boolean; daemonGeneration: number }) => useSessionContinuationInspections({
            ...props, sessionId: 'session-1', machine: { machineId: 'machine-1', serverId: account.home.id,
                connectionGeneration: 1, daemonGeneration: props.daemonGeneration },
            machinePresence: 'online', targetSelections: [selection],
        }), { initialProps: { demanded: true, daemonGeneration: 1 } });
        await vi.waitFor(() => expect(hook.getCurrent().read(selection)).toMatchObject({ status: 'answered', inspection: { type: 'available' } }));
        transport.failureCode = failureCode;
        await hook.rerender({ demanded: true, daemonGeneration: 2 });
        await vi.waitFor(() => expect(hook.getCurrent().read(selection)).toMatchObject(failureCode === 'RPC_METHOD_NOT_AVAILABLE'
            ? { status: 'answered', inspection: { type: 'unavailable', reason: 'operation_unavailable' } }
            : { status: 'indeterminate' }));
        const failedCalls = transport.calls.length;
        await hook.rerender({ demanded: true, daemonGeneration: 2 });
        expect(transport.calls).toHaveLength(failedCalls);
        await hook.rerender({ demanded: false, daemonGeneration: 2 });
        transport.failureCode = null;
        await hook.rerender({ demanded: true, daemonGeneration: 2 });
        await vi.waitFor(() => expect(hook.getCurrent().read(selection)).toMatchObject({ status: 'answered', inspection: { type: 'available' } }));
        await hook.unmount();
    },
);

it('cancels an unanswered inspection when the picker closes and retries the same target when reopened', async () => {
    const hook = await renderHook((demanded: boolean) => useSessionContinuationInspections({
        demanded, sessionId: 'session-1', machine: { machineId: 'machine-1', serverId: account.home.id,
            connectionGeneration: 1, daemonGeneration: 1 },
        machinePresence: 'online', targetSelections: [selection],
    }), { initialProps: true });
    expect(hook.getCurrent().read(selection).status).toBe('checking');
    await vi.waitFor(() => expect(transport.calls).toHaveLength(1));
    await hook.rerender(false);
    expect(transport.calls[0]?.signal?.aborted).toBe(true);
    await hook.rerender(true);
    await vi.waitFor(() => expect(hook.getCurrent().read(selection)).toMatchObject({ status: 'answered', inspection: { type: 'available' } }));
    await hook.unmount();
});

it('keeps a failed target settled when another target changes while the picker stays open', async () => {
    transport.holdFirst = false;
    transport.failureCode = 'RPC_TRANSPORT_UNAVAILABLE';
    const hook = await renderHook((targets: SessionAgentTransitionSelectionV1[]) => useSessionContinuationInspections({
        demanded: true, sessionId: 'session-1', machine: { machineId: 'machine-1', serverId: account.home.id,
            connectionGeneration: 1, daemonGeneration: 1 },
        machinePresence: 'online', targetSelections: targets,
    }), { initialProps: [selection] });
    await vi.waitFor(() => expect(hook.getCurrent().read(selection).status).toBe('indeterminate'));
    const failed = hook.getCurrent().read(selection);
    transport.failureCode = null;
    const changedSelection: SessionAgentTransitionSelectionV1 = { v: 1, agentId: 'claude' };
    await hook.rerender([selection, changedSelection]);
    expect(hook.getCurrent().read(selection)).toEqual(failed);
    await vi.waitFor(() => expect(hook.getCurrent().read(changedSelection)).toMatchObject({ status: 'answered', inspection: { type: 'available' } }));
    await hook.unmount();
});


it('does not inspect a retained hidden picker until its layout becomes visible', async () => {
    transport.holdFirst = false;
    let visible = false;
    const wrapper = ({ children }: React.PropsWithChildren) => React.createElement(
        PluginSurfaceFocusEligibilityProvider, { active: visible, children });
    const hook = await renderHook((daemonGeneration: number) => useSessionContinuationInspections({
        demanded: true, sessionId: 'session-1', machine: { machineId: 'machine-1', serverId: account.home.id,
            connectionGeneration: 1, daemonGeneration },
        machinePresence: 'online', targetSelections: [selection],
    }), { initialProps: 1, wrapper });
    expect(transport.calls).toHaveLength(0);
    await hook.rerender(2);
    expect(transport.calls).toHaveLength(0);
    visible = true;
    await hook.rerender(2);
    await vi.waitFor(() => expect(transport.calls).toHaveLength(1));
    visible = false;
    await hook.rerender(3);
    expect(transport.calls).toHaveLength(1);
    visible = true;
    await hook.rerender(3);
    await vi.waitFor(() => expect(transport.calls).toHaveLength(2));
    await vi.waitFor(() => expect(hook.getCurrent().read(selection).status).toBe('answered'));
});
