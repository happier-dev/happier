import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderHook } from '@/dev/testkit';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

// The machine RPC is the boundary: `tool.systemTasks` start returns a task id, the terminal
// result arrives through `poll` (packages/cli-common interactiveTaskKinds).
const rpc = vi.hoisted(() => ({
    pollResults: [] as unknown[],
    invoke: vi.fn(),
    detect: vi.fn(async (..._args: unknown[]) => ({ supported: true, response: { protocolVersion: 1, results: {} } })),
}));

vi.mock('@/sync/ops', () => ({
    machineCapabilitiesInvoke: (...args: unknown[]) => rpc.invoke(...args),
    // The capability cache owner's detect RPC: the facts re-read after an update.
    machineCapabilitiesDetect: (...args: unknown[]) => rpc.detect(...args),
}));

import { getMachineCapabilitiesSnapshot } from '@/hooks/server/useMachineCapabilitiesCache';
import type { UpdateItem } from './items/updateItem';
import * as runs from './machineUpdateRuns';
import { buildRemoteCliUpdateItem } from './items/buildMachineUpdateItems';

const remoteCli: UpdateItem = {
    id: 'studio:happier-cli',
    subject: { kind: 'happier-cli' },
    machineId: 'studio',
    title: 'Happier CLI',
    currentVersion: '0.2.12',
    latestVersion: '0.2.14',
    state: 'available',
    progressPercent: null,
    step: null,
    managedBy: 'happier',
    action: { kind: 'run', verb: 'update' },
    failure: null,
    skipped: false,
};

const accountA = { serverId: 'server-a', accountId: 'account-a' } as const;
const otherServer = { serverId: 'server-b', accountId: 'account-a' } as const;

function installRpc() {
    rpc.invoke.mockImplementation(async (_machineId: string, request: { method: string }) => {
        if (request.method === 'start') return { supported: true, response: { ok: true, result: { taskId: 'task-1' } } };
        const next = rpc.pollResults.length > 1 ? rpc.pollResults.shift() : rpc.pollResults[0];
        return { supported: true, response: { ok: true, result: { events: [], nextCursor: 0, result: next ?? null, pendingPrompt: null } } };
    });
}

async function advance(ms: number) {
    await vi.advanceTimersByTimeAsync(ms);
}

async function advanceRemotePoll(): Promise<void> {
    // `runMachineItemUpdate` reaches the poll timer through several awaited RPC boundaries. Wait
    // for the first poll to return before advancing it; module-owned background timers can already
    // exist, so timer count alone cannot tell us the update poll's delay has been scheduled.
    for (let attempts = 0; attempts < 100 && !rpc.invoke.mock.calls.some((call) => call[1]?.method === 'poll'); attempts += 1) {
        await Promise.resolve();
    }
    expect(rpc.invoke.mock.calls.some((call) => call[1]?.method === 'poll')).toBe(true);
    for (let attempts = 0; attempts < 20 && rpc.invoke.mock.calls.filter((call) => call[1]?.method === 'poll').length < 2; attempts += 1) {
        await vi.advanceTimersToNextTimerAsync();
        await Promise.resolve();
    }
    expect(rpc.invoke.mock.calls.filter((call) => call[1]?.method === 'poll')).toHaveLength(2);
}

