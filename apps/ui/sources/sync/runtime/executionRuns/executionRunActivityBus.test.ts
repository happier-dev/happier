import { describe, expect, it, vi } from 'vitest';
import { ExecutionRunPublicStateSchema } from '@happier-dev/protocol/execution/runs/responseSchemas';

import {
    notifyExecutionRunActivity,
    notifyExecutionRunActivityFromUpdate,
    notifyExecutionRunActivityReconnect,
    readRunningExecutionRunRosterSnapshot,
    refreshRunningExecutionRunRoster,
    subscribeExecutionRunActivity,
    subscribeRunningExecutionRunRoster,
} from './executionRunActivityBus';

describe('executionRunActivityBus', () => {
    it.each([
        { reader: 'owner (receives live Run hints)', live: true, reads: 0 },
        { reader: 'collaborator (no live Run hints)', live: false, reads: 20 },
    ])('re-reads a running roster on own-Session content pages only for a $reader', async ({ live, reads }) => {
        const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
        const address = { serverId: 'home-content', sessionId: live ? 'owned-session' : 'shared-session' };
        let calls = 0;
        const unsubscribe = subscribeRunningExecutionRunRoster(address, () => {}, async () => { calls++; return []; }, () => live);
        try {
            await vi.waitFor(() => expect(calls).toBe(1));
            // P03-SESSION-E2E: a live turn publishes a socket wake and a detailed page per message.
            for (let index = 0; index < 20; index++) {
                publishHomeAccountChange(address.serverId, [address.sessionId], { source: 'socket', changeKinds: ['session'], sessionSystemRecords: [] });
                publishHomeAccountChange(address.serverId, [address.sessionId], { feedPageConsumed: true, changeKinds: ['session'] });
                await new Promise(resolve => setTimeout(resolve, 0));
            }
            const contentReads = calls - 1;
            if (live) expect(contentReads).toBe(0); else expect(contentReads).toBeGreaterThanOrEqual(reads);
            // Access changes still re-read for every reader.
            publishHomeAccountChange(address.serverId, [address.sessionId], { changeKinds: ['share'] });
            await vi.waitFor(() => expect(calls - 1).toBe(contentReads + 1));
        } finally { unsubscribe(); }
    });

    it('keeps settled refreshes quiet while publishing changed runs, failures and recovery', async () => {
        const address = { serverId: 'home-a', sessionId: 'settled-roster' };
        const run = ExecutionRunPublicStateSchema.parse({
            runId: 'run-one', callId: 'call-one', sidechainId: 'sidechain-one', intent: 'review',
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, permissionMode: 'read_only',
            retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'request_response',
            status: 'running', startedAtMs: 123,
        });
        let response = Promise.resolve<readonly typeof run[] | null>([run]);
        const publications = vi.fn();
        const unsubscribe = subscribeRunningExecutionRunRoster(address, publications, () => response);
        try {
            expect(readRunningExecutionRunRosterSnapshot(address).loading).toBe(true);
            await response;
            const settled = readRunningExecutionRunRosterSnapshot(address);
            expect(settled).toMatchObject({ loading: false, failed: false, runs: [run] });
            publications.mockClear();
            for (let index = 0; index < 3; index++) {
                response = Promise.resolve([{ ...run }]);
                refreshRunningExecutionRunRoster(address);
                expect.soft(readRunningExecutionRunRosterSnapshot(address)).toBe(settled);
                await response;
            }
            expect.soft(publications).toHaveBeenCalledTimes(0);
            expect(readRunningExecutionRunRosterSnapshot(address)).toBe(settled);

            response = Promise.resolve([run, { ...run, runId: 'run-two' }]);
            refreshRunningExecutionRunRoster(address);
            expect.soft(readRunningExecutionRunRosterSnapshot(address).loading).toBe(false);
            await response;
            const changed = readRunningExecutionRunRosterSnapshot(address);
            expect(changed.runs.map(item => item.runId)).toEqual(['run-one', 'run-two']);
            expect(changed.runs[0]).toBe(settled.runs[0]);
            publications.mockClear();

            response = Promise.resolve(null);
            refreshRunningExecutionRunRoster(address);
            await response;
            const failed = readRunningExecutionRunRosterSnapshot(address);
            expect(failed).toMatchObject({ loading: false, failed: true });
            expect(failed.runs).toBe(changed.runs);
            expect.soft(publications).toHaveBeenCalledTimes(1);
            publications.mockClear();
            refreshRunningExecutionRunRoster(address);
            expect.soft(readRunningExecutionRunRosterSnapshot(address)).toBe(failed);
            await response;
            expect.soft(publications).toHaveBeenCalledTimes(0);

            response = Promise.resolve(changed.runs);
            notifyExecutionRunActivityReconnect(address.serverId);
            await response;
            expect(readRunningExecutionRunRosterSnapshot(address)).toMatchObject({ loading: false, failed: false });
            expect.soft(publications).toHaveBeenCalledTimes(1);
        } finally { unsubscribe(); }
    });

    it('wakes only the exact Machine demand and catches it up on its Home reconnect', () => {
        const own = vi.fn();
        const otherHome = vi.fn();
        const sameSessionId = vi.fn();
        const off = [subscribeExecutionRunActivity({ serverId: 'home-a', machineId: 'machine-one' }, own),
            subscribeExecutionRunActivity({ serverId: 'home-b', machineId: 'machine-one' }, otherHome),
            subscribeExecutionRunActivity({ serverId: 'home-a', sessionId: 'machine-one' }, sameSessionId)];
        try {
            notifyExecutionRunActivityFromUpdate('home-a', { type: 'execution-run-updated', machineId: 'machine-one', runId: 'run-one' });
            expect(own).toHaveBeenCalledExactlyOnceWith({ runId: 'run-one' });
            expect(otherHome).not.toHaveBeenCalled();
            expect(sameSessionId).not.toHaveBeenCalled();
            notifyExecutionRunActivityFromUpdate('home-a', { type: 'execution-run-updated', machineId: 'machine-one', sessionId: 'session-one', runId: 'run-one' });
            notifyExecutionRunActivityFromUpdate('home-a', { type: 'execution-run-updated', machineId: 'machine-one', runId: 'run-one', run: {} });
            expect(own).toHaveBeenCalledTimes(1);
            notifyExecutionRunActivityReconnect('home-a');
            expect(own).toHaveBeenLastCalledWith({ runId: null });
            expect(otherHome).not.toHaveBeenCalled();
        } finally { for (const dispose of off) dispose(); }
        own.mockClear();
        notifyExecutionRunActivityReconnect('home-a');
        expect(own).not.toHaveBeenCalled();
    });
    it('isolates listeners for duplicate raw Session ids across Homes', () => {
        const homeAListener = vi.fn();
        const homeBListener = vi.fn();
        const unsubscribeHomeA = subscribeExecutionRunActivity(
            { serverId: 'home-a', sessionId: 'same-session' },
            homeAListener,
        );
        const unsubscribeHomeB = subscribeExecutionRunActivity(
            { serverId: 'home-b', sessionId: 'same-session' },
            homeBListener,
        );

        notifyExecutionRunActivity({ serverId: 'home-b', sessionId: 'same-session' });

        expect(homeAListener).not.toHaveBeenCalled();
        expect(homeBListener).toHaveBeenCalledTimes(1);

        unsubscribeHomeA();
        unsubscribeHomeB();
    });

    it('catches up only demanded addresses in the reconnected Home', () => {
        const homeAListener = vi.fn();
        const homeBListener = vi.fn();
        const unsubscribeA = subscribeExecutionRunActivity({ serverId: 'home-a', sessionId: 's1' }, homeAListener);
        const unsubscribeB = subscribeExecutionRunActivity({ serverId: 'home-b', sessionId: 's1' }, homeBListener);
        notifyExecutionRunActivityReconnect('home-b');
        expect(homeAListener).not.toHaveBeenCalled();
        expect(homeBListener).toHaveBeenCalledWith({ runId: null });
        unsubscribeB();
        homeBListener.mockClear();
        notifyExecutionRunActivityReconnect('home-b');
        expect(homeBListener).not.toHaveBeenCalled();
        unsubscribeA();
    });
});
