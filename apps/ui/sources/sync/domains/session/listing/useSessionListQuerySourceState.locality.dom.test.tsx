/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildConnectedServicesAccountChangeV1, TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1 } from '@happier-dev/protocol/changes';
import type { SessionListQueryV1 } from '@happier-dev/protocol/sessions/listing/query';

import { createSessionListQuerySourceHarness, waitForSessionListQueryState, type SessionListQuerySourceHarness } from '@/dev/testkit/harness/sessionListQuerySourceHarness';
import { createPlainSessionCurrentProjectionRecordFixture, createSessionFixture, createSessionOwnerViewerFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { storage } from '@/sync/domains/state/storageStore';
import { buildSessionListRenderableFromSession } from './sessionListRenderable';
import { useSessionListQueryHomeStates, useSessionListQuerySourceState, type SessionListQuerySourceState } from './useSessionListQuerySourceState';
import { useSessionListHomeObservations } from '@/sync/store/hooks';
import type { SessionListHomeObservation } from './sessionListHomeObservation';
import { invalidateSessionListQueryHome, retireSessionListQueryAddress } from './sessionListQueryInvalidation';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { planSyncActionsFromChanges, plannedChangesAffectSessionListQuery } from '@/sync/runtime/orchestration/changesPlanner';
import { setServerReachabilityNetworkAllowed } from '@/sync/runtime/connectivity/serverReachabilitySupervisorPool';
import { sync } from '@/sync/sync';

vi.mock('socket.io-client', async (importOriginal) => (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
).createSocketIoClientBoundary(importOriginal));

const QUERY: SessionListQueryV1 = {
    v: 1, storage: 'active', includeInactive: false, scope: 'all_accessible',
    attention: 'any', audiences: [], tagIds: [], includeAttention: true,
};

let boundary: SessionListQuerySourceHarness;
beforeEach(async () => { boundary = await createSessionListQuerySourceHarness(); });
afterEach(async () => { await boundary.dispose(); });

async function mount(element: React.ReactElement) {
    const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
    const previous = environment.IS_REACT_ACT_ENVIRONMENT;
    environment.IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => { root.render(element); });
    return { async unmount() {
        await act(async () => root.unmount());
        container.remove();
        environment.IS_REACT_ACT_ENVIRONMENT = previous;
    } };
}

async function writeMetadata(serverId: string, sessionId: string, version: number) {
    const row = storage.getState().sessionListRowsByServerId[serverId]?.[sessionId];
    if (!row) throw new Error('The Session row must be admitted before it is updated');
    await act(async () => storage.getState().applyServerScopedSessionListRowPatches(serverId, [{
        sessionId, patch: { metadataVersion: version, metadata: { ...row.metadata, path: row.metadata?.path ?? '', name: 'Name ' + version } },
    }]));
}

