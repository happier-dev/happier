import { describe, expect, it, vi } from 'vitest';
import { createServer, type ServerResponse } from 'node:http';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createDeferred } from '@/testkit/async/deferred';
import { requestSessionInputLiveWork } from '@/agent/runtime/session/input/sessionProviderInputAdmissionRpc';
import { createSessionLiveWorkProducer } from './sessionLiveWorkProducer';
import { waitForChangeOrDeadline } from './waitForChangeOrDeadline';
import { createActionOperationStore } from '../actionOperations/actionOperationStore';

import { createManagedActivityInventory, createLiveWorkProducerGroup, readMachineMaintenanceAdmission, readWorkspaceSessionIdle, type LiveWorkProducerV1, type LiveWorkItemV1 } from './managedActivity';

function producer() {
    let items: readonly LiveWorkItemV1[] = [];
    let coverage: 'complete' | 'unknown' = 'complete';
    const listeners = new Set<() => void>();
    return {
        source: { read: () => ({ items, coverage }), subscribe: (listener: () => void) => {
            listeners.add(listener); return () => { listeners.delete(listener); };
        } } satisfies LiveWorkProducerV1,
        change(next: typeof items, nextCoverage: typeof coverage = 'complete') {
            items = next; coverage = nextCoverage;
            for (const listener of listeners) listener();
        },
    };
}

