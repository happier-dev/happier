import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol';

import { createMachineFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { installSettingsViewCommonModuleMocks } from '@/components/settings/settingsViewTestHelpers';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { installLocalStorageMock } from '@/auth/storage/tokenStorage.web.testHelpers';

installSettingsViewCommonModuleMocks({ text: async () => vi.importActual<typeof import('@/text')>('@/text'),
    // The reader must observe the same real store that receives socket activity.
    storage: async importOriginal => await importOriginal(),
});
afterEach(() => standardCleanup());

describe('MachineWorkSummaryReader', () => {
    it('refreshes from existing exact-Machine liveness without following another Home or Machine', async () => {
        const { storage } = await import('@/sync/domains/state/storageStore');
        const { handleEphemeralSocketUpdate, flushMachineActivityUpdates } = await import('@/sync/engine/socket/socket');
        const { MachineActivityAccumulator } = await import('@/sync/engine/activity/machineActivityAccumulator');
        const { MachineWorkSummaryReader } = await import('./MachineWorkSummaryReader');
        const previousState = storage.getState();
        const serverId = 'machine-work-live-home';
        const activeAt = Date.now() - 1000;
        const machine = createMachineFixture({ id: 'machine', activeAt });
        const other = createMachineFixture({ id: 'other', activeAt });
        let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
        const accumulator = new MachineActivityAccumulator((updates, options) => flushMachineActivityUpdates({
            updates, ...options,
            applyMachines: (machines, applyOptions) => storage.getState().applyMachines(machines, false, applyOptions),
        }));
        try {
            storage.setState(state => ({ ...state, machines: { machine, other },
                machineListByServerId: { ...state.machineListByServerId, [serverId]: [machine, other] },
                machineListStatusByServerId: { ...state.machineListStatusByServerId, [serverId]: 'idle' },
            }));
            let response: unknown = { kind: 'current', requesters: [
                { accountId: 'bob', displayName: 'Bob', sessions: 1, tasks: 0, terminals: 0 },
            ] };
            const executor = createActionExecutor({ machineWorkSummaryGet: async () => response });
            screen = await renderScreen(<MachineWorkSummaryReader machineId="machine" machineName="devbox"
                scope={{ serverId, accountId: 'alice' }} online execute={executor.execute} />);
            expect(screen.findByTestId('machine-work-summary.bob') !== null).toBe(true);
            response = { kind: 'current', requesters: [] };
            const receiveLiveness = async (sourceServerId: string, id: string, activeAt: number) => {
                // Socket receive is the external boundary. The incumbent parser,
                // accumulator and scoped Machine store writer remain real.
                await handleEphemeralSocketUpdate({ update: { type: 'machine-activity', id, active: true, activeAt },
                    sourceServerId,
                    addMachineActivityUpdate: update => accumulator.addUpdate(update, { sourceServerId }),
                    addActivityUpdate: () => {}, getSessionEncryption: () => null,
                    getSession: () => undefined, applyMessages: () => {},
                });
                accumulator.flush();
            };
            await act(async () => { await receiveLiveness('another-home', 'machine', activeAt + 1); });
            expect(screen.findByTestId('machine-work-summary.bob') !== null).toBe(true);
            await act(async () => { await receiveLiveness(serverId, 'other', activeAt + 2); });
            expect(screen.findByTestId('machine-work-summary.bob') !== null).toBe(true);
            await act(async () => { await receiveLiveness(serverId, 'machine', activeAt + 3); });
            expect(screen.findByTestId('machine-work-summary.bob') !== null).toBe(false);
            expect(screen.findByTestId('machine-work-summary.empty') !== null).toBe(true);
        } finally {
            accumulator.reset();
            await act(async () => { screen?.tree.unmount(); });
            storage.setState(previousState);
        }
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
