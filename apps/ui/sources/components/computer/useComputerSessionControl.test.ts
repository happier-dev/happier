import { describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createUnavailableRuntimeActionExecutor } from '@happier-dev/protocol/actions/executor/dispatch';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import type { ComputerControlStatusResponseV1, ComputerSelectedTargetResponseV1 } from '@happier-dev/protocol/computer/v1';
import type { MachineLiveStreamFrameV1 } from '@happier-dev/protocol/machines/peer/mediation/stream/v1';

import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { createComputerRuntimeActionExecutor, type ComputerMachineRpc } from '@/sync/domains/computer/actions/runtimeActionExecutor';
import { createComputerControlClient, getComputerSessionProjection, publishComputerStatusFrame, publishComputerStreamInputFailure } from '@/sync/domains/computer/computerControlClient';
import { encodeBase64 } from '@/encryption/base64';

import { useComputerSessionControl } from './useComputerSessionControl';
import { useComputerTargetPicker } from './useComputerTargetPicker';
import { computerTargetKeyV1, type ComputerTargetsListResponseV1 } from '@happier-dev/protocol/computer/v1';

const target = { kind: 'window', displayId: ':77', pid: 123, windowId: 456 } as const;
const identity = { target, sourceId: 'computer:1' };
const targetList = { targets: [{ target }], grants: { capture: 'granted', input: 'granted' } } as const;
const selection = {
    consentGranted: true,
    access: 'use',
    selectedTarget: target,
    sourceId: 'computer:1',
    approvalDisplay: { machineDisplayName: 'Studio laptop', requiresTargetSelection: false, target: { kind: 'window', title: 'Sign in to Lumen' } },
} satisfies ComputerSelectedTargetResponseV1;
const status = (controller: 'agent' | 'human' | 'idle', extra: Partial<{ stopping: boolean; uncertain: boolean; controlEpoch: number }> = {}) => ({
    ...identity, controller, controlEpoch: extra.controlEpoch ?? 1, stopping: extra.stopping ?? false, uncertain: extra.uncertain ?? false,
    grants: targetList.grants,
});
const capture = {
    ...identity, status: 'captured', captureId: 'capture_2',
    geometry: { captureWidth: 10, captureHeight: 10, nativeWidth: 10, nativeHeight: 10, originX: 0, originY: 0, scaleX: 1, scaleY: 1, crop: { x: 0, y: 0, width: 10, height: 10 } },
    media: { mediaId: 'm', mediaKind: 'image', width: 10, height: 10, sizeBytes: 1,
        file: { sessionId: 'session_1', storage: 'daemon', path: 'p.png', sha256: 'a'.repeat(64), mimeType: 'image/png' } },
};

/** A machine whose computer owner answers like W7's: the stop is pending until its interrupt settles. */
function createMachine() {
    let current = status('agent');
    const interrupt = createDeferred<'known' | 'unknown'>();
    const calls: string[] = [];
    const machine: ComputerMachineRpc = async ({ actionId }) => {
        calls.push(actionId);
        switch (actionId) {
            case 'computer.targets.list': return targetList;
            case 'computer.target.get': return selection;
            case 'computer.target.select': return selection;
            case 'computer.control.status': return current;
            case 'computer.control.interrupt': {
                current = status('human', { stopping: true, controlEpoch: 2 });
                const completion = await interrupt.promise;
                current = status('human', { controlEpoch: 2, uncertain: completion === 'unknown' });
                return { ...identity, status: 'interrupted', completion };
            }
            case 'computer.capture':
                current = status('human', { controlEpoch: 2 });
                return capture;
            case 'computer.control.handBack':
                current = status('idle', { controlEpoch: 3 });
                return { ...identity, status: 'dispatched' };
            default: return { ok: false, errorCode: 'unexpected', error: 'unexpected' };
        }
    };
    return { machine: vi.fn(machine), interrupt, calls };
}

function executorWith(machine: ComputerMachineRpc) {
    // These unrelated host transport ports are absent from this computer fixture. Reject any escape
    // into one instead of inventing a successful response; the real Action/compiler contracts stay intact.
    const unavailablePort = async (): Promise<never> => { throw new Error('Unexpected non-computer host transport'); };
    return createActionExecutor({
        executionRunStart: unavailablePort,
        executionRunList: unavailablePort,
        executionRunGet: unavailablePort,
        detachedExecutionRunSend: unavailablePort,
        executionRunStop: unavailablePort,
        executionRunAction: unavailablePort,
        executionRunWait: unavailablePort,
        sessionOpen: unavailablePort,
        sessionFork: unavailablePort,
        sessionRollback: unavailablePort,
        sessionSpawnNew: unavailablePort,
        pathsListRecent: unavailablePort,
        machinesList: unavailablePort,
        serversList: unavailablePort,
        reviewEnginesList: unavailablePort,
        agentsBackendsList: unavailablePort,
        agentsModelsList: unavailablePort,
        sessionSendMessage: unavailablePort,
        sessionModeSet: unavailablePort,
        sessionModesList: unavailablePort,
        sessionList: unavailablePort,
        sessionActivityGet: unavailablePort,
        sessionRecentMessagesGet: unavailablePort,
        resetGlobalVoiceAgent: unavailablePort,
        daemonMemorySearch: unavailablePort,
        daemonMemoryGetWindow: unavailablePort,
        daemonMemoryEnsureUpToDate: unavailablePort,
        runtimeActionExecute: createComputerRuntimeActionExecutor({ executeOnMachine: machine, fallback: createUnavailableRuntimeActionExecutor() }),
    } satisfies ActionExecutorDeps);
}

async function renderControl(machine: ComputerMachineRpc) {
    const executor = executorWith(machine);
    return await renderHook(() => useComputerSessionControl({
        scope: { sessionId: 'session_1', machineId: 'machine_1' },
        execute: executor.execute,
    }));
}