describe('session list query source: subscription locality', () => {
    it('does no index renders for 20 Machine heartbeat and daemon publications but observes a display change', async () => {
        const serverId = boundary.serverIds[0]!;
        let machine = createMachineFixture({ id: 'index-machine', active: true,
            metadata: { ...createMachineFixture().metadata!, host: 'first-host', homeDir: '/home/example' },
            daemonState: { contributionRegistryProjectionRevision: 1 } });
        storage.getState().applyMachines([machine], false, { sourceServerId: serverId });
        const homes = [{ serverId, query: QUERY }];
        let renders = 0;
        const state: { current: SessionListQuerySourceState | null } = { current: null };
        function Host() {
            state.current = useSessionListQuerySourceState({ enabled: true, homes });
            renders += 1;
            return null;
        }
        const screen = await mount(<Host />);
        try {
            await waitForSessionListQueryState(() => expect(state.current?.statesByServerId[serverId]?.phase).toBe('ready'));
            const settled = renders;
            for (let index = 0; index < 20; index++) {
                machine = { ...machine, seq: machine.seq + 1, updatedAt: machine.updatedAt + 1,
                    activeAt: machine.activeAt + 1, daemonStateVersion: machine.daemonStateVersion + 1,
                    daemonState: { contributionRegistryProjectionRevision: index + 2 } };
                await act(async () => storage.getState().applyMachines([machine], false, { sourceServerId: serverId }));
            }
            expect(renders - settled).toBe(0);
            machine = { ...machine, metadataVersion: machine.metadataVersion + 1,
                metadata: { ...machine.metadata!, host: 'renamed-host' } };
            await act(async () => storage.getState().applyMachines([machine], false, { sourceServerId: serverId }));
            expect(renders - settled).toBe(1);
        } finally { await screen.unmount(); }
    });
    it('does no index renders when a Session row write leaves every Home index unchanged', async () => {
        // The list pane subscriber redrew on every message and agent-state write on the Account.
        const serverId = boundary.serverIds[0]!;
        const homes = [{ serverId, query: QUERY }];
        let renders = 0;
        const state: { current: SessionListQuerySourceState | null } = { current: null };
        function Host() {
            state.current = useSessionListQuerySourceState({ enabled: true, homes });
            renders += 1;
            return null;
        }
        const screen = await mount(<Host />);
        try {
            await waitForSessionListQueryState(() => expect(state.current?.statesByServerId[serverId]?.phase).toBe('ready'));
            const settled = { renders, result: state.current };
            const row = buildSessionListRenderableFromSession(createSessionFixture({ id: 'unlisted-writer', serverId }));
            for (let seq = 1; seq <= 3; seq++) {
                await act(async () => storage.setState((current) => ({ sessionListRowsByServerId: {
                    ...current.sessionListRowsByServerId,
                    [serverId]: { ...current.sessionListRowsByServerId[serverId], [row.id]: { ...row, seq } },
                } })));
            }
            expect(renders - settled.renders).toBe(0);
            expect(state.current).toBe(settled.result);
        } finally { await screen.unmount(); }
    });
    it('does no index renders across a hidden-tab pause and resume of the applied Home, and still reads a real socket loss', async () => {
        // P03-JOURNEYS-3: the pause's own disconnect read as an offline applied Home, so every list row
        // redrew on hide (~1.26k renders live) and again on show.
        const serverId = boundary.focusedHome();
        const homes = [{ serverId, query: QUERY }];
        let renders = 0;
        const state: { current: SessionListQuerySourceState | null } = { current: null };
        function Host() {
            state.current = useSessionListQuerySourceState({ enabled: true, homes });
            renders += 1;
            return null;
        }
        // The test platform has no document visibility or AppState source: drive Sync's own pause and resume
        // steps (the routine teardown a hidden tab runs, and its foreground resume).
        const pauseOwner = sync as unknown as Readonly<{
            teardownRoutineConnectivity: (tag?: string) => void;
            resumeAfterForegroundTransition: (tag: string) => void;
        }>;
        const screen = await mount(<Host />);
        try {
            await waitForSessionListQueryState(() => expect(state.current?.statesByServerId[serverId]?.phase).toBe('ready'));
            const settled = { renders, result: state.current };
            const statuses: string[] = [];
            const unsubscribe = storage.subscribe((next, previous) => {
                if (next.socketStatus !== previous.socketStatus) statuses.push(next.socketStatus);
            });
            try {
                await act(async () => { pauseOwner.teardownRoutineConnectivity('test.hide'); });
                await waitForSessionListQueryState(() => expect(statuses.length).toBeGreaterThan(0));
                await act(async () => {
                    setServerReachabilityNetworkAllowed(true);
                    pauseOwner.resumeAfterForegroundTransition('test.show');
                });
                await waitForSessionListQueryState(() => expect(storage.getState().socketStatus).toBe('connected'));
            } finally { unsubscribe(); }
            expect({ statuses, renders: renders - settled.renders }).toEqual({ statuses: ['paused', 'connected'], renders: 0 });
            expect(state.current).toBe(settled.result);
            boundary.loseTransport(serverId);
            await waitForSessionListQueryState(() => expect(state.current).not.toBe(settled.result));
        } finally {
            await screen.unmount();
        }
    });
    it('advances a cold read-to-end consumer during finite known-row Home changes instead of repeating page one', async () => {
        const serverId = boundary.focusedHome();
        const ids = Array.from({ length: 1_000 }, (_, index) => `cold-corpus-${index}`);
        const rows = ids.map(id => {
            const session = createSessionFixture({ id, active: true, activeAt: Date.now() });
            return { ...createPlainSessionCurrentProjectionRecordFixture({ id, active: true, activeAt: session.activeAt }),
                viewer: createSessionOwnerViewerFixture(session) };
        });
        storage.getState().applyServerScopedSessionListRows(serverId, [
            buildSessionListRenderableFromSession(createSessionFixture({ id: ids[0]!, metadataVersion: 1 })),
        ], { source: 'ordinary', mode: 'append' });
        const requests: Array<{ cursor: string | null; answer: ReturnType<typeof createDeferred<void>> }> = [];
        let releaseImmediately = false;
        boundary.http.answer(serverId, '/v2/sessions/query', { select(input) {
            const cursor = input && typeof input === 'object' && 'cursor' in input && typeof input.cursor === 'string'
                ? input.cursor : null;
            const answer = createDeferred<void>();
            requests.push({ cursor, answer });
            if (releaseImmediately) answer.resolve();
            const offset = cursor === null ? 0 : Number(cursor);
            return { body: { sessions: rows.slice(offset, offset + 500),
                nextCursor: offset === 0 ? '500' : null, hasNext: offset === 0,
                attentionNextCursor: null, attentionHasNext: false }, respondAfter: answer.promise };
        } });
        // A tag selection is not decided by row facts, so known-row wakes still re-read
        // it (row-decided selections are placed in place instead; sessionListRowPlacement.test.ts).
        const homes = [{ serverId, query: { ...QUERY, includeAttention: false, limit: 500, tagIds: ['tag-a'] }, readMode: 'complete' as const }];
        const state: { current: ReturnType<typeof useSessionListQueryHomeStates> | null } = { current: null };
        function Host() {
            state.current = useSessionListQueryHomeStates({ enabled: true, homes });
            return null;
        }
        const screen = await mount(<Host />);
        try {
            await waitForSessionListQueryState(() => expect(requests).toHaveLength(1));
            for (let index = 0; index < 3; index++) {
                await writeMetadata(serverId, ids[0]!, index + 2);
                const plan = planSyncActionsFromChanges([{ cursor: index + 1, kind: 'session', entityId: ids[0]!,
                    changedAt: index + 1, hint: { lastMessageSeq: index + 1, lastMessageId: `message-${index}` } }],
                { isSessionListMember: id => ids.includes(id) });
                await act(async () => {
                    publishHomeAccountChange(serverId, plan.sessionRowRefreshIds, {
                        changeKinds: ['session'], sessionListQueryAffects: plannedChangesAffectSessionListQuery(plan),
                    });
                    requests[index]!.answer.resolve();
                });
                await waitForSessionListQueryState(() => expect(requests).toHaveLength(index + 2));
            }
            const cursorsDuringChanges = requests.map(request => request.cursor);
            // Finite changes do recover when the Home stops waking; this separates starvation
            // under arrivals from a permanently stuck controller or broken continuation fixture.
            releaseImmediately = true;
            await act(async () => { for (const request of requests) request.answer.resolve(); });
            await waitForSessionListQueryState(() => expect(state.current?.coverageComplete).toBe(true));
            expect(state.current?.statesByServerId[serverId]?.addresses).toHaveLength(1_000);
            expect(storage.getState().sessionListRowsByServerId[serverId]?.[ids[0]!]!.metadata?.name).toBe('Name 4');
            expect(cursorsDuringChanges.slice(0, 2), `physical query cursors during three known-row wakes: ${JSON.stringify(cursorsDuringChanges)}`)
                .toEqual([null, '500']);
        } finally {
            releaseImmediately = true;
            for (const request of requests) request.answer.resolve();
            await screen.unmount();
        }
    });

    it('keeps the settled Session list through Machine and Connected Service wakes but re-reads Team access', async () => {
        const serverId = boundary.focusedHome();
        const machines = Array.from({ length: 446 }, (_, index) => createMachineFixture({ id: `idle-machine-${index}` }));
        const sessions = Array.from({ length: 500 }, (_, index) => {
            const id = `idle-session-${index}`;
            const session = createSessionFixture({ id, active: true, activeAt: Date.now() });
            return { ...createPlainSessionCurrentProjectionRecordFixture({ id, active: true, activeAt: session.activeAt }),
                viewer: createSessionOwnerViewerFixture(session) };
        });

        let pageReads = 0;
        let responseBytes = 0;
        let revokeFirstSession = false;
        boundary.http.answer(serverId, '/v2/sessions/query', { select(input) {
            const cursor = input && typeof input === 'object' && 'cursor' in input ? Number(input.cursor ?? 0) : 0;
            const visible = revokeFirstSession ? sessions.slice(1) : sessions;
            const hasNext = cursor + 100 < visible.length;
            const body = { sessions: visible.slice(cursor, cursor + 100),
                nextCursor: hasNext ? String(cursor + 100) : null, hasNext,
                attentionNextCursor: null, attentionHasNext: false };
            pageReads++;
            responseBytes += Buffer.byteLength(JSON.stringify(body));
            return { body };
        } });
        const homes = [{ serverId, query: { ...QUERY, includeAttention: false, limit: 100 }, readMode: 'complete' as const }];
        const state: { current: ReturnType<typeof useSessionListQueryHomeStates> | null } = { current: null };
        function Host() {
            state.current = useSessionListQueryHomeStates({ enabled: true, homes });
            return null;
        }
        const screen = await mount(<Host />);
        let cursor = 0;
        const publish = async (change: Readonly<{ kind: 'account' | 'machine'; entityId: string; hint?: unknown }>) => {
            const seq = ++cursor;
            const planned = planSyncActionsFromChanges([{ ...change, cursor: seq, changedAt: seq }]);
            await act(async () => publishHomeAccountChange(serverId, [change.entityId], {
                changeKinds: [change.kind],
                feedPageConsumed: true,
                sessionListQueryAffects: plannedChangesAffectSessionListQuery(planned),
            }));
            await waitForSessionListQueryState(() => expect(state.current?.coverageComplete).toBe(true));
        };
        const totals = () => ({ pageReads, responseBytes });
        try {
            await waitForSessionListQueryState(() => expect(state.current?.coverageComplete).toBe(true));
            expect(pageReads).toBe(5);
            await act(async () => storage.getState().applyMachines(machines, false, { sourceServerId: serverId }));
            expect(Object.keys(storage.getState().machineRecordsByServerId[serverId] ?? {})).toHaveLength(446);
            const settled = totals();
            await publish({ kind: 'machine', entityId: machines[0]!.id });
            expect(totals(), 'the Machine wake').toEqual(settled);

            const credential = buildConnectedServicesAccountChangeV1({
                pluginId: 'happier.agent.claude', localId: 'claude-subscription',
            });
            await publish(credential);
            await publish(credential);
            const credentialTraffic = { pageReads: pageReads - settled.pageReads, responseBytes: responseBytes - settled.responseBytes };

            revokeFirstSession = true;
            const beforeTeam = totals();
            await publish({ kind: 'account', entityId: TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1 });
            await waitForSessionListQueryState(() => {
                const ids = state.current?.statesByServerId[serverId]?.addresses.map(address => address.sessionId);
                expect(ids).toHaveLength(sessions.length - 1);
                expect(ids).not.toContain(sessions[0]!.id);
            });
            expect(pageReads - beforeTeam.pageReads).toBe(5);
            expect(credentialTraffic, 'two Connected Service refresh wakes').toEqual({ pageReads: 0, responseBytes: 0 });
        } finally { await screen.unmount(); }
    });

    it('keeps a never-successful query failed while its ordinary success fallback advances', async () => {
        const serverId = boundary.serverIds[0]!;
        const homes = [{ serverId, query: QUERY }];
        let queryRequests = 0;
        // A rejected query is local to this corpus. Only transport loss or a
        // Home-wide readiness verdict establishes that the Home is offline.
        boundary.http.answer(serverId, '/v2/sessions/query', { select() {
            queryRequests += 1;
            return { body: {}, status: 400 };
        } });
        let observation: SessionListHomeObservation | null | undefined;
        function Host() {
            const query = useSessionListQueryHomeStates({ enabled: true, homes });
            observation = useSessionListHomeObservations(query.statesByServerId)[serverId];
            return null;
        }
        const screen = await mount(<Host />);
        try {
            const initial = storage.getState().concurrentSessionListCacheByServerId[serverId]?.listObservation;
            await waitForSessionListQueryState(() => {
                expect(observation?.phase).toBe('error');
                expect(observation?.lastSuccessAt).toBe(initial?.lastSuccessAt ?? null);
            });
            const failedPhase = observation?.phase;
            const requests = queryRequests;
            expect(requests).toBeGreaterThan(0);
            const lastSuccessAt = (initial?.lastSuccessAt ?? 0) + 1_000;
            await act(async () => storage.setState(state => ({
                concurrentSessionListCacheByServerId: {
                    ...state.concurrentSessionListCacheByServerId,
                    [serverId]: { ...state.concurrentSessionListCacheByServerId[serverId],
                        serverName: state.concurrentSessionListCacheByServerId[serverId]?.serverName ?? null,
                        listObservation: { phase: 'ready', lastSuccessAt } },
                },
            })));
            expect(observation).toEqual({ phase: failedPhase, lastSuccessAt });
            expect(queryRequests, 'observing ordinary freshness must not retry the failed query').toBe(requests);
        } finally { await screen.unmount(); }
    });

    it('keeps unaffected Home rows settled across corpus arrivals and another Home failure, while its own failure and recovery stay current', async () => {
        const [serverId, otherHome] = boundary.serverIds;
        const homes = boundary.serverIds.map(serverId => ({ serverId, query: QUERY }));
        const ids = Array.from({ length: 100 }, (_, index) => `corpus-${index}`);
        for (const home of boundary.serverIds) boundary.setRows(home, ids);
        let renders = 0;
        let commits = 0;
        let observation: SessionListHomeObservation | null | undefined;
        const state: { current: ReturnType<typeof useSessionListQueryHomeStates> | null } = { current: null };
        const Row = React.memo(function Row(props: { observation: SessionListHomeObservation | null | undefined }) {
            renders += 1;
            React.useLayoutEffect(() => { commits += 1; });
            observation = props.observation;
            return null;
        });
        function Host() {
            state.current = useSessionListQueryHomeStates({ enabled: true, homes });
            const observations = useSessionListHomeObservations(state.current.statesByServerId);
            return <Row observation={observations[serverId!]} />;
        }
        const screen = await mount(<Host />);
        try {
            await waitForSessionListQueryState(() => {
                for (const home of boundary.serverIds) expect(state.current?.statesByServerId[home]?.phase).toBe('ready');
            });
            const settled = { renders, commits, observation };
            for (let index = 0; index < 20; index++) {
                await act(async () => retireSessionListQueryAddress(serverId!, ids[index]!));
                await act(async () => storage.getState().applyServerScopedSessionListRows(otherHome!, [
                    buildSessionListRenderableFromSession(createSessionFixture({ id: `arrival-${index}` })),
                ], { source: 'ordinary', mode: 'append' }));
            }
            expect(renders - settled.renders, '20 unrelated arrivals and corpus retirements render no unchanged Home row').toBe(0);
            expect(commits - settled.commits, '20 unrelated arrivals and corpus retirements commit no unchanged Home row').toBe(0);
            boundary.failQueries(otherHome!, 'all');
            await act(async () => { await invalidateSessionListQueryHome(otherHome!); });
            expect(renders - settled.renders, 'another Home failure must not render this row').toBe(0);
            expect(commits - settled.commits, 'another Home failure must not commit this row').toBe(0);
            const beforeOtherChange = { renders, commits, observation };
            await act(async () => retireSessionListQueryAddress(otherHome!, ids[50]!));
            expect({ renders, commits, observation }).toEqual(beforeOtherChange);
            expect(beforeOtherChange.observation?.phase).toBe('ready');
            expect(settled.observation?.lastSuccessAt).toBeTypeOf('number');
            boundary.failQueries(serverId!, 'all');
            await act(async () => { await invalidateSessionListQueryHome(serverId!); });
            // failQueries returns HTTP 503 without restart/retry hints: this
            // attempt failed, but it does not establish Home-wide unavailability.
            expect(observation?.phase).toBe('error');
            expect(state.current?.statesByServerId[serverId!]).toMatchObject({
                phase: 'error', failureReason: 'response',
                addresses: expect.arrayContaining([{ serverId, sessionId: ids[50] }]),
            });
            expect(observation?.lastSuccessAt).toBe(beforeOtherChange.observation?.lastSuccessAt);
            expect(renders).toBeGreaterThan(settled.renders);
            expect(commits).toBeGreaterThan(settled.commits);
            boundary.failQueries(serverId!, null);
            await act(async () => { await state.current?.refresh(); });
            // Observe the successful retry through the owner's pushed render.
            await waitForSessionListQueryState(() => expect(observation?.phase).toBe('ready'));
        } finally { await screen.unmount(); }
    });

    it('does not re-render a disabled source (the home and summary paths) when session rows or Machines change', async () => {
        const serverId = boundary.serverIds[0]!;
        const row = buildSessionListRenderableFromSession(createSessionFixture({ id: 'idle-row', metadataVersion: 1 }));
        storage.getState().applyServerScopedSessionListRows(serverId, [row], { source: 'ordinary', mode: 'replace' });
        let machine = createMachineFixture({ id: 'disabled-query-machine', activeAt: Date.now(),
            daemonState: { contributionRegistryProjectionRevision: 1 } });
        storage.getState().applyMachines([machine], false, { sourceServerId: serverId });
        let renders = 0;
        function Host() {
            useSessionListQuerySourceState({ enabled: false, homes: [] });
            renders += 1;
            return null;
        }
        const screen = await mount(<Host />);
        try {
            const settled = renders;
            await writeMetadata(serverId, row.id, 2);
            await writeMetadata(serverId, row.id, 3);
            for (let index = 0; index < 5; index++) {
                machine = { ...machine, seq: machine.seq + 1, daemonStateVersion: machine.daemonStateVersion + 1,
                    activeAt: Date.now(), updatedAt: Date.now() };
                await act(async () => storage.getState().applyMachines([machine], false, { sourceServerId: serverId }));
            }
            expect(renders).toBe(settled);
        } finally { await screen.unmount(); }
    });

    it('does not re-render a states-only consumer (personal membership) when a session row changes', async () => {
        const serverId = boundary.serverIds[0]!;
        const sessionId = boundary.accountId(serverId) + '-row';
        const homes = [{ serverId, query: QUERY }];
        let renders = 0;
        const state: { current: ReturnType<typeof useSessionListQueryHomeStates> | null } = { current: null };
        function Host() {
            state.current = useSessionListQueryHomeStates({ enabled: true, homes });
            renders += 1;
            return null;
        }
        const screen = await mount(<Host />);
        try {
            await waitForSessionListQueryState(() => expect(state.current?.statesByServerId[serverId]?.phase).toBe('ready'));
            const settled = renders;
            const settledStates = state.current?.statesByServerId;
            expect(boundary.queryRequests.some(request => request.serverId === serverId)).toBe(true);
            await writeMetadata(serverId, sessionId, 2);
            await writeMetadata(serverId, sessionId, 3);
            expect(renders).toBe(settled);
            expect(state.current?.statesByServerId).toBe(settledStates);
        } finally { await screen.unmount(); }
    });

    it('keeps the index of an enabled source when only a row\'s metadata changed, and rebuilds it when the corpus changed', async () => {
        const serverId = boundary.serverIds[0]!;
        const sessionId = boundary.accountId(serverId) + '-row';
        const homes = [{ serverId, query: QUERY }];
        const state: { current: SessionListQuerySourceState | null } = { current: null };
        function Host() {
            state.current = useSessionListQuerySourceState({ enabled: true, homes });
            return null;
        }
        const screen = await mount(<Host />);
        try {
            await waitForSessionListQueryState(() => expect(state.current?.statesByServerId[serverId]?.phase).toBe('ready'));
            const settledSource = state.current?.source;
            const settledByServerId = state.current?.byServerId;
            expect(Array.isArray(settledSource)).toBe(true);
            expect(settledSource?.length).toBeGreaterThan(0);
            await writeMetadata(serverId, sessionId, 2);
            expect(state.current?.source).toBe(settledSource);
            expect(state.current?.byServerId).toBe(settledByServerId);
            boundary.setRows(serverId, [sessionId, 'late-row']);
            await act(async () => { await state.current?.refresh(); });
            expect(state.current?.source).not.toBe(settledSource);
            expect(state.current?.statesByServerId[serverId]?.addresses.map(address => address.sessionId)).toEqual([sessionId, 'late-row']);
        } finally { await screen.unmount(); }
    });
});
