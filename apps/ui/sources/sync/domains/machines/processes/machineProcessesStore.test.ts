import { describe, expect, it } from 'vitest';
import { createDeferred } from '@/dev/testkit';
import { MACHINE_PROCESS_HISTORY_WINDOW_MS, type MachineProcessesAnswerV1, type MachineProcessesWatchResultV1 } from '@happier-dev/protocol/machines/processes/machineProcessesV1';
import { createMachineProcessesStore } from './machineProcessesStore';
import type { MachineProcessesRpcResult, MachineProcessesWatchInput } from './machineProcessesRpc';
import { selectMachineProcessesLeftBehind } from './selectMachineProcessesLeftBehind';

const key = { serverId: 'home', machineId: 'm', scope: 'happier' as const, view: 'tree' as const };
function answer(at = 1000): MachineProcessesAnswerV1 {
    return { v: 1, machineId: 'm', capturedAtMs: at, state: 'live', platform: 'linux', evidenceModel: 'fenced',
        owners: [{ rowId: 'session:s', owner: { kind: 'session', sessionId: 's' }, state: 'running', totals: { processCount: 1, memoryBytes: 40 },
            members: [{ rowId: 'live', ref: 'live', name: 'agent', pid: 10, startedAtMs: 1, level: 'proven', memoryBytes: 40, memoryKind: 'rss' }] }],
        leftBehind: [
            { rowId: 'ref1', ref: 'ref1', name: 'vite', command: 'vite --port 5173', pid: 20, startedAtMs: 1, level: 'left_behind', memoryBytes: 100, memoryKind: 'rss', owner: { kind: 'session', sessionId: 's' }, confirmedAtMs: 100 },
            { rowId: 'ref2', ref: 'ref2', name: 'sleep', pid: 21, startedAtMs: 1, level: 'left_behind', memoryBytes: 200, memoryKind: 'rss', owner: { kind: 'terminal', terminalId: 't' }, confirmedAtMs: 100 },
        ], totals: { happier: { processCount: 1, memoryBytes: 40 }, leftBehind: { processCount: 2, memoryBytes: 300 } } };
}
async function settle() { for (let i = 0; i < 10; i++) await Promise.resolve(); }
describe('machine process subscription and cleanup selection', () => {
    it('retains unchanged All-process groups and members through one changed group and reordering', async () => {
        let value: MachineProcessesAnswerV1 = { ...answer(), notHappier: [
            { appGroup: 'first', members: [{ name: 'first', appGroup: 'first', pid: 30, ref: 'first-30', memoryBytes: 10 }] },
            { appGroup: 'second', members: [{ name: 'second', appGroup: 'second', pid: 40, ref: 'second-40', memoryBytes: 20 },
                { name: 'second-child', appGroup: 'second', pid: 41, ref: 'second-41', memoryBytes: 30 }] },
        ] };
        const store = createMachineProcessesStore({ snapshotClient: async () => ({ ok: true, value: structuredClone(value) }),
            watchClient: () => new Promise(() => {}) });
        const all = { ...key, scope: 'all' as const };
        try {
            await store.read(all);
            const held = store.getState(all).answer!;
            let publications = 0;
            const stop = store.observe(all, () => { publications++; });
            for (let index = 0; index < 3; index++) await store.read(all);
            expect(publications).toBe(0);
            value = structuredClone(value);
            value.capturedAtMs++;
            value.notHappier![1].members[0].memoryBytes = 25;
            value.notHappier!.reverse();
            await store.read(all);
            const next = store.getState(all).answer!;
            expect(publications).toBe(1);
            expect(next.notHappier![1]).toBe(held.notHappier![0]);
            expect(next.notHappier![0].members[1]).toBe(held.notHappier![1].members[1]);
            expect(next.notHappier![0].members[0].memoryBytes).toBe(25);
            expect(next.capturedAtMs).toBe(value.capturedAtMs);
            stop();
        } finally { store.reset(); }
    });

    it('retains failed-watch freshness after the initial snapshot instead of overwriting it with a redundant read', async () => {
        const pending: Array<ReturnType<typeof createDeferred<MachineProcessesRpcResult<MachineProcessesAnswerV1>>>> = [];
        const store = createMachineProcessesStore({
            snapshotClient: () => {
                const response = createDeferred<MachineProcessesRpcResult<MachineProcessesAnswerV1>>();
                pending.push(response);
                return response.promise;
            },
            watchClient: async () => ({ ok: false, reason: 'request_failed' }),
        });
        const release = store.demand(key);
        try {
            pending[0].resolve({ ok: true, value: answer() });
            await settle();
            expect(store.getState(key).status).toBe('error');
            // Finish any initial demand read still in flight after the watch failed.
            pending[1]?.resolve({ ok: true, value: answer() });
            await settle();
            expect(store.getState(key)).toMatchObject({ status: 'error', reason: 'request_failed', answer: answer() });
        } finally { release(); store.reset(); }
    });

    it('settles an initial transport failure out of loading and recovers through the existing retry owner', async () => {
        const pending = createDeferred<MachineProcessesRpcResult<MachineProcessesAnswerV1>>();
        let retry = false;
        const store = createMachineProcessesStore({
            snapshotClient: async () => retry ? { ok: true, value: answer() } : pending.promise,
            watchClient: () => new Promise(() => {}),
        });
        const release = store.demand(key);
        try {
            await settle();
            expect(store.getState(key)).toMatchObject({ status: 'loading', answer: null });
            // The transport owns expiry; the store neither adds a timer nor retries it silently.
            const failure = { ok: false as const, reason: 'request_failed' as const, errorCode: 'permission_denied' };
            pending.resolve(failure);
            await settle();
            expect(store.getState(key)).toMatchObject({ status: 'error', reason: 'request_failed', answer: null, failure });
            retry = true;
            store.retry(key);
            await settle();
            expect(store.getState(key)).toMatchObject({ status: 'ready', answer: { state: 'live' } });
            expect(store.getState(key)).not.toHaveProperty('failure');
        } finally { release(); store.reset(); }
    });
    it('shares reads and long polls, preserves unchanged owner/row references and retains last good rows after failure and release', async () => {
        let reads = 0;
        const watches: Array<{ input: MachineProcessesWatchInput; response: ReturnType<typeof createDeferred<MachineProcessesRpcResult<MachineProcessesWatchResultV1>>> }> = [];
        const store = createMachineProcessesStore({
            async snapshotClient() { reads++; return { ok: true, value: answer(reads > 1 ? 5000 : 1000) }; },
            watchClient(input) {
                const response = createDeferred<MachineProcessesRpcResult<MachineProcessesWatchResultV1>>();
                watches.push({ input, response });
                input.signal?.addEventListener('abort', () => response.resolve({ ok: false, reason: 'request_failed' }), { once: true });
                return response.promise;
            },
        });
        expect(store.getState(key).answer).toBeNull();
        expect(reads).toBe(0);
        const a = store.demand(key); const b = store.demand(key);
        await settle();
        expect(reads).toBe(1); expect(watches).toHaveLength(1);
        const previous = store.getState(key).answer!;
        watches[0].response.resolve({ ok: true, value: { changed: true, answer: answer(3000) } });
        await settle();
        const next = store.getState(key).answer!;
        expect(next.owners).toBe(previous.owners);
        expect(next.leftBehind).toBe(previous.leftBehind);
        expect(watches[1].input.since).toBe(3000);
        watches[1].response.resolve({ ok: false, reason: 'request_failed' });
        await settle();
        expect(store.getState(key)).toMatchObject({ status: 'error', answer: next });
        a(); b();
        expect(store.getState(key).answer).toBe(next);
        const resumed = store.demand(key);
        await settle();
        expect(reads).toBe(2);
        expect(watches.at(-1)?.input.signal?.aborted).toBe(false);
        resumed(); expect(watches.at(-1)?.input.signal?.aborted).toBe(true);
        store.reset();
    });
    it('asks for history newer than the series it holds and joins only that delta, keeping idle series and the hour window', async () => {
        const sample = (capturedAtMs: number) => ({ capturedAtMs, memoryBytes: 10 });
        const watches: Array<{ input: MachineProcessesWatchInput; response: ReturnType<typeof createDeferred<MachineProcessesRpcResult<MachineProcessesWatchResultV1>>> }> = [];
        const store = createMachineProcessesStore({
            snapshotClient: async () => ({ ok: true, value: answer(1000) }),
            watchClient(input) {
                const response = createDeferred<MachineProcessesRpcResult<MachineProcessesWatchResultV1>>();
                watches.push({ input, response });
                return response.promise;
            },
        });
        const release = store.demand(key);
        const arrive = async (index: number, at: number, history: NonNullable<MachineProcessesAnswerV1['history']>) => {
            watches[index].response.resolve({ ok: true, value: { changed: true, answer: { ...answer(at), history } } });
            await settle();
        };
        try {
            await settle();
            // Nothing held yet: the daemon answers the whole series.
            expect(watches[0].input.historySince).toBeUndefined();
            await arrive(0, 3000, { 'session:s': [sample(1000), sample(3000)], idle: [sample(2000)] });
            const first = store.getState(key).answer!.history!;
            expect(watches[1].input.historySince).toBe(3000);
            await arrive(1, 5000, { 'session:s': [sample(5000)], idle: [] });
            const second = store.getState(key).answer!.history!;
            expect(second['session:s'].map(point => point.capturedAtMs)).toEqual([1000, 3000, 5000]);
            expect(second.idle).toBe(first.idle);
            expect(watches[2].input.historySince).toBe(5000);
            // Even an idle series expires when another series advances the hour window.
            const late = 5000 + MACHINE_PROCESS_HISTORY_WINDOW_MS - 1000;
            await arrive(2, late, { 'session:s': [sample(late)], idle: [] });
            const third = store.getState(key).answer!.history!;
            expect(third['session:s'].map(point => point.capturedAtMs)).toEqual([5000, late]);
            expect(third.idle).toEqual([]);
            // A series the daemon stops listing is removed from the client too.
            await arrive(3, late + 2000, { 'session:s': [] });
            expect(Object.keys(store.getState(key).answer!.history!)).toEqual(['session:s']);
        } finally { release(); store.reset(); }
    });
    it('takes the displayed filtered confirmed set once for refs, count and memory, then narrows that same set for cleanup', () => {
        const rows = answer().leftBehind;
        const selected = selectMachineProcessesLeftBehind(rows, { query: '5173' });
        expect(selected).toMatchObject({ refs: ['ref1'], count: 1, memoryBytes: 100 });
        expect(selected.items[0]).toBe(rows[0]);
        expect(selectMachineProcessesLeftBehind(rows, { selectedRefs: new Set(['ref2', 'not-visible']), query: 'vite' })).toMatchObject({ refs: [], count: 0, memoryBytes: 0 });
        expect(selectMachineProcessesLeftBehind(rows, { selectedRefs: new Set(['ref2']) })).toMatchObject({ refs: ['ref2'], count: 1, memoryBytes: 200 });
    });
    it('retains the actual last-good capture time on native unavailability and does not erase rows when detail demand changes', async () => {
        let unavailable = false;
        const store = createMachineProcessesStore({
            async snapshotClient() { return { ok: true, value: unavailable ? { ...answer(3000), state: 'unavailable', reason: 'read_failed', owners: [], leftBehind: [] } : answer() }; },
            watchClient: () => new Promise(() => {}),
        });
        await store.read(key);
        const lastGood = store.getState(key).answer;
        expect(store.getState({ ...key, detailToken: 'live' }).answer).toBe(lastGood);
        unavailable = true;
        await store.read(key);
        expect(store.getState(key)).toMatchObject({ status: 'unavailable', reason: 'read_failed' });
        expect(store.getState(key).answer).toBe(lastGood);
        store.reset();
    });
    it('never serves retained private rows to another Account on the same Home and Machine', async () => {
        const store = createMachineProcessesStore({ snapshotClient: async () => ({ ok: true, value: answer() }), watchClient: () => new Promise(() => {}) });
        await store.read({ ...key, accountId: 'first' });
        expect(store.getState({ ...key, accountId: 'first' }).answer).not.toBeNull();
        expect(store.getState({ ...key, accountId: 'second' }).answer).toBeNull();
        store.reset();
    });
});
