import { describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { createActionExecutor, createUnavailableRuntimeActionExecutor, type ActionExecutorDeps } from '@happier-dev/protocol';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { useComputerSessionControl } from '@/components/computer/useComputerSessionControl';

import { createComputerRuntimeActionExecutor, type ComputerMachineRpc } from './runtimeActionExecutor';
import type { ComputerTargetsListResponseV1 } from '@happier-dev/protocol/computer/v1';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';

const target = { kind: 'window', displayId: ':77', pid: 123, windowId: 456 } as const;
const selected = {
    consentGranted: false,
    selectedTarget: target,
    sourceId: 'computer:1',
    approvalDisplay: { machineDisplayName: 'Studio laptop', requiresTargetSelection: false, target: { kind: 'window', title: 'Sign in to Lumen' } },
};

function executorWith(machine: ComputerMachineRpc, accountLifetime?: ServerAccountScopeLifetime) {
    // Only the computer transport is used; other host-effect dependencies are outside this fixture.
    // The machine RPC is the network boundary; the canonical Action front door runs for real above it.
    return createActionExecutor({
        runtimeActionExecute: createComputerRuntimeActionExecutor({ executeOnMachine: machine, fallback: createUnavailableRuntimeActionExecutor(), accountLifetime }),
    } as ActionExecutorDeps);
}

describe('computer runtime Actions from Happier', () => {
    it('does not publish retired Account readiness into a new Account reader of the same Computer scope', async () => {
        const { storage } = await import('@/sync/domains/state/storageStore');
        const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        const { getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable, publishAppliedActiveServerSnapshot, publishAppliedActiveServerRuntimeAvailability } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
        const previousScope = storage.getState().profileScope;
        const previousProfile = storage.getState().profile;
        const previousSnapshot = getAppliedActiveServerSnapshot();
        const previousAvailable = isAppliedActiveServerRuntimeAvailable();
        const serverId = 'computer-callback-home';
        const scope = { serverId, sessionId: 'same-computer-session', machineId: 'same-computer-machine' };
        storage.getState().activateProfileScope({ serverId, accountId: 'account-a' });
        publishAppliedActiveServerSnapshot({ serverId, serverUrl: 'https://computer-callback.test', generation: 1 });
        const accountA = captureActiveServerAccountScopeLifetime();
        expect(accountA?.isCurrent()).toBe(true);
        if (!accountA) throw new Error('Expected the canonical Account A lifetime');
        const pendingA = createDeferred<ComputerTargetsListResponseV1>();
        const selectionB = { ...selected, sourceId: 'computer:account-b', consentGranted: true,
            approvalDisplay: { ...selected.approvalDisplay, target: { kind: 'window' as const, title: 'Account B window' } } };
        let targetReads = 0;
        let readinessReads = 0;
        // The delayed machine RPC is the external network boundary. Its old reply
        // may arrive after cancellation; publication below it stays canonical.
        const machine: ComputerMachineRpc = async ({ actionId }) => {
            if (actionId === 'computer.target.get') return ++targetReads === 1 ? selected : selectionB;
            if (actionId === 'computer.targets.list') return ++readinessReads === 1 ? await pendingA.promise
                : { targets: [{ target }], grants: { capture: 'granted', input: 'granted' } };
            if (actionId === 'computer.control.status') return { target, sourceId: selectionB.sourceId,
                controller: 'human', controlEpoch: 2, stopping: false, uncertain: false };
            throw new Error(`Unexpected Computer RPC: ${actionId}`);
        };
        const executor = executorWith(machine, accountA);
        const readerA = await renderHook(() => useComputerSessionControl({ scope, execute: executor.execute }));
        let readerB: typeof readerA | null = null;
        try {
            expect(targetReads).toBe(1);
            expect(readinessReads).toBe(1);
            await act(async () => { storage.getState().activateProfileScope({ serverId, accountId: 'account-b' }); });
            expect(accountA?.isCurrent()).toBe(false);
            await readerA.unmount();
            const accountB = captureActiveServerAccountScopeLifetime();
            if (!accountB) throw new Error('Expected the canonical Account B lifetime');
            const executorB = executorWith(machine, accountB);
            readerB = await renderHook(() => useComputerSessionControl({ scope, execute: executorB.execute }));
            expect(readerB.getCurrent().selection?.sourceId).toBe(selectionB.sourceId);
            expect(readerB.getCurrent().presence.kind).toBe('human');
            await act(async () => { pendingA.resolve({ targets: [], grants: { capture: 'denied', input: 'denied' } }); });
            expect(readerB.getCurrent().selection?.sourceId).toBe(selectionB.sourceId);
            expect(readerB.getCurrent().targetTitle).toBe('Account B window');
            expect(readerB.getCurrent().presence.kind).toBe('human');
        } finally {
            await readerB?.unmount();
            if (!readerB) await readerA.unmount();
            publishAppliedActiveServerRuntimeAvailability(false);
            storage.setState({ profileScope: previousScope, profile: previousProfile });
            publishAppliedActiveServerSnapshot(previousSnapshot, previousAvailable);
        }
    });

    it.each(['parked', 'unmounted'] as const)('does not start another ordinary read after the final reader is %s', async retirement => {
        const pendingTarget = createDeferred<typeof selected>();
        const calls: string[] = [];
        const machine: ComputerMachineRpc = async ({ actionId }) => {
            calls.push(actionId);
            if (actionId === 'computer.target.get') return await pendingTarget.promise;
            if (actionId === 'computer.targets.list') return { targets: [{ target }], grants: { capture: 'granted', input: 'granted' } };
            if (actionId === 'computer.control.status') return { target, sourceId: selected.sourceId,
                controller: 'human', controlEpoch: 1, stopping: false, uncertain: false };
            throw new Error(`Unexpected Computer RPC: ${actionId}`);
        };
        const executor = executorWith(machine);
        const scope = { sessionId: `retired-read-${retirement}`, machineId: 'ordinary-machine' };
        let enabled = true;
        const reader = await renderHook(() => useComputerSessionControl({ scope, execute: executor.execute, enabled }));
        try {
            expect(calls).toEqual(['computer.target.get']);
            if (retirement === 'parked') {
                enabled = false;
                await reader.rerender();
            } else await reader.unmount();
            await act(async () => { pendingTarget.resolve(selected); });
            // The already-issued read may settle, but it cannot create fresh
            // readiness/status demand for an absent or parked presentation.
            expect(calls).toEqual(['computer.target.get']);
        } finally {
            if (retirement === 'parked') await reader.unmount();
        }
    });

    it('returns a known retired Account effect acknowledgement without applying its selection to a new Account reader', async () => {
        const { storage } = await import('@/sync/domains/state/storageStore');
        const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        const { getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable, publishAppliedActiveServerSnapshot, publishAppliedActiveServerRuntimeAvailability } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
        const previousScope = storage.getState().profileScope;
        const previousProfile = storage.getState().profile;
        const previousSnapshot = getAppliedActiveServerSnapshot();
        const previousAvailable = isAppliedActiveServerRuntimeAvailable();
        const serverId = 'computer-effect-home';
        const scope = { serverId, sessionId: 'same-effect-session', machineId: 'same-effect-machine' };
        storage.getState().activateProfileScope({ serverId, accountId: 'account-a' });
        publishAppliedActiveServerSnapshot({ serverId, serverUrl: 'https://computer-effect.test', generation: 1 });
        const accountA = captureActiveServerAccountScopeLifetime();
        expect(accountA?.isCurrent()).toBe(true);
        if (!accountA) throw new Error('Expected the canonical Account A lifetime');
        const pendingSelection = createDeferred<typeof selected>();
        const issuedSelection = createDeferred<void>();
        const nextBRead = createDeferred<typeof selected>();
        const selectionB = { ...selected, sourceId: 'computer:effect-account-b', consentGranted: true,
            approvalDisplay: { ...selected.approvalDisplay, target: { kind: 'window' as const, title: 'Account B effect window' } } };
        let boundaryAccount: 'a' | 'b' = 'a';
        let bTargetReads = 0;
        // Hold the later owner re-read too: an immediate refresh must not hide
        // an old Account selection briefly disclosed to the new reader.
        const machine: ComputerMachineRpc = async ({ actionId }) => {
            if (actionId === 'computer.target.select') {
                issuedSelection.resolve();
                return await pendingSelection.promise;
            }
            if (actionId === 'computer.target.get') {
                if (boundaryAccount === 'a') return { ...selected, consentGranted: true };
                return ++bTargetReads === 1 ? selectionB : await nextBRead.promise;
            }
            if (actionId === 'computer.targets.list') return { targets: [{ target }], grants: { capture: 'granted', input: 'granted' } };
            if (actionId === 'computer.control.status') return { target, sourceId: boundaryAccount === 'a' ? selected.sourceId : selectionB.sourceId,
                controller: 'human', controlEpoch: 2, stopping: false, uncertain: false };
            throw new Error(`Unexpected Computer RPC: ${actionId}`);
        };
        const executor = executorWith(machine, accountA);
        const readerA = await renderHook(() => useComputerSessionControl({ scope, execute: executor.execute }));
        let readerB: typeof readerA | null = null;
        const effect = executor.execute('computer.target.select', { machineId: scope.machineId, target }, {
            surface: 'ui', authority: 'present_user', defaultSessionId: scope.sessionId, serverId,
        });
        try {
            await Promise.race([
                issuedSelection.promise,
                effect.then(result => { throw new Error(`Selection Action settled before its machine RPC: ${JSON.stringify(result)}`); }),
            ]);
            await act(async () => { storage.getState().activateProfileScope({ serverId, accountId: 'account-b' }); });
            expect(accountA?.isCurrent()).toBe(false);
            await readerA.unmount();
            boundaryAccount = 'b';
            const accountB = captureActiveServerAccountScopeLifetime();
            if (!accountB) throw new Error('Expected the canonical Account B lifetime');
            const executorB = executorWith(machine, accountB);
            readerB = await renderHook(() => useComputerSessionControl({ scope, execute: executorB.execute }));
            expect(readerB.getCurrent().selection?.sourceId).toBe(selectionB.sourceId);
            expect(readerB.getCurrent().presence.kind).toBe('human');
            await act(async () => {
                pendingSelection.resolve(selected);
                expect(await effect).toEqual({ ok: true, result: selected });
            });
            expect(readerB.getCurrent().selection?.sourceId).toBe(selectionB.sourceId);
            expect(readerB.getCurrent().targetTitle).toBe('Account B effect window');
            expect(readerB.getCurrent().presence.kind).toBe('human');
        } finally {
            await readerB?.unmount();
            if (!readerB) await readerA.unmount();
            await act(async () => { pendingSelection.resolve(selected); nextBRead.resolve(selectionB); await effect; });
            publishAppliedActiveServerRuntimeAvailability(false);
            storage.setState({ profileScope: previousScope, profile: previousProfile });
            publishAppliedActiveServerSnapshot(previousSnapshot, previousAvailable);
        }
    });

    it('sends the person’s choice to the named machine for this Session, through the Action front door', async () => {
        const machine = vi.fn<ComputerMachineRpc>(async () => selected);
        const result = await executorWith(machine).execute('computer.target.select', { machineId: 'machine_1', target }, {
            surface: 'ui', authority: 'present_user', defaultSessionId: 'session_1', serverId: 'home_1',
        });
        expect(result).toEqual({ ok: true, result: selected });
        expect(machine).toHaveBeenCalledWith(expect.objectContaining({
            serverId: 'home_1', machineId: 'machine_1', sessionId: 'session_1',
            actionId: 'computer.target.select', input: { machineId: 'machine_1', target },
        }));
    });

    it('never carries an agent’s or a Session-less request onto the person’s route', async () => {
        const machine = vi.fn<ComputerMachineRpc>(async () => selected);
        const executor = executorWith(machine);
        expect(await executor.execute('computer.control.status', { machineId: 'machine_1' }, {
            surface: 'ui', authority: 'account_automation', defaultSessionId: 'session_1',
        })).toMatchObject({ ok: false, errorCode: 'present_user_required' });
        expect(await executor.execute('computer.control.status', { machineId: 'machine_1' }, {
            surface: 'ui', authority: 'present_user',
        })).toMatchObject({ ok: false, errorCode: 'computer_session_required' });
        expect(machine).not.toHaveBeenCalled();
    });

    it('returns the computer owner’s refusal as a failure, not as a payload', async () => {
        const machine = vi.fn<ComputerMachineRpc>(async () => ({ ok: false, errorCode: 'computer_target_in_use', error: 'computer_target_in_use' }));
        expect(await executorWith(machine).execute('computer.target.select', { machineId: 'machine_1', target }, {
            surface: 'ui', authority: 'present_user', defaultSessionId: 'session_1',
        })).toMatchObject({ ok: false, errorCode: 'computer_target_in_use' });
    });
});