describe('useComputerSessionControl', () => {
    it.each(['computer.target.get', 'computer.control.status'] as const)(
        'keeps a known share available for release after a failed %s read', async failedAction => {
            let failing = false;
            let shared = true;
            const machine: ComputerMachineRpc = async ({ actionId }) => {
                if (failing && actionId === failedAction) return { ok: false, errorCode: 'MACHINE_RPC_TIMEOUT', error: 'MACHINE_RPC_TIMEOUT' };
                if (actionId === 'computer.target.get') return shared ? selection : {
                    consentGranted: false, approvalDisplay: { machineDisplayName: 'Studio laptop', requiresTargetSelection: true },
                };
                if (actionId === 'computer.targets.list') return targetList;
                if (actionId === 'computer.control.status') return status('human');
                throw new Error(`Unexpected Computer RPC: ${actionId}`);
            };
            const hook = await renderControl(machine);
            try {
                expect(hook.getCurrent().selection?.sourceId).toBe(selection.sourceId);
                failing = true;
                await act(async () => hook.getCurrent().refresh());
                expect(hook.getCurrent().failure).toBe('MACHINE_RPC_TIMEOUT');
                expect(hook.getCurrent().stopFailed).toBe(false);
                expect(hook.getCurrent().selection?.sourceId).toBe(selection.sourceId);
                expect(hook.getCurrent().canInput).toBe(false);
                failing = false;
                shared = false;
                await act(async () => hook.getCurrent().refresh());
                expect(hook.getCurrent().selection?.sourceId).toBeUndefined();
                expect(hook.getCurrent().failure).toBeNull();
            } finally { await hook.unmount(); }
        },
    );

    it('reports an unconfirmed release and keeps Stop sharing available until the owner confirms closure', async () => {
        let closes = 0;
        let shared = true;
        const machine: ComputerMachineRpc = async ({ actionId }) => {
            if (actionId === 'computer.target.close') {
                if (++closes === 1) return { ...identity, targetLabel: 'Sign in to Lumen', status: 'interrupted', completion: 'unknown' };
                shared = false;
                return { ...identity, targetLabel: 'Sign in to Lumen', status: 'dispatched' };
            }
            if (actionId === 'computer.target.get') return shared ? selection : {
                consentGranted: false, approvalDisplay: { machineDisplayName: 'Studio laptop', requiresTargetSelection: true },
            };
            if (actionId === 'computer.targets.list') return targetList;
            if (actionId === 'computer.control.status') return status('human');
            throw new Error(`Unexpected Computer RPC: ${actionId}`);
        };
        const hook = await renderControl(machine);
        try {
            await act(async () => hook.getCurrent().stopSharing());
            expect(hook.getCurrent().selection?.sourceId).toBe(selection.sourceId);
            expect(hook.getCurrent().failure).toBe('control_not_drained');
            // The failure belongs to the person's Stop sharing, so the viewer can say so.
            expect(hook.getCurrent().stopFailed).toBe(true);
            expect(hook.getCurrent().busy).toBeNull();
            await act(async () => hook.getCurrent().stopSharing());
            expect(hook.getCurrent().selection?.sourceId).toBeUndefined();
            expect(hook.getCurrent().failure).toBeNull();
            expect(hook.getCurrent().stopFailed).toBe(false);
            expect(hook.getCurrent().busy).toBeNull();
        } finally { await hook.unmount(); }
    });

    it('retires the mounted source from the close answer with no follow-up target read', async () => {
        let shared = true;
        const calls: string[] = [];
        const hook = await renderControl(async ({ actionId }) => {
            calls.push(actionId);
            if (actionId === 'computer.target.close') {
                shared = false;
                return { ...identity, targetLabel: 'Sign in to Lumen', status: 'dispatched' };
            }
            if (actionId === 'computer.target.get') return shared ? selection : {
                consentGranted: false, approvalDisplay: { machineDisplayName: 'Studio laptop', requiresTargetSelection: true },
            };
            if (actionId === 'computer.control.status') return status('human');
            throw new Error(`Unexpected Computer RPC: ${actionId}`);
        });
        try {
            calls.length = 0;
            await act(async () => hook.getCurrent().stopSharing());
            expect(calls).toEqual(['computer.target.close']);
            expect(hook.getCurrent().selection).toMatchObject({ consentGranted: false, approvalDisplay: { requiresTargetSelection: true } });
            expect(hook.getCurrent().failure).toBeNull();
            expect(hook.getCurrent().busy).toBeNull();
        } finally { await hook.unmount(); }
    });

    it('does not request picker thumbnails while refreshing control and waits for current grants before admitting the picture', async () => {
        const controller = createDeferred<ComputerControlStatusResponseV1>();
        const calls: string[] = [];
        const machine: ComputerMachineRpc = async ({ actionId }) => {
            calls.push(actionId);
            if (actionId === 'computer.target.get') return selection;
            if (actionId === 'computer.targets.list') throw new Error('Picker thumbnails are unavailable');
            if (actionId === 'computer.control.status') return await controller.promise;
            throw new Error(`Unexpected Computer RPC: ${actionId}`);
        };
        const hook = await renderControl(machine);
        try {
            expect(hook.getCurrent().canRead).toBe(false);
            expect(calls).toContain('computer.control.status');
            expect(hook.getCurrent().selection?.sourceId).toBe(selection.sourceId);
            await act(async () => { controller.resolve(status('human')); });
            expect(hook.getCurrent().canRead).toBe(true);
            expect(hook.getCurrent().presence.kind).toBe('human');
            expect(calls).not.toContain('computer.targets.list');
        } finally {
            controller.resolve(status('human'));
            await hook.unmount();
        }
    });

    it.each([
        { access: 'see', displayAccess: undefined, expected: 'see' },
        { access: 'use', displayAccess: undefined, expected: 'use' },
        { access: undefined, displayAccess: 'see', expected: 'see' },
        { access: undefined, displayAccess: undefined, expected: null },
    ] as const)('never widens access when recovering an uncertain selection ($access, $displayAccess)', async ({ access, displayAccess, expected }) => {
        const currentSelection = { ...selection, access, approvalDisplay: { ...selection.approvalDisplay, access: displayAccess } };
        const selections: unknown[] = [];
        let captures = 0;
        const machine: ComputerMachineRpc = async ({ actionId, input }) => {
            if (actionId === 'computer.target.get') return currentSelection;
            if (actionId === 'computer.targets.list') return targetList;
            if (actionId === 'computer.control.status') return status('human', { uncertain: true });
            if (actionId === 'computer.target.select') { selections.push(input); return currentSelection; }
            if (actionId === 'computer.capture') { captures += 1; return capture; }
            throw new Error(`Unexpected recovery RPC: ${actionId}`);
        };
        const hook = await renderControl(machine);
        try {
            await act(async () => hook.getCurrent().checkAgain());
            if (expected) {
                expect(selections).toEqual([{ machineId: 'machine_1', target, access: expected }]);
                expect(captures).toBe(1);
            } else {
                expect(selections).toEqual([]);
                expect(captures).toBe(0);
                expect(hook.getCurrent().failure).toBe('invalid_action_output');
                expect(hook.getCurrent().canInput).toBe(false);
            }
        } finally { await hook.unmount(); }
    });

    it('keeps the admitted cached Machine identity when Computer discovery fails and withdraws it on Account retirement', async () => {
        const { storage } = await import('@/sync/domains/state/storageStore');
        const { activateStorageAccountScope } = await import('@/dev/testkit/runtime/storageRuntime');
        const { createMachineFixture } = await import('@/dev/testkit/fixtures/machineFixtures');
        const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        const accountScope = { serverId: 'computer-identity-home', accountId: 'computer-identity-account' };
        const previousProfile = storage.getState().profile;
        const previousLists = storage.getState().machineListByServerId;
        const previousStatuses = storage.getState().machineListStatusByServerId;
        const owner = await activateStorageAccountScope(accountScope);
        const accountLifetime = captureActiveServerAccountScopeLifetime();
        if (!accountLifetime) throw new Error('Expected the canonical Computer Account lifetime');
        const cachedMachine = createMachineFixture({ id: 'computer-identity-machine', active: false,
            metadata: { ...createMachineFixture().metadata!, host: 'cached-host', displayName: 'Cached studio' } });
        storage.setState({ machineListByServerId: { ...previousLists, [accountScope.serverId]: [cachedMachine] },
            machineListStatusByServerId: { ...previousStatuses, [accountScope.serverId]: 'idle' } });
        let reachable = false;
        const executor = executorWith(async ({ actionId }) => {
            if (!reachable) return { ok: false, errorCode: 'machine_unreachable', error: 'Machine is unreachable' };
            if (actionId === 'computer.target.get') return selection;
            if (actionId === 'computer.targets.list') return targetList;
            return status('human');
        });
        const scope = { serverId: accountScope.serverId, sessionId: 'computer-identity-session', machineId: cachedMachine.id };
        let enabled = true;
        let renders = 0;
        const hook = await renderHook(() => {
            renders += 1;
            return useComputerSessionControl({ scope, execute: executor.execute, accountLifetime, enabled });
        });
        try {
            expect(hook.getCurrent().failure).toBe('machine_unreachable');
            expect(hook.getCurrent().selection).toBeNull();
            expect(hook.getCurrent().machineName).toBe('Cached studio');
            // A Machine this device cannot read yet has no name to put in a sentence: not "Locked machine".
            await act(async () => storage.setState({ machineListByServerId: { ...previousLists,
                [accountScope.serverId]: [{ ...cachedMachine, availability: { kind: 'locked', reason: 'recipient_key_pending' } }] } }));
            expect(hook.getCurrent().machineName).toBeNull();
            await act(async () => storage.setState({ machineListByServerId: { ...previousLists,
                [accountScope.serverId]: [{ ...cachedMachine, metadata: { ...cachedMachine.metadata!, displayName: 'Renamed studio' } }] } }));
            expect(hook.getCurrent().machineName).toBe('Renamed studio');
            enabled = false;
            await hook.rerender();
            const parkedRenders = renders;
            await act(async () => storage.setState({ machineListByServerId: { ...previousLists,
                [accountScope.serverId]: [{ ...cachedMachine, metadata: { ...cachedMachine.metadata!, displayName: 'Resumed studio' } }] } }));
            expect(renders).toBe(parkedRenders);
            expect(hook.getCurrent().machineName).toBe('Renamed studio');
            enabled = true;
            await hook.rerender();
            expect(hook.getCurrent().machineName).toBe('Resumed studio');
            reachable = true;
            await act(async () => { hook.getCurrent().refresh(); });
            expect(hook.getCurrent().machineName).toBe(selection.approvalDisplay.machineDisplayName);
            enabled = false;
            await hook.rerender();
            await act(async () => { storage.getState().activateProfileScope({ ...accountScope, accountId: 'replacement-account' }); });
            expect(hook.getCurrent().machineName).toBeNull();
        } finally {
            await hook.unmount();
            storage.setState({ profile: previousProfile, machineListByServerId: previousLists, machineListStatusByServerId: previousStatuses });
            owner.dispose();
        }
    });

    it.each(['absent', 'foreign_home', 'unadmitted'] as const)('does not borrow a cached Machine identity from %s data', async inputClass => {
        const { storage } = await import('@/sync/domains/state/storageStore');
        const { activateStorageAccountScope } = await import('@/dev/testkit/runtime/storageRuntime');
        const { createMachineFixture } = await import('@/dev/testkit/fixtures/machineFixtures');
        const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        const accountScope = { serverId: `identity-${inputClass}-home`, accountId: 'identity-account' };
        const previousLists = storage.getState().machineListByServerId;
        const previousStatuses = storage.getState().machineListStatusByServerId;
        const owner = await activateStorageAccountScope(accountScope);
        const accountLifetime = captureActiveServerAccountScopeLifetime();
        const machine = createMachineFixture({ id: 'identity-machine', metadata: { ...createMachineFixture().metadata!, host: 'private-host', displayName: 'Private studio' } });
        storage.setState({ machineListByServerId: { ...previousLists, [accountScope.serverId]: inputClass === 'absent' ? [] : [machine] },
            machineListStatusByServerId: { ...previousStatuses, [accountScope.serverId]: 'idle' } });
        const executor = executorWith(async () => ({ ok: false, errorCode: 'machine_unreachable', error: 'Machine is unreachable' }));
        const hook = await renderHook(() => useComputerSessionControl({
            scope: { serverId: inputClass === 'foreign_home' ? 'another-home' : accountScope.serverId,
                sessionId: `identity-${inputClass}-session`, machineId: machine.id },
            execute: executor.execute, accountLifetime: inputClass === 'unadmitted' ? null : accountLifetime,
        }));
        try { expect(hook.getCurrent().machineName).toBeNull(); }
        finally {
            await hook.unmount();
            storage.setState({ machineListByServerId: previousLists, machineListStatusByServerId: previousStatuses });
            owner.dispose();
        }
    });

    it.each(['stale_capture', 'capture_expired', 'capture_generation_mismatch', 'capture_frame_mismatch', 'capture_coordinate_invalid', 'human_input_interruption_uncertain', 'background_unavailable'] as const)('retains the exact source but blocks input after %s until capture is confirmed', async code => {
        const { machine, calls } = createMachine();
        const scope = { sessionId: 'input-refusal', machineId: 'machine_1' };
        const executor = executorWith(machine);
        const hook = await renderHook(() => useComputerSessionControl({ scope, execute: executor.execute }));
        await act(async () => publishComputerStreamInputFailure(scope, 'foreign-source', 'stale_capture'));
        expect(hook.getCurrent().canInput).toBe(true);
        await act(async () => publishComputerStreamInputFailure(scope, selection.sourceId, code));
        expect(hook.getCurrent().failure).toBe(code);
        expect(hook.getCurrent().selection?.sourceId).toBe(selection.sourceId);
        expect(hook.getCurrent().canInput).toBe(false);
        await act(async () => getComputerSessionProjection(scope, executor.execute).applyStatus(status('human')));
        expect(hook.getCurrent().failure).toBe(code);
        await act(async () => hook.getCurrent().refresh());
        expect(hook.getCurrent().failure).toBe(code);
        await act(async () => hook.getCurrent().checkAgain());
        expect(hook.getCurrent().failure).toBeNull();
        expect(hook.getCurrent().canInput).toBe(true);
        expect(calls.filter(action => action === 'computer.capture')).toHaveLength(1);
        expect(calls.filter(action => action === 'computer.target.select')).toHaveLength(code === 'human_input_interruption_uncertain' || code === 'background_unavailable' ? 1 : 0);
        expect(calls).not.toContain('computer.input');
    });
    it('does not release the native quarantine when an explicit recapture still fails', async () => {
        const calls: string[] = [];
        const machine: ComputerMachineRpc = async ({ actionId }) => {
            calls.push(actionId);
            if (actionId === 'computer.target.get') return selection;
            if (actionId === 'computer.target.select') return selection;
            if (actionId === 'computer.targets.list') return targetList;
            if (actionId === 'computer.capture') return { ...identity, status: 'failed', code: 'driver_unavailable' };
            return status('human', { uncertain: true });
        };
        const scope = { sessionId: 'quarantined-native', machineId: 'machine_1' };
        const executor = executorWith(machine);
        const hook = await renderHook(() => useComputerSessionControl({ scope, execute: executor.execute }));
        await act(async () => publishComputerStreamInputFailure(scope, selection.sourceId, 'human_input_interruption_uncertain'));
        await act(async () => hook.getCurrent().checkAgain());
        expect(hook.getCurrent().canInput).toBe(false);
        expect(hook.getCurrent().presence.kind).toBe('unconfirmed');
        expect(hook.getCurrent().failure).toBe('driver_unavailable');
        expect(calls).not.toContain('computer.input');
    });

    it('keeps unknown input quarantined when admitted source recovery is refused', async () => {
        const calls: string[] = [];
        const machine: ComputerMachineRpc = async ({ actionId }) => {
            calls.push(actionId);
            if (actionId === 'computer.target.get') return selection;
            if (actionId === 'computer.targets.list') return targetList;
            if (actionId === 'computer.control.status') return status('human', { uncertain: true });
            if (actionId === 'computer.target.select') return { ok: false, errorCode: 'approval_rejected', error: 'approval_rejected' };
            if (actionId === 'computer.capture') return capture;
            throw new Error(`Unexpected recovery RPC: ${actionId}`);
        };
        const hook = await renderControl(machine);
        await act(async () => { hook.getCurrent().checkAgain(); });
        expect(hook.getCurrent().canInput).toBe(false);
        expect(hook.getCurrent().presence.kind).toBe('unconfirmed');
        expect(hook.getCurrent().failure).toBe('approval_rejected');
        expect(calls).not.toContain('computer.capture');
        expect(calls).not.toContain('computer.input');
    });

    it('refuses Computer reads and effects when borrowed Account authority is explicitly unavailable', async () => {
        const { machine, calls } = createMachine();
        const executor = executorWith(machine);
        const client = createComputerControlClient({ sessionId: 'unavailable-account-session', machineId: 'machine_1' }, executor.execute, null);
        expect(client.isCurrent()).toBe(false);
        expect(await client.listTargets()).toEqual({ ok: false, code: 'action_account_scope_changed' });
        expect(await client.getTarget()).toEqual({ ok: false, code: 'action_account_scope_changed' });
        expect(await client.selectTarget(target)).toEqual({ ok: false, code: 'action_account_scope_changed' });
        expect(calls).toEqual([]);
    });
    it.each(['computer_target_not_available', 'forbidden'] as const)('retires shared read and control facts after an owner refusal: %s', async code => {
        let available = true;
        const machine: ComputerMachineRpc = async ({ actionId }) => available
            ? actionId === 'computer.target.get' ? selection : actionId === 'computer.targets.list' ? targetList : status('human')
            : { ok: false, errorCode: code, error: code };
        const executor = executorWith(machine);
        const scope = { sessionId: `lost-source-${code}`, machineId: 'machine_1' };
        const hook = await renderHook(() => ({
            viewer: useComputerSessionControl({ scope, execute: executor.execute }),
            strip: useComputerSessionControl({ scope, execute: executor.execute }),
        }));
        expect(hook.getCurrent().viewer.selection?.sourceId).toBe('computer:1');
        available = false;
        await act(async () => { hook.getCurrent().viewer.refresh(); });
        expect(hook.getCurrent().viewer.selection?.sourceId).toBeUndefined();
        expect(hook.getCurrent().strip.presence.kind).toBe('idle');
        expect(hook.getCurrent().viewer.failure).toBe(code);
    });

    it('observes separate OS grants on the ordinary Machine and does not grant use after opening Settings', async () => {
        let grants: ComputerTargetsListResponseV1['grants'] = { capture: 'granted', input: 'denied' };
        const calls: string[] = [];
        const machine: ComputerMachineRpc = async ({ actionId }) => {
            calls.push(actionId);
            if (actionId === 'computer.targets.list') return { targets: [{ target }], grants };
            if (actionId === 'computer.permissions.openSettings') return { status: 'dispatched' };
            if (actionId === 'computer.target.select') return selection;
            return actionId === 'computer.target.get' ? selection : { ...status('human'), grants };
        };
        const executor = executorWith(machine);
        const scope = { sessionId: 'native-grants', machineId: 'ordinary-machine' };
        const callbacks = { onSelected: vi.fn(), onClose: vi.fn() };
        const hook = await renderHook(() => ({
            control: useComputerSessionControl({ scope, execute: executor.execute }),
            picker: useComputerTargetPicker({ scope, execute: executor.execute, currentTargetKey: computerTargetKeyV1(target), access: 'use', ...callbacks }),
        }));
        await act(async () => { hook.getCurrent().picker.requestSettings('input'); });
        expect(hook.getCurrent().picker.openSettings).toBe('opened');
        await act(async () => { hook.getCurrent().picker.share(); });
        expect(calls).not.toContain('computer.target.select');
        expect(hook.getCurrent().control.canRead).toBe(true);
        expect(hook.getCurrent().control.canInput).toBe(false);
        grants = { capture: 'granted', input: 'granted' };
        expect(hook.getCurrent().control.canInput).toBe(false);
        await act(async () => { hook.getCurrent().picker.retry(); });
        expect(hook.getCurrent().control.canInput).toBe(true);
        await act(async () => { hook.getCurrent().picker.share(); });
        expect(callbacks.onSelected).toHaveBeenCalledWith(expect.objectContaining({ selectedTarget: target }));
        grants = { capture: 'denied', input: 'granted' };
        await act(async () => { hook.getCurrent().picker.retry(); });
        expect(hook.getCurrent().control.canRead).toBe(false);
        expect(hook.getCurrent().control.selection?.sourceId).toBe(selection.sourceId);
    });

    it('keeps a refreshing list visible, then removes a lost choice and refuses unknown OS grants', async () => {
        let listed: ComputerTargetsListResponseV1 = { targets: [{ target }], grants: { capture: 'granted', input: 'granted' } };
        const nextList = createDeferred<ComputerTargetsListResponseV1>();
        let pending = false;
        const machine = vi.fn<ComputerMachineRpc>(async ({ actionId }) => actionId === 'computer.targets.list'
            ? pending ? await nextList.promise : listed : selection);
        const executor = executorWith(machine);
        const scope = { sessionId: 'lost-picker-target', machineId: 'ordinary-machine' };
        const callbacks = { onSelected: vi.fn(), onClose: vi.fn() };
        const hook = await renderHook(() => useComputerTargetPicker({ scope, execute: executor.execute,
            currentTargetKey: computerTargetKeyV1(target), ...callbacks }));
        const previous = hook.getCurrent().state;
        pending = true;
        await act(async () => { hook.getCurrent().retry(); });
        expect(hook.getCurrent().state).toBe(previous);
        await act(async () => { nextList.resolve({ ...listed, targets: [] }); });
        expect(hook.getCurrent().selectedKey).toBeNull();
        pending = false;
        listed = { targets: [{ target }], grants: { capture: 'unknown', input: 'unknown' } };
        await act(async () => { hook.getCurrent().retry(); });
        await act(async () => { hook.getCurrent().setSelectedKey(computerTargetKeyV1(target)); });
        await act(async () => { hook.getCurrent().share(); });
        expect(callbacks.onSelected).not.toHaveBeenCalled();
        expect(hook.getCurrent().recovery).toMatchObject({ cause: 'permission_unknown', action: 'refresh' });
    });

    it('rechecks OS grants on viewer refresh while retaining the owner-confirmed share for release', async () => {
        let grants: ComputerTargetsListResponseV1['grants'] = { capture: 'granted', input: 'granted' };
        const machine: ComputerMachineRpc = async ({ actionId }) => actionId === 'computer.targets.list'
            ? { targets: [{ target }], grants } : actionId === 'computer.target.get' ? selection : { ...status('human'), grants };
        const hook = await renderControl(machine);
        expect(hook.getCurrent().canInput).toBe(true);
        grants = { capture: 'denied', input: 'granted' };
        await act(async () => { hook.getCurrent().refresh(); });
        expect(hook.getCurrent().canRead).toBe(false);
        expect(hook.getCurrent().selection?.sourceId).toBe(selection.sourceId);
        grants = { capture: 'granted', input: 'denied' };
        expect(hook.getCurrent().canRead).toBe(false);
        await act(async () => { hook.getCurrent().refresh(); });
        expect(hook.getCurrent().selection?.sourceId).toBe('computer:1');
        expect(hook.getCurrent().canRead).toBe(true);
        expect(hook.getCurrent().canInput).toBe(false);
    });

    it('keeps person-side controls available on see-only Agent access when OS input is granted', async () => {
        const machine: ComputerMachineRpc = async ({ actionId }) => actionId === 'computer.targets.list'
            ? targetList : actionId === 'computer.target.get' ? { ...selection, access: 'see' } : status('human');
        const hook = await renderControl(machine);
        expect(hook.getCurrent().selection?.access).toBe('see');
        expect(hook.getCurrent().canRead).toBe(true);
        expect(hook.getCurrent().canInput).toBe(true);
    });

    it('does not guess a replacement from the same app hint after a removed choice and repeated refresh', async () => {
        let listed: ComputerTargetsListResponseV1 = { ...targetList, targets: [{ target, appName: 'Editor' }] };
        const machine: ComputerMachineRpc = async () => listed;
        const executor = executorWith(machine);
        const callbacks = { onSelected: vi.fn(), onClose: vi.fn() };
        const hook = await renderHook(() => useComputerTargetPicker({ scope: { sessionId: 'removed-suggestion', machineId: 'machine_1' },
            execute: executor.execute, currentTargetKey: computerTargetKeyV1(target), requestedTarget: 'Editor', ...callbacks }));
        listed = { ...listed, targets: [] };
        await act(async () => { hook.getCurrent().retry(); });
        expect(hook.getCurrent().selectedKey).toBeNull();
        const replacement = { ...target, windowId: 999 };
        listed = { ...listed, targets: [{ target: replacement, appName: 'Editor' }] };
        await act(async () => { hook.getCurrent().retry(); });
        expect(hook.getCurrent().selectedKey).toBeNull();
        await act(async () => { hook.getCurrent().share(); });
        expect(callbacks.onSelected).not.toHaveBeenCalled();
    });

    it.each(['scope_changed', 'unmounted'] as const)('retires awaited picker callbacks when %s', async retirement => {
        const select = createDeferred<typeof selection>();
        const settings = createDeferred<{ status: 'dispatched' }>();
        const machine: ComputerMachineRpc = async ({ actionId }) => {
            if (actionId === 'computer.targets.list') return targetList;
            if (actionId === 'computer.permissions.openSettings') return await settings.promise;
            return await select.promise;
        };
        const executor = executorWith(machine);
        const callbacks = { onSelected: vi.fn(), onClose: vi.fn() };
        let scope = { sessionId: 'picker-retirement', machineId: 'machine_1' };
        const hook = await renderHook(() => useComputerTargetPicker({ scope, execute: executor.execute,
            currentTargetKey: computerTargetKeyV1(target), ...callbacks }));
        await act(async () => { hook.getCurrent().share(); hook.getCurrent().requestSettings('input'); });
        if (retirement === 'unmounted') await hook.unmount();
        else { scope = { ...scope, machineId: 'machine_2' }; await hook.rerender(); }
        await act(async () => { select.resolve(selection); settings.resolve({ status: 'dispatched' }); });
        expect(callbacks.onSelected).not.toHaveBeenCalled();
        expect(callbacks.onClose).not.toHaveBeenCalled();
        if (retirement === 'scope_changed') expect(hook.getCurrent().openSettings).toBe('idle');
    });

    it('retires picker rows and pending intents with its borrowed Account lifetime', async () => {
        const { storage } = await import('@/sync/domains/state/storageStore');
        const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        const { getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable, publishAppliedActiveServerSnapshot, publishAppliedActiveServerRuntimeAvailability } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
        const previousScope = storage.getState().profileScope;
        const previousProfile = storage.getState().profile;
        const previousSnapshot = getAppliedActiveServerSnapshot();
        const previousAvailable = isAppliedActiveServerRuntimeAvailable();
        const serverId = 'picker-account-home';
        storage.getState().activateProfileScope({ serverId, accountId: 'picker-account-a' });
        publishAppliedActiveServerSnapshot({ serverId, serverUrl: 'https://picker-account.test', generation: 1 });
        const accountLifetime = captureActiveServerAccountScopeLifetime();
        if (!accountLifetime) throw new Error('Expected the canonical picker Account lifetime');
        const select = createDeferred<typeof selection>();
        const settings = createDeferred<{ status: 'dispatched' }>();
        const machine: ComputerMachineRpc = async ({ actionId }) => actionId === 'computer.targets.list' ? targetList
            : actionId === 'computer.permissions.openSettings' ? await settings.promise : await select.promise;
        const executor = executorWith(machine);
        const callbacks = { onSelected: vi.fn(), onClose: vi.fn() };
        const input = { scope: { serverId, sessionId: 'picker-account-session', machineId: 'picker-account-machine' },
            execute: executor.execute, currentTargetKey: computerTargetKeyV1(target), accountLifetime, ...callbacks };
        const picker = await renderHook(() => useComputerTargetPicker(input));
        try {
            expect(picker.getCurrent().state.kind).toBe('ready');
            await act(async () => { picker.getCurrent().share(); picker.getCurrent().requestSettings('input'); });
            await act(async () => { storage.getState().activateProfileScope({ serverId, accountId: 'picker-account-b' }); });
            expect(accountLifetime.isCurrent()).toBe(false);
            expect(picker.getCurrent().state.kind).not.toBe('ready');
            expect(picker.getCurrent().selectedKey).toBeNull();
            await act(async () => { select.resolve(selection); settings.resolve({ status: 'dispatched' }); });
            expect(callbacks.onSelected).not.toHaveBeenCalled();
            expect(callbacks.onClose).not.toHaveBeenCalled();
            expect(picker.getCurrent().openSettings).not.toBe('opened');
        } finally {
            await picker.unmount();
            publishAppliedActiveServerRuntimeAvailability(false);
            storage.setState({ profileScope: previousScope, profile: previousProfile });
            publishAppliedActiveServerSnapshot(previousSnapshot, previousAvailable);
        }
    });

    it('refuses a retired Computer client read but preserves its issued effect acknowledgement', async () => {
        const { storage } = await import('@/sync/domains/state/storageStore');
        const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        const { getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable, publishAppliedActiveServerSnapshot, publishAppliedActiveServerRuntimeAvailability } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
        const previousScope = storage.getState().profileScope;
        const previousProfile = storage.getState().profile;
        const previousSnapshot = getAppliedActiveServerSnapshot();
        const previousAvailable = isAppliedActiveServerRuntimeAvailable();
        const serverId = 'client-account-home';
        storage.getState().activateProfileScope({ serverId, accountId: 'client-account-a' });
        publishAppliedActiveServerSnapshot({ serverId, serverUrl: 'https://client-account.test', generation: 1 });
        const accountLifetime = captureActiveServerAccountScopeLifetime();
        if (!accountLifetime) throw new Error('Expected the canonical client Account lifetime');
        const pendingRead = createDeferred<typeof selection>();
        const effectResult = { ...identity, status: 'dispatched' as const };
        const pendingEffect = createDeferred<typeof effectResult>();
        const readIssued = createDeferred<void>();
        const effectIssued = createDeferred<void>();
        const machine: ComputerMachineRpc = async ({ actionId }) => {
            if (actionId === 'computer.target.get') {
                readIssued.resolve();
                return await pendingRead.promise;
            }
            if (actionId === 'computer.control.handBack') {
                effectIssued.resolve();
                return await pendingEffect.promise;
            }
            throw new Error(`Unexpected Computer RPC: ${actionId}`);
        };
        const executor = executorWith(machine);
        const client = createComputerControlClient({ serverId, sessionId: 'client-account-session', machineId: 'client-account-machine' },
            executor.execute, accountLifetime);
        try {
            const read = client.getTarget();
            const effect = client.handBack();
            // A front-door refusal must fail the fixture immediately, not look
            // like a slow OS operation that never reached the RPC boundary.
            expect(await Promise.race([readIssued.promise.then(() => 'issued'), read])).toBe('issued');
            expect(await Promise.race([effectIssued.promise.then(() => 'issued'), effect])).toBe('issued');
            storage.getState().activateProfileScope({ serverId, accountId: 'client-account-b' });
            pendingRead.resolve(selection);
            pendingEffect.resolve(effectResult);
            expect(await read).toEqual({ ok: false, code: 'action_account_scope_changed' });
            expect(await effect).toMatchObject({ ok: true, value: effectResult });
            expect(await client.handBack()).toEqual({ ok: false, code: 'action_account_scope_changed' });
        } finally {
            publishAppliedActiveServerRuntimeAvailability(false);
            storage.setState({ profileScope: previousScope, profile: previousProfile });
            publishAppliedActiveServerSnapshot(previousSnapshot, previousAvailable);
        }
    });

    it('does not capture after the admitted recovery selection settles for a retired Account', async () => {
        const { storage } = await import('@/sync/domains/state/storageStore');
        const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        const { getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable, publishAppliedActiveServerSnapshot, publishAppliedActiveServerRuntimeAvailability } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
        const previousScope = storage.getState().profileScope;
        const previousProfile = storage.getState().profile;
        const previousSnapshot = getAppliedActiveServerSnapshot();
        const previousAvailable = isAppliedActiveServerRuntimeAvailable();
        const serverId = 'recovery-account-home';
        storage.getState().activateProfileScope({ serverId, accountId: 'recovery-account-a' });
        publishAppliedActiveServerSnapshot({ serverId, serverUrl: 'https://recovery-account.test', generation: 1 });
        const accountLifetime = captureActiveServerAccountScopeLifetime();
        if (!accountLifetime) throw new Error('Expected the canonical recovery Account lifetime');
        const pendingSelection = createDeferred<typeof selection>();
        const selectIssued = createDeferred<void>();
        const calls: string[] = [];
        const machine: ComputerMachineRpc = async ({ actionId }) => {
            calls.push(actionId);
            if (actionId === 'computer.target.get') return selection;
            if (actionId === 'computer.targets.list') return targetList;
            if (actionId === 'computer.control.status') return status('human', { uncertain: true });
            if (actionId === 'computer.target.select') { selectIssued.resolve(); return await pendingSelection.promise; }
            if (actionId === 'computer.capture') return capture;
            throw new Error(`Unexpected recovery RPC: ${actionId}`);
        };
        const executor = executorWith(machine);
        const scope = { serverId, sessionId: 'recovery-account-session', machineId: 'machine_1' };
        const hook = await renderHook(() => useComputerSessionControl({ scope, execute: executor.execute, accountLifetime }));
        try {
            await act(async () => { hook.getCurrent().checkAgain(); });
            expect(calls).toContain('computer.target.select');
            await selectIssued.promise;
            await act(async () => { storage.getState().activateProfileScope({ serverId, accountId: 'recovery-account-b' }); });
            await act(async () => { pendingSelection.resolve({ ...selection, sourceId: 'retired-recovery-source' }); });
            expect(hook.getCurrent().selection).toBeNull();
            expect(hook.getCurrent().canInput).toBe(false);
            expect(calls).not.toContain('computer.capture');
        } finally {
            pendingSelection.resolve(selection);
            await hook.unmount();
            publishAppliedActiveServerRuntimeAvailability(false);
            storage.setState({ profileScope: previousScope, profile: previousProfile });
            publishAppliedActiveServerSnapshot(previousSnapshot, previousAvailable);
        }
    });

    it('parks viewer demand while retaining selection and resumes with a fresh owner read', async () => {
        const { machine, calls } = createMachine();
        const executor = executorWith(machine);
        const scope = { sessionId: 'retained-viewer-demand', machineId: 'machine_1' };
        let enabled = false;
        let turnActive = false;
        const hook = await renderHook(() => useComputerSessionControl({ scope, execute: executor.execute, enabled, refreshKey: turnActive }));
        expect(calls).toEqual([]);
        enabled = true;
        await hook.rerender();
        expect(hook.getCurrent().selection?.sourceId).toBe('computer:1');
        const selected = hook.getCurrent().selection;
        const reads = calls.length;
        enabled = false;
        turnActive = true;
        await hook.rerender();
        await act(async () => { hook.getCurrent().refresh(); });
        expect(calls).toHaveLength(reads);
        expect(hook.getCurrent().selection).toBe(selected);
        enabled = true;
        await hook.rerender();
        expect(calls.filter(id => id === 'computer.control.status')).toHaveLength(2);
        expect(calls.some(id => id === 'computer.target.close' || id === 'session.stop')).toBe(false);
    });
    it('retires a still-mounted Account reader before binding the next Account of the same Home and Session', async () => {
        const { storage } = await import('@/sync/domains/state/storageStore');
        const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        const { getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable, publishAppliedActiveServerSnapshot, publishAppliedActiveServerRuntimeAvailability } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
        const previousScope = storage.getState().profileScope;
        const previousProfile = storage.getState().profile;
        const previousSnapshot = getAppliedActiveServerSnapshot();
        const previousAvailable = isAppliedActiveServerRuntimeAvailable();
        const serverId = 'mounted-computer-home';
        storage.getState().activateProfileScope({ serverId, accountId: 'mounted-account-a' });
        publishAppliedActiveServerSnapshot({ serverId, serverUrl: 'https://mounted-computer.test', generation: 1 });
        let accountLifetime = captureActiveServerAccountScopeLifetime();
        expect(accountLifetime?.isCurrent()).toBe(true);
        let ownerSelection = selection;
        const calls: string[] = [];
        const pendingInterrupt = createDeferred<'known'>();
        const machine: ComputerMachineRpc = async ({ actionId }) => {
            calls.push(actionId);
            if (actionId === 'computer.target.get') return ownerSelection;
            if (actionId === 'computer.targets.list') return targetList;
            if (actionId === 'computer.control.status') return { ...status('human'), sourceId: ownerSelection.sourceId };
            if (actionId === 'computer.control.interrupt') {
                return { ...identity, status: 'interrupted', completion: await pendingInterrupt.promise };
            }
            throw new Error(`Unexpected Computer RPC: ${actionId}`);
        };
        const executor = executorWith(machine);
        const scope = { serverId, sessionId: 'mounted-same-session', machineId: 'mounted-same-machine' };
        const reader = await renderHook(() => useComputerSessionControl({ scope, execute: executor.execute, accountLifetime }));
        const choices: unknown[] = [];
        const picker = await renderHook(() => useComputerTargetPicker({ scope, execute: executor.execute, accountLifetime,
            currentTargetKey: computerTargetKeyV1(target), onSelected: value => choices.push(value),
            onChosen: value => choices.push(value), onClose: () => {} }));
        try {
            expect(reader.getCurrent().selection?.sourceId).toBe(selection.sourceId);
            expect(reader.getCurrent().canRead).toBe(true);
            const oldControl = reader.getCurrent();
            const oldPicker = picker.getCurrent();
            expect(oldPicker.state.kind).toBe('ready');
            let takeover: ReturnType<typeof oldControl.takeControl> | undefined;
            await act(async () => { takeover = oldControl.takeControl(); });
            expect(reader.getCurrent().presence.kind).toBe('stopping');
            const readsBeforeRetirement = calls.length;
            await act(async () => { storage.getState().activateProfileScope({ serverId, accountId: 'mounted-account-b' }); });
            expect(accountLifetime?.isCurrent()).toBe(false);
            // Retirement precedes the parent's render with the next borrowed binding.
            // The still-mounted transcript strip must not disclose Account A facts.
            expect(reader.getCurrent().selection).toBeNull();
            expect(reader.getCurrent().canRead).toBe(false);
            expect(reader.getCurrent().presence.kind).toBe('idle');
            await act(async () => { pendingInterrupt.resolve('known'); });
            expect(await takeover).toEqual({ status: 'unknown' });
            await act(async () => {
                oldControl.checkAgain();
                expect(await oldControl.takeControl()).toEqual({ status: 'failed' });
                oldControl.handBack();
                oldControl.stopSharing();
                oldControl.applySelection(selection);
                oldControl.refresh();
                oldPicker.share();
                oldPicker.stopSharing();
                oldPicker.requestSettings('capture');
            });
            expect(reader.getCurrent().selection).toBeNull();
            expect(picker.getCurrent().state).toEqual({ kind: 'failed', code: 'action_account_scope_changed' });
            expect(choices).toEqual([]);
            expect(calls).toHaveLength(readsBeforeRetirement);
            ownerSelection = { ...selection, sourceId: 'computer:mounted-account-b' };
            accountLifetime = captureActiveServerAccountScopeLifetime();
            expect(accountLifetime?.isCurrent()).toBe(true);
            await reader.rerender();
            expect(reader.getCurrent().selection?.sourceId).toBe(ownerSelection.sourceId);
            expect(reader.getCurrent().presence.kind).toBe('human');
            const currentReads = calls.length;
            const mismatched = createComputerControlClient({ ...scope, serverId: 'another-computer-home' }, executor.execute, accountLifetime);
            const unavailable = createComputerControlClient(scope, executor.execute, null);
            expect(await mismatched.getTarget()).toEqual({ ok: false, code: 'action_account_scope_changed' });
            expect(await unavailable.interrupt()).toEqual({ ok: false, code: 'action_account_scope_changed' });
            expect(calls).toHaveLength(currentReads);
        } finally {
            await picker.unmount();
            await reader.unmount();
            publishAppliedActiveServerRuntimeAvailability(false);
            storage.setState({ profileScope: previousScope, profile: previousProfile });
            publishAppliedActiveServerSnapshot(previousSnapshot, previousAvailable);
        }
    });
    it('shares a retained reader with a reader mounted after the subscription replay', async () => {
        const { machine, calls } = createMachine();
        const executor = executorWith(machine);
        const scope = { sessionId: 'strict-subscription-replay', machineId: 'machine_1' };
        const retained = getComputerSessionProjection(scope, executor.execute);
        // Exercise the actual external-store cleanup/re-subscribe sequence. The
        // legacy test renderer does not replay subscriptions for a Strict wrapper.
        const unsubscribe = retained.subscribe(() => {});
        unsubscribe();
        const stopRetained = retained.subscribe(() => {});
        const later = await renderHook(() => useComputerSessionControl({ scope, execute: executor.execute }));
        expect(later.getCurrent().presence.kind).toBe('agent');
        expect(calls.filter(id => id === 'computer.target.get')).toHaveLength(1);
        expect(calls.filter(id => id === 'computer.control.status')).toHaveLength(1);
        await later.unmount();
        stopRetained();
    });
    it('refreshes after a turn transition even when an earlier read is still pending', async () => {
        const pendingStatus = createDeferred<ComputerControlStatusResponseV1>();
        let statusReads = 0;
        let current = status('agent');
        let turnActive = false;
        const machine: ComputerMachineRpc = async ({ actionId }) => {
            if (actionId === 'computer.targets.list') return targetList;
            if (actionId === 'computer.target.get') return selection;
            return ++statusReads === 2 ? await pendingStatus.promise : current;
        };
        const executor = executorWith(machine);
        const scope = { sessionId: 'turn-transition', machineId: 'machine_1' };
        const hook = await renderHook(() => useComputerSessionControl({ scope, execute: executor.execute, refreshKey: turnActive }));
        await act(async () => { hook.getCurrent().refresh(); });
        expect(statusReads).toBe(2);
        turnActive = true;
        current = status('human', { controlEpoch: 2 });
        await hook.rerender();
        await act(async () => { pendingStatus.resolve(status('agent')); });
        expect(hook.getCurrent().presence.kind).toBe('human');
        expect(statusReads).toBe(3);
    });
    it('keeps a source transition newer than an already pending status read', async () => {
        const pendingStatus = createDeferred<ComputerControlStatusResponseV1>();
        let statusReads = 0;
        const machine: ComputerMachineRpc = async ({ actionId }) => {
            if (actionId === 'computer.targets.list') return targetList;
            if (actionId === 'computer.target.get') return selection;
            return ++statusReads === 1 ? status('agent') : await pendingStatus.promise;
        };
        const executor = executorWith(machine);
        const scope = { sessionId: 'in-flight-metadata', machineId: 'machine_1' };
        const hook = await renderHook(() => useComputerSessionControl({ scope, execute: executor.execute }));
        await act(async () => { hook.getCurrent().refresh(); });
        expect(statusReads).toBe(2);
        const payload = new TextEncoder().encode(JSON.stringify(status('human', { controlEpoch: 2 })));
        await act(async () => {
            publishComputerStatusFrame(scope, 'computer:1', { v: 1, streamId: 'stream', sequence: 2, timestampMs: 2,
                payloadKind: 'metadata', payloadEncoding: 'binary_base64', payloadBase64: encodeBase64(payload), payloadSizeBytes: payload.length });
            pendingStatus.resolve(status('agent'));
        });
        expect(hook.getCurrent().presence.kind).toBe('human');
    });
    it('publishes only strict selected-source status to all readers, without image or identical-status renders', async () => {
        const { machine, calls } = createMachine();
        const executor = executorWith(machine);
        const scope = { sessionId: 'metadata-session', machineId: 'machine_1' };
        let renders = 0;
        const hook = await renderHook(() => {
            renders += 1;
            return {
                viewer: useComputerSessionControl({ scope, execute: executor.execute }),
                strip: useComputerSessionControl({ scope, execute: executor.execute }),
            };
        });
        function frame(value: unknown): MachineLiveStreamFrameV1 {
            const payload = new TextEncoder().encode(JSON.stringify(value));
            return { v: 1, streamId: 'stream', sequence: 1, timestampMs: 1, payloadKind: 'metadata', payloadEncoding: 'binary_base64',
                payloadBase64: encodeBase64(payload), payloadSizeBytes: payload.length };
        }
        const acting = { ...status('agent'), activity: { kind: 'click', targetLabel: 'Sign in' }, activeTarget: { x: 0.1, y: 0.2, width: 0.1, height: 0.1 } };
        await act(async () => { publishComputerStatusFrame({ ...scope, serverId: '' }, 'computer:1', frame(acting)); });
        expect(hook.getCurrent().viewer.agentActing).toBe(true);
        expect(hook.getCurrent().strip.presence).toMatchObject({ activity: 'click', target: { x: 0.1, y: 0.2 } });
        const afterChange = renders;
        await act(async () => {
            publishComputerStatusFrame(scope, 'computer:1', frame(acting));
            publishComputerStatusFrame(scope, 'computer:other', frame(status('human')));
            publishComputerStatusFrame(scope, 'computer:1', frame({ ...status('human'), untrusted: true }));
            publishComputerStatusFrame(scope, 'computer:1', { ...frame(status('human')), payloadKind: 'image_keyframe' });
        });
        expect(renders).toBe(afterChange);
        expect(calls.filter(id => id === 'computer.control.status')).toHaveLength(1);
        await act(async () => { publishComputerStatusFrame(scope, 'computer:1', frame(status('human'))); });
        expect(hook.getCurrent().viewer.presence.kind).toBe('human');
        expect(hook.getCurrent().strip.presence.kind).toBe('human');
    });
    it('shares mounted readers and publishes a control mutation to both consumers', async () => {
        const { machine, interrupt, calls } = createMachine();
        const executor = executorWith(machine);
        const scope = { sessionId: 'shared-session', machineId: 'machine_1' };
        const hook = await renderHook(() => ({
            viewer: useComputerSessionControl({ scope, execute: executor.execute }),
            strip: useComputerSessionControl({ scope, execute: executor.execute }),
        }));
        expect(calls.filter(id => id === 'computer.target.get')).toHaveLength(1);
        expect(calls.filter(id => id === 'computer.control.status')).toHaveLength(1);
        await act(async () => { interrupt.resolve('known'); await hook.getCurrent().viewer.takeControl(); });
        expect(hook.getCurrent().viewer.presence.kind).toBe('human');
        expect(hook.getCurrent().strip.presence.kind).toBe('human');
        await act(async () => { hook.getCurrent().strip.handBack(); });
        await hook.rerender();
        expect(hook.getCurrent().viewer.presence.kind).toBe('agent');
    });
    it.each(['refused', 'connection-lost'] as const)('returns a settled takeover result when the owner is unchanged after %s', async (outcome) => {
        let current = status('agent');
        const machine: ComputerMachineRpc = async ({ actionId }) => {
            if (actionId === 'computer.targets.list') return targetList;
            if (actionId === 'computer.target.get') return selection;
            if (actionId === 'computer.control.status') return current;
            if (outcome === 'connection-lost') return { ok: false, errorCode: 'machine_unreachable', error: 'machine_unreachable' };
            return { ...identity, status: 'failed', code: 'computer_permission_denied' };
        };
        const hook = await renderControl(machine);
        let result: unknown;
        await act(async () => { result = await hook.getCurrent().takeControl(); });
        expect(result).toEqual({ status: outcome === 'refused' ? 'failed' : 'unknown' });
        expect(hook.getCurrent().presence.kind).toBe('agent');

        current = status('human', { controlEpoch: 2 });
        await act(async () => { hook.getCurrent().refresh(); });
        expect(hook.getCurrent().presence.kind).toBe('human');
    });

    it('sends see-only access through the real Action front door to the computer owner', async () => {
        const machine = vi.fn<ComputerMachineRpc>(async () => ({ ...selection, access: 'see' }));
        const executor = executorWith(machine);
        const client = createComputerControlClient({ sessionId: 'session_1', machineId: 'machine_1' }, executor.execute);
        expect(await client.selectTarget(target, 'see')).toMatchObject({ ok: true, value: { access: 'see' } });
        expect(machine).toHaveBeenCalledWith(expect.objectContaining({ input: { machineId: 'machine_1', target, access: 'see' } }));
    });

    it('refreshes activity and the shared cursor even when controller and epoch are unchanged', async () => {
        let current: ComputerControlStatusResponseV1 = status('agent');
        const machine: ComputerMachineRpc = async ({ actionId }) => actionId === 'computer.target.get' ? selection
            : actionId === 'computer.targets.list' ? targetList : current;
        const hook = await renderControl(machine);
        expect(hook.getCurrent().agentActing).toBe(false);
        current = { ...status('agent'), activity: { kind: 'click', targetLabel: 'Sign in' }, activeTarget: { x: 0.4, y: 0.2, width: 0.1, height: 0.1, label: 'Sign in' } };
        await act(async () => { hook.getCurrent().refresh(); });
        await hook.rerender();
        expect(hook.getCurrent().agentActing).toBe(true);
        expect(hook.getCurrent().presence).toMatchObject({ kind: 'agent', activity: 'click', target: { x: 0.4, y: 0.2, label: 'Sign in' } });
        current = status('agent');
        await act(async () => { hook.getCurrent().refresh(); });
        await hook.rerender();
        expect(hook.getCurrent().presence).toMatchObject({ kind: 'agent', activity: null, target: null });
        expect(hook.getCurrent().agentActing).toBe(false);
    });

    it('shows stopping until the machine answers, and never “you have control” on an unconfirmed stop', async () => {
        const { machine, interrupt } = createMachine();
        const hook = await renderControl(machine);
        expect(hook.getCurrent().presence.kind).toBe('agent');
        expect(hook.getCurrent().targetTitle).toBe('Sign in to Lumen');

        await act(async () => { hook.getCurrent().takeControl(); });
        expect(hook.getCurrent().presence.kind).toBe('stopping');

        await act(async () => { interrupt.resolve('unknown'); });
        await hook.rerender();
        expect(hook.getCurrent().presence.kind).toBe('unconfirmed');
    });

    it('confirms the stop with a fresh look, then hands back', async () => {
        const { machine, interrupt, calls } = createMachine();
        const hook = await renderControl(machine);
        await act(async () => { hook.getCurrent().takeControl(); interrupt.resolve('unknown'); });
        await hook.rerender();
        expect(hook.getCurrent().presence.kind).toBe('unconfirmed');

        await act(async () => { hook.getCurrent().checkAgain(); });
        await hook.rerender();
        expect(calls).toContain('computer.capture');
        expect(hook.getCurrent().presence).toMatchObject({ kind: 'human', interruptedCompletion: null });

        await act(async () => { hook.getCurrent().handBack(); });
        await hook.rerender();
        expect(calls).toContain('computer.control.handBack');
        expect(hook.getCurrent().presence.kind).toBe('agent');
    });
});