describe('runMachineItemUpdate — a remote CLI update is started, then observed', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        runs.markUpdateCompletionsSeen(accountA);
        runs.markUpdateCompletionsSeen(otherServer);
        rpc.invoke.mockReset();
        rpc.pollResults = [];
        installRpc();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('an asynchronous refusal shows its failure and never "waiting to reconnect"', async () => {
        rpc.pollResults = [
            null,
            { protocolVersion: 1, taskId: 'task-1', ok: false, error: { code: 'cli_remote_update_unsupported', message: 'no' } },
        ];
        const seenSteps: string[] = [];
        const read = () => runs.observeMachineUpdateRun(runs.readMachineUpdateRuns('server-a'), remoteCli.id, { lastUpdateSignature: '' });

        const done = runs.runMachineItemUpdate(remoteCli, { scope: accountA, lastUpdateSignature: '' });
        await advance(0);
        seenSteps.push(String(read().step));
        await advanceRemotePoll();
        await done;
        seenSteps.push(String(read().step));

        expect(read()).toMatchObject({ running: false, errorMessage: 'updates.row.remoteUnsupported' });
        expect(seenSteps).not.toContain('reconnecting');
    });

    it('enters "waiting to reconnect" only once the task reports that it started the updater', async () => {
        rpc.pollResults = [
            null,
            { protocolVersion: 1, taskId: 'task-1', ok: true, data: { started: true, currentVersion: '0.2.12', channel: 'stable', logPath: '/l' } },
        ];
        const read = () => runs.observeMachineUpdateRun(runs.readMachineUpdateRuns('server-a'), remoteCli.id, { lastUpdateSignature: '' });

        const done = runs.runMachineItemUpdate(remoteCli, { scope: accountA, lastUpdateSignature: '' });
        await advance(0);
        expect(read()).toMatchObject({ running: true, step: 'installing' });
        await advanceRemotePoll();
        await done;
        expect(read()).toMatchObject({ running: true, step: 'reconnecting' });
    });

    it('exposes a changed failed outcome after admission even when the target version is current', async () => {
        vi.useRealTimers();
        rpc.pollResults = [{ protocolVersion: 1, taskId: 'task-1', ok: true, data: { started: true, currentVersion: '0.2.12', channel: 'stable', logPath: '/l' } }];
        await runs.runMachineItemUpdate(remoteCli, { scope: accountA, lastUpdateSignature: '' });
        const lastUpdate = { targetVersion: '0.2.14', outcome: 'failed', at: 2, message: 'Restoring the old daemon failed.' } as const;
        const task = runs.observeMachineUpdateRun(runs.readMachineUpdateRuns('server-a'), remoteCli.id, { lastUpdateSignature: runs.signatureOfLastUpdate(lastUpdate) });
        expect(task.running).toBe(false);
        const row = buildRemoteCliUpdateItem({
            machineId: 'studio', title: 'Happier CLI', online: true, platform: 'linux', happyCliVersion: '0.2.14', remoteUpdateAdvertised: true, task,
            facts: { currentVersion: '0.2.14', latestVersion: '0.2.14', channel: 'stable', installSource: 'managed', updateCommand: 'happier self update', canUpdateRemotely: true, lastUpdate },
        });
        expect(row).toMatchObject({ state: 'failed', failure: { kind: 'message', message: lastUpdate.message }, action: { kind: 'run', verb: 'retry' } });
    });

    it('another update holding the lock is a retryable refusal, never "installing" (its lock may not be this update)', async () => {
        rpc.pollResults = [
            { protocolVersion: 1, taskId: 'task-1', ok: false, error: { code: 'cli_update_in_progress', message: 'busy' } },
        ];
        vi.useRealTimers();
        const read = () => runs.observeMachineUpdateRun(runs.readMachineUpdateRuns('server-a'), remoteCli.id, { lastUpdateSignature: '' });
        const done = runs.runMachineItemUpdate(remoteCli, { scope: accountA, lastUpdateSignature: '' });
        await done;
        expect(read()).toMatchObject({ running: false, errorMessage: 'updates.row.anotherUpdateRunning' });

        rpc.pollResults = [
            { protocolVersion: 1, taskId: 'task-1', ok: true, data: { started: true, currentVersion: '0.2.12', channel: 'stable', logPath: '/l' } },
        ];
        await runs.runMachineItemUpdate(remoteCli, { scope: accountA, lastUpdateSignature: '' });
        expect(rpc.invoke.mock.calls.filter((call) => call[1]?.method === 'start')).toHaveLength(2);
        expect(read()).toMatchObject({ running: true, step: 'reconnecting', errorMessage: null });
    });

    it('losing the machine before the task confirmed admission is "outcome unknown" (Retry), never admitted', async () => {
        rpc.invoke.mockImplementation(async (_machineId: string, request: { method: string }) => (
            request.method === 'start'
                ? { supported: true, response: { ok: true, result: { taskId: 'task-1' } } }
                : { supported: false, reason: 'error' }
        ));
        vi.useRealTimers();
        const seen: string[] = [];
        const read = () => runs.observeMachineUpdateRun(runs.readMachineUpdateRuns('server-a'), remoteCli.id, { lastUpdateSignature: '' });
        const done = runs.runMachineItemUpdate(remoteCli, { scope: accountA, lastUpdateSignature: '' });
        await done;
        seen.push(String(read().step));
        expect(read()).toMatchObject({ running: false, errorMessage: 'updates.row.outcomeUnknown' });
        expect(seen).not.toContain('reconnecting');
        expect(runs.readUnseenUpdateCompletions(accountA).size).toBe(0);

        installRpc();
        rpc.pollResults = [
            { protocolVersion: 1, taskId: 'task-1', ok: true, data: { started: true, currentVersion: '0.2.12', channel: 'stable', logPath: '/l' } },
        ];
        await runs.runMachineItemUpdate(remoteCli, { scope: accountA, lastUpdateSignature: '' });
        expect(read()).toMatchObject({ running: true, step: 'reconnecting', errorMessage: null });
        expect(runs.readUnseenUpdateCompletions(accountA).get(remoteCli.id)).toBe('pendingRemote');
    });

    it('a machine\'s unseen "Updated" belongs to its server: opening Updates on another server keeps it', async () => {
        rpc.pollResults = [
            { protocolVersion: 1, taskId: 'task-1', ok: true, data: { started: true, currentVersion: '0.2.12', channel: 'stable', logPath: '/l' } },
        ];
        const done = runs.runMachineItemUpdate(remoteCli, { scope: accountA, lastUpdateSignature: '' });
        await done;
        runs.markUpdateCompletionsSeen(otherServer);
        expect(runs.readUnseenUpdateCompletions(accountA).get(remoteCli.id)).toBe('pendingRemote');
        expect(runs.readUnseenUpdateCompletions(otherServer).size).toBe(0);
        runs.markUpdateCompletionsSeen(accountA);
        expect(runs.readUnseenUpdateCompletions(accountA).size).toBe(0);
    });

    it.each([
        '[release-runtime] archive exceeds expanded-byte limit',
        'Extraction failed in C:\\private\\install.log.',
    ])('shows structured extraction guidance instead of raw runtime output: %s', async (message) => {
        rpc.invoke.mockResolvedValue({
            supported: true,
            response: { ok: false, error: { code: 'archive-expanded-byte-limit', message }, logPath: '/logs/codex.log' },
        });
        const codex: UpdateItem = { ...remoteCli, id: 'studio:agent:codex', subject: { kind: 'agent-cli', agentId: 'codex' }, title: 'Codex' };
        await runs.runMachineItemUpdate(codex, { scope: accountA });
        expect(runs.observeMachineUpdateRun(runs.readMachineUpdateRuns('server-a'), codex.id)).toMatchObject({
            running: false,
            errorMessage: 'updates.row.archiveExpandedByteLimit',
            logPath: '/logs/codex.log',
        });
        expect(runs.readUnseenUpdateCompletions(accountA).has(codex.id)).toBe(false);
    });

    it('raw installer output never becomes the row\'s sentence; its log stays behind View log', async () => {
        rpc.invoke.mockImplementation(async () => ({
            supported: true,
            response: { ok: false, error: { message: 'npm ERR! code E404\nnpm ERR! 404 Not Found - GET https://registry.npmjs.org/x', code: 'install-failed' }, logPath: '/logs/codex.log' },
        }));
        const codex: UpdateItem = { ...remoteCli, id: 'studio:agent:codex', subject: { kind: 'agent-cli', agentId: 'codex' }, title: 'Codex' };
        await runs.runMachineItemUpdate(codex, { scope: accountA });
        expect(runs.observeMachineUpdateRun(runs.readMachineUpdateRuns('server-a'), codex.id)).toMatchObject({
            running: false,
            errorMessage: 'updates.row.failedGeneric',
            logPath: '/logs/codex.log',
        });
    });

    it('an in-flight update stays attached to the server it started on, even after switching servers', async () => {
        rpc.pollResults = [
            null,
            null,
            { protocolVersion: 1, taskId: 'task-1', ok: true, data: { started: true, currentVersion: '0.2.12', channel: 'stable', logPath: '/l' } },
        ];
        const done = runs.runMachineItemUpdate(remoteCli, { scope: accountA, lastUpdateSignature: '' });
        await advance(5_000);
        await done;

        // Start and every poll go to the original server, never to whichever server is active now.
        expect(rpc.invoke.mock.calls.length).toBeGreaterThanOrEqual(3);
        for (const call of rpc.invoke.mock.calls) expect(call[2]).toMatchObject({ serverId: 'server-a' });
        // The run belongs to that server's rows only.
        expect(runs.observeMachineUpdateRun(runs.readMachineUpdateRuns('server-a'), remoteCli.id, { lastUpdateSignature: '' }).running).toBe(true);
        expect(runs.observeMachineUpdateRun(runs.readMachineUpdateRuns('server-b'), remoteCli.id, { lastUpdateSignature: '' }).running).toBe(false);
    });

    it('an explicit press runs the vendor updater without asking again, and shows the runtime\'s own reason', async () => {
        rpc.invoke.mockImplementation(async () => ({
            supported: true,
            response: { ok: false, error: { message: 'npm won’t install a release less than a day old.', code: 'update-not-verified' } },
        }));
        const codex: UpdateItem = { ...remoteCli, id: 'studio:agent:codex', subject: { kind: 'agent-cli', agentId: 'codex' }, title: 'Codex' };
        await runs.runMachineItemUpdate(codex, { scope: accountA });

        expect(rpc.invoke.mock.calls[0]?.[1]).toMatchObject({ method: 'install', params: { intent: 'update', allowVendorRecipeExecution: true } });
        expect(runs.observeMachineUpdateRun(runs.readMachineUpdateRuns('server-a'), codex.id)).toMatchObject({
            running: false,
            errorMessage: 'npm won’t install a release less than a day old.',
        });
    });

    it.each(['agent-cli', 'installable'] as const)('keeps %s and Update All busy until refreshed facts replace the old version', async (kind) => {
        vi.useRealTimers();
        const machineId = `refresh-${kind}`;
        const item: UpdateItem = { ...remoteCli, id: `${machineId}:tool`, machineId,
            subject: kind === 'agent-cli' ? { kind, agentId: 'codex' } : { kind, key: 'gh' } };
        let release!: () => void;
        let entered!: () => void;
        const detecting = new Promise<void>((resolve) => { entered = resolve; });
        const pending = new Promise<void>((resolve) => { release = resolve; });
        rpc.invoke.mockResolvedValue({ supported: true, response: { ok: true, result: { version: '2' } } });
        rpc.detect.mockImplementationOnce(async () => {
            entered(); await pending;
            const id = kind === 'agent-cli' ? 'cli.codex' : 'dep.gh';
            return { supported: true, response: { protocolVersion: 1, results: {
                [id]: { ok: true, checkedAt: Date.now(), data: kind === 'agent-cli'
                    ? { available: true, version: '2', latestVersion: '2', updateSupported: true }
                    : { installed: true, installedVersion: '2', latestVersionCheck: { ok: true, latestVersion: '2' } } },
            } } };
        });
        const updating = runs.runUpdateBatch(accountA, [item], (next) => runs.runMachineItemUpdate(next, { scope: accountA }));
        await detecting;
        const duringRefresh = runs.observeMachineUpdateRun(runs.readMachineUpdateRuns(accountA.serverId), item.id);
        const batchDuringRefresh = runs.readUpdateBatch(accountA);
        const completionDuringRefresh = runs.readUnseenUpdateCompletions(accountA).has(item.id);
        release();
        await updating;
        expect(duringRefresh.running).toBe(true);
        expect(batchDuringRefresh).toEqual({ done: 0, total: 1, stopping: false });
        expect(completionDuringRefresh).toBe(false);
        expect(runs.observeMachineUpdateRun(runs.readMachineUpdateRuns(accountA.serverId), item.id).running).toBe(false);
        expect(runs.readUnseenUpdateCompletions(accountA).has(item.id)).toBe(true);
        const result = getMachineCapabilitiesSnapshot(machineId, accountA.serverId)?.response.results[kind === 'agent-cli' ? 'cli.codex' : 'dep.gh'];
        expect(result).toMatchObject({ ok: true, data: kind === 'agent-cli' ? { version: '2' } : { installedVersion: '2' } });
    });

    it('after an agent update the machine\'s facts are re-read fresh, with the latest version, through the capability cache', async () => {
        rpc.detect.mockClear();
        rpc.invoke.mockImplementation(async () => ({ supported: true, response: { ok: true, result: { previousVersion: '2.1.281', version: '2.1.283' } } }));
        const claude: UpdateItem = { ...remoteCli, id: 'studio:agent:claude', subject: { kind: 'agent-cli', agentId: 'claude' }, title: 'Claude' };
        await runs.runMachineItemUpdate(claude, { scope: accountA });
        await advance(0);

        expect(rpc.detect).toHaveBeenCalledWith(
            'studio',
            expect.objectContaining({
                bypassCache: true,
                requests: expect.arrayContaining([{ id: 'cli.claude', params: { includeLatestVersion: true } }]),
            }),
            expect.objectContaining({ serverId: 'server-a' }),
        );
    });

    it('a runtime that finds the tool already current reports "Already up to date", never a failure or "Updated"', async () => {
        rpc.invoke.mockImplementation(async () => ({ supported: true, response: { ok: true, result: { alreadyCurrent: true, version: '2.1.283' } } }));
        const claude: UpdateItem = { ...remoteCli, id: 'studio:agent:claude', subject: { kind: 'agent-cli', agentId: 'claude' }, title: 'Claude' };
        await runs.runMachineItemUpdate(claude, { scope: accountA });
        expect(runs.observeMachineUpdateRun(runs.readMachineUpdateRuns('server-a'), claude.id)).toMatchObject({
            running: false,
            errorMessage: null,
            alreadyCurrent: true,
        });
        expect(runs.readUnseenUpdateCompletions(accountA).size).toBe(0);
    });

    it('reopening adopts the pending batch and Stop prevents the remaining update through the real executor', async () => {
        vi.useRealTimers();
        const first: UpdateItem = { ...remoteCli, id: 'batch-stop:agent:codex', machineId: 'batch-stop', subject: { kind: 'agent-cli', agentId: 'codex' } };
        const second: UpdateItem = { ...first, id: 'batch-stop:agent:claude', subject: { kind: 'agent-cli', agentId: 'claude' } };
        const items = [first, second];
        let release!: () => void;
        const pending = new Promise<void>((resolve) => { release = resolve; });
        rpc.invoke.mockImplementation(async () => {
            await pending;
            return { supported: true, response: { ok: true, result: {} } };
        });
        const execute = (item: UpdateItem) => runs.runMachineItemUpdate(item, { scope: accountA });
        const open = () => renderHook(() => runs.useUpdateBatch(accountA, items, execute));
        const initial = await open();
        let completion!: Promise<void>;
        await act(async () => { completion = initial.getCurrent().updateAll(); });
        expect(initial.getCurrent().batch).toEqual({ done: 0, total: 2, stopping: false });
        await initial.unmount();
        const reopened = await open();
        expect(reopened.getCurrent().batch).toEqual({ done: 0, total: 2, stopping: false });
        await act(async () => { await reopened.getCurrent().updateAll(); });
        await act(async () => { reopened.getCurrent().stopAfterCurrent(); });
        expect(reopened.getCurrent().batch?.stopping).toBe(true);
        await act(async () => { release(); await completion; });
        expect(reopened.getCurrent().batch).toBeNull();
        expect(rpc.invoke.mock.calls.map((call) => call[1]?.id)).toEqual(['cli.codex']);
        expect(runs.observeMachineUpdateRun(runs.readMachineUpdateRuns(accountA.serverId), second.id).running).toBe(false);
        await reopened.unmount();
    });

    it('keeps the initiating account/server and machine order after a failed first update while other machines run concurrently', async () => {
        vi.useRealTimers();
        const scope = { serverId: 'batch-scope', accountId: 'original-account' };
        const otherAccount = { ...scope, accountId: 'other-account' };
        const agent: UpdateItem = { ...remoteCli, id: 'ordered:agent:codex', machineId: 'ordered', subject: { kind: 'agent-cli', agentId: 'codex' } };
        const cli: UpdateItem = { ...remoteCli, id: 'ordered:happier-cli', machineId: 'ordered' };
        const parallel: UpdateItem = { ...agent, id: 'parallel:agent:claude', machineId: 'parallel', subject: { kind: 'agent-cli', agentId: 'claude' } };
        let release!: () => void;
        const pending = new Promise<void>((resolve) => { release = resolve; });
        rpc.invoke.mockImplementation(async (machineId: string, request: { method: string }) => {
            if (machineId === 'ordered' && request.method === 'install') {
                await pending;
                return { supported: true, response: { ok: false, error: { code: 'install-failed', message: 'Failed.' } } };
            }
            if (request.method === 'start') return { supported: true, response: { ok: true, result: { taskId: 'batch-scope-task' } } };
            if (request.method === 'poll') return { supported: true, response: { ok: true, result: { result: { ok: true } } } };
            return { supported: true, response: { ok: true, result: {} } };
        });
        const execute = (item: UpdateItem) => runs.runMachineItemUpdate(item, { scope });
        const initial = await renderHook(() => runs.useUpdateBatch(scope, [cli, agent, parallel], execute));
        let completion!: Promise<void>;
        await act(async () => { completion = initial.getCurrent().updateAll(); });
        expect(rpc.invoke.mock.calls.map((call) => call[0])).toEqual(['ordered', 'parallel']);
        expect(initial.getCurrent().batch).toEqual({ done: 1, total: 3, stopping: false });
        await initial.unmount();
        const switched = await renderHook(() => runs.useUpdateBatch(otherAccount, [], execute));
        expect(switched.getCurrent().batch).toBeNull();
        await act(async () => { switched.getCurrent().stopAfterCurrent(); });
        const original = await renderHook(() => runs.useUpdateBatch(scope, [], execute));
        expect(original.getCurrent().batch).toEqual({ done: 1, total: 3, stopping: false });
        await act(async () => { release(); await completion; });
        expect(rpc.invoke.mock.calls.map((call) => call[1]?.method)).toEqual(['install', 'install', 'start', 'poll']);
        for (const call of rpc.invoke.mock.calls) expect(call[2]).toMatchObject({ serverId: scope.serverId });
        expect(runs.readUnseenUpdateCompletions(scope).get(parallel.id)).toBe('done');
        expect(runs.readUnseenUpdateCompletions(otherAccount).size).toBe(0);
        expect(runs.observeMachineUpdateRun(runs.readMachineUpdateRuns(scope.serverId), agent.id)).toMatchObject({ running: false, errorMessage: 'Failed.' });
        expect(original.getCurrent().batch).toBeNull();
        await switched.unmount();
        await original.unmount();
    });
});