describe('managed activity inventory', () => {
    it('keeps resident services busy for retention while maintenance reads fresh facts and excludes only its Action', async () => {
        const service: LiveWorkItemV1 = { category: 'service', ownerRef: 'deployed-db', attribution: { kind: 'unknown' },
            state: 'active', lifecyclePurpose: 'deployment', serviceActivity: 'residency' };
        const source = producer();
        source.change([service]);
        const operations = createActionOperationStore();
        const inventory = createManagedActivityInventory({ producers: [source.source,
            { read: operations.readLiveWork, subscribe: operations.subscribe }] });
        try {
            expect(await inventory.readDecision()).toEqual({ kind: 'busy', reasons: ['service'] });
            expect(await readMachineMaintenanceAdmission(inventory)).toEqual({ kind: 'eligible' });
            for (const lifecyclePurpose of ['development', 'infrastructure'] as const) {
                source.change([{ ...service, lifecyclePurpose }]);
                expect(await readMachineMaintenanceAdmission(inventory)).toEqual({ kind: 'eligible' });
            }
            source.change([{ ...service, serviceActivity: 'transition' }]);
            expect(await readMachineMaintenanceAdmission(inventory)).toEqual({ kind: 'blocked', reasons: ['service'] });
            source.change([service]);
            for (const operationId of ['reboot', 'other']) operations.create({ operationId, actionId: 'projects.compute.exec',
                scope: { accountId: 'owner', machineId: 'machine' }, title: 'Work', cancellation: 'supported', inputIdentity: operationId });
            expect(await readMachineMaintenanceAdmission(inventory, { excludeOperationId: 'reboot' }))
                .toEqual({ kind: 'blocked', reasons: ['finite'] });
            operations.succeed('other', {});
            expect(await readMachineMaintenanceAdmission(inventory, { excludeOperationId: 'reboot' })).toEqual({ kind: 'eligible' });
            source.change([{ ...service, ownerRef: 'reboot', serviceActivity: 'transition' }]);
            expect(await readMachineMaintenanceAdmission(inventory, { excludeOperationId: 'reboot' }))
                .toEqual({ kind: 'blocked', reasons: ['service'] });
            source.change([service], 'unknown');
            expect(await readMachineMaintenanceAdmission(inventory, { excludeOperationId: 'reboot' }))
                .toEqual({ kind: 'unknown', reasons: ['coverage_unknown'] });
        } finally { inventory.dispose(); }
    });
    it('publishes only changed service activity facts while retaining a busy retention decision', async () => {
        const source = producer();
        const service = { category: 'service' as const, ownerRef: 'deployed-db', attribution: { kind: 'unknown' as const },
            state: 'active' as const, lifecyclePurpose: 'deployment' as const, serviceActivity: 'residency' as const };
        source.change([service]);
        const inventory = createManagedActivityInventory({ producers: [source.source] });
        let publications = 0;
        const unsubscribe = inventory.subscribeFacts(() => { publications++; });
        try {
            await inventory.read();
            publications = 0;
            for (let index = 0; index < 100; index++) await inventory.read();
            expect(publications).toBe(0);
            const transition = { ...service, serviceActivity: 'transition' as const };
            source.change([transition]);
            await inventory.read();
            expect(publications).toBe(1);
            expect(await inventory.readDecision()).toEqual({ kind: 'busy', reasons: ['service'] });
        } finally { unsubscribe(); inventory.dispose(); }
    });
    it('refreshes every Session for explicit confirmation during a partial passive read and retires its late idle reply', async () => {
        const passiveRequest = createDeferred();
        const passiveTransportCompleted = createDeferred();
        let passiveResponse: ServerResponse | undefined;
        let peerWorking = false;
        let sourceReads = 0;
        let peerReads = 0;
        const reply = (response: ServerResponse, working: boolean) => {
            response.setHeader('Content-Type', 'application/json');
            response.end(JSON.stringify({ session: working ? 'active' : 'settled', input: 'settled',
                agents: 'settled', attention: 'settled' }));
        };
        const server = createServer((request, response) => {
            if (request.url === '/source') {
                sourceReads += 1;
                if (sourceReads === 2) {
                    passiveResponse = response;
                    passiveRequest.resolve();
                    return;
                }
                reply(response, false);
            } else {
                peerReads += 1;
                reply(response, peerWorking);
            }
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('HTTP transport address unavailable');
        let sourceObservations = 0;
        const session = (id: string, pid: number) => {
            const tracked = { pid, startedBy: 'daemon' as const, happySessionId: id };
            return createSessionLiveWorkProducer({ readSessions: () => [tracked], readActivity: async () => {
                const latePassiveRead = id === 'source' && ++sourceObservations === 2;
                const result = await requestSessionInputLiveWork({ callRpc: async () =>
                    (await fetch(`http://127.0.0.1:${address.port}/${id}`)).json() });
                if (latePassiveRead) passiveTransportCompleted.resolve();
                return result;
            } });
        };
        const source = session('source', 1);
        const peer = session('peer', 2);
        const inventory = createManagedActivityInventory({ producers: [source, peer] });
        const decisions: Awaited<ReturnType<typeof inventory.readDecision>>[] = [];
        const unsubscribe = inventory.subscribe(decision => { decisions.push(decision); });
        try {
            expect((await inventory.readDecision()).kind).toBe('idle');
            source.notifyChanged('observation');
            await passiveRequest.promise;
            // The peer has changed before its hint arrives. A destructive caller's
            // explicit confirmation must refresh it, even while the passive read waits.
            peerWorking = true;
            const confirmation = inventory.readDecision();
            await vi.waitFor(() => expect(peerReads).toBe(2));
            expect(await confirmation).toEqual({ kind: 'busy', reasons: ['session'] });
            expect(sourceReads).toBe(3);
            const beforeLateReply = [...decisions];
            reply(passiveResponse!, false);
            await passiveTransportCompleted.promise;
            // The transport continuation and aggregate projection finish before
            // the next event-loop turn; no timer budget governs product behavior.
            await nextTurn();
            expect(decisions).toEqual(beforeLateReply);
        } finally {
            unsubscribe(); inventory.dispose(); server.closeAllConnections();
            await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        }
    });
    it('does not use a partial passive projection as a fresh confirmation of unrelated Session work', async () => {
        let working = false;
        let sessionReads = 0;
        const server = createServer((_request, response) => {
            sessionReads++;
            response.setHeader('Content-Type', 'application/json');
            response.end(JSON.stringify({ session: working ? 'active' : 'settled', input: 'settled',
                agents: 'settled', attention: 'settled' }));
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('HTTP transport address unavailable');
        const tracked = { pid: 1, startedBy: 'daemon' as const, happySessionId: 'session' };
        const sessions = createSessionLiveWorkProducer({ readSessions: () => [tracked], readActivity: () =>
            requestSessionInputLiveWork({ callRpc: async () => (await fetch(`http://127.0.0.1:${address.port}/activity`)).json() }) });
        const operations = createActionOperationStore();
        const inventory = createManagedActivityInventory({ producers: [sessions,
            { read: operations.readLiveWork, subscribe: operations.subscribe }] });
        const passive = createDeferred<Awaited<ReturnType<typeof inventory.readDecision>>>();
        let unsubscribe = () => {};
        try {
            expect((await inventory.readDecision()).kind).toBe('idle');
            expect(sessionReads).toBe(1);
            unsubscribe = inventory.subscribe(decision => passive.resolve(decision));
            // A delayed Session hint must not let the retained peer projection
            // satisfy an explicit fresh confirmation while another owner updates.
            working = true;
            operations.create({ operationId: 'finite', actionId: 'projects.compute.exec',
                scope: { accountId: 'owner', machineId: 'machine' }, title: 'Work',
                cancellation: 'supported', inputIdentity: 'finite' });
            await passive.promise;
            expect(sessionReads).toBe(1);
            expect(await inventory.readDecision()).toEqual({ kind: 'busy', reasons: ['session', 'finite'] });
            expect(sessionReads).toBe(2);
        } finally {
            unsubscribe(); inventory.dispose(); server.closeAllConnections();
            await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        }
    });
    it('retains idle across healthy Session observations but publishes discovered work and material invalidations', async () => {
        let now = 100;
        let working = false;
        const tracked = { pid: 1, startedBy: 'daemon' as const, happySessionId: 'session' };
        const source = createSessionLiveWorkProducer({ readSessions: () => [tracked], readActivity: async () => ({
            session: working ? 'active' : 'settled', input: 'settled', agents: 'settled', attention: 'settled',
        }) });
        const inventory = createManagedActivityInventory({ producers: [source], now: () => now });
        try {
            expect(await inventory.readDecision()).toEqual({ kind: 'idle', since: 100 });
            now = 200;
            source.notifyChanged('observation');
            expect(await inventory.readDecision()).toEqual({ kind: 'idle', since: 100 });
            working = true;
            source.notifyChanged('observation');
            expect(await inventory.readDecision()).toEqual({ kind: 'busy', reasons: ['session'] });
            now = 300;
            working = false;
            source.notifyChanged('observation');
            expect(await inventory.readDecision()).toEqual({ kind: 'idle', since: 300 });
            now = 400;
            source.notifyChanged();
            expect(await inventory.readDecision()).toEqual({ kind: 'idle', since: 400 });
        } finally { inventory.dispose(); }
    });
    it('publishes fresh Session facts while a retired runner transport remains pending, without accepting its late idle proof', async () => {
        const retiredRequest = createDeferred();
        const currentRequest = createDeferred();
        const retiredResponse = createDeferred<ServerResponse>();
        const server = createServer((request, response) => {
            if (request.url === '/retired') {
                retiredRequest.resolve();
                retiredResponse.resolve(response);
                return;
            }
            response.setHeader('Content-Type', 'application/json');
            response.end(JSON.stringify({ session: 'settled', input: 'settled', agents: 'settled', attention: 'settled', settledAt: 200 }));
            currentRequest.resolve();
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('HTTP transport address unavailable');
        const retired = { pid: 1, startedBy: 'daemon' as const, happySessionId: 'retired' };
        const current = { pid: 2, startedBy: 'daemon' as const, happySessionId: 'current' };
        let sessions = [retired];
        let now = 100;
        const source = createSessionLiveWorkProducer({ readSessions: () => sessions,
            readActivity: tracked => requestSessionInputLiveWork({ callRpc: async () =>
                (await fetch(`http://127.0.0.1:${address.port}/${tracked.happySessionId}`)).json() }) });
        const inventory = createManagedActivityInventory({ producers: [source], now: () => now });
        const published: unknown[] = [];
        const unsubscribe = inventory.subscribe(decision => { published.push(decision); });
        const old = inventory.readDecision();
        try {
            await retiredRequest.promise;
            sessions = [current];
            now = 200;
            source.notifyChanged();
            let fresh: Awaited<ReturnType<typeof inventory.read>> | undefined;
            const read = inventory.read().then(result => { fresh = result; });
            await currentRequest.promise;
            // Only the old network request is withheld. The new production projection
            // must publish independently; this is a test assertion window, not a product deadline.
            await vi.waitFor(() => expect(fresh).toMatchObject({ coverage: 'complete', idleSince: 200,
                items: [{ category: 'session', ownerRef: current, state: 'settled', settledAt: 200 },
                    { category: 'input', state: 'settled' }, { category: 'agents', state: 'settled' },
                    { category: 'attention', state: 'settled' }] }), { timeout: 1_000 });
            await read;
            const beforeLateReply = [...published];
            now = 300;
            const response = await retiredResponse.promise;
            response.setHeader('Content-Type', 'application/json');
            response.end(JSON.stringify({ session: 'settled', input: 'settled', agents: 'settled', attention: 'settled', settledAt: 1 }));
            expect(await old).toMatchObject({ kind: 'unknown' });
            expect(published).toEqual(beforeLateReply);
            expect(await inventory.readDecision()).toEqual({ kind: 'idle', since: 200 });
        } finally {
            unsubscribe(); inventory.dispose();
            server.closeAllConnections();
            await old;
            await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        }
    });
    it('shares concurrent live Session observations and reads again after settlement', async () => {
        // The remote Session transport is the system boundary; inventory, Session
        // projection and RPC response validation below use their real owners.
        const firstRequest = createDeferred();
        const pending = new Set<ServerResponse>();
        let requests = 0;
        let released = false;
        const reply = (response: ServerResponse) => {
            response.setHeader('Content-Type', 'application/json');
            response.end(JSON.stringify({ session: 'settled', input: 'settled', agents: 'settled', attention: 'settled', settledAt: 1 }));
        };
        const server = createServer((_request, response) => {
            requests++;
            firstRequest.resolve();
            if (released) reply(response);
            else pending.add(response);
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('HTTP transport address unavailable');
        const tracked = { pid: 1, startedBy: 'daemon' as const, happySessionId: 'session' };
        const source = createSessionLiveWorkProducer({ readSessions: () => [tracked], readActivity: () =>
            requestSessionInputLiveWork({ callRpc: async () => (await fetch(`http://127.0.0.1:${address.port}/activity`)).json() }) });
        const inventory = createManagedActivityInventory({ producers: [source] });
        try {
            const readers = Array.from({ length: 12 }, () => inventory.readDecision());
            await firstRequest.promise;
            released = true;
            for (const response of pending) reply(response);
            const decisions = await Promise.all(readers);
            expect(decisions.every(decision => decision.kind === 'idle')).toBe(true);
            expect(requests).toBe(1);
            expect((await inventory.readDecision()).kind).toBe('idle');
            expect(requests).toBe(2);
        } finally {
            inventory.dispose();
            server.closeAllConnections();
            await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        }
    });
    it('reads workspace Session work rather than service residency or a different workspace', () => {
        const service: LiveWorkItemV1 = { category: 'service', ownerRef: 'project-service', attribution: { kind: 'unknown' }, state: 'active' };
        const session: LiveWorkItemV1 = { category: 'session', ownerRef: 'session', attribution: { kind: 'unknown' },
            state: 'settled', workspacePath: '/repo/src' };
        const workspace = { workspacePath: '/repo', workspaceId: 'workspace' };
        const read = (items: readonly LiveWorkItemV1[]) => readWorkspaceSessionIdle({ items, coverage: 'complete' }, workspace);
        expect(read([service, session])).toBe(true);
        expect(read([service, { ...session, category: 'agents', state: 'active' }])).toBe(false);
        expect(read([service, { ...session, category: 'attention', state: 'active' }])).toBe(false);
        expect(read([service, { ...session, state: 'active', workspacePath: '/repo-other' }])).toBe(true);
        expect(read([service, { ...session, state: 'active', workspaceId: 'other' }])).toBe(true);
        expect(read([service, { ...session, state: 'unknown' }])).toBeNull();
        expect(read([service, { ...session, state: 'active', workspacePath: undefined }])).toBeNull();
        expect(readWorkspaceSessionIdle({ items: [service], coverage: 'unknown' }, workspace)).toBeNull();
    });
    it('uses canonical workspace path boundaries on Windows and does not borrow a sibling workspace', () => {
        const session: LiveWorkItemV1 = { category: 'input', ownerRef: 'session', attribution: { kind: 'unknown' },
            state: 'active', workspacePath: 'c:/Users/ALICE/repo/src' };
        const workspace = { workspacePath: 'C:\\Users\\alice\\repo\\' };
        expect(readWorkspaceSessionIdle({ items: [session], coverage: 'complete' }, workspace)).toBe(false);
        expect(readWorkspaceSessionIdle({ items: [{ ...session, workspacePath: 'C:\\Users\\alice2\\repo' }], coverage: 'complete' }, workspace)).toBe(true);
        expect(readWorkspaceSessionIdle({ items: [session], coverage: 'complete' }, { workspacePath: 'not-absolute' })).toBeNull();
    });
    it('wakes per-session planning on an owner edge even while another session keeps the machine busy', async () => {
        vi.useFakeTimers();
        const source = producer();
        const one: LiveWorkItemV1 = { category: 'session', ownerRef: 'one', attribution: { kind: 'unknown' }, state: 'active' };
        const two: LiveWorkItemV1 = { ...one, ownerRef: 'two' };
        source.change([one, two]);
        const inventory = createManagedActivityInventory({ producers: [source.source] });
        try {
            expect(await inventory.readDecision()).toEqual({ kind: 'busy', reasons: ['session'] });
            const waiting = waitForChangeOrDeadline({ remainingMs: 1000, waitForChange: signal => new Promise(resolve => {
                const unsubscribe = inventory.subscribe(() => { unsubscribe(); resolve(); });
                signal.addEventListener('abort', unsubscribe, { once: true });
            }) });
            source.change([{ ...one, state: 'settled', settledAt: 20 }, two]);
            await inventory.read();
            await vi.advanceTimersByTimeAsync(1000);
            expect(await waiting).toBe('changed');
        } finally { inventory.dispose(); vi.useRealTimers(); }
    });
    it('does not confirm an asynchronous settled snapshot invalidated by a real owner edge', async () => {
        let notify = () => {};
        let release = () => {};
        let delayed = false;
        const source: LiveWorkProducerV1 = {
            read: () => delayed ? new Promise(resolve => { release = () => resolve({ items: [], coverage: 'complete' }); })
                : { items: [], coverage: 'complete' },
            subscribe: listener => { notify = listener; return () => {}; },
        };
        const inventory = createManagedActivityInventory({ producers: [source], now: () => 100 });
        expect((await inventory.readDecision()).kind).toBe('idle');
        delayed = true;
        const confirmation = inventory.readDecision();
        delayed = false;
        notify(); release();
        expect((await confirmation).kind).toBe('unknown');
        inventory.dispose();
    });
    it('observes late incumbent owners and releases retired owner subscriptions without inventing coverage', async () => {
        let current: LiveWorkProducerV1[] | null = null;
        const group = createLiveWorkProducerGroup(() => current);
        const inventory = createManagedActivityInventory({ producers: [group] });
        expect((await inventory.readDecision()).kind).toBe('unknown');
        const owner = producer();
        current = [owner.source];
        group.notifyChanged();
        expect((await inventory.readDecision()).kind).toBe('idle');
        owner.change([{ category: 'setup', ownerRef: 'actual-operation', attribution: { kind: 'unknown' }, state: 'active' }]);
        expect(await inventory.readDecision()).toEqual({ kind: 'busy', reasons: ['setup'] });
        current = null;
        group.notifyChanged();
        expect((await inventory.readDecision()).kind).toBe('unknown');
        inventory.dispose(); group.dispose();
    });
    it('does not miss an active edge followed by settlement in the same turn', async () => {
        let now = 10;
        const source = producer();
        const inventory = createManagedActivityInventory({ producers: [source.source], now: () => now });
        expect(await inventory.readDecision()).toEqual({ kind: 'idle', since: 10 });
        now = 20;
        source.change([{ category: 'finite', ownerRef: 'operation', attribution: { kind: 'unknown' }, state: 'active' }]);
        now = 30;
        source.change([]);
        expect(await inventory.readDecision()).toEqual({ kind: 'idle', since: 30 });
        inventory.dispose();
    });
    it('uses real producer edges for aggregate idle, including service and transfer work absent from public counts', async () => {
        let now = 10;
        const service = producer();
        const transfer = producer();
        service.change([{ category: 'service', ownerRef: 'service', attribution: { kind: 'unknown' }, state: 'active' }]);
        const inventory = createManagedActivityInventory({ producers: [service.source, transfer.source], now: () => now });
        const decisions: unknown[] = [];
        const cleanup = inventory.subscribe(decision => { decisions.push(decision); });
        expect(await inventory.readDecision()).toEqual({ kind: 'busy', reasons: ['service'] });
        now = 20;
        transfer.change([{ category: 'transfer', ownerRef: 'transfer', attribution: { kind: 'unknown' }, state: 'active' }]);
        service.change([]);
        expect(await inventory.readDecision()).toEqual({ kind: 'busy', reasons: ['transfer'] });
        now = 30;
        transfer.change([]);
        expect(await inventory.readDecision()).toEqual({ kind: 'idle', since: 30 });
        now = 80;
        expect((await inventory.read()).idleSince).toBe(30);
        expect(decisions).toContainEqual({ kind: 'idle', since: 30 });
        cleanup(); inventory.dispose();
    });

    it('fails unknown coverage closed and starts a new idle interval only after coverage recovers', async () => {
        let now = 10;
        const source = producer();
        const inventory = createManagedActivityInventory({ producers: [source.source], now: () => now });
        expect(await inventory.readDecision()).toEqual({ kind: 'idle', since: 10 });
        source.change([], 'unknown');
        expect(await inventory.readDecision()).toEqual({ kind: 'unknown', reasons: ['coverage_unknown'] });
        now = 30;
        source.change([]);
        expect(await inventory.readDecision()).toEqual({ kind: 'idle', since: 30 });
        inventory.dispose();
    });

    it('retains internal operation to PTY association without transporting references or attribution', async () => {
        const source = producer();
        source.change([{ category: 'finite', ownerRef: 'private-operation', associatedTerminal: 'private-terminal',
            attribution: { kind: 'unknown' }, state: 'active' },
        { category: 'terminal', ownerRef: 'private-terminal', attribution: { kind: 'unknown' }, state: 'active' }]);
        const inventory = createManagedActivityInventory({ producers: [source.source] });
        expect((await inventory.read()).items).toHaveLength(2);
        expect(await inventory.readDecision()).toEqual({ kind: 'busy', reasons: ['finite'] });
        inventory.dispose();
    });
});
