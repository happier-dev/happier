import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { applyWorkBoardIntentV1, buildWorkBoardItemKeyV1, createWorkBoardV1} from '@happier-dev/protocol/boards/workBoardV1';
import { encodePlainArtifactStoredContent} from '@happier-dev/protocol/storage/artifactStoredContent';
import { managedMachineActionEndpointPathV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { normalizeSessionListFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import { createSessionListSourceFixture } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';

import { createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { createPlainSessionCurrentProjectionRecordFixture, createSessionFixture, createSessionListRenderableSessionFixture, createSessionOwnerViewerFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { observeMachinePresenceForTest } from '@/dev/testkit/harness/machinePresence';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { createRenderCommitCounter, createRootLayoutFeaturesResponse, renderScreen, useRenderCommitCounter } from '@/dev/testkit';
import * as React from 'react';
import { isSessionListRowVisible } from '@/sync/domains/session/sessionSurfaceVisibility';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { waitForHomeGovernance, type HomeDomainAnswer } from '@/dev/testkit/harness/homeGovernanceHarness';
import { ARTIFACT_LIST_PATH, AUTOMATION_QUERY_PATH, RUN_STORAGE_PATH, boardDefinitionArtifact, boardRunStoragePage, installBoardLibraryTestHarness } from '../boardLibraryTestHarness';
import type { BoardHomes } from './useBoardContent';

const harness = installBoardLibraryTestHarness();
const { readSessionStatusNextRefreshAtMs } = await import('@/utils/sessions/sessionUtils');
const { sessionListRuntimeClock } = await import('@/hooks/session/sessionListRuntimeClock');
const { workflowRunRowFromSummary, workflowRunStoreKey } = await import('@/sync/store/domains/workflowRuns');
const { formatWorkflowDefinitionContentUnavailableReason } = await import('@/components/workflows/presentation/workflowProblemPresentation');
const { clearMachineRequestReachabilityForTest, recordMachineRequestFailed, recordMachineRequestSucceeded } = await import('@/sync/domains/machines/reachability/machineReachability');
const { storage } = await import('@/sync/domains/state/storageStore');
const { useBoardCards, useBoardMembership, useBoardWidgets } = await import('./useBoardContent');
const { resolveBoardPruneMembership } = await import('./boardMembership');
const { buildBoardCards } = await import('./boardCards');
const { BoardCardBodyContent } = await import('../cards/BoardCardView');
const { t } = await import('@/text');
const { useWorkflowDefinitionLibrary, useWorkflowRunWindow } = await import('@/components/workflows/library/workflowLibraryReads');
const { useWorkflowLibrarySummaries } = await import('@/components/workflows/library/useWorkflowLibrarySummaries');
const runAnswer = vi.fn<(input: unknown) => HomeDomainAnswer>();
// Markdown is a third-party rendering boundary; membership never renders it.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({ splitStreamingRevealTextParts: () => [] }));

let previousState = storage.getState();
let homes: BoardHomes;
beforeEach(async () => {
    previousState = storage.getState();
    const serverId = await harness.connect('http://board-runs.test', 'account-a', 'srv_managed_board_home');
    storage.setState({ profileScope: { serverId, accountId: 'account-a' },
        workflowRunsById: {}, workflowRunListWindows: {} });
    homes = { activeServerId: serverId, mountedServerIds: [serverId], isHomeMounted: (id) => id === serverId };
    harness.home.answer(serverId, RUN_STORAGE_PATH, { select: runAnswer });
});
afterEach(async () => {
    clearMachineRequestReachabilityForTest();
    standardCleanup();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    (await import('@/components/workflows/library/workflowLibraryReads')).resetWorkflowLibraryReadsForTests();
    (await import('@/sync/domains/scope/activeServerAccountScope')).retireActiveServerAccountScopeLifetime();
    await harness.dispose();
    runAnswer.mockReset();
    storage.setState(previousState);
});

function runsBoard(startedBy: readonly ('you' | 'agents' | 'triggers')[] = []) {
    return { ...createWorkBoardV1({ id: 'board-runs', name: 'Runs' }), source: { picked: [],
        filter: normalizeSessionListFilterV1({ show: 'runs', startedBy, homeServerIds: homes.mountedServerIds }),
    } };
}

function runPageCursor(input: unknown) {
    // Refreshes can repeat a page; HTTP answers follow its cursor, not call order.
    if (input === null || typeof input !== 'object' || !('request' in input)) return undefined;
    const request = input.request;
    return request !== null && typeof request === 'object' && 'cursor' in request ? request.cursor : undefined;
}

describe('Board shared Run filter membership', () => {
    it('reads managed state for a run-only Board and refreshes its retained card on observed Start', async () => {
        const { getServerProfileById } = await import('@/sync/domains/server/serverProfiles');
        const serverId = homes.activeServerId!;
        expect(getServerProfileById(serverId)?.serverIdentityId).toBe('srv_managed_board_home');
        const guest = createMachineFixture({ id: 'guest', active: false, activeAt: 0,
            managedInputRuntime: { nativeReady: false, wakeState: 'asleep', state: 'asleep' } });
        const run = createWorkflowRunSummaryFixture({ id: 'managed-run', state: 'running', machineId: guest.id });
        storage.setState({ workflowRunsById: { [workflowRunStoreKey(run.id)]: workflowRunRowFromSummary(run) } });
        storage.getState().applyMachines([guest], true, { sourceServerId: serverId, sourceAccountId: 'account-a' });
        const ref = { kind: 'workflow_run' as const, qualifiedId: { serverId, id: run.id } };
        const membership = { members: [{ key: buildWorkBoardItemKeyV1(ref), ref, picked: true, sourced: false, available: true }], complete: true };
        const hook = await renderHook(() => useBoardCards(membership, homes));
        try {
            await waitForHomeGovernance(() => expect(hook.getCurrent()[0]?.status).toMatchObject({ bucket: 'idle', word: t('managedPower.asleep') }));
            await act(async () => storage.getState().applyMachines([{ ...guest,
                managedInputRuntime: { nativeReady: false, wakeState: 'starting', state: 'starting' },
            }], true, { sourceServerId: serverId, sourceAccountId: 'account-a' }));
            await waitForHomeGovernance(() => expect(hook.getCurrent()[0]?.status)
                .toMatchObject({ bucket: 'working', state: 'starting' }));
            expect(harness.home.requestsFor(managedMachineActionEndpointPathV1('machines.managed.list'))).toHaveLength(0);
        } finally { await hook.unmount(); }
    });
    it.each([true, false])('hides private picked Session cards on sharing push without removing Board membership (enabled=%s)', async (enabled) => {
        const { buildSessionOrganizationSessionKey } = await import('@/sync/domains/session/organization/keys');
        const { setScreenSharingPrivacyActive } = await import('@/desktop/capture/useNativeRecordingActive');
        const serverId = homes.activeServerId!;
        const row = createSessionListRenderableSessionFixture({ id: 'private-picked', metadata: { name: 'Secret invoices', path: '/private', host: 'host' } });
        storage.setState({ settings: { ...storage.getState().settings, sessionListHiddenTagIdsWhileRecording: { [serverId]: ['secret'] } },
            sessionOrganizationTagAssignmentsBySessionKey: { [buildSessionOrganizationSessionKey(serverId, row.id)]: { sessionId: row.id, tagIds: ['secret'] } },
            sessionListRowsByServerId: { [serverId]: { [row.id]: row } } });
        const ref = { kind: 'session' as const, qualifiedId: { serverId, id: row.id } };
        const membership = { members: [{ key: buildWorkBoardItemKeyV1(ref), ref, picked: true, sourced: false, available: true }],
            complete: true, settled: true, undetermined: { count: 0, reasons: [] } };
        const hook = await renderHook(({ active }: { active: boolean }) => useBoardCards(membership, homes, { enabled: active }), { initialProps: { active: true } });
        try {
            expect(hook.getCurrent().map(card => card.title)).toContain('Secret invoices');
            await hook.rerender({ active: enabled });
            await act(async () => {
                storage.setState({ settings: { ...storage.getState().settings,
                    sessionListHiddenTagIdsWhileRecording: { [serverId]: ['secret'] } },
                    sessionOrganizationTagAssignmentsBySessionKey: { [buildSessionOrganizationSessionKey(serverId, row.id)]: { sessionId: row.id, tagIds: ['secret'] } } });
                setScreenSharingPrivacyActive(true);
            });
            const { readSessionRecordingVisibility } = await import('@/sync/store/sessionRecordingVisibility');
            expect(readSessionRecordingVisibility()({ serverId, sessionId: row.id })).toBe(false);
            expect(hook.getCurrent()).toEqual([]);
            expect(membership.members).toHaveLength(1);
            await act(async () => setScreenSharingPrivacyActive(false));
            await hook.rerender({ active: true });
            expect(hook.getCurrent().map(card => card.title)).toContain('Secret invoices');
        } finally { await hook.unmount(); setScreenSharingPrivacyActive(false); }
    });
    it('settles answered Run filter unknowns with incompleteness instead of treating them as misses', async () => {
        const pending = createDeferred<void>();
        onTestFinished(() => pending.resolve());
        runAnswer.mockReturnValue({ body: await boardRunStoragePage([
            createWorkflowRunSummaryFixture({ id: 'unknown-run' }), createWorkflowRunSummaryFixture({ id: 'other-run' }),
        ]), respondAfter: pending.promise });
        const base = runsBoard(['you', 'agents', 'triggers']);
        const board = { ...base, source: { picked: [], filter: normalizeSessionListFilterV1({ ...base.source.filter,
            scope: 'all_accessible', extensions: { 'retired/field': { kind: 'boolean', value: true } },
        }) } };
        const hook = await renderHook(() => useBoardMembership(board, homes));
        await waitForHomeGovernance(() => expect(harness.home.requestsFor(RUN_STORAGE_PATH).length).toBeGreaterThan(0));
        expect(hook.getCurrent().settled).toBe(false);
        await act(async () => { pending.resolve(); await pending.promise; });
        await waitForHomeGovernance(() => expect(hook.getCurrent().settled).toBe(true));
        expect(hook.getCurrent()).toMatchObject({ members: [], complete: false, undetermined: { count: 2,
            reasons: [{ kind: 'workflow_run', reason: 'filter_facts_unavailable', count: 2 }] } });
    });
    it.each([false, true])('settles an unlisted visible Session by exact read, without paging its Home (exists: %s)', async exists => {
        const serverId = homes.activeServerId!;
        const id = 'unlisted-card';
        const gate = createDeferred<void>();
        onTestFinished(() => gate.resolve());
        const answer = { body: exists
            ? { session: createPlainSessionCurrentProjectionRecordFixture({ id }) }
            : { error: 'not_found', code: 'session_not_found' }, status: exists ? 200 : 404, respondAfter: gate.promise };
        harness.home.answer(serverId, `/v2/sessions/${id}`, answer);
        harness.home.answer(serverId, `/v2/sessions/${id}?accessProjectionVersion=1`, answer);
        const ref = { kind: 'session' as const, qualifiedId: { serverId, id } };
        const membership = { members: [{ key: buildWorkBoardItemKeyV1(ref), ref, picked: true, sourced: false, available: true }], complete: true };
        storage.setState({ sessionListRowsByServerId: {}, deletedSessionIds: {}, concurrentSessionListCacheByServerId: {} });
        let cards: ReturnType<typeof useBoardCards> = [];
        function Host() {
            cards = useBoardCards(membership, homes);
            return cards.map(card => <BoardCardBodyContent key={card.key} card={card} />);
        }
        const screen = await renderScreen(<Host />);
        expect(isSessionListRowVisible(id, serverId)).toBe(true);
        const exactReads = () => harness.home.requests.filter(request => request.method === 'GET'
            && request.path.split('?')[0] === `/v2/sessions/${id}`);
        await waitForHomeGovernance(() => expect(exactReads()).toHaveLength(1));
        const pages = harness.home.requestsFor('/v2/sessions').length;
        await act(async () => { gate.resolve(); await gate.promise; });
        await waitForHomeGovernance(() => expect(cards[0]?.availability).toBe(exists ? 'ready' : 'content_unavailable'));
        expect(harness.home.requestsFor('/v2/sessions')).toHaveLength(pages);
        expect(exactReads()).toHaveLength(1);
        await screen.unmount();
    });
    it('does not redraw a Session-filter Board when a row write changes no Board answer', async () => {
        // A pinned Board's count redrew on every message and agent-state write on the Account.
        const board = { ...createWorkBoardV1({ id: 'filtered-sessions', name: 'Sessions' }), source: {
            picked: [], filter: normalizeSessionListFilterV1({ show: 'sessions', homeServerIds: homes.mountedServerIds }),
        } };
        const row = createSessionListRenderableSessionFixture({ id: 'busy-writer', active: true, activeAt: Date.now() });
        storage.setState({ sessionListRowsByServerId: { [homes.activeServerId!]: { [row.id]: row } } });
        let renders = 0;
        await renderHook(() => { renders += 1; return useBoardMembership(board, homes); });
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
        const before = renders;
        for (let seq = 2; seq < 5; seq += 1) {
            await act(async () => { storage.setState({ sessionListRowsByServerId: { [homes.activeServerId!]: { [row.id]: { ...row, seq } } } }); });
        }
        expect(renders - before).toBe(0);
    });

    it('does not settle a Session filter before any Home has been observed', async () => {
        const board = { ...createWorkBoardV1({ id: 'opening', name: 'Opening' }), source: {
            picked: [], filter: normalizeSessionListFilterV1({ show: 'sessions', homeServerIds: [] }),
        } };
        const openingHomes: BoardHomes = { activeServerId: null, mountedServerIds: [], isHomeMounted: () => false };
        const hook = await renderHook(() => useBoardMembership(board, openingHomes));
        expect(hook.getCurrent()).toMatchObject({ members: [], complete: false, settled: false });
    });

    it('does not call a filter of an unmounted Home an answered empty selection', async () => {
        const board = { ...createWorkBoardV1({ id: 'unmounted', name: 'Unavailable Home' }), source: {
            picked: [], filter: normalizeSessionListFilterV1({ show: 'sessions', homeServerIds: ['not-mounted'] }),
        } };
        const hook = await renderHook(() => useBoardMembership(board, homes));
        expect(hook.getCurrent()).toMatchObject({ members: [], settled: false });
    });

    it.each([false, true])('waits for the filtered item source to answer (with items: %s)', async withItems => {
        const pending = createDeferred<void>();
        onTestFinished(() => pending.resolve());
        const rows = withItems ? [createWorkflowRunSummaryFixture({ id: 'late', startedBy: 'user' })] : [];
        runAnswer.mockReturnValue({ body: await boardRunStoragePage(rows), respondAfter: pending.promise });
        const hook = await renderHook(() => useBoardMembership(runsBoard(['you']), homes));
        await waitForHomeGovernance(() => expect(harness.home.requestsFor(RUN_STORAGE_PATH).length).toBeGreaterThan(0));
        expect(hook.getCurrent()).toMatchObject({ members: [], settled: false });
        await act(async () => { pending.resolve(); await pending.promise; });
        await waitForHomeGovernance(() => expect(hook.getCurrent().settled).toBe(true));
        expect(hook.getCurrent().members.map(member => member.ref.qualifiedId.id)).toEqual(withItems ? ['late'] : []);
    });

    it('settles a coordinators-only Run selection as complete empty without requesting Runs', async () => {
        const board = { ...runsBoard(), source: { picked: [], filter: normalizeSessionListFilterV1({
            show: 'runs', coordinator: 'coordinator', homeServerIds: homes.mountedServerIds,
        }) } };
        const hook = await renderHook(() => useBoardMembership(board, homes));
        expect(hook.getCurrent()).toMatchObject({ members: [], complete: true });
        expect(harness.home.requestsFor(RUN_STORAGE_PATH)).toHaveLength(0);
    });
    it('keeps a directly picked legacy-Home Session keyed by its persisted ref through canonical arrivals and misses', async () => {
        const { adoptHomeProfile, areServerProfileIdentifiersEquivalent, resolveServerProfileScopeIdForIdentifier, upsertServerProfile } =
            await import('@/sync/domains/server/serverProfiles');
        const url = 'https://board-picked-legacy.test';
        const legacy = await upsertServerProfile({ serverUrl: url, source: 'legacy' });
        const canonical = 'srv_board_picked_legacy_home';
        await adoptHomeProfile({ descriptor: { v: 1, homeServerIdentityId: canonical,
            canonicalServerUrl: url, revision: 1, endpoints: [{ kind: 'https', url }] }, source: 'manual' });
        expect(legacy.id).not.toBe(canonical);
        expect(resolveServerProfileScopeIdForIdentifier(legacy.id)).toBe(canonical);
        expect(areServerProfileIdentifiersEquivalent(legacy.id, canonical)).toBe(true);
        const ref = { kind: 'session', qualifiedId: { serverId: legacy.id, id: 'legacy-picked-session' } } as const;
        const key = buildWorkBoardItemKeyV1(ref);
        expect(key).not.toBe(buildWorkBoardItemKeyV1({ kind: 'session', qualifiedId: { serverId: canonical, id: ref.qualifiedId.id } }));
        const membership = { members: [{ key, ref, picked: true, sourced: false, available: true }], complete: true };
        const aliasHomes: BoardHomes = { activeServerId: canonical, mountedServerIds: [canonical],
            isHomeMounted: id => areServerProfileIdentifiersEquivalent(id, canonical) };
        const row = createSessionListRenderableSessionFixture({ id: ref.qualifiedId.id, active: true, activeAt: Date.now(),
            hasPendingPermissionRequests: true, pendingRequestObservedAt: Date.now(),
            metadata: { path: '/repo', host: 'test', homeDir: '/home/test', name: 'Legacy pick' } });
        storage.getState().applyServerScopedSessionListRows(canonical, [row], { source: 'rowOnly', mode: 'append' });
        const hook = await renderHook(() => useBoardCards(membership, aliasHomes));
        expect(hook.getCurrent()[0]).toMatchObject({ key, ref, picked: true, availability: 'ready', title: 'Legacy pick',
            status: { bucket: 'needs_you' } });
        const changed = { ...row, metadata: { ...row.metadata!, name: 'Updated legacy pick' } };
        act(() => { storage.getState().applyServerScopedSessionListRows(canonical, [changed], { source: 'rowOnly', mode: 'append' }); });
        expect(hook.getCurrent()[0]).toMatchObject({ key, ref, title: 'Updated legacy pick', status: { bucket: 'needs_you' } });
        act(() => { storage.setState({ sessionListRowsByServerId: {}, concurrentSessionListCacheByServerId: {
            [canonical]: { serverName: null, listObservation: { phase: 'error', lastSuccessAt: null } },
        } }); });
        expect(hook.getCurrent()[0]).toMatchObject({ key, ref, availability: 'content_unavailable', unavailableReason: t('boards.card.readFailed') });
        act(() => { storage.getState().applyServerScopedSessionListRows(canonical, [changed], { source: 'rowOnly', mode: 'append' }); });
        expect(hook.getCurrent()[0]).toMatchObject({ key, ref, availability: 'ready', title: 'Updated legacy pick' });
        expect(membership.members[0]).toMatchObject({ key, ref });
    });
    it('reads a task-linked Session through its canonical Home when the source retains a profile alias', async () => {
        const { adoptHomeProfile, areServerProfileIdentifiersEquivalent } = await import('@/sync/domains/server/serverProfiles');
        const profile = await adoptHomeProfile({ descriptor: { v: 1, homeServerIdentityId: 'srv_board_task_home',
            canonicalServerUrl: 'https://board-task-alias.test', revision: 1,
            endpoints: [{ kind: 'https', url: 'https://board-task-alias.test' }],
        }, source: 'manual' });
        const ref = { kind: 'task', pluginId: 'com.acme.tasks', qualifiedId: { serverId: profile.id, id: 'task' } } as const;
        const key = buildWorkBoardItemKeyV1(ref);
        const now = Date.now();
        const row = createSessionListRenderableSessionFixture({ id: 'worker', active: true, activeAt: now,
            hasPendingPermissionRequests: true, pendingRequestObservedAt: now });
        storage.setState({ sessionListRowsByServerId: { [profile.id]: { [row.id]: row } } });
        const sessionRef = { kind: 'session' as const, qualifiedId: { serverId: profile.id, id: row.id } };
        const membership = { members: [{ key, ref, picked: true, sourced: false, available: true },
            { key: buildWorkBoardItemKeyV1(sessionRef), ref: sessionRef, picked: true, sourced: false, available: true }], complete: true,
            taskItems: new Map([[key, { title: 'External task', category: 'completed' as const,
                linkedSessions: [{ serverId: profile.id, sessionId: row.id }] }]]) };
        const taskHomes: BoardHomes = { activeServerId: 'srv_board_task_home', mountedServerIds: ['srv_board_task_home'],
            isHomeMounted: id => areServerProfileIdentifiersEquivalent(id, profile.id) };
        const hook = await renderHook(() => useBoardCards(membership, taskHomes));
        expect(hook.getCurrent().map(card => card.status.bucket)).toEqual(['needs_you', 'needs_you']);
        await act(async () => storage.setState({ sessionListRowsByServerId: {}, concurrentSessionListCacheByServerId: {
            [profile.id]: { serverName: null, listObservation: { phase: 'error', lastSuccessAt: null } },
        } }));
        expect(hook.getCurrent().map(card => card.status.bucket)).toEqual(['offline', 'offline']);
        await act(async () => storage.setState({ sessionListRowsByServerId: { [profile.id]: { [row.id]: row } } }));
        expect(hook.getCurrent().map(card => card.status.bucket)).toEqual(['needs_you', 'needs_you']);
    });
    it('settles an absent Session after its own Home answers and recovers when the row arrives', async ({ onTestFinished }) => {
        const serverId = homes.activeServerId!;
        // Keep the real bootstrap read pending while this case drives the
        // Home's observation states; an unanswered route is a settled error.
        const sessionRead = createDeferred<void>();
        onTestFinished(() => sessionRead.resolve());
        harness.home.answer(serverId, '/v2/sessions', {
            body: { sessions: [], nextCursor: null, hasNext: false }, respondAfter: sessionRead.promise,
        });
        harness.home.answer(serverId, '/v2/sessions/active', {
            body: { sessions: [], nextCursor: null, hasNext: false }, respondAfter: sessionRead.promise,
        });
        const ref = { kind: 'session' as const, qualifiedId: { serverId, id: 'late-or-uncached' } };
        const membership = { members: [{ key: buildWorkBoardItemKeyV1(ref), ref, picked: true, sourced: false, available: true }], complete: true };
        storage.setState({ sessionListRowsByServerId: {}, deletedSessionIds: {}, concurrentSessionListCacheByServerId: {} });
        let renders = 0;
        const hook = await renderHook((props: { enabled: boolean }) => {
            renders += 1;
            return useBoardCards(membership, homes, props);
        }, { initialProps: { enabled: true } });
        expect(hook.getCurrent()).toEqual([]);
        // A failed read is terminal for loading, and phone grouping must not call it Idle.
        await act(async () => storage.setState({ concurrentSessionListCacheByServerId: {
            [serverId]: { serverName: null, listObservation: { phase: 'error', lastSuccessAt: null } },
        } }));
        expect(hook.getCurrent()[0]).toMatchObject({ availability: 'content_unavailable',
            status: { bucket: 'offline' }, body: { kind: 'none' } });
        expect(hook.getCurrent()[0]?.unavailableReason).toBe(t('boards.card.readFailed'));
        const failedCard = hook.getCurrent()[0];
        await act(async () => storage.setState({ concurrentSessionListCacheByServerId: {
            [serverId]: { serverName: null, listObservation: { phase: 'loading', lastSuccessAt: null } },
        } }));
        expect(hook.getCurrent()[0]).toBe(failedCard);
        await act(async () => storage.setState({ concurrentSessionListCacheByServerId: {} }));
        expect(hook.getCurrent()[0]).toBe(failedCard);
        // A different Home's settlement says nothing about this qualified Session.
        await act(async () => storage.setState({ concurrentSessionListCacheByServerId: {
            other: { serverName: null, listObservation: { phase: 'ready', lastSuccessAt: 1 } },
        }, deletedSessionIds: { [ref.qualifiedId.id]: 'other' } }));
        expect(hook.getCurrent()[0]).toBe(failedCard);
        await act(async () => storage.setState({ concurrentSessionListCacheByServerId: {
            [serverId]: { serverName: null, listObservation: { phase: 'ready', lastSuccessAt: 1 } },
        } }));
        expect(hook.getCurrent()[0]).toMatchObject({ availability: 'content_unavailable',
            unavailableReason: expect.any(String), body: { kind: 'none' } });
        await act(async () => storage.setState({ concurrentSessionListCacheByServerId: {
            [serverId]: { serverName: null, listObservation: { phase: 'refreshing', lastSuccessAt: 1 } },
        } }));
        expect(hook.getCurrent()[0]?.availability).toBe('content_unavailable');
        const row = createSessionListRenderableSessionFixture({ id: ref.qualifiedId.id });
        await act(async () => storage.setState({ sessionListRowsByServerId: { [serverId]: { [row.id]: row } } }));
        expect(hook.getCurrent()[0]?.availability).toBe('ready');
        const readyCard = hook.getCurrent()[0];
        await act(async () => storage.setState({ sessionListRowsByServerId: {}, concurrentSessionListCacheByServerId: {
            [serverId]: { serverName: null, listObservation: { phase: 'refreshing', lastSuccessAt: 1 } },
        } }));
        expect(hook.getCurrent()[0]).toBe(readyCard);
        await act(async () => storage.setState({ sessionListRowsByServerId: {}, deletedSessionIds: { [row.id]: serverId },
            concurrentSessionListCacheByServerId: {} }));
        expect(hook.getCurrent()[0]?.availability).toBe('content_unavailable');
        await act(async () => storage.setState({ deletedSessionIds: {}, concurrentSessionListCacheByServerId: {
            [serverId]: { serverName: null, listObservation: { phase: 'loading', lastSuccessAt: null } },
        } }));
        (await import('@/sync/domains/scope/activeServerAccountScope')).retireActiveServerAccountScopeLifetime();
        await hook.rerender({ enabled: true });
        expect(hook.getCurrent()).toEqual([]);
        await hook.rerender({ enabled: false });
        const inactiveRenders = renders;
        await act(async () => storage.setState({ deletedSessionIds: {}, concurrentSessionListCacheByServerId: {
            [serverId]: { serverName: null, listObservation: { phase: 'loading', lastSuccessAt: null } },
        } }));
        expect(renders).toBe(inactiveRenders);
    });

    it('settles an absent Machine only after an applied inventory and preserves a cached Machine during refresh', async ({ onTestFinished }) => {
        const serverId = homes.activeServerId!;
        // Drive the source observations below without a bootstrap HTTP miss settling them concurrently.
        const inventoryRead = createDeferred<void>();
        onTestFinished(() => inventoryRead.resolve());
        harness.home.answer(serverId, '/v1/machines?includeRevoked=true', { body: [], respondAfter: inventoryRead.promise });
        const ref = { kind: 'machine' as const, qualifiedId: { serverId, id: 'removed-machine' } };
        const membership = { members: [{ key: buildWorkBoardItemKeyV1(ref), ref, picked: true, sourced: false, available: true }], complete: true };
        storage.setState({ machineListByServerId: { [serverId]: null }, machineListStatusByServerId: { [serverId]: 'loading' } });
        const hook = await renderHook(() => useBoardCards(membership, homes));
        expect(hook.getCurrent()).toEqual([]);
        await act(async () => storage.setState({ machineListByServerId: { [serverId]: [] }, machineListStatusByServerId: { [serverId]: 'idle' } }));
        expect(hook.getCurrent()[0]?.availability).toBe('content_unavailable');
        const machine = createMachineFixture({ id: ref.qualifiedId.id });
        await act(async () => storage.setState({ machineListByServerId: { [serverId]: [machine] }, machineListStatusByServerId: { [serverId]: 'loading' } }));
        expect(hook.getCurrent()[0]?.availability).toBe('ready');
    });

    it.each([false, true])('keeps an answered Machine section settled through refresh and recovery (with items: %s)', async withItems => {
        const serverId = homes.activeServerId!;
        const inventoryRead = createDeferred<void>();
        onTestFinished(() => inventoryRead.resolve());
        harness.home.answer(serverId, '/v1/machines?includeRevoked=true', { body: [], respondAfter: inventoryRead.promise });
        const machines = withItems ? [createMachineFixture({ id: 'retained-machine' })] : [];
        storage.setState({ machineListByServerId: { [serverId]: machines }, machineListStatusByServerId: { [serverId]: 'idle' } });
        const board = { ...createWorkBoardV1({ id: 'machines-refresh', name: 'Machines' }),
            source: { picked: [], sections: ['my_machines'] as const } };
        const hook = await renderHook(() => useBoardMembership(board, homes));
        expect(hook.getCurrent().settled).toBe(true);
        const admitted = hook.getCurrent().members;
        for (const status of ['loading', 'error'] as const) {
            await act(async () => storage.setState({ machineListStatusByServerId: { [serverId]: status } }));
            expect(hook.getCurrent().settled).toBe(true);
            expect(hook.getCurrent().members).toBe(admitted);
            expect(hook.getCurrent().complete).toBe(false);
        }
        await act(async () => storage.setState({ machineListByServerId: { [serverId]: [] },
            machineListStatusByServerId: { [serverId]: 'idle' } }));
        expect(hook.getCurrent()).toMatchObject({ members: [], complete: true, settled: true });
    });

    it.each(['selection', 'Account', 'Home', 'credentials'] as const)('retires retained membership on a real %s change while the reader is away', async change => {
        const serverId = homes.activeServerId!;
        const gate = createDeferred<void>();
        onTestFinished(() => gate.resolve());
        harness.home.answer(serverId, '/v1/machines?includeRevoked=true', { body: [], respondAfter: gate.promise });
        storage.setState({ machineListByServerId: { [serverId]: [createMachineFixture({ id: 'retained-machine' })] },
            machineListStatusByServerId: { [serverId]: 'idle' } });
        const board = { ...createWorkBoardV1({ id: 'retired-membership', name: 'Machines' }),
            source: { picked: [], sections: ['my_machines'] as const } };
        const first = await renderHook(() => useBoardMembership(board, homes));
        expect(first.getCurrent()).toMatchObject({ settled: true, members: [{ ref: { qualifiedId: { id: 'retained-machine' } } }] });
        await first.unmount();
        storage.setState({ machineListByServerId: {}, machineListStatusByServerId: { [serverId]: 'loading' } });
        if (change === 'Account') (await import('@/sync/domains/scope/activeServerAccountScope')).retireActiveServerAccountScopeLifetime();
        if (change === 'credentials') await harness.home.switchAccount(serverId, 'replacement-account');
        const nextBoard = change === 'selection' ? { ...board, source: { picked: [], sections: ['running'] as const } } : board;
        const nextHomes = change === 'Home' ? { ...homes, mountedServerIds: [], isHomeMounted: () => false } : homes;
        const next = await renderHook(() => useBoardMembership(nextBoard, nextHomes));
        expect(next.getCurrent()).toMatchObject({ settled: false, complete: false, members: [] });
    });

    it.each([false, true])('keeps an answered Running section settled through a failed refresh and recovery (with items: %s)', async withItems => {
        const rows = withItems ? [createWorkflowRunSummaryFixture({ id: 'retained-run', state: 'running' })] : [];
        runAnswer.mockReturnValue({ body: await boardRunStoragePage(rows) });
        const board = { ...createWorkBoardV1({ id: 'running-refresh', name: 'Running' }),
            source: { picked: [], sections: ['running'] as const } };
        const hook = await renderHook(() => ({ membership: useBoardMembership(board, homes), window: useWorkflowRunWindow('active') }));
        await waitForHomeGovernance(() => expect(hook.getCurrent().membership.complete).toBe(true));
        const admitted = hook.getCurrent().membership.members;
        const refresh = createDeferred<void>();
        onTestFinished(() => refresh.resolve());
        runAnswer.mockReturnValue({ dispatchThenFail: true, respondAfter: refresh.promise });
        await act(async () => { hook.getCurrent().window.retry(); });
        expect(hook.getCurrent().membership.settled).toBe(true);
        expect(hook.getCurrent().membership.members).toBe(admitted);
        await act(async () => refresh.resolve());
        await waitForHomeGovernance(() => expect(hook.getCurrent().window.status).toBe('failed'));
        expect(hook.getCurrent().membership.settled).toBe(true);
        expect(hook.getCurrent().membership.members).toBe(admitted);
        expect(hook.getCurrent().membership.complete).toBe(false);
        runAnswer.mockReturnValue({ body: await boardRunStoragePage([]) });
        await act(async () => { hook.getCurrent().window.retry(); });
        await waitForHomeGovernance(() => expect(hook.getCurrent().membership.complete).toBe(true));
        expect(hook.getCurrent().membership).toMatchObject({ members: [], settled: true });
    });

    it('keeps an absent picked Run loading through continuation before settling the exhausted reader', async () => {
        const pending = createDeferred<void>();
        onTestFinished(() => pending.resolve());
        const firstPage = await boardRunStoragePage([createWorkflowRunSummaryFixture({ id: 'another-run' })], 'more-runs');
        const lastPage = await boardRunStoragePage([]);
        runAnswer.mockImplementation(input => runPageCursor(input) === 'more-runs'
            ? { body: lastPage, respondAfter: pending.promise } : { body: firstPage });
        const ref = { kind: 'workflow_run' as const, qualifiedId: { serverId: homes.activeServerId!, id: 'missing-run' } };
        const membership = { members: [{ key: buildWorkBoardItemKeyV1(ref), ref, picked: true, sourced: false, available: true }], complete: true };
        const hook = await renderHook(() => useBoardCards(membership, homes));
        await waitForHomeGovernance(() => expect(harness.home.requestsFor(RUN_STORAGE_PATH).some(request =>
            request.input !== null && typeof request.input === 'object' && 'request' in request.input
            && (request.input.request as { cursor?: string }).cursor === 'more-runs')).toBe(true));
        expect(hook.getCurrent()).toEqual([]);
        await act(async () => { pending.resolve(); await pending.promise; });
        await waitForHomeGovernance(() => expect(hook.getCurrent()[0]?.availability).toBe('content_unavailable'));
    });

    it('updates live Machine cards when this Home request fails and recovers with the same presence row', async () => {
        const machine = createMachineFixture({ id: 'recovering-machine', active: true, activeAt: Date.now() });
        const serverId = homes.activeServerId!;
        storage.setState({ machineListByServerId: { [serverId]: [machine] } });
        observeMachinePresenceForTest({ serverId, accountId: 'account-a' }, [machine.id]);
        const ref = { kind: 'machine' as const, qualifiedId: { serverId, id: machine.id } };
        const membership = { members: [{ key: buildWorkBoardItemKeyV1(ref), ref, picked: true, sourced: false, available: true }], complete: true };
        const hook = await renderHook(() => useBoardCards(membership, homes));
        await waitForHomeGovernance(() => expect(hook.getCurrent()[0]?.body).toMatchObject({ online: true }));
        await act(async () => recordMachineRequestFailed({ serverId, accountId: 'account-a', machineId: machine.id, observedAtMs: Date.now() }));
        expect(hook.getCurrent()[0]?.body).toMatchObject({ online: false });
        await act(async () => recordMachineRequestSucceeded({ serverId, accountId: 'account-a', machineId: machine.id, observedAtMs: Date.now() + 1 }));
        expect(hook.getCurrent()[0]?.body).toMatchObject({ online: true });
    });
    it('does not render an idle Board for other surfaces clock wakes', async () => {
        vi.useFakeTimers();
        // These retained idle rows are already past every freshness boundary.
        vi.setSystemTime(1_000_000);
        const rows = Array.from({ length: 20 }, (_, index) => createSessionListRenderableSessionFixture({ id: `idle-session-${index}`, active: false }));
        const runs = Array.from({ length: 20 }, (_, index) => workflowRunRowFromSummary(
            createWorkflowRunSummaryFixture({ id: `finished-run-${index}`, state: 'succeeded' }), null));
        storage.setState({ sessionListRowsByServerId: { [homes.activeServerId!]: Object.fromEntries(rows.map(row => [row.id, row])) },
            workflowRunsById: Object.fromEntries(runs.map(row => [row.id, row])) });
        const refs = [
            ...rows.map(row => ({ kind: 'session' as const, qualifiedId: { serverId: homes.activeServerId!, id: row.id } })),
            ...runs.map(row => ({ kind: 'workflow_run' as const, qualifiedId: { serverId: homes.activeServerId!, id: row.id } })),
        ];
        const membership = { members: refs.map(ref => ({ key: buildWorkBoardItemKeyV1(ref), ref, picked: true, sourced: false, available: true })), complete: true };
        let renders = 0;
        const hook = await renderHook(() => { renders += 1; return useBoardCards(membership, homes); });
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });
        const cards = hook.getCurrent();
        expect(cards).toHaveLength(40);
        const before = renders;
        const otherSurface = {};
        try {
            for (let second = 0; second < 60; second += 1) {
                sessionListRuntimeClock.requestWake(otherSurface, Date.now() + 1000);
                await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
            }
        } finally {
            sessionListRuntimeClock.clearWake(otherSurface);
        }
        expect(hook.getCurrent()).toBe(cards);
        expect(renders - before).toBe(0);
        // Suppressing unrelated wakes must not suppress actual Board source changes.
        const row = rows[0]!;
        act(() => { storage.setState({ sessionListRowsByServerId: { [homes.activeServerId!]: {
            ...storage.getState().sessionListRowsByServerId[homes.activeServerId!],
            [row.id]: { ...row, active: true, activeAt: Date.now(), hasPendingPermissionRequests: true, pendingRequestObservedAt: Date.now() },
        } } }); });
        expect(hook.getCurrent()[0]?.status.bucket).toBe('needs_you');
    });

    it('keeps My machines own-only without hiding an unreadable owned Machine', async () => {
        const owned = createMachineFixture({ id: 'owned', availability: {
            kind: 'locked', reason: 'encryption_material_unavailable',
        } });
        const shared = createMachineFixture({ id: 'shared', isShared: true, access: {
            custodian: { accountId: 'alice', displayName: 'Alice' }, role: 'use',
            resourceMode: 'plain', accessState: 'ready',
        } });
        storage.setState({ machineListByServerId: { [homes.activeServerId!]: [owned, shared] } });
        const base = createWorkBoardV1({ id: 'my-machines', name: 'My machines' });
        const board = { ...base, source: { ...base.source, sections: ['my_machines' as const] } };
        const hook = await renderHook(() => useBoardMembership(board, homes));
        expect(hook.getCurrent().members.map(member => member.ref.qualifiedId.id)).toEqual(['owned']);
    });

    it('refreshes exclude-only Session filter membership at its canonical freshness deadline without store writes', async () => {
        const serverId = homes.activeServerId!;
        const features = createRootLayoutFeaturesResponse({ features: {
            sessions: { enabled: true, filteredListing: { enabled: true } },
        } });
        harness.home.answer(serverId, '/v1/features', { body: features });
        harness.home.answer(serverId, '/v1/features/authenticated', { body: features });
        const { getServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
        await getServerFeaturesSnapshot({ serverId, force: true });
        vi.useFakeTimers({ now: Date.now() });
        const session = createSessionFixture({ id: 'excluded-stale-session', active: true, activeAt: Date.now() });
        harness.home.answer(serverId, '/v2/sessions/query', { body: createSessionListSourceFixture({
            sessions: [{ ...createPlainSessionCurrentProjectionRecordFixture({ id: session.id,
                active: session.active, activeAt: session.activeAt }), viewer: createSessionOwnerViewerFixture(session) }],
            nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false,
        }) });
        const filter = normalizeSessionListFilterV1({ show: 'sessions', scope: 'all_accessible',
            homeServerIds: [serverId], excludedStatuses: ['stale', 'disconnected'] });
        const board = { ...createWorkBoardV1({ id: 'exclude-stale', name: 'Current Sessions' }), source: { picked: [], filter } };
        const hook = await renderHook(() => useBoardMembership(board, homes));
        await waitForHomeGovernance(async () => {
            await act(async () => {});
            expect(hook.getCurrent().settled).toBe(true);
        });
        // The query proves membership; an actual runtime arrival supplies the live observation
        // that can expire. A list-only HTTP row intentionally carries no live presence proof.
        act(() => { storage.getState().applyServerScopedSessionListRows(serverId, [
            createSessionListRenderableSessionFixture({ id: session.id, active: true, activeAt: Date.now(),
                thinking: true, thinkingAt: Date.now(), presence: 'online' }),
        ], { source: 'rowOnly', mode: 'append' }); });
        expect(hook.getCurrent().members.map(member => member.ref.qualifiedId.id)).toEqual([session.id]);
        const rows = storage.getState().sessionListRowsByServerId;
        const row = rows[serverId]![session.id]!;
        const freshnessAt = readSessionStatusNextRefreshAtMs(row, Date.now());
        expect(freshnessAt).not.toBeNull();
        await act(async () => { await vi.advanceTimersByTimeAsync(freshnessAt! - Date.now() + 1); });
        const { matchSessionListRowLocalFilter } = await import('@/sync/domains/session/listing/sessionListWorkFilter');
        expect(matchSessionListRowLocalFilter(row, serverId, filter, { nowMs: Date.now(), viewerAccountId: 'account-a' })).toBe('miss');
        expect(storage.getState().sessionListRowsByServerId).toBe(rows);
        expect(hook.getCurrent().members).toEqual([]);
    });

    it('refreshes Session deadlines while Machine presence follows authoritative pushes', async () => {
        // Exercise deadline deltas in the shared clock's current epoch, not backwards time travel.
        vi.useFakeTimers({ now: Date.now() });
        const row = createSessionListRenderableSessionFixture({ id: 'expiring-session', active: true,
            activeAt: Date.now(), thinking: true, thinkingAt: Date.now(),
            metadata: { path: '/repo', host: 'test', homeDir: '/home/test', machineId: 'expiring-machine' } });
        const waiting = createSessionListRenderableSessionFixture({ id: 'waiting-session', active: true,
            activeAt: Date.now(), hasPendingPermissionRequests: true, pendingRequestObservedAt: Date.now() });
        const machine = createMachineFixture({ id: 'expiring-machine', activeAt: Date.now() });
        storage.setState({ sessionListRowsByServerId: { [homes.activeServerId!]: { [row.id]: row, [waiting.id]: waiting } },
            machineListByServerId: { [homes.activeServerId!]: [machine] } });
        observeMachinePresenceForTest({ serverId: homes.activeServerId!, accountId: 'account-a' }, [machine.id]);
        const members = [
            { kind: 'session', qualifiedId: { serverId: homes.activeServerId!, id: row.id } } as const,
            { kind: 'machine', qualifiedId: { serverId: homes.activeServerId!, id: machine.id } } as const,
            { kind: 'session', qualifiedId: { serverId: homes.activeServerId!, id: waiting.id } } as const,
        ].map(ref => ({ key: buildWorkBoardItemKeyV1(ref), ref, picked: true, sourced: false, available: true }));
        const membership = { members, complete: true };
        const hook = await renderHook(() => useBoardCards(membership, homes));
        expect(hook.getCurrent()[0]?.status.bucket).toBe('working');
        expect(hook.getCurrent()[2]?.status.bucket).toBe('needs_you');
        expect(hook.getCurrent()[1]?.body).toMatchObject({ kind: 'machine', online: true, counts: { running: 1, needsYou: 0 } });
        const freshnessAt = readSessionStatusNextRefreshAtMs(row, Date.now());
        expect(freshnessAt).not.toBeNull();
        await act(async () => { await vi.advanceTimersByTimeAsync(1001); });
        expect(hook.getCurrent()[1]?.body).toMatchObject({ kind: 'machine', online: true });
        await act(async () => { await vi.advanceTimersByTimeAsync(freshnessAt! - Date.now() + 1); });
        expect(hook.getCurrent()[0]?.status.bucket).not.toBe('working');
        expect(hook.getCurrent()[2]?.status.bucket).toBe('needs_you');
        expect(hook.getCurrent()[1]?.body).toMatchObject({ kind: 'machine', counts: { running: 0, needsYou: 0 } });
        await act(async () => storage.getState().applyMachineActivityUpdates([{ id: machine.id, active: false, activeAt: Date.now() }], { sourceServerId: homes.activeServerId! }));
        expect(hook.getCurrent()[1]?.body).toMatchObject({ kind: 'machine', online: false });
    });

    it('removes Board deadline demand while inactive and refreshes on focus', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(100_000);
        const machine = createMachineFixture({ id: 'inactive-machine', activeAt: Date.now() });
        storage.setState({ machineListByServerId: { [homes.activeServerId!]: [machine] } });
        observeMachinePresenceForTest({ serverId: homes.activeServerId!, accountId: 'account-a' }, [machine.id]);
        const ref = { kind: 'machine', qualifiedId: { serverId: homes.activeServerId!, id: machine.id } } as const;
        const membership = { members: [{ key: buildWorkBoardItemKeyV1(ref), ref, picked: true, sourced: false, available: true }], complete: true };
        let renders = 0;
        const hook = await renderHook((props: { enabled: boolean }) => {
            renders += 1;
            return useBoardCards(membership, homes, props);
        }, { initialProps: { enabled: true } });
        const retained = hook.getCurrent();
        await hook.rerender({ enabled: false });
        const inactiveRenders = renders;
        await act(async () => { await vi.advanceTimersByTimeAsync(1001); });
        expect(renders).toBe(inactiveRenders);
        expect(hook.getCurrent()).toBe(retained);
        await act(async () => storage.getState().applyMachineActivityUpdates([{ id: machine.id, active: false, activeAt: Date.now() }], { sourceServerId: homes.activeServerId! }));
        // The real Account transport has its own timers; clock-owned withdrawal
        // is verified at sessionListRuntimeClock, not by counting the entire process.
        await hook.rerender({ enabled: true });
        expect(hook.getCurrent()[0]?.body).toMatchObject({ kind: 'machine', online: false });
    });

    it('does no definition read or machine-driven projection for a session-only Board', async () => {
        const row = createSessionListRenderableSessionFixture({ id: 'only-session' });
        storage.setState({ sessionListRowsByServerId: { [homes.activeServerId!]: { [row.id]: row } } });
        const ref = { kind: 'session', qualifiedId: { serverId: homes.activeServerId!, id: row.id } } as const;
        const membership = { members: [{ key: buildWorkBoardItemKeyV1(ref), ref, picked: true, sourced: false, available: true }], complete: true };
        let renders = 0;
        const hook = await renderHook(() => { renders += 1; return useBoardCards(membership, homes); });
        const cards = hook.getCurrent();
        const before = renders;
        act(() => { storage.setState({ machineListByServerId: { ...storage.getState().machineListByServerId, unrelated: [] } }); });
        expect(renders).toBe(before);
        expect(hook.getCurrent()).toBe(cards);
        expect(harness.home.requests.filter(request => request.path === ARTIFACT_LIST_PATH)).toHaveLength(0);
    });

    it('constructs and commits only changed cards on a populated 1,000-Session Board with a picked Machine', async () => {
        let nameReads = 0;
        const nameReadIds = new Set<number>();
        const statusReadIds = new Set<number>();
        const rows = Object.fromEntries(Array.from({ length: 1000 }, (_, index) => {
            const row = createSessionListRenderableSessionFixture({ id: `session-${index}`, active: true, activeAt: Date.now(),
                thinking: true, thinkingAt: Date.now(), metadata: {
                path: '/repo', host: 'test', homeDir: '/home/test', machineId: 'counted-machine',
                get name() { nameReads += 1; nameReadIds.add(index); return `Session ${index}`; },
            } });
            const activeAt = row.activeAt;
            Object.defineProperty(row, 'activeAt', { enumerable: true, get: () => { statusReadIds.add(index); return activeAt; } });
            return [row.id, row];
        }));
        const runs = Object.fromEntries(Array.from({ length: 20 }, (_, index) => {
            const row = workflowRunRowFromSummary(createWorkflowRunSummaryFixture({ id: `run-${index}`, state: 'running' }), null);
            return [row.id, row];
        }));
        const machine = createMachineFixture({ id: 'counted-machine', activeAt: Date.now() });
        storage.setState({ sessionListRowsByServerId: { [homes.activeServerId!]: rows }, workflowRunsById: runs,
            machineListByServerId: { [homes.activeServerId!]: [machine] } });
        observeMachinePresenceForTest({ serverId: homes.activeServerId!, accountId: 'account-a' }, [machine.id]);
        const members = [...Object.keys(rows).map(id => ({ kind: 'session', qualifiedId: { serverId: homes.activeServerId!, id } } as const)),
            ...Object.keys(runs).map(id => ({ kind: 'workflow_run', qualifiedId: { serverId: homes.activeServerId!, id } } as const)),
            { kind: 'machine', qualifiedId: { serverId: homes.activeServerId!, id: machine.id } } as const]
            .map(ref => ({ key: buildWorkBoardItemKeyV1(ref), ref, picked: true, sourced: false, available: true }));
        const membership = { members, complete: true };
        const counters = new Map(members.map(member => [member.key, createRenderCommitCounter()]));
        const MeasuredCard = React.memo(function MeasuredCard({ card }: { card: ReturnType<typeof useBoardCards>[number] }) {
            useRenderCommitCounter(counters.get(card.key)!);
            return <BoardCardBodyContent card={card} />;
        });
        let cards: ReturnType<typeof useBoardCards> = [];
        function Host() {
            cards = useBoardCards(membership, homes);
            return cards.map(card => <MeasuredCard key={card.key} card={card} />);
        }
        const mountStarted = performance.now();
        await renderScreen(<Host />);
        const mountMs = performance.now() - mountStarted;
        const before = cards;
        expect(before).toHaveLength(1021);
        expect(before.at(-1)?.body).toMatchObject({ kind: 'machine', counts: { running: 1000, needsYou: 0 } });
        for (const counter of counters.values()) counter.reset();
        nameReads = 0;
        const updated = { ...rows['session-7']!, hasPendingPermissionRequests: true, pendingRequestObservedAt: Date.now() };
        nameReadIds.clear();
        statusReadIds.clear();
        const updateStarted = performance.now();
        act(() => { storage.getState().applyServerScopedSessionListRows(homes.activeServerId!, [updated], { source: 'rowOnly', mode: 'append' }); });
        const updateMs = performance.now() - updateStarted;
        console.info('Board 1,000-Session owner mount/update measurement', { mountMs, updateMs, nameReads,
            statusRowsRead: statusReadIds.size, mountedRowsRendered: [...counters.values()].filter(counter => counter.read().renders > 0).length });
        expect(cards.filter((card, index) => card !== before[index]).map(card => card.ref.qualifiedId.id)).toEqual(['session-7', machine.id]);
        expect(cards.at(-1)?.body).toMatchObject({ kind: 'machine', counts: { running: 999, needsYou: 1 } });
        // The name getter observes real detail projection work, rather than only reconciled output identities.
        expect(nameReads).toBeGreaterThan(0);
        expect([...nameReadIds]).toEqual([7]);
        expect(statusReadIds.size).toBe(1);
        expect(statusReadIds.has(7)).toBe(true);
        expect([...counters].filter(([, counter]) => counter.read().renders > 0)
            .map(([key, counter]) => [key, counter.read()])).toEqual([
                [members[7]!.key, { renders: 1, commits: 1 }], [members.at(-1)!.key, { renders: 1, commits: 1 }],
            ]);
        for (const counter of counters.values()) counter.reset();
        nameReads = 0;
        statusReadIds.clear();
        const unrelatedStarted = performance.now();
        act(() => { storage.getState().applyServerScopedSessionListRows(homes.activeServerId!, [
            createSessionListRenderableSessionFixture({ id: 'outside-board' }),
        ], { source: 'rowOnly', mode: 'append' }); });
        const unrelatedMs = performance.now() - unrelatedStarted;
        expect([...counters.values()].every(counter => counter.read().renders === 0 && counter.read().commits === 0)).toBe(true);
        expect(nameReads).toBe(0);
        expect(statusReadIds.size).toBe(0);
        const beforeRun = cards;
        const arrivedRun = workflowRunRowFromSummary(createWorkflowRunSummaryFixture({ id: 'run-3', state: 'succeeded', revision: 2 }), null);
        const runStarted = performance.now();
        act(() => { storage.getState().upsertWorkflowRuns([arrivedRun]); });
        const runMs = performance.now() - runStarted;
        expect(cards.filter((card, index) => card !== beforeRun[index]).map(card => card.ref.qualifiedId.id)).toEqual(['run-3']);
        expect([...counters].filter(([, counter]) => counter.read().renders > 0).map(([key, counter]) => [key, counter.read()]))
            .toEqual([[members[1003]!.key, { renders: 1, commits: 1 }]]);
        expect(nameReads).toBe(0);
        expect(statusReadIds.size).toBe(0);
        for (const counter of counters.values()) counter.reset();
        const beforeBatch = cards;
        act(() => {
            for (const id of ['session-8', 'session-9']) storage.getState().applyServerScopedSessionListRows(homes.activeServerId!, [
                { ...rows[id]!, hasPendingPermissionRequests: true, pendingRequestObservedAt: Date.now() },
            ], { source: 'rowOnly', mode: 'append' });
        });
        expect(cards.filter((card, index) => card !== beforeBatch[index]).map(card => card.ref.qualifiedId.id))
            .toEqual(['session-8', 'session-9', machine.id]);
        expect(cards.at(-1)?.body).toMatchObject({ kind: 'machine', counts: { running: 997, needsYou: 3 } });
        console.info('Board 1,000-Session owner measurement', { mountMs, updateMs, unrelatedMs, runMs });
    });

    it('retains same-Account cards without detail work while inactive and resumes current facts', async () => {
        let titleReads = 0;
        const row = createSessionListRenderableSessionFixture({ id: 'focus-session', active: true, activeAt: Date.now(), metadata: {
            path: '/repo', host: 'test', homeDir: '/home/test',
            get name() { titleReads += 1; return 'Focus session'; },
        } });
        storage.setState({ sessionListRowsByServerId: { [homes.activeServerId!]: { [row.id]: row } } });
        const ref = { kind: 'session', qualifiedId: { serverId: homes.activeServerId!, id: row.id } } as const;
        const membership = { members: [{ key: buildWorkBoardItemKeyV1(ref), ref, picked: true, sourced: false, available: true }], complete: true };
        let renders = 0;
        const hook = await renderHook((props: { enabled: boolean }) => {
            renders += 1;
            return useBoardCards(membership, homes, props);
        }, { initialProps: { enabled: true } });
        const retained = hook.getCurrent();
        await hook.rerender({ enabled: false });
        const inactiveRenders = renders;
        titleReads = 0;
        const updated = { ...row, hasPendingPermissionRequests: true, pendingRequestObservedAt: Date.now() };
        act(() => { storage.setState({ sessionListRowsByServerId: { [homes.activeServerId!]: { [row.id]: updated } } }); });
        expect(renders).toBe(inactiveRenders);
        expect(hook.getCurrent()).toBe(retained);
        expect(titleReads).toBe(0);
        await hook.rerender({ enabled: true });
        expect(hook.getCurrent()[0]?.status.bucket).toBe('needs_you');
        expect(titleReads).toBeGreaterThan(0);
        await hook.rerender({ enabled: false });
        act(() => { storage.setState({ profileScope: { serverId: homes.activeServerId!, accountId: 'account-b' } }); });
        expect(hook.getCurrent()).toEqual([]);
    });

    it.each([[6, 1], [66, 1], [66, 2]])('opens only %s-catalog/%s-picked Workflow content', async (count, pickedCount) => {
        const artifacts = Array.from({ length: count }, (_, index) => boardDefinitionArtifact(
            `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`, `Workflow ${index + 1}`));
        harness.answerDefinitions(homes.activeServerId!, { body: artifacts });
        const picked = artifacts.slice(-pickedCount);
        runAnswer.mockReturnValue({ body: { summaries: picked.map(({ id: sourceArtifactId }) => ({
            sourceArtifactId, lastRun: null, recent: [], needsYouCount: 0, needsYouRunId: null,
        })), remainingSourceArtifactIds: [] } });
        const members = picked.map(artifact => {
            const ref = { kind: 'workflow', qualifiedId: { serverId: homes.activeServerId!, id: artifact.id } } as const;
            return { key: buildWorkBoardItemKeyV1(ref), ref, picked: true, sourced: false, available: true };
        });
        const requestStart = harness.home.requests.length;
        const hook = await renderHook((props: { enabled: boolean }) => useBoardCards({ members, complete: true }, homes, props),
            { initialProps: { enabled: false } });
        // Seeded commits also wake Sync's independent header reconciliation. Count
        // Workflow inventory and opened content, leaving those header-only feed reads separate.
        const artifactReads = () => harness.home.requests.slice(requestStart).filter(request => request.method === 'GET'
            && (request.path === ARTIFACT_LIST_PATH || request.path.startsWith('/v1/artifacts/'))
            || request.method === 'POST' && request.path === '/v1/artifacts/read'
                && (request.input as { projection?: string }).projection !== 'headers');
        expect(artifactReads().map(({ method, path }) => ({ method, path }))).toEqual([]);
        await hook.rerender({ enabled: true });
        await waitForHomeGovernance(() => expect(hook.getCurrent().map(card => card.title)).toEqual(picked.map(artifact => `Workflow ${Number(artifact.id.slice(-12))}`)));
        const reads = artifactReads();
        const bodyIds = reads.flatMap(request => request.path === '/v1/artifacts/read'
            ? (request.input as { artifactIds: string[] }).artifactIds : request.method === 'GET' && request.path !== ARTIFACT_LIST_PATH
                ? [request.path.slice('/v1/artifacts/'.length)] : []);
        expect({ catalogSize: count, inventoryPages: reads.filter(request => request.path === ARTIFACT_LIST_PATH).length,
            requestedBodies: bodyIds.length, requests: reads.length }).toEqual({ catalogSize: count,
            inventoryPages: 0, requestedBodies: picked.length, requests: picked.length });
        expect(bodyIds.slice().sort()).toEqual(picked.map(artifact => artifact.id).sort());
    });

    it.each(['11111111-1111-4111-8111-111111111111', 'retained-saved-definition'])('shares exact Workflow demand and refreshes only picked %s after its push', async (definitionId) => {
        const unrelatedId = '22222222-2222-4222-8222-222222222222';
        let definition = boardDefinitionArtifact(definitionId, 'Before');
        const pending = createDeferred<void>();
        onTestFinished(() => pending.resolve());
        harness.home.answer(homes.activeServerId!, `GET /v1/artifacts/${definitionId}`, { select: () => ({
            body: definition, respondAfter: pending.promise,
        }) });
        runAnswer.mockReturnValue({ body: { summaries: [{ sourceArtifactId: definitionId,
            lastRun: null, recent: [], needsYouCount: 0, needsYouRunId: null }], remainingSourceArtifactIds: [] } });
        const ref = { kind: 'workflow', qualifiedId: { serverId: homes.activeServerId!, id: definitionId } } as const;
        const membership = { members: [{ key: buildWorkBoardItemKeyV1(ref), ref, picked: true, sourced: false, available: true }], complete: true };
        const requestStart = harness.home.requests.length;
        const first = await renderHook(() => useBoardCards(membership, homes));
        const second = await renderHook(() => useBoardCards(membership, homes));
        const exactReads = () => harness.home.requests.slice(requestStart).filter(request => request.path === `/v1/artifacts/${definitionId}`);
        expect(exactReads()).toHaveLength(1);
        await act(async () => { pending.resolve(); await pending.promise; });
        await waitForHomeGovernance(() => expect(second.getCurrent()[0]?.title).toBe('Before'));
        // The real Home bootstrap may queue its recovery wake behind that held
        // flight. Explicit pushes below are measured after this initial answer.
        const initialReadCount = exactReads().length;
        const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
        await act(async () => { publishHomeAccountChange(homes.activeServerId!, [unrelatedId], { changeKinds: ['artifact'], feedPageConsumed: true }); });
        expect(exactReads()).toHaveLength(initialReadCount);
        const changed = boardDefinitionArtifact(definitionId, 'After');
        definition = { ...changed, headerVersion: 2,
            header: encodePlainArtifactStoredContent({ kind: 'workflow-definition.v1', definitionId,
                revision: { headerVersion: 2, bodyVersion: 1 }, metadata: { title: 'After' } }) };
        await act(async () => { publishHomeAccountChange(homes.activeServerId!, [definitionId], { changeKinds: ['artifact'], feedPageConsumed: true }); });
        await waitForHomeGovernance(() => expect(first.getCurrent()[0]?.title).toBe('After'));
        expect(second.getCurrent()[0]?.title).toBe('After');
        expect(exactReads()).toHaveLength(initialReadCount + 1);
        expect(harness.home.requestsFor(ARTIFACT_LIST_PATH)).toHaveLength(0);
    });

    it('settles a failed Workflow status as unavailable beside an answered neighbor and recovers on retry', async () => {
        const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
        harness.answerDefinitions(homes.activeServerId!, { body: ids.map((id, index) => boardDefinitionArtifact(id, `Summary ${index}`)) });
        const summary = (sourceArtifactId: string, needsYouCount: number) => ({
            sourceArtifactId, lastRun: null, recent: [], needsYouCount, needsYouRunId: needsYouCount > 0 ? 'held-run' : null,
        });
        runAnswer.mockReturnValue({ body: { summaries: [summary(ids[0]!, 1)], remainingSourceArtifactIds: [] } });
        const members = ids.map(id => {
            const ref = { kind: 'workflow', qualifiedId: { serverId: homes.activeServerId!, id } } as const;
            return { key: buildWorkBoardItemKeyV1(ref), ref, picked: true, sourced: false, available: true };
        });
        const hook = await renderHook(() => ({ cards: useBoardCards({ members, complete: true }, homes),
            summaries: useWorkflowLibrarySummaries(ids), library: useWorkflowDefinitionLibrary({ definitionIds: ids }) }));
        await waitForHomeGovernance(() => expect(hook.getCurrent().library.status).toBe('loaded'));
        await waitForHomeGovernance(() => expect(hook.getCurrent().summaries.failedIds.has(ids[1]!)).toBe(true));
        expect(hook.getCurrent().cards).toMatchObject([
            { title: 'Summary 0', availability: 'ready', status: { bucket: 'needs_you' } },
            { title: 'Summary 1', availability: 'content_unavailable', status: { bucket: 'offline' } },
        ]);
        runAnswer.mockReturnValue({ body: { summaries: ids.map(id => summary(id, 1)), remainingSourceArtifactIds: [] } });
        await act(async () => hook.getCurrent().summaries.retry());
        await waitForHomeGovernance(() => expect(hook.getCurrent().cards.every(card => card.status.bucket === 'needs_you')
            && hook.getCurrent().cards.length === 2).toBe(true));
    });

    it('preserves unavailable definition reasons on Board cards beside readable neighbors', async () => {
        const definitionIds = ['header', 'body', 'readable', 'missing'];
        // Only stored HTTP bytes are malformed; the real Artifact codec and
        // Workflow list owner classify each row beside its readable neighbor.
        harness.answerDefinitions(homes.activeServerId!, { body: [
            { ...boardDefinitionArtifact('header', 'Unavailable'), header: encodePlainArtifactStoredContent({
                kind: 'workflow-definition.v1', definitionId: 'header',
                revision: { headerVersion: 1, bodyVersion: 1 }, metadata: { title: 7 },
            }) },
            { ...boardDefinitionArtifact('body', 'Repair me'), body: encodePlainArtifactStoredContent({ body: 'not-json' }) },
            boardDefinitionArtifact('readable', 'Readable'),
        ] });
        runAnswer.mockReturnValue({ body: { summaries: definitionIds.map(sourceArtifactId => ({
            sourceArtifactId, lastRun: null, recent: [], needsYouCount: 0, needsYouRunId: null,
        })), remainingSourceArtifactIds: [] } });
        const members = definitionIds.map(definitionId => {
            const ref = { kind: 'workflow', qualifiedId: { serverId: homes.activeServerId!, id: definitionId } } as const;
            return { key: buildWorkBoardItemKeyV1(ref), ref, picked: true, sourced: false, available: true };
        });
        const hook = await renderHook(() => ({
            cards: useBoardCards({ members, complete: true }, homes),
            library: useWorkflowDefinitionLibrary(),
        }));
        await waitForHomeGovernance(() => expect(hook.getCurrent().library.status).toBe('loaded'));
        expect(hook.getCurrent().cards).toMatchObject([
            { availability: 'content_unavailable', unavailableReason: formatWorkflowDefinitionContentUnavailableReason('invalid_header'), body: { kind: 'none' } },
            { availability: 'content_unavailable', title: 'Repair me', unavailableReason: formatWorkflowDefinitionContentUnavailableReason('invalid_body'), body: { kind: 'none' } },
            { availability: 'ready', title: 'Readable', body: { kind: 'workflow' } },
            { availability: 'content_unavailable', unavailableReason: expect.any(String), body: { kind: 'none' } },
        ]);
        expect(hook.getCurrent().cards.slice(0, 2).every(card => card.status.tone === 'neutral')).toBe(true);
    });
    it('consumes the definition list scheduler occurrence without deriving a date from its schedule', async () => {
        const definitions = [
            { definitionId: '11111111-1111-4111-8111-111111111111', nextRunAt: 123_456 },
            { definitionId: '22222222-2222-4222-8222-222222222222', nextRunAt: null },
        ];
        harness.answerDefinitions(homes.activeServerId!, { body: definitions.map((definition, index) =>
            boardDefinitionArtifact(definition.definitionId, `Schedule ${index}`)) });
        harness.home.answer(homes.activeServerId!, `POST ${AUTOMATION_QUERY_PATH}`, { body: {
            automations: definitions.map(({ definitionId, nextRunAt }, index) => ({
                id: `automation-${index}`, name: 'Scheduled workflow', description: null, enabled: true,
                workflowDefinitionId: definitionId, scopeSessionId: null, targetType: null, existingSessionId: null,
                templateVersion: 1, lastRunAt: null, createdAt: 1, updatedAt: 1, assignments: [],
                triggers: [{ id: `trigger-${index}`, revision: 1, enabled: true, createdAt: 1, updatedAt: 1,
                    kind: 'schedule', schedule: { kind: 'interval', everyMs: 60_000, scheduleExpr: null, timezone: null }, nextRunAt }],
            })), nextCursor: null,
        } });
        runAnswer.mockReturnValue({ body: { summaries: definitions.map(({ definitionId: sourceArtifactId }) => ({
            sourceArtifactId, lastRun: null, recent: [], needsYouCount: 0, needsYouRunId: null,
        })), remainingSourceArtifactIds: [] } });
        const members = definitions.map(definition => {
            const ref = { kind: 'workflow', qualifiedId: { serverId: homes.activeServerId!, id: definition.definitionId } } as const;
            return { key: buildWorkBoardItemKeyV1(ref), ref, picked: true, sourced: false, available: true };
        });
        const hook = await renderHook(() => ({
            cards: useBoardCards({ members, complete: true }, homes),
            library: useWorkflowDefinitionLibrary(),
        }));
        await waitForHomeGovernance(() => expect(hook.getCurrent().library.status).toBe('loaded'));
        expect(hook.getCurrent().library.definitions.map(({ definitionId, nextRunAt }) => ({ definitionId, nextRunAt }))
            .sort((left, right) => left.definitionId.localeCompare(right.definitionId))).toEqual(definitions);
        expect(hook.getCurrent().cards.map(card => card.body)).toMatchObject([
            { kind: 'workflow', nextRun: { kind: 'scheduled', at: 123_456 } },
            { kind: 'workflow', nextRun: { kind: 'unscheduled' } },
        ]);
    });
    it('projects both widget copies in Board order independently of work/status membership and mode', async () => {
        const surface = { serverId: homes.activeServerId!, accountId: 'account-a', owner: { kind: 'workBoard', boardId: 'widgets' } } as const;
        const instance = { v: 1, id: 'first', definition: { kind: 'builtin', id: 'changes' }, bindings: {} } as const;
        let board = createWorkBoardV1({ id: 'widgets', name: 'Mixed' });
        const add = applyWorkBoardIntentV1({ v: 1, boards: [board] }, { kind: 'widget_add', boardId: board.id, ref: { surface, instanceId: instance.id }, instance, size: 'full' });
        if (add.status !== 'applied') throw new Error('add failed'); board = add.boards.boards[0]!;
        const next = applyWorkBoardIntentV1({ v: 1, boards: [board] }, { kind: 'widget_add', boardId: board.id, ref: { surface, instanceId: 'second' }, instance: { ...instance, id: 'second', bindings: { session: { kind: 'value', value: 'other' } } }, toIndex: 0 });
        if (next.status !== 'applied') throw new Error('add failed'); board = next.boards.boards[0]!;
        const hook = await renderHook(useBoardWidgets, { initialProps: board });
        expect(hook.getCurrent().map(item => [item.instance.id, item.size])).toEqual([['second', 'medium'], ['first', 'full']]);
        expect((await hook.rerender({ ...board, mode: 'by_status' })).map(item => item.instance.id)).toEqual(['second', 'first']);
    });
    it('keeps Running positions through paging and consumes the existing window continuation before certifying completeness', async () => {
        const first = createWorkflowRunSummaryFixture({ id: 'first', state: 'running' });
        const second = createWorkflowRunSummaryFixture({ id: 'second', state: 'running' });
        const secondKey = buildWorkBoardItemKeyV1({ kind: 'workflow_run', qualifiedId: { serverId: homes.activeServerId!, id: second.id } });
        const board = { ...createWorkBoardV1({ id: 'running', name: 'Running' }),
            source: { picked: [], sections: ['running'] as const }, positionsByItemRef: { [secondKey]: { x: 12, y: 34 } } };
        const pending = createDeferred<void>();
        onTestFinished(() => pending.resolve());
        const firstPage = await boardRunStoragePage([first], 'page-two');
        const secondPage = await boardRunStoragePage([second]);
        runAnswer.mockImplementation(input => runPageCursor(input) === 'page-two'
            ? { body: secondPage, respondAfter: pending.promise } : { body: firstPage });
        const hook = await renderHook(() => useBoardMembership(board, homes));
        await waitForHomeGovernance(() => expect(harness.home.requestsFor(RUN_STORAGE_PATH).some(request =>
            request.input !== null && typeof request.input === 'object' && 'request' in request.input
            && (request.input.request as { cursor?: string }).cursor === 'page-two')).toBe(true));
        const partial = hook.getCurrent();
        expect(partial.members).toEqual([]);
        // A save while the source is paging cannot discard the already saved page-two layout.
        const moved = applyWorkBoardIntentV1({ v: 1, boards: [board] }, { kind: 'set_positions', boardId: board.id,
            positionsByItemRef: { [secondKey]: { x: 12, y: 34 } },
            membership: resolveBoardPruneMembership(board, partial, homes.isHomeMounted) });
        expect(moved.status).toBe('applied');
        if (moved.status !== 'applied') throw new Error('position edit refused');
        expect(moved.boards.boards[0]!.positionsByItemRef[secondKey]).toEqual({ x: 12, y: 34 });
        expect(partial.complete).toBe(false);
        await waitForHomeGovernance(() => expect(harness.home.requestsFor(RUN_STORAGE_PATH).some(request =>
            request.input !== null && typeof request.input === 'object' && 'request' in request.input
            && (request.input.request as { cursor?: string }).cursor === 'page-two')).toBe(true));
        await act(async () => { pending.resolve(); await pending.promise; });
        await waitForHomeGovernance(() => expect(hook.getCurrent().members.map((member) => member.ref.qualifiedId.id)).toEqual(['first', 'second']));
        expect(hook.getCurrent().complete).toBe(true);
    });

    it('never prunes Running positions after a failed first read or failed refresh', async () => {
        const row = createWorkflowRunSummaryFixture({ id: 'saved', state: 'running' });
        const savedKey = buildWorkBoardItemKeyV1({ kind: 'workflow_run', qualifiedId: { serverId: homes.activeServerId!, id: row.id } });
        const board = { ...createWorkBoardV1({ id: 'running', name: 'Running' }),
            source: { picked: [], sections: ['running'] as const }, positionsByItemRef: { [savedKey]: { x: 12, y: 34 } } };
        runAnswer.mockReturnValueOnce({ dispatchThenFail: true });
        const hook = await renderHook(() => ({ membership: useBoardMembership(board, homes), window: useWorkflowRunWindow('active') }));
        await waitForHomeGovernance(() => expect(hook.getCurrent().window.status).toBe('failed'));
        const savedAfterEdit = () => {
            const result = applyWorkBoardIntentV1({ v: 1, boards: [board] }, { kind: 'set_positions', boardId: board.id,
                positionsByItemRef: {}, membership: resolveBoardPruneMembership(board, hook.getCurrent().membership, homes.isHomeMounted) });
            if (result.status !== 'applied') throw new Error('position edit refused');
            return result.boards.boards[0]!;
        };
        expect(savedAfterEdit().positionsByItemRef[savedKey]).toEqual({ x: 12, y: 34 });
        expect(hook.getCurrent().membership.complete).toBe(false);
        runAnswer.mockReturnValueOnce({ body: await boardRunStoragePage([row]) });
        await act(async () => { hook.getCurrent().window.retry(); });
        await waitForHomeGovernance(() => expect(hook.getCurrent().membership.complete).toBe(true));
        runAnswer.mockReturnValueOnce({ dispatchThenFail: true });
        await act(async () => { hook.getCurrent().window.retry(); });
        await waitForHomeGovernance(() => expect(hook.getCurrent().window.status).toBe('failed'));
        expect(hook.getCurrent().membership.complete).toBe(false);
        expect(savedAfterEdit().positionsByItemRef[savedKey]).toEqual({ x: 12, y: 34 });
    });

    it('treats an answered empty Run window as complete', async () => {
        runAnswer.mockReturnValue({ body: await boardRunStoragePage([]) });
        const board = runsBoard(['you']);
        const hook = await renderHook(() => useBoardMembership(board, homes));
        expect(hook.getCurrent().members).toEqual([]);
        await waitForHomeGovernance(() => expect(hook.getCurrent().complete).toBe(true));
    });

    it('uses the shared starter and attention rule, deduplicates picks, and retains membership identity on unrelated writes', async () => {
        const waiting = createWorkflowRunSummaryFixture({ id: 'waiting', startedBy: 'trigger',
            invocationAttentionRequired: true, attentionRequired: true });
        const user = createWorkflowRunSummaryFixture({ id: 'user', startedBy: 'user' });
        const agent = createWorkflowRunSummaryFixture({ id: 'agent', startedBy: 'agent' });
        runAnswer.mockReturnValue({ body: await boardRunStoragePage([waiting, user, agent]) });
        const initial = runsBoard(['you']);
        const board = { ...initial, source: { ...initial.source, picked: [
            { kind: 'workflow_run', qualifiedId: { serverId: homes.activeServerId!, id: 'waiting' } } as const,
        ] } };
        const hook = await renderHook(() => useBoardMembership(board, homes));
        await waitForHomeGovernance(() => expect(hook.getCurrent().members.map((member) => member.ref.qualifiedId.id)).toEqual(['waiting', 'user']));
        expect(hook.getCurrent().members[0]?.picked).toBe(true);
        expect(hook.getCurrent().complete).toBe(true);
        const membership = hook.getCurrent();
        act(() => { storage.setState({ workflowRunsById: { ...storage.getState().workflowRunsById,
            [workflowRunStoreKey('unrelated')]: workflowRunRowFromSummary(createWorkflowRunSummaryFixture({ id: 'unrelated' })),
        } }); });
        expect(hook.getCurrent()).toBe(membership);
    });

    it('finds later-page filter matches and completes only after continuation failure is retried', async () => {
        const first = createWorkflowRunSummaryFixture({ id: 'first', startedBy: 'agent' });
        const later = createWorkflowRunSummaryFixture({ id: 'later', startedBy: 'user' });
        const firstPage = await boardRunStoragePage([first], 'page-two');
        runAnswer.mockImplementation(input => runPageCursor(input) === 'page-two'
            ? { dispatchThenFail: true } : { body: firstPage });
        const board = runsBoard(['you']);
        const hook = await renderHook(() => ({ membership: useBoardMembership(board, homes), window: useWorkflowRunWindow('all') }));
        await waitForHomeGovernance(() => expect(hook.getCurrent().window.loadMoreFailed).toBe(true));
        expect(hook.getCurrent().membership.members).toEqual([]);
        expect(hook.getCurrent().membership.complete).toBe(false);
        const retryPending = createDeferred<void>();
        const pending = createDeferred<void>();
        onTestFinished(() => { retryPending.resolve(); pending.resolve(); });
        const laterPage = await boardRunStoragePage([later]);
        runAnswer.mockImplementation(input => runPageCursor(input) === 'page-two'
            ? { body: laterPage, respondAfter: pending.promise } : { body: firstPage, respondAfter: retryPending.promise });
        await act(async () => { hook.getCurrent().window.retry(); });
        await waitForHomeGovernance(() => expect(hook.getCurrent().window.loadMoreFailed).toBe(false));
        expect(hook.getCurrent().membership.complete).toBe(false);
        await act(async () => { retryPending.resolve(); await retryPending.promise; });
        await waitForHomeGovernance(() => expect(hook.getCurrent().window.loadingMore).toBe(true));
        expect(hook.getCurrent().membership.complete).toBe(false);
        await act(async () => { pending.resolve(); await pending.promise; });
        await waitForHomeGovernance(() => expect(hook.getCurrent().membership.members.map(member => member.ref.qualifiedId.id)).toEqual(['later']));
        expect(hook.getCurrent().membership.complete).toBe(true);
    });

    it('preserves placed Runs from a mounted Home not served by the active Home window', async () => {
        const { upsertServerProfileOnly } = await import('@/sync/domains/server/serverRuntime');
        const other = await upsertServerProfileOnly({ serverUrl: 'http://board-runs-second.test', name: 'Second Board Home' });
        const mountedServerIds = [homes.activeServerId!, other.id];
        homes = { ...homes, mountedServerIds, isHomeMounted: (id) => mountedServerIds.includes(id) };
        const inactiveKey = buildWorkBoardItemKeyV1({
            kind: 'workflow_run', qualifiedId: { serverId: other.id, id: 'inactive-run' },
        });
        const board = { ...runsBoard(['you']), positionsByItemRef: { [inactiveKey]: { x: 12, y: 34 } } };
        runAnswer.mockReturnValue({ body: await boardRunStoragePage([createWorkflowRunSummaryFixture({ id: 'active-run', startedBy: 'user' })]) });
        const hook = await renderHook(() => ({ membership: useBoardMembership(board, homes), window: useWorkflowRunWindow('all') }));
        await waitForHomeGovernance(() => expect(hook.getCurrent().window.status).toBe('loaded'));
        const membership = hook.getCurrent().membership;
        expect(membership.members.map((member) => member.ref.qualifiedId.id)).toEqual(['active-run', 'inactive-run']);
        expect(membership.members.find((member) => member.key === inactiveKey)?.available).toBe(false);
        const cards = buildBoardCards(membership.members, {
            nowMs: Date.now(), session: () => null, workflowRun: () => null, machine: () => null,
            workflow: () => null, machineSessionCounts: new Map(), accountScopedHome: (id) => id === homes.activeServerId,
        });
        expect(cards.find((card) => card.key === inactiveKey)?.availability).toBe('home_unavailable');
        expect(resolveBoardPruneMembership(board, membership, homes.isHomeMounted).liveItemKeys).toContain(inactiveKey);
        expect(membership.complete).toBe(false);
    });

    it('retires Account-A membership while Account B loads through the same window owner', async () => {
        const old = createWorkflowRunSummaryFixture({ id: 'old', startedBy: 'user' });
        runAnswer.mockReturnValue({ body: await boardRunStoragePage([old]) });
        const board = runsBoard(['you']);
        const hook = await renderHook(() => useBoardMembership(board, homes));
        await waitForHomeGovernance(() => expect(hook.getCurrent().members.map((member) => member.ref.qualifiedId.id)).toEqual(['old']));
        const pending = createDeferred<void>();
        onTestFinished(() => pending.resolve());
        runAnswer.mockReturnValue({ body: await boardRunStoragePage([]), respondAfter: pending.promise });
        await act(async () => { await harness.switchAccount(homes.activeServerId!, 'http://board-runs.test', 'account-b'); });
        expect(hook.getCurrent().members).toEqual([]);
        expect(hook.getCurrent().complete).toBe(false);
        await act(async () => { pending.resolve(); await pending.promise; });
        await waitForHomeGovernance(() => expect(hook.getCurrent().complete).toBe(true));
    });
});
