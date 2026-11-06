import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createActionExecutor as createProtocolActionExecutor} from '@happier-dev/protocol/actions/actionExecutor';
import { type ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';

import { createMachineFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { installSettingsViewCommonModuleMocks } from '@/components/settings/settingsViewTestHelpers';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { installLocalStorageMock } from '@/auth/storage/tokenStorage.web.testHelpers';

installSettingsViewCommonModuleMocks({ text: async () => vi.importActual<typeof import('@/text')>('@/text'),
    // The reader must observe the same real store that receives socket activity.
    storage: 'real',
});
afterEach(() => standardCleanup());

// Cold transformation of the real store/Action/socket graph belongs to
// collection, outside any individual mounted-operation deadline.
await import('./MachineWorkSummaryReader');
await import('@/sync/engine/socket/socket');

const createActionExecutor = (ports: Partial<ActionExecutorDeps>) =>
    createProtocolActionExecutor(createActionExecutorBoundaryFixture(ports));

describe('MachineWorkSummaryReader', () => {
    it('shares exact Machine demand across mounted consumers and follows only its work changes', async () => {
        const { MachineWorkSummaryReader } = await import('./MachineWorkSummaryReader');
        const { publishMachineWorkSummaryChanged } = await import('@/sync/store/domains/machines');
        let sessions = 1;
        const read = vi.fn(async () => ({ kind: 'current', requesters: [
            { accountId: 'bob', displayName: 'Bob', sessions, tasks: 0, terminals: 0 },
        ] }));
        const executor = createActionExecutor({ machineWorkSummaryGet: read });
        const props = { machineId: 'shared-demand', machineName: 'devbox',
            scope: { serverId: 'shared-demand-home', accountId: 'alice' }, online: true, execute: executor.execute };
        const first = await renderScreen(<MachineWorkSummaryReader {...props} />);
        const second = await renderScreen(<MachineWorkSummaryReader {...props} />);
        expect(read).toHaveBeenCalledTimes(1);
        await act(async () => { publishMachineWorkSummaryChanged(props.scope.serverId, 'unrelated'); });
        expect(read).toHaveBeenCalledTimes(1);
        sessions = 2;
        await act(async () => { publishMachineWorkSummaryChanged(props.scope.serverId, props.machineId); });
        expect(read).toHaveBeenCalledTimes(2);
        expect(first.getTextContent()).toContain('2 sessions');
        expect(second.getTextContent()).toContain('2 sessions');
        await first.unmount();
        sessions = 3;
        await act(async () => { publishMachineWorkSummaryChanged(props.scope.serverId, props.machineId); });
        expect(second.getTextContent()).toContain('3 sessions');
        await second.unmount();
        await act(async () => { publishMachineWorkSummaryChanged(props.scope.serverId, props.machineId); });
        expect(read).toHaveBeenCalledTimes(3);
    });
    it('holds unknown presence as unavailable without reading or claiming offline, then follows the observed verdict', async () => {
        const { MachineWorkSummaryReader } = await import('./MachineWorkSummaryReader');
        const read = vi.fn(async () => ({ kind: 'current', requesters: [] }));
        const executor = createActionExecutor({ machineWorkSummaryGet: read });
        const props = { machineId: 'machine', machineName: 'devbox', scope: { serverId: 'home', accountId: 'alice' }, execute: executor.execute };
        const screen = await renderScreen(<MachineWorkSummaryReader {...props} online={null} />);
        expect(screen.findByTestId('machine-work-summary.offline')).toBeNull();
        expect(screen.findByTestId('machine-work-summary.unavailable')).not.toBeNull();
        expect(read).not.toHaveBeenCalled();
        await screen.update(<MachineWorkSummaryReader {...props} online={false} />);
        expect(screen.findByTestId('machine-work-summary.offline')).not.toBeNull();
        await screen.update(<MachineWorkSummaryReader {...props} online />);
        expect(screen.findByTestId('machine-work-summary.empty')).not.toBeNull();
    });

    it('settles an in-flight read when heartbeat updates arrive before its response', async () => {
        const { storage } = await import('@/sync/domains/state/storageStore');
        const { MachineWorkSummaryReader } = await import('./MachineWorkSummaryReader');
        const previousState = storage.getState();
        const serverId = 'work-heartbeat-home';
        const machine = createMachineFixture({ id: 'machine', activeAt: Date.now() });
        let finish: ((value: unknown) => void) | undefined;
        let signal: AbortSignal | undefined;
        let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
        // Only the asynchronous Machine RPC boundary is delayed; the real
        // Action and scoped store must keep the request admitted until it settles.
        const executor = createActionExecutor({ machineWorkSummaryGet: async args => {
            signal = args.signal;
            return new Promise<unknown>(resolve => { finish = resolve; });
        } });
        try {
            storage.setState(state => ({ ...state, machines: { machine },
                machineListByServerId: { ...state.machineListByServerId, [serverId]: [machine] },
                machineListStatusByServerId: { ...state.machineListStatusByServerId, [serverId]: 'idle' },
            }));
            screen = await renderScreen(<MachineWorkSummaryReader machineId="machine" machineName="devbox"
                scope={{ serverId, accountId: 'alice' }} online execute={executor.execute} />);
            const admittedSignal = signal;
            const admittedResponse = finish;
            for (let index = 1; index <= 3; index++) {
                await act(async () => { storage.getState().applyMachines([
                    { ...machine, activeAt: machine.activeAt + index },
                ], false, { sourceServerId: serverId }); });
            }
            expect(admittedSignal?.aborted).toBe(false);
            await act(async () => { admittedResponse?.({ kind: 'current', requesters: [] }); });
            expect(screen.findByTestId('machine-work-summary.empty')).not.toBeNull();
            expect(screen.findByTestId('machine-work-summary.loading')).toBeNull();
        } finally {
            await act(async () => { screen?.tree.unmount(); });
            storage.setState(previousState);
        }
    });
    it('keeps heartbeats read-free and retains its last answer during an explicit refresh', async () => {
        const { storage } = await import('@/sync/domains/state/storageStore');
        const { MachineWorkSummaryReader } = await import('./MachineWorkSummaryReader');
        const previousState = storage.getState();
        const serverId = 'work-recheck-home';
        const machine = createMachineFixture({ id: 'machine', activeAt: Date.now() });
        let reads = 0;
        let finish: ((value: unknown) => void) | undefined;
        // First read answers unavailable; the explicit refresh is held at the RPC boundary.
        const executor = createActionExecutor({ machineWorkSummaryGet: async () => {
            reads++;
            return reads === 1 ? { kind: 'unavailable' } : new Promise<unknown>(resolve => { finish = resolve; });
        } });
        let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
        try {
            storage.setState(state => ({ ...state, machines: { machine },
                machineListByServerId: { ...state.machineListByServerId, [serverId]: [machine] },
                machineListStatusByServerId: { ...state.machineListStatusByServerId, [serverId]: 'idle' },
            }));
            screen = await renderScreen(<MachineWorkSummaryReader machineId="machine" machineName="devbox"
                scope={{ serverId, accountId: 'alice' }} online execute={executor.execute} />);
            expect(screen.findByTestId('machine-work-summary.unavailable')).not.toBeNull();
            await act(async () => { storage.getState().applyMachines([{ ...machine, activeAt: machine.activeAt + 1 }], false, { sourceServerId: serverId }); });
            expect(reads).toBe(1);
            await act(async () => { publishHomeAccountChange(serverId, ['machine']); });
            expect(reads).toBe(2);
            expect(screen.findByTestId('machine-work-summary.unavailable')).not.toBeNull();
            expect(screen.findByTestId('machine-work-summary.loading')).toBeNull();
            await act(async () => { finish?.({ kind: 'current', requesters: [
                { accountId: 'bob', displayName: 'Bob', sessions: 1, tasks: 0, terminals: 0 },
            ] }); });
            expect(screen.findByTestId('machine-work-summary.bob')).not.toBeNull();
            // Repeated inventory hydration with unchanged liveness needs no new RPC.
            await act(async () => { storage.getState().applyMachines([{ ...machine }], false, { sourceServerId: serverId }); });
            expect(reads).toBe(2);
            // Liveness advances without invalidating the accepted work facts.
            await act(async () => { storage.getState().applyMachineActivityUpdates([
                { id: machine.id, active: true, activeAt: machine.activeAt + 2 },
            ], { sourceServerId: serverId }); });
            expect(reads).toBe(2);
            await act(async () => { publishHomeAccountChange(serverId, ['machine']); });
            expect(reads).toBe(3);
            expect(screen.findByTestId('machine-work-summary.bob')).not.toBeNull();
            expect(screen.findByTestId('machine-work-summary.stale')).not.toBeNull();
            expect(screen.findByTestId('machine-work-summary.loading')).toBeNull();
            await act(async () => { finish?.({ kind: 'current', requesters: [] }); });
            expect(screen.findByTestId('machine-work-summary.bob')).toBeNull();
            expect(screen.findByTestId('machine-work-summary.empty')).not.toBeNull();
        } finally {
            await act(async () => { screen?.tree.unmount(); });
            storage.setState(previousState);
        }
    });
    it('refreshes counts only from exact-Machine work facts and releases that demand on unmount', async () => {
        const { storage } = await import('@/sync/domains/state/storageStore');
        const { handleEphemeralSocketUpdate, flushMachineActivityUpdates } = await import('@/sync/engine/socket/socket');
        const { MachineWorkSummaryReader } = await import('./MachineWorkSummaryReader');
        const previousState = storage.getState();
        const serverId = 'machine-work-live-home';
        const activeAt = Date.now() - 1000;
        const machine = createMachineFixture({ id: 'machine', activeAt });
        const other = createMachineFixture({ id: 'other', activeAt });
        let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
        try {
            storage.setState(state => ({ ...state, machines: { machine, other },
                machineListByServerId: { ...state.machineListByServerId, [serverId]: [machine, other] },
                machineListStatusByServerId: { ...state.machineListStatusByServerId, [serverId]: 'idle' },
            }));
            let response: unknown = { kind: 'current', requesters: [
                { accountId: 'bob', displayName: 'Bob', sessions: 1, tasks: 0, terminals: 0 },
            ] };
            const read = vi.fn(async () => response);
            const executor = createActionExecutor({ machineWorkSummaryGet: read });
            screen = await renderScreen(<MachineWorkSummaryReader machineId="machine" machineName="devbox"
                scope={{ serverId, accountId: 'alice' }} online execute={executor.execute} />);
            expect(screen.findByTestId('machine-work-summary.bob') !== null).toBe(true);
            response = { kind: 'current', requesters: [
                { accountId: 'bob', displayName: 'Bob', sessions: 2, tasks: 0, terminals: 0 },
            ] };
            const receiveLiveness = async (sourceServerId: string, id: string, activeAt: number, workSummaryChanged = false) => {
                // Socket receive is the external boundary. The incumbent parser
                // and scoped Machine store writer remain real and apply immediately.
                await handleEphemeralSocketUpdate({ update: workSummaryChanged
                    ? { type: 'machine-work-summary-changed', machineId: id }
                    : { type: 'machine-activity', id, active: true, activeAt },
                    sourceServerId,
                    addMachineActivityUpdate: update => flushMachineActivityUpdates({ updates: new Map([[id, update]]), sourceServerId }),
                    addActivityUpdate: () => {}, getSessionEncryption: () => null,
                    getSession: () => undefined, applyMessages: () => {},
                });
            };
            await act(async () => { await receiveLiveness('another-home', 'machine', activeAt + 1, true); });
            expect(screen.findByTestId('machine-work-summary.bob') !== null).toBe(true);
            await act(async () => { await receiveLiveness(serverId, 'other', activeAt + 2, true); });
            expect(screen.findByTestId('machine-work-summary.bob') !== null).toBe(true);
            const settledRoot = storage.getState();
            const rootPublications = vi.fn();
            const stopRoot = storage.subscribe(rootPublications);
            try {
                await act(async () => { await receiveLiveness(serverId, 'machine', activeAt + 3); });
                expect(rootPublications).not.toHaveBeenCalled();
                expect(storage.getState()).toBe(settledRoot);
            } finally { stopRoot(); }
            expect(read).toHaveBeenCalledTimes(1);
            await act(async () => { await receiveLiveness(serverId, 'machine', activeAt + 3, true); });
            expect(read).toHaveBeenCalledTimes(2);
            expect(screen.getTextContent()).toContain('2 sessions');
            await act(async () => { screen?.tree.unmount(); });
            screen = undefined;
            await act(async () => { await receiveLiveness(serverId, 'machine', activeAt + 4, true); });
            expect(read).toHaveBeenCalledTimes(2);
        } finally {
            await act(async () => { screen?.tree.unmount(); });
            storage.setState(previousState);
        }
    });
    it.each([false, true])('runs a trailing read only while still demanded after a pending work change (unmount: %s)', async unmount => {
        const { handleEphemeralSocketUpdate } = await import('@/sync/engine/socket/socket');
        const { MachineWorkSummaryReader } = await import('./MachineWorkSummaryReader');
        let finish: ((value: unknown) => void) | undefined;
        const read = vi.fn(async (): Promise<unknown> => read.mock.calls.length === 1
            ? new Promise<unknown>(resolve => { finish = resolve; })
            : { kind: 'current', requesters: [{ accountId: 'bob', displayName: 'Bob', sessions: 2, tasks: 0, terminals: 0 }] });
        const executor = createActionExecutor({ machineWorkSummaryGet: read });
        const screen = await renderScreen(<MachineWorkSummaryReader machineId="machine" machineName="devbox"
            scope={{ serverId: 'trailing-home', accountId: 'alice' }} online execute={executor.execute} />);
        await act(async () => {
            await handleEphemeralSocketUpdate({ update: { type: 'machine-work-summary-changed', machineId: 'machine' }, sourceServerId: 'trailing-home',
                addMachineActivityUpdate: () => {}, addActivityUpdate: () => {}, getSessionEncryption: () => null,
                getSession: () => undefined, applyMessages: () => {},
            });
        });
        expect(read).toHaveBeenCalledTimes(1);
        if (unmount) await act(async () => { screen.tree.unmount(); });
        await act(async () => { finish?.({ kind: 'current', requesters: [
            { accountId: 'bob', displayName: 'Bob', sessions: 1, tasks: 0, terminals: 0 },
        ] }); });
        expect(read).toHaveBeenCalledTimes(unmount ? 1 : 2);
        if (!unmount) expect(screen.getTextContent()).toContain('2 sessions');
    });
    it('recovers on same-Account credential restoration without reviving a retired request', async () => {
        const storage = installLocalStorageMock();
        try {
            const { TokenStorage } = await import('@/auth/storage/tokenStorage');
            const { MachineWorkSummaryReader } = await import('./MachineWorkSummaryReader');
            const serverUrl = 'https://machine-work-credential-recovery.test';
            const scope = { serverId: 'work-credential-recovery', accountId: 'alice' };
            // Only the local-storage and Machine RPC boundaries are substituted;
            // use the real credential writer, mutation fanout and Action owner.
            const credentials = { token: 'header.eyJzdWIiOiJhbGljZSJ9.signature' };
            expect(await TokenStorage.setCredentialsForServerUrl(serverUrl, scope, credentials)).toBe(true);
            let response: unknown = { kind: 'current', requesters: [{ accountId: 'bob', displayName: 'Bob', sessions: 1, tasks: 0, terminals: 0 }] };
            let delayResponse = false;
            let finishRetired: ((value: unknown) => void) | undefined;
            const executor = createActionExecutor({ machineWorkSummaryGet: async () => delayResponse
                ? new Promise<unknown>(resolve => { finishRetired = resolve; }) : response });
            const screen = await renderScreen(<MachineWorkSummaryReader machineId="machine" machineName="devbox"
                scope={scope} online execute={executor.execute} />);
            expect(screen.findByTestId('machine-work-summary.bob') !== null).toBe(true);
            delayResponse = true;
            await act(async () => { publishHomeAccountChange(scope.serverId, ['machine']); });
            expect(finishRetired !== undefined).toBe(true);
            await act(async () => {
                expect(await TokenStorage.removeCredentialsForServerUrl(serverUrl, scope)).toBe(true);
            });
            expect(screen.findByTestId('machine-work-summary.bob') !== null).toBe(false);
            expect(screen.findByTestId('machine-work-summary.denied') !== null).toBe(true);
            delayResponse = false;
            response = { kind: 'current', requesters: [{ accountId: 'carol', displayName: 'Carol', sessions: 2, tasks: 0, terminals: 0 }] };
            await act(async () => {
                expect(await TokenStorage.setCredentialsForServerUrl(serverUrl, scope, credentials)).toBe(true);
            });
            expect(screen.findByTestId('machine-work-summary.carol') !== null).toBe(true);
            expect(screen.findByTestId('machine-work-summary.denied') !== null).toBe(false);
            await act(async () => {
                finishRetired?.({ kind: 'current', requesters: [{ accountId: 'bob', displayName: 'Bob', sessions: 99, tasks: 0, terminals: 0 }] });
            });
            expect(screen.findByTestId('machine-work-summary.bob') !== null).toBe(false);
            expect(screen.findByTestId('machine-work-summary.carol') !== null).toBe(true);
            await act(async () => { screen.tree.unmount(); });
        } finally {
            storage.restore();
        }
    });
    it('reads normally after StrictMode replays its effect setup and cleanup', async () => {
        const { MachineWorkSummaryReader } = await import('./MachineWorkSummaryReader');
        const executor = createActionExecutor({ machineWorkSummaryGet: async () => ({ kind: 'current',
            requesters: [{ accountId: 'bob', displayName: 'Bob', sessions: 1, tasks: 0, terminals: 0 }] }) });
        const screen = await renderScreen(<React.StrictMode><MachineWorkSummaryReader machineId="machine" machineName="devbox"
            scope={{ serverId: 'home', accountId: 'alice' }} online execute={executor.execute} /></React.StrictMode>);
        expect(screen.findByTestId('machine-work-summary.bob')).not.toBeNull();
    });
    it('reads through the safe Action and retains explicitly stale counts, but clears them on denial', async () => {
        const { MachineWorkSummaryReader } = await import('./MachineWorkSummaryReader');
        let response: unknown = { kind: 'current', requesters: [{ accountId: 'bob', displayName: 'Bob', sessions: 1, tasks: 0, terminals: 0 }] };
        // The Machine RPC is the external boundary; retain the real Action parser and dispatcher.
        const executor = createActionExecutor({ machineWorkSummaryGet: async () => response });
        const screen = await renderScreen(<MachineWorkSummaryReader machineId="machine" machineName="devbox"
            scope={{ serverId: 'home', accountId: 'alice' }} online execute={executor.execute} />);
        expect(screen.findByTestId('machine-work-summary.bob')).not.toBeNull();
        response = { kind: 'unavailable' };
        await act(async () => { publishHomeAccountChange('home', ['machine']); });
        expect(screen.findByTestId('machine-work-summary.bob')).not.toBeNull();
        expect(screen.findByTestId('machine-work-summary.stale')).not.toBeNull();
        expect(screen.findByTestId('machine-work-summary.empty')).toBeNull();
        response = { kind: 'refused', code: 'access_denied' };
        await act(async () => { publishHomeAccountChange('home', ['machine']); });
        expect(screen.findByTestId('machine-work-summary.bob')).toBeNull();
        expect(screen.findByTestId('machine-work-summary.denied')).not.toBeNull();
    });

    it('discards a late result after the exact Home/Machine target changes', async () => {
        const { MachineWorkSummaryReader } = await import('./MachineWorkSummaryReader');
        let finish: ((value: unknown) => void) | undefined;
        const executor = createActionExecutor({ machineWorkSummaryGet: async ({ input }) => input.serverId === 'old'
            ? new Promise<unknown>(resolve => { finish = resolve; }) : { kind: 'unavailable' } });
        const screen = await renderScreen(<MachineWorkSummaryReader machineId="machine" machineName="devbox"
            scope={{ serverId: 'old', accountId: 'alice' }} online execute={executor.execute} />);
        await act(async () => { screen.tree.update(<MachineWorkSummaryReader machineId="machine" machineName="devbox"
            scope={{ serverId: 'new', accountId: 'alice' }} online execute={executor.execute} />); });
        await act(async () => { finish?.({ kind: 'current', requesters: [{ accountId: 'bob', displayName: 'Bob', sessions: 1, tasks: 0, terminals: 0 }] }); });
        expect(screen.findByTestId('machine-work-summary.bob')).toBeNull();
        expect(screen.findByTestId('machine-work-summary.unavailable')).not.toBeNull();
    });

    it('refreshes existing rows when the Machine page is explicitly refreshed', async () => {
        const { MachineWorkSummaryReader } = await import('./MachineWorkSummaryReader');
        let sessions = 1;
        const executor = createActionExecutor({ machineWorkSummaryGet: async () => ({ kind: 'current',
            requesters: [{ accountId: 'bob', displayName: 'Bob', sessions, tasks: 0, terminals: 0 }] }) });
        const screen = await renderScreen(<MachineWorkSummaryReader machineId="machine" machineName="devbox"
            scope={{ serverId: 'home', accountId: 'alice' }} online execute={executor.execute} refreshKey={0} />);
        expect(screen.getTextContent()).toContain('1 session');
        sessions = 2;
        await act(async () => { screen.tree.update(<MachineWorkSummaryReader machineId="machine" machineName="devbox"
            scope={{ serverId: 'home', accountId: 'alice' }} online execute={executor.execute} refreshKey={1} />); });
        expect(screen.getTextContent()).toContain('2 sessions');
    });
});
