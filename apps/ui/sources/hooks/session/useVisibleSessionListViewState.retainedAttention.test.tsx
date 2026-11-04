import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import * as React from 'react';
import { createDeferred, createRenderCommitCounter, useRenderCommitCounter, renderScreen } from '@/dev/testkit';
import { countStoreNotifications } from '@/dev/testkit/performance/counts';
import { createSessionListSourceFixture } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import {
    ABSENT_SESSION_FOLLOW_FACTS_V1} from '@happier-dev/protocol/sessions/follow/accountFollow';
import {
    NO_SESSION_PERSONAL_RELEVANCE_FACTS_V1,
    resolveSessionPersonalRelevanceV1,
} from '@happier-dev/protocol/sessions/personal/relevance';
import {
    SessionOrganizationSnapshotSchema} from '@happier-dev/protocol/sessions/organization/snapshot';
import {
    SessionViewerProjectionV1Schema} from '@happier-dev/protocol/sessions/personal/viewer';
import {
    projectViewerReadStateV1} from '@happier-dev/protocol/sessions/personal/readState';
import {
    resolveSessionEffectiveNotificationV1} from '@happier-dev/protocol/sessions/personal/eventEligibility';
import {
    resolveSessionPersonalAttentionV1} from '@happier-dev/protocol/sessions/personal/attention';

import { createPlainSessionByIdResponseFixture, createSessionFixture, createSessionAccessFixture, createSessionOwnerViewerFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import type { SessionListQueryHomeInput } from '@/sync/domains/session/listing/useSessionListQuerySourceState';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createHomeHubArtifactHttpBoundary } from '@/dev/testkit/harness/homeHubArtifactHttpBoundary';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { useMachinePresenceNowMs } from '@/hooks/machine/useMachinePresenceNowMs';
import { isMachineOnline } from '@/utils/sessions/machineUtils';
import { normalizeSessionListFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';

const route = vi.hoisted(() => ({ pathname: '/session/done' }));
const mountedRowCost = vi.hoisted(() => ({
    os: 'web' as 'web' | 'ios',
    counters: new Map<string, ReturnType<typeof createRenderCommitCounter>>(),
}));
const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
installDisconnectedServerSocketBoundary();

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return { ...createExpoRouterMock().module, usePathname: () => route.pathname };
});
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    const ReactModule = await import('react');
    const { createRenderCommitCounter: createCounter, useRenderCommitCounter: useCounter } = await import('@/dev/testkit/performance/counts');
    const boundary = await createReactNativeWebMock();
    const unmeasured = createCounter();
    // Native Pressable is the system boundary: observe the actual production row's
    // root commits, without replacing its row, subscription, view model or memo.
    const Pressable = ReactModule.forwardRef<unknown, Record<string, unknown>>(function CountedNativePressable(props, ref) {
        useCounter(mountedRowCost.counters.get(String(props.testID ?? '')) ?? unmeasured);
        return ReactModule.createElement(boundary.Pressable, { ...props, ref });
    });
    return { ...boundary, Pressable, Platform: { ...boundary.Platform, get OS() { return mountedRowCost.os; } } };
});
vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    return createReanimatedModuleMock();
});
vi.mock('react-native-gesture-handler', async () => {
    const { createGestureHandlerMock } = await import('@/dev/testkit/mocks/gestureHandler');
    return createGestureHandlerMock();
});
vi.mock('react-native-worklets', () => ({ scheduleOnRN: (fn: (...args: unknown[]) => void, ...args: unknown[]) => fn(...args) }));
vi.mock('@legendapp/list/react-native', async (importOriginal) => {
    const { createCapturingLegendListMock } = await import('@/dev/testkit/mocks/legendList');
    return createCapturingLegendListMock({ original: await importOriginal() }).module;
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});
// This third-party renderer is not exercised by a session-list state hook.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({ splitStreamingRevealTextParts: () => [] }));

// Warm the actual graph during collection, outside response-ordering test budgets.
await import('./useVisibleSessionListViewState');
await import('@/sync/ops/sessions');
const { projectManager } = await import('@/sync/runtime/orchestration/projectManager');
const { useSessionListViewState } = await import('@/components/sessions/shell/useSessionListViewState');
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
const { CommandPaletteProvider } = await import('@/components/appShell/commandPalette/CommandPaletteProvider');
const { InboxSummaryProvider } = await import('@/hooks/inbox/useInboxSummary');

function currentViewer(seq: number, cursor: number, latestReadyEventSeq: number | null = null, pendingPermissionRequestCount = 0, pendingUserActionRequestCount = 0) {
    const readState = projectViewerReadStateV1({
        tracked: true,
        row: { lastViewedSessionSeq: cursor, unreadSince: cursor < seq ? 300 : null },
        visibleSessionSeq: seq,
    });
    return SessionViewerProjectionV1Schema.parse({
        latestFailureSeq: 0,
        readState,
        relevance: resolveSessionPersonalRelevanceV1({ ...NO_SESSION_PERSONAL_RELEVANCE_FACTS_V1, ownedByMe: true }),
        attention: resolveSessionPersonalAttentionV1({
            tracked: true, accessible: true, accountSuspended: false, contentAvailable: true,
            visibleSessionSeq: seq, readState, latestReadyEventSeq, latestFailureSeq: null, hasPrimarySessionFailure: false,
            pendingBlockedCount: 0, pendingPermissionRequestCount, pendingUserActionRequestCount,
            capabilities: { canSubmitAgentInput: true, canApprovePermissions: true },
            responsible: false, discussion: { hasUnread: false, hasMention: false },
            attentionStanding: 'none', reminderDue: false,
        }),
        follow: ABSENT_SESSION_FOLLOW_FACTS_V1,
        notification: resolveSessionEffectiveNotificationV1({ facts: ABSENT_SESSION_FOLLOW_FACTS_V1, isSessionOwner: true }),
    });
}

function completedSession(cursor: number, serverId: string) {
    return createSessionFixture({
        id: 'done', serverId, owner: 'u1', seq: 3, lastViewedSessionSeq: cursor,
        viewer: currentViewer(3, cursor, 3), latestTurnStatus: 'completed',
        latestReadyEventSeq: 3, latestReadyEventAt: 300,
        lastTurnCompletedAt: 300, updatedAt: 300, active: false, presence: 0,
    });
}

describe('visible session-list retained attention through real state', () => {
    let previousState: ReturnType<(typeof import('@/sync/domains/state/storage'))['storage']['getState']>;
    let account: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
    let serverId: string;
    let archiveResponse: (() => Promise<Response>) | undefined;
    let snapshotResponse = createDeferred<void>();
    let listedSessions: ReturnType<typeof createSessionFixture>[] = [];
    const transportRequests: string[] = [];

    beforeEach(async () => {
        transportRequests.length = 0;
        archiveResponse = undefined;
        snapshotResponse = createDeferred<void>();
        await home.reset();
        projectManager.clear();
        const { storage } = await import('@/sync/domains/state/storage');
        previousState = storage.getState();
        await loadSyncSingletonForTests();
        serverId = await home.addHome({ name: 'Retained attention Home', serverUrl: 'https://retained-attention.test', accountId: 'u1' });
        const settings = {
            sessionListLayoutV1: 'recent_activity', sessionListAttentionPlacementV1: 'top',
            hideInactiveSessions: false,
        } as const;
        listedSessions = [completedSession(2, serverId), createSessionFixture({
            id: 'quiet', serverId, owner: 'u1', seq: 1, lastViewedSessionSeq: 1,
            viewer: currentViewer(1, 1), updatedAt: 100, active: false, presence: 0,
        })];
        const http = createHomeHubArtifactHttpBoundary('u1');
        account = await restoreServerAccountForTest({ serverUrl: 'https://retained-attention.test', accountId: 'u1', request: async (input, init) => {
            transportRequests.push(new URL(String(input)).pathname);
            if (/^\/v2\/sessions\/(done|quiet)\/archive$/.test(new URL(String(input)).pathname) && archiveResponse) return await archiveResponse();
            if (new URL(String(input)).pathname === '/v2/sessions') {
                await snapshotResponse.promise;
                return Response.json(createSessionListSourceFixture({
                    sessions: listedSessions.map(session => ({ ...createPlainSessionByIdResponseFixture(session).session,
                        viewer: createSessionOwnerViewerFixture(session) })),
                    nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false,
                }));
            }
            if (['/v2/sessions/active', '/v2/sessions/attention'].includes(new URL(String(input)).pathname)) {
                return Response.json({ sessions: [], nextCursor: null, hasNext: false });
            }
            if (new URL(String(input)).pathname === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: settings }, version: 1 });
            const bootstrap = createEmptyAccountBootstrapHttpResponse(new URL(String(input)).pathname, init);
            if (bootstrap) return bootstrap;
            const path = new URL(String(input)).pathname;
            if (path === '/v2/sessions/read-batch' || listedSessions.some(session => path === `/v2/sessions/${session.id}`)) return null;
            return http.request(input, init);
        } });
        expect(account.home.id).toBe(serverId);
        await storage.getState().activateSettingsScope({ serverId, accountId: 'u1' });
        await vi.waitFor(() => expect(storage.getState().settingsVersion).toBe(1));
        storage.getState().applySettingsLocal(settings);
        storage.getState().applySessionOrganizationSnapshot(serverId, SessionOrganizationSnapshotSchema.parse({
            schemaVersion: 1, version: 1, pins: [], folders: [], folderAssignments: [], tags: [],
            tagAssignments: [], orderEntries: [], labels: [],
        }));
        storage.getState().applySessions(listedSessions);
        // Hydration is deliberately row-only. Ordinary admission belongs to the
        // server page producer, not to whichever Session was opened or updated.
        storage.getState().applyServerScopedSessionListRows(serverId, Object.values(storage.getState().sessionListRowsByServerId[serverId] ?? {}), {
            source: 'ordinary', mode: 'replace',
        });
        route.pathname = '/session/done';
        vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 1, 17));
    });

    afterEach(async () => {
        snapshotResponse.resolve();
        await standardCleanup();
        // Identity discovery advances the connection generation. This test
        // still owns that Home, while the captured account disposer correctly
        // refuses to retire a later generation on its caller's behalf.
        const { disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
        await disconnectActiveServerConnection();
        await account?.dispose();
        account = undefined;
        const { storage } = await import('@/sync/domains/state/storage');
        storage.setState(previousState, true);
        await home.reset();
        projectManager.clear();
        mountedRowCost.os = 'web';
        mountedRowCost.counters.clear();
    });

    it('routes value-list demand through the real retained selector without reading transport or changing ordinary membership', async () => {
        const { useVisibleSessionListPaneState } = await import('./useVisibleSessionListPaneState');
        const { storage } = await import('@/sync/domains/state/storage');
        snapshotResponse.resolve();
        const { getSyncSingleton } = await import('@/sync/runtime/getSyncSingleton');
        await getSyncSingleton().refreshSessions({ awaitSessionListHydration: true });
        const filter = normalizeSessionListFilterV1({ homeServerIds: [serverId], scope: 'all_accessible', includeInactive: true });
        const request = { fieldId: 'show', options: [{ value: 'sessions' }, { value: 'runs' }, { value: 'both' }] } as const;
        const hook = await renderHook(() => useVisibleSessionListPaneState('all', { workFilter: filter }));
        try {
            await flushHookEffects();
            const ordinary = hook.getCurrent().visibleSessionListIndex;
            const before = transportRequests.length;
            expect(hook.getCurrent().conditionValueCounts).toBeUndefined();
            await act(async () => hook.getCurrent().onConditionValueCountRequest!(request));
            await flushHookEffects();
            expect(hook.getCurrent().conditionValueCounts).toEqual({ fieldId: 'show', options: [
                { value: 'sessions', count: 2 }, { value: 'runs', count: 0 }, { value: 'both', count: 2 },
            ] });
            expect(hook.getCurrent().visibleSessionListIndex).toBe(ordinary);
            const counts = hook.getCurrent().conditionValueCounts;
            let nonChangeEmits = 0;
            const unsubscribe = hook.subscribe(() => { nonChangeEmits += 1; });
            const current = storage.getState().sessions.done!;
            await act(async () => storage.getState().applySessions([{ ...current, metadataVersion: current.metadataVersion + 1,
                metadata: { ...current.metadata!, name: 'Renamed without changing kind' } }]));
            await flushHookEffects();
            expect(hook.getCurrent().conditionValueCounts).toBe(counts);
            expect(nonChangeEmits).toBe(0);
            unsubscribe();
            await act(async () => hook.getCurrent().onConditionValueCountRequest!(null));
            await flushHookEffects();
            expect(hook.getCurrent().conditionValueCounts).toBeUndefined();
            expect(transportRequests).toHaveLength(before);
        } finally { await hook.unmount(); }
    });

    it('limits real row commits to changed base and mirror occurrences across 1000 Sessions and 139 Machines', async () => {
        const { storage } = await import('@/sync/domains/state/storage');
        const { createMachineFixture } = await import('@/dev/testkit/fixtures/machineFixtures');
        const { buildPerfProfile, perfFixtureId } = await import('../../../../../packages/tests/src/testkit/stress/scenarios/perfProfile');
        const { buildSessionListIndexNodeId } = await import('@/sync/domains/sessionList/sessionListIndexIdentity');
        const profile = buildPerfProfile(42);
        expect(profile.sessions).toHaveLength(192);
        expect(profile.machines).toHaveLength(137);
        const now = Date.now();
        // Expand the canonical 192/137 fixture explicitly. Its original spread of
        // Machines serves the initial rows; the two added Machines serve an arrival
        // and the unrelated-Machine control, respectively.
        const machines = Array.from({ length: 139 }, (_, index) => {
            const platform = ['linux', 'darwin', 'win32'][index % 3]!;
            const homeDir = platform === 'win32' ? 'C:\\Users\\perf' : '/home/perf';
            return createMachineFixture({ id: perfFixtureId(profile.seed, 'machine', index), active: false, activeAt: 0,
                metadata: { host: `dev-${String(index).padStart(3, '0')}`, displayName: `Machine ${index}`, platform,
                    homeDir, happyHomeDir: `${homeDir}${platform === 'win32' ? '\\' : '/'}.happier`, happyCliVersion: '0.0.0-test' } });
        });
        const makeSession = (index: number, requesting: boolean) => {
            const template = profile.sessions[index % profile.sessions.length]!;
            const machineIndex = index === 1000 ? 137 : index % profile.machines.length;
            const machine = machines[machineIndex]!;
            const separator = machine.metadata!.platform === 'win32' ? '\\' : '/';
            return createSessionFixture({ id: `mounted-perf-${index}`, serverId, owner: 'u1', seq: 1,
                projectKey: template.project, lastViewedSessionSeq: 1, viewer: currentViewer(1, 1, null, requesting ? 1 : 0),
                createdAt: 100 + index, updatedAt: now, active: requesting, activeAt: requesting ? now : 0,
                presence: requesting ? 'online' : 0, latestTurnStatus: requesting ? 'in_progress' : undefined,
                latestTurnStatusObservedAt: requesting ? now : null,
                pendingPermissionRequestCount: requesting ? 1 : 0, pendingUserActionRequestCount: 0,
                pendingVersion: requesting ? 1 : 0,
                pendingRequestObservedAt: requesting ? now : null,
                agentState: { requests: requesting ? { approval: {
                    kind: 'permission', tool: 'Bash', arguments: { command: 'pwd' }, createdAt: now, turnId: 'cost-turn',
                } } : {} },
                metadata: { name: template.title, machineId: machine.id,
                    path: `${machine.metadata!.homeDir}${separator}projects${separator}${template.project}`,
                    homeDir: machine.metadata!.homeDir, host: machine.metadata!.host },
            });
        };
        const sessions = Array.from({ length: 1000 }, (_, index) => makeSession(index, index === 0));
        listedSessions = sessions;
        snapshotResponse.resolve();
        const { getSyncSingleton } = await import('@/sync/runtime/getSyncSingleton');
        await getSyncSingleton().refreshSessions({ awaitSessionListHydration: true });
        expect(new Set(sessions.map(session => session.projectKey)).size).toBe(6);
        expect(new Set(machines.map(machine => machine.metadata!.platform))).toEqual(new Set(['linux', 'darwin', 'win32']));
        storage.getState().applySettingsLocal({ sessionListLayoutV1: 'projects',
            sessionListAttentionPlacementV1: 'both', hideInactiveSessions: false });
        storage.getState().applyMachines(machines, true);
        storage.getState().applySessions(sessions);
        storage.getState().applyServerScopedSessionListRows(serverId,
            sessions.map(session => storage.getState().sessionListRowsByServerId[serverId]![session.id]!),
            { source: 'ordinary', mode: 'replace' });
        await vi.waitFor(() => expect(storage.getState().isSessionDraftsReady).toBe(true));
        route.pathname = '/';
        mountedRowCost.os = 'ios';
        const rowId = (sessionId: string, role: 'base' | 'needsYou' = 'base') => `session-list-item-${buildSessionListIndexNodeId({
            type: 'session', serverId, sessionId, occurrenceRole: role,
        })}`;
        for (const session of sessions) mountedRowCost.counters.set(rowId(session.id), createRenderCommitCounter());
        const changedIds = [rowId(sessions[0]!.id), rowId(sessions[0]!.id, 'needsYou')];
        mountedRowCost.counters.set(changedIds[1]!, createRenderCommitCounter());
        const listCounter = createRenderCommitCounter();
        function MountedList() {
            useRenderCommitCounter(listCounter);
            const state = useSessionListViewState('all', { pathname: '/' });
            return React.createElement(React.Fragment, null, state.nodes.map((item, index) => React.createElement(
                React.Fragment, { key: item.id }, state.renderVirtualizedItem({ item, index }))));
        }
        const screen = await renderScreen(<InjectedAuthProvider credentials={account!.credentials}>
            <InboxSummaryProvider><AppPaneProvider><CommandPaletteProvider><MountedList /></CommandPaletteProvider></AppPaneProvider></InboxSummaryProvider>
        </InjectedAuthProvider>);
        const reset = () => { listCounter.reset(); for (const counter of mountedRowCost.counters.values()) counter.reset(); };
        const assertPhase = (phase: string, changed: readonly string[], expectedOwnCommits?: number) => {
            const counts = [...mountedRowCost.counters].map(([id, counter]) => [id, counter.read()] as const);
            const unchanged = counts.filter(([id]) => !changed.includes(id));
            console.info('SESSION_LIST_MOUNTED_1000_COST', JSON.stringify({ phase, list: listCounter.read(),
                changed: changed.map((id, index) => ({ role: index === 0 ? 'base' : 'needsYou', ...mountedRowCost.counters.get(id)!.read() })),
                unchangedRenders: unchanged.reduce((sum, [, count]) => sum + count.renders, 0),
                unchangedCommits: unchanged.reduce((sum, [, count]) => sum + count.commits, 0) }));
            for (const [id, count] of counts) {
                if (!changed.includes(id)) expect(count, `${phase}: ${id}`).toEqual({ renders: 0, commits: 0 });
                else if (expectedOwnCommits !== undefined) expect(count, `${phase}: ${id}`)
                    .toEqual({ renders: expectedOwnCommits, commits: expectedOwnCommits });
                else {
                    expect(count.renders, `${phase}: ${id}`).toBeGreaterThan(0);
                    expect(count.commits, `${phase}: ${id}`).toBe(count.renders);
                }
            }
        };
        try {
            await flushHookEffects({ cycles: 4, turns: 3 });
            const mountedIds = screen.root.findAll(node => typeof node.type === 'string'
                && mountedRowCost.counters.has(String(node.props.testID ?? ''))).map(node => String(node.props.testID));
            expect(mountedIds).toHaveLength(1001);
            expect(new Set(mountedIds).size).toBe(1001);
            expect(changedIds.every(id => mountedRowCost.counters.get(id)!.read().commits > 0)).toBe(true);
            // Retained predecessor fields are not live row presentation inputs.
            // Publish them directly to isolate subscription cost from ingress stripping.
            reset();
            await act(async () => storage.setState(state => ({ settings: { ...state.settings,
                sessionListWorkingStatusAnimatedTextEnabled: false, sessionListNarrowWorkingIndicatorStyle: 'pulse',
            } })));
            await flushHookEffects();
            assertPhase('retiredPreferencePublication', []);
            expect(listCounter.read()).toEqual({ renders: 0, commits: 0 });
            const statusLabels = changedIds.map(id => screen.findHostByTestId(id)?.props.accessibilityLabel);
            reset();
            // The real HTTP owner has admitted layout-1 metadata. Mutate that
            // current tuple rather than replaying the older fixture's layout-0 shape.
            const currentSession = storage.getState().sessions[sessions[0]!.id]!;
            await act(async () => storage.getState().applySessions([{ ...currentSession, updatedAt: now + 1,
                agentStateVersion: currentSession.agentStateVersion + 1, pendingVersion: 2,
                pendingPermissionRequestCount: 0, pendingUserActionRequestCount: 1, pendingRequestObservedAt: now + 1,
                viewer: currentViewer(1, 1, null, 0, 1), agentState: { requests: { question: {
                    kind: 'user_action', tool: 'AskUserQuestion', arguments: { questions: [] }, createdAt: now + 1, turnId: 'cost-turn',
                } } } }]));
            await flushHookEffects();
            expect(storage.getState().sessionListRowsByServerId[serverId]![sessions[0]!.id]).toMatchObject({
                hasPendingPermissionRequests: false, hasPendingUserActionRequests: true,
            });
            changedIds.forEach((id, index) => expect(screen.findHostByTestId(id)?.props.accessibilityLabel).not.toBe(statusLabels[index]));
            assertPhase('status', changedIds, 1);
            reset();
            await act(async () => storage.getState().applyMachines([{ ...machines[138]!, metadataVersion: 2,
                metadata: { ...machines[138]!.metadata!, displayName: 'Unrelated Machine renamed' } }]));
            await flushHookEffects();
            assertPhase('unrelatedMachine', []);
            for (const [arrivalIndex, phase] of [[1000, 'ordinaryArrival'], [1001, 'newProjectArrival']] as const) {
                const template = makeSession(arrivalIndex, true);
                const arrival = arrivalIndex === 1000 ? template : { ...template, projectKey: 'new-cost-project',
                    metadata: { ...template.metadata!, path: `${template.metadata!.homeDir}/projects/new-cost-project` } };
                listedSessions = [...listedSessions, arrival];
                const arrivalIds = [rowId(arrival.id), rowId(arrival.id, 'needsYou')];
                for (const id of arrivalIds) mountedRowCost.counters.set(id, createRenderCommitCounter());
                reset();
                await act(async () => {
                    storage.getState().applySessions([arrival]);
                    storage.getState().applyServerScopedSessionListRows(serverId,
                        [storage.getState().sessionListRowsByServerId[serverId]![arrival.id]!], { source: 'ordinary', mode: 'append' });
                });
                await flushHookEffects();
                arrivalIds.forEach(id => expect(screen.findHostByTestId(id)).not.toBeNull());
                assertPhase(phase, arrivalIds);
            }
        } finally { await screen.unmount(); }
    });

    it('places attention before Scheduled and Drafts, then ordinary groups, without remounting Drafts', async () => {
        const { storage } = await import('@/sync/domains/state/storage');
        const { SessionListVirtualizedContent } = await import('@/components/sessions/shell/sessionListVirtualizedContent');
        const { ScheduledWorkflowGroup } = await import('@/components/workflows/triggers/ScheduledWorkflowSection');
        const { projectScheduledWorkflowRows } = await import('@/components/workflows/triggers/scheduledWorkflowRows');
        const { WorkflowTriggerSetV1Schema} = await import('@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1');
        const { writeNewSessionDraft } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
        const { buildSessionListIndexNodeId } = await import('@/sync/domains/sessionList/sessionListIndexIdentity');
        const now = Date.now();
        const sessions = ['needs', 'working', 'ordinary'].map((id, index) => createSessionFixture({
            id, serverId, owner: 'u1', seq: 1, projectKey: 'order-project', lastViewedSessionSeq: 1,
            viewer: currentViewer(1, 1, null, id === 'needs' ? 1 : 0),
            active: id !== 'ordinary', activeAt: now, presence: id !== 'ordinary' ? 'online' : 0,
            createdAt: 100 + index, updatedAt: now, thinking: id === 'working', thinkingAt: id === 'working' ? now : 0,
            latestTurnStatus: id !== 'ordinary' ? 'in_progress' : undefined, latestTurnStatusObservedAt: now,
            pendingPermissionRequestCount: id === 'needs' ? 1 : 0, pendingVersion: id === 'needs' ? 1 : 0,
            pendingRequestObservedAt: id === 'needs' ? now : null,
            agentState: { requests: id === 'needs' ? { approval: {
                kind: 'permission', tool: 'Bash', arguments: { command: 'pwd' }, createdAt: now,
            } } : {} }, metadata: { name: id, path: '/order', host: 'order-box' },
        }));
        listedSessions = sessions;
        snapshotResponse.resolve();
        const { getSyncSingleton } = await import('@/sync/runtime/getSyncSingleton');
        await getSyncSingleton().refreshSessions({ awaitSessionListHydration: true });
        storage.getState().applySettingsLocal({ sessionListLayoutV1: 'projects', hideInactiveSessions: false,
            sessionListAttentionPlacementV1: 'both' });
        await vi.waitFor(() => expect(storage.getState().isSessionDraftsReady).toBe(true));
        const draftId = '00000000-0000-4000-8000-000000000008';
        writeNewSessionDraft({ scope: { serverId, accountId: 'u1' }, draftId,
            patch: { text: 'Keep this draft focused' }, materializationIntent: 'userEdit' });
        const schedule = WorkflowTriggerSetV1Schema.parse({ automationId: 'order-habit', revision: 1,
            enabled: true, health: 'available', target: { kind: 'inline', definition: { version: 1,
                blocks: [{ kind: 'step', id: 'review', document: { text: 'Review', references: [], attachments: [] },
                    input: [], result: { kind: 'text' } }] } }, triggers: [{ id: 'timer', revision: 1,
                enabled: true, kind: 'schedule', nextRunAt: now + 120_000, createdAt: now, updatedAt: now,
                triggerDefinitionEnvelope: null,
                schedule: { kind: 'interval', everyMs: 60_000, scheduleExpr: null, timezone: null } }] });
        const scheduledSection = React.createElement(ScheduledWorkflowGroup, { read: { available: true,
            rows: projectScheduledWorkflowRows([schedule]), status: 'ready', retry: () => {}, serverId } });
        route.pathname = '/';
        mountedRowCost.os = 'ios';
        function ComposedList() {
            const state = useSessionListViewState('all', { pathname: '/' });
            return React.createElement(SessionListVirtualizedContent, { nodes: state.nodes,
                rowHeight: state.rowHeight, rowDensity: state.rowDensity, safeAreaBottom: 0,
                renderItem: state.renderVirtualizedItem, rowExtraData: state.virtualizedRowExtraData,
                scheduledSection, showReminders: false, onStopScrollEventPropagationOnWeb: () => {} });
        }
        const screen = await renderScreen(<InjectedAuthProvider credentials={account!.credentials}>
            <InboxSummaryProvider><AppPaneProvider><CommandPaletteProvider><ComposedList /></CommandPaletteProvider></AppPaneProvider></InboxSummaryProvider>
        </InjectedAuthProvider>);
        const rowId = (sessionId: string, occurrenceRole: 'base' | 'needsYou' | 'working' = 'base') =>
            `session-list-item-${buildSessionListIndexNodeId({ type: 'session', serverId, sessionId, occurrenceRole })}`;
        const draftRowId = `session-draft-row:new-session:${draftId}`;
        const scheduledId = 'scheduled-workflow:order-habit:timer';
        const order = (ids: readonly string[]) => screen.root.findAll(node => typeof node.type === 'string'
            && ids.includes(String(node.props.testID ?? ''))).map(node => String(node.props.testID));
        try {
            await flushHookEffects({ cycles: 4, turns: 3 });
            const projectHeader = screen.root.findAll(node => typeof node.type === 'string'
                && String(node.props.testID ?? '').startsWith('session-list-project-header:'))[0];
            expect(projectHeader).toBeDefined();
            const projectHeaderId = String(projectHeader!.props.testID);
            expect(order([rowId('needs', 'needsYou'), rowId('working', 'working'), scheduledId, draftRowId, projectHeaderId, rowId('ordinary')]))
                .toEqual([rowId('needs', 'needsYou'), rowId('working', 'working'), scheduledId, draftRowId, projectHeaderId, rowId('ordinary')]);
            const draftHost = screen.findHostByTestId(draftRowId);
            expect(draftHost).not.toBeNull();
            await act(async () => storage.getState().applySettingsLocal({
                sessionListAttentionPlacementV1: 'inPlace',
            }));
            await flushHookEffects();
            expect(screen.findHostByTestId(rowId('needs', 'needsYou'))).toBeNull();
            expect(screen.findHostByTestId(rowId('working', 'working'))).toBeNull();
            const inPlace = order([scheduledId, draftRowId, rowId('needs'), rowId('working'), rowId('ordinary')]);
            expect(inPlace.slice(0, 2)).toEqual([scheduledId, draftRowId]);
            expect(inPlace.slice(2)).toHaveLength(3);
            expect(screen.findHostByTestId(draftRowId)).toBe(draftHost);
            await act(async () => writeNewSessionDraft({ scope: { serverId, accountId: 'u1' }, draftId,
                patch: { text: 'Live draft update stays in its mounted row' }, materializationIntent: 'userEdit' }));
            await flushHookEffects();
            expect(screen.getTextContent()).toContain('Live draft update stays in its mounted row');
            expect(screen.findHostByTestId(draftRowId)).toBe(draftHost);
        } finally { await screen.unmount(); }
    });

    it('keeps Machine names on headers and refreshes inherited checkout context when the visible lead changes', async () => {
        const { storage } = await import('@/sync/domains/state/storage');
        const { createMachineFixture } = await import('@/dev/testkit/fixtures/machineFixtures');
        const { buildSessionListIndexNodeId } = await import('@/sync/domains/sessionList/sessionListIndexIdentity');
        const now = Date.now();
        const sessions = ['context-lead', 'context-report', 'context-other'].map((id, index) => createSessionFixture({
            id, serverId, owner: 'u1', projectKey: 'context-project', seq: 1, lastViewedSessionSeq: 1,
            viewer: currentViewer(1, 1), createdAt: 100 + index, updatedAt: now, active: false, presence: 0,
            ...(id === 'context-report' ? { manager: { sessionId: 'context-lead' } } : {}),
            metadata: { name: id, path: '/work/context', machineId: id === 'context-other' ? 'other-machine' : 'shared-machine',
                workspaceId: 'accepted-context-checkout', branch: 'feature/context', host: `${id}-host` },
        }));
        listedSessions = sessions;
        snapshotResponse.resolve();
        const { getSyncSingleton } = await import('@/sync/runtime/getSyncSingleton');
        await getSyncSingleton().refreshSessions({ awaitSessionListHydration: true });
        storage.getState().applySettingsLocal({ sessionListLayoutV1: 'recent_activity', sessionListAttentionPlacementV1: 'inPlace',
            sessionListRowContextV1: true, sessionListIdentityDisplay: 'auto', hideInactiveSessions: false });
        storage.getState().applyMachines([createMachineFixture({ id: 'shared-machine' }), createMachineFixture({ id: 'other-machine' })], true);
        storage.getState().applySessions(sessions);
        storage.getState().applyServerScopedSessionListRows(serverId, sessions.map(session =>
            storage.getState().sessionListRowsByServerId[serverId]![session.id]!), { source: 'ordinary', mode: 'replace' });
        await vi.waitFor(() => expect(storage.getState().isSessionDraftsReady).toBe(true));
        route.pathname = '/';
        mountedRowCost.os = 'ios';
        const occurrenceId = (sessionId: string) => buildSessionListIndexNodeId({ type: 'session', serverId, sessionId });
        const otherCounter = createRenderCommitCounter();
        mountedRowCost.counters.set(`session-list-item-${occurrenceId('context-other')}`, otherCounter);
        function List() {
            const state = useSessionListViewState('all', { pathname: '/' });
            return React.createElement(React.Fragment, null, state.nodes.map((item, index) => React.createElement(
                React.Fragment, { key: item.id }, state.renderVirtualizedItem({ item, index }))));
        }
        const screen = await renderScreen(<InjectedAuthProvider credentials={account!.credentials}>
            <InboxSummaryProvider><AppPaneProvider><CommandPaletteProvider><List /></CommandPaletteProvider></AppPaneProvider></InboxSummaryProvider>
        </InjectedAuthProvider>);
        const badge = (kind: 'machine' | 'checkout', id: string) => screen.findHostByTestId(
            `session-list-row-context-${kind}-${occurrenceId(id)}`);
        try {
            await flushHookEffects({ cycles: 4, turns: 3 });
            // OWNER-RULINGS (2026-11-01 "Session list status") and SESSION-LIST-GROUPS:
            // Machine names belong to colliding group headers; rows keep checkout context only.
            expect(badge('machine', 'context-lead')).toBeNull();
            expect(badge('checkout', 'context-lead')).not.toBeNull();
            expect(badge('machine', 'context-report')).toBeNull();
            expect(badge('checkout', 'context-report')).toBeNull();
            expect(screen.findHostByTestId(`session-list-item-${occurrenceId('context-report')}`)?.props.accessibilityLabel)
                .toContain('feature/context');
            otherCounter.reset();
            const lead = storage.getState().sessions['context-lead']!;
            await act(async () => storage.getState().applySessions([{ ...lead, metadataVersion: lead.metadataVersion + 1,
                metadata: { ...lead.metadata!, machineId: 'other-machine', workspaceId: 'different-checkout' } }]));
            await flushHookEffects();
            expect(badge('machine', 'context-report')).toBeNull();
            expect(badge('checkout', 'context-report')).not.toBeNull();
            expect(otherCounter.read()).toEqual({ renders: 0, commits: 0 });
            const changedLead = storage.getState().sessions['context-lead']!;
            await act(async () => storage.getState().applySessions([{ ...changedLead, metadataVersion: changedLead.metadataVersion + 1,
                metadata: null }]));
            await flushHookEffects();
            expect(badge('machine', 'context-report')).toBeNull();
            expect(badge('checkout', 'context-report')).not.toBeNull();
            const report = storage.getState().sessions['context-report']!;
            await act(async () => storage.getState().applySessions([{ ...report, manager: null }]));
            await flushHookEffects();
            expect(badge('machine', 'context-report')).toBeNull();
            expect(badge('checkout', 'context-report')).not.toBeNull();
        } finally { await screen.unmount(); }
    });

    it('counts a visible Session once in the actual query presentation for Top and Both placement', async () => {
        const { storage } = await import('@/sync/domains/state/storage');
        const { useVisibleSessionListPaneState } = await import('./useVisibleSessionListPaneState');
        const { useSessionListViewFilterController } = await import('@/components/sessions/shell/search/useSessionListViewFilterController');
        const { SessionsListViewWithFilterController } = await import('@/components/sessions/shell/SessionsList');
        const { buildSessionListIndexNodeId } = await import('@/sync/domains/sessionList/sessionListIndexIdentity');
        const now = Date.now();
        const session = createSessionFixture({ id: 'query-needs', serverId, owner: 'u1', projectKey: 'query-project',
            seq: 1, lastViewedSessionSeq: 1, viewer: currentViewer(1, 1, null, 1), updatedAt: now,
            active: true, activeAt: now, presence: 'online', latestTurnStatus: 'in_progress', latestTurnStatusObservedAt: now,
            pendingPermissionRequestCount: 1, pendingVersion: 1, pendingRequestObservedAt: now,
            agentState: { requests: { approval: { kind: 'permission', tool: 'Bash',
                arguments: { command: 'pwd' }, createdAt: now } } }, metadata: { name: 'Query request', path: '/query', host: 'query-box' },
        });
        listedSessions = [session];
        snapshotResponse.resolve();
        const { getSyncSingleton } = await import('@/sync/runtime/getSyncSingleton');
        await getSyncSingleton().refreshSessions({ awaitSessionListHydration: true });
        storage.getState().applySettingsLocal({ sessionListLayoutV1: 'projects',
            sessionListAttentionPlacementV1: 'top', hideInactiveSessions: false });
        route.pathname = '/';
        mountedRowCost.os = 'ios';
        function QueryList() {
            const controller = useSessionListViewFilterController('active');
            const pane = useVisibleSessionListPaneState('all', { workFilter: controller.filters, pathname: '/' });
            // Exercise the published ready-query presentation against the real
            // pane/index/controller, not a mocked count or empty-state decision.
            return React.createElement(SessionsListViewWithFilterController, { corpusStorage: 'active',
                filterController: controller, pathname: '/', paneState: { ...pane,
                    queryPresentation: { kind: 'ready', complete: true } } });
        }
        const screen = await renderScreen(<InjectedAuthProvider credentials={account!.credentials}>
            <InboxSummaryProvider><AppPaneProvider><CommandPaletteProvider><QueryList /></CommandPaletteProvider></AppPaneProvider></InboxSummaryProvider>
        </InjectedAuthProvider>);
        const rowId = (occurrenceRole: 'base' | 'needsYou') => `session-list-item-${buildSessionListIndexNodeId({
            type: 'session', serverId, sessionId: session.id, occurrenceRole,
        })}`;
        const publishedCounts = () => screen.root.findAll(node =>
            node.props.queryPresentationState?.presentation?.kind === 'ready')
            .map(node => node.props.queryPresentationState.visibleSessionCount);
        try {
            await flushHookEffects({ cycles: 4, turns: 3 });
            expect(screen.findHostByTestId(rowId('needsYou'))).not.toBeNull();
            expect(screen.findHostByTestId(rowId('base'))).toBeNull();
            expect(screen.findHostByTestId('session-list-query-empty-state')).toBeNull();
            expect(publishedCounts()).toEqual([1]);
            await act(async () => storage.getState().applySettingsLocal({ sessionListAttentionPlacementV1: 'both' }));
            await flushHookEffects();
            expect(screen.findHostByTestId(rowId('needsYou'))).not.toBeNull();
            expect(screen.findHostByTestId(rowId('base'))).not.toBeNull();
            expect(screen.findHostByTestId('session-list-query-empty-state')).toBeNull();
            expect(publishedCounts()).toEqual([1]);
        } finally { await screen.unmount(); }
    });

    it('keeps Project arrivals appended only in the mounted view and reseeds a different savedspace', async () => {
        const { storage } = await import('@/sync/domains/state/storage');
        const { useVisibleSessionListViewState } = await import('./useVisibleSessionListViewState');
        const { normalizeSessionListFilterV1 } = await import('@happier-dev/protocol/sessions/listFilter/sessionListFilterV1');
        storage.getState().applySettingsLocal({ sessionListLayoutV1: 'projects' });
        const a = createSessionFixture({ id: 'project-a', serverId, owner: 'u1', projectKey: 'a', createdAt: 20,
            viewer: currentViewer(1, 1), seq: 1, active: false });
        const b = createSessionFixture({ id: 'project-b', serverId, owner: 'u1', projectKey: 'b', createdAt: 10,
            viewer: currentViewer(1, 1), seq: 1, active: false });
        const publish = (sessions: typeof listedSessions) => {
            storage.getState().applySessions(sessions);
            storage.getState().applyServerScopedSessionListRows(serverId, sessions.map(session =>
                storage.getState().sessionListRowsByServerId[serverId]![session.id]!), { source: 'ordinary', mode: 'replace' });
        };
        publish([a]);
        const workFilter = normalizeSessionListFilterV1({ homeServerIds: [serverId], show: 'sessions', includeInactive: true });
        const initialProps: { context?: string } = { context: 'space-a' };
        const hook = await renderHook(({ context }: { context?: string }) => useVisibleSessionListViewState('all', {
            collapseContextKey: context, workFilter,
        }), { initialProps });
        const keys = () => hook.getCurrent().visibleSessionListIndex?.flatMap(item =>
            item.type === 'header' && item.headerKind === 'project' && item.projectKey ? [item.projectKey.projectKey] : []);
        try {
            expect(keys()).toEqual(['a']);
            await act(async () => publish([a, b]));
            await flushHookEffects();
            expect(keys()).toEqual(['a', 'b']);
            await hook.rerender({ context: 'space-b' });
            expect(keys()).toEqual(['b', 'a']);
            await hook.rerender({ context: undefined });
            const c = createSessionFixture({ ...a, id: 'project-c', projectKey: 'c', createdAt: 1 });
            await act(async () => publish([a, b, c]));
            await flushHookEffects();
            expect(keys()).toEqual(['b', 'a', 'c']);

            // The same published Sessions can remain visible to another Account via sharing.
            // No optional savedspace context is present to mask the Account lifetime boundary.
            const shared = [a, b, c].map(session => ({ ...session, access: createSessionAccessFixture('view'), accessLevel: 'view' as const }));
            const previousAccount = account;
            const nextHttp = createHomeHubArtifactHttpBoundary('u2');
            const nextAccount = await restoreServerAccountForTest({ serverUrl: 'https://retained-attention.test', accountId: 'u2',
                activation: 'switch', request: async (input, init) => {
                    const path = new URL(String(input)).pathname;
                    if (path === '/v2/sessions') return Response.json(createSessionListSourceFixture({
                        sessions: shared.map(session => ({ ...createPlainSessionByIdResponseFixture(session).session,
                            viewer: currentViewer(1, 1) })),
                        nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false,
                    }));
                    if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {
                        sessionListLayoutV1: 'projects', hideInactiveSessions: false,
                    } }, version: 1 });
                    const bootstrap = createEmptyAccountBootstrapHttpResponse(path, init);
                    if (bootstrap) return bootstrap;
                    if (path === '/v2/sessions/read-batch' || shared.some(session => path === `/v2/sessions/${session.id}`)) return null;
                    return nextHttp.request(input, init);
                } });
            account = { ...nextAccount, dispose: async () => { await nextAccount.dispose(); await previousAccount?.dispose(); } };
            await storage.getState().activateSettingsScope({ serverId, accountId: 'u2' });
            storage.getState().applySettingsLocal({ sessionListLayoutV1: 'projects' });
            await act(async () => publish(shared));
            await flushHookEffects();
            expect(keys()).toEqual(['c', 'b', 'a']);
        } finally { await hook.unmount(); }
    });

    it('reseeds the mounted pane when switching saved spaces with identical filters', async () => {
        const { storage } = await import('@/sync/domains/state/storage');
        const { SessionsListPaneContent } = await import('@/components/sessions/shell/SessionsListPaneContent');
        const { SessionsListViewWithFilterController } = await import('@/components/sessions/shell/SessionsList');
        const { normalizeSessionListFilterV1 } = await import('@happier-dev/protocol/sessions/listFilter/sessionListFilterV1');
        const { writeCollectionSpaceSelectionV1 } = await import('@/sync/domains/session/listing/sessionListSpaces');
        const { areAccountSettingsScopesEqual } = await import('@/sync/domains/settings/scope/accountSettingsScope');
        const a = createSessionFixture({ id: 'pane-project-a', serverId, owner: 'u1', projectKey: 'a', createdAt: 20,
            viewer: currentViewer(1, 1), seq: 1, active: false });
        const b = createSessionFixture({ id: 'pane-project-b', serverId, owner: 'u1', projectKey: 'b', createdAt: 10,
            viewer: currentViewer(1, 1), seq: 1, active: false });
        listedSessions = [a];
        snapshotResponse.resolve();
        const { getSyncSingleton } = await import('@/sync/runtime/getSyncSingleton');
        await getSyncSingleton().refreshSessions({ awaitSessionListHydration: true });
        const filter = normalizeSessionListFilterV1({ homeServerIds: [serverId], show: 'sessions', includeInactive: true });
        storage.getState().applySettingsLocal({ sessionListLayoutV1: 'projects', hideInactiveSessions: false,
            sessionListAttentionPlacementV1: 'inPlace', collectionSpacesV1: { v: 1, spaces: ['space-a', 'space-b'].map(id => ({
                id, name: id, entityKind: 'sessionWork' as const, icon: { kind: 'icon' as const, name: 'list' as const }, filter,
                includeNeedsYouEverywhere: false,
            })) } });
        const scope = { serverId, accountId: 'u1' };
        const selectSpace = (spaceId: string) => writeCollectionSpaceSelectionV1({ scope, entityKind: 'sessionWork', spaceId,
            isCurrent: () => areAccountSettingsScopesEqual(storage.getState().settingsScope, scope),
            readSettings: () => storage.getState().settings });
        expect(await selectSpace('space-a')).toEqual({ ok: true });
        route.pathname = '/';
        mountedRowCost.os = 'ios';
        const screen = await renderScreen(<InjectedAuthProvider credentials={account!.credentials}>
            <InboxSummaryProvider><AppPaneProvider><CommandPaletteProvider>
                <SessionsListPaneContent storageKind="all" fallbackGuidanceVariant="sidebar" pathname="/" />
            </CommandPaletteProvider></AppPaneProvider></InboxSummaryProvider>
        </InjectedAuthProvider>);
        const keys = () => {
            const pane = screen.root.findByType(SessionsListViewWithFilterController).props.paneState as
                import('./useVisibleSessionListPaneState').VisibleSessionListPaneState;
            return pane.visibleSessionListIndex?.flatMap(item => item.type === 'header' && item.headerKind === 'project'
                && item.projectKey ? [item.projectKey.projectKey] : []);
        };
        try {
            await flushHookEffects({ cycles: 4, turns: 3 });
            await vi.waitFor(() => expect(keys()).toEqual(['a']));
            await act(async () => {
                listedSessions = [a, b];
                storage.getState().applySessions([b]);
                storage.getState().applyServerScopedSessionListRows(serverId,
                    [storage.getState().sessionListRowsByServerId[serverId]![b.id]!], { source: 'ordinary', mode: 'append' });
            });
            await flushHookEffects();
            expect(keys()).toEqual(['a', 'b']);
            await act(async () => { await selectSpace('space-b'); });
            await flushHookEffects();
            expect(screen.root.findByType(SessionsListViewWithFilterController).props.filterController.selectedSpaceId).toBe('space-b');
            expect(keys()).toEqual(['b', 'a']);
        } finally { await screen.unmount(); }
    });

    it('confines repeated row-content publications to the changed row, without list commits', async () => {
        const { storage, useSessionListRenderableWithServerScope } = await import('@/sync/domains/state/storage');
        const { useVisibleSessionListViewState } = await import('./useVisibleSessionListViewState');
        const sessions = Array.from({ length: 24 }, (_, index) => createSessionFixture({
            id: `render-row-${index}`, serverId, owner: 'u1', seq: 1, lastViewedSessionSeq: 1,
            viewer: currentViewer(1, 1), updatedAt: 100, active: false, presence: 0,
            metadata: { name: `Row ${index}`, path: '/workspace', host: 'test' },
        }));
        storage.getState().applySessions(sessions);
        storage.getState().applyServerScopedSessionListRows(serverId,
            sessions.map(session => storage.getState().sessionListRowsByServerId[serverId]![session.id]!),
            { source: 'ordinary', mode: 'replace' });
        route.pathname = '/';
        const listCounter = createRenderCommitCounter();
        const rowCounters = new Map(sessions.map(session => [session.id, createRenderCommitCounter()]));
        function Row({ id }: { id: string }) {
            useRenderCommitCounter(rowCounters.get(id)!);
            const row = useSessionListRenderableWithServerScope(serverId, id);
            return React.createElement('row', { id, name: row?.metadata?.name });
        }
        function List() {
            useRenderCommitCounter(listCounter);
            const state = useVisibleSessionListViewState();
            return React.createElement(React.Fragment, null, state.visibleSessionListIndex?.flatMap(item =>
                item.type === 'session' ? [React.createElement(Row, { key: item.sessionId, id: item.sessionId })] : []));
        }
        const screen = await renderScreen(React.createElement(List));
        try {
            await flushHookEffects({ cycles: 2, turns: 2 });
            expect(screen.findAllByType('row')).toHaveLength(24);
            listCounter.reset();
            for (const counter of rowCounters.values()) counter.reset();
            for (let update = 1; update <= 5; update += 1) {
                await act(async () => {
                    storage.getState().applySessions([{
                        ...sessions[0]!, metadataVersion: update,
                        metadata: { ...sessions[0]!.metadata!, name: `Changed ${update}` },
                    }]);
                });
            }
            const counts = { list: listCounter.read(), rows: Object.fromEntries(
                [...rowCounters].map(([id, counter]) => [id, counter.read()])) };
            console.info('SESSION_LIST_ROW_FANOUT', JSON.stringify(counts));
            expect(screen.findAllByType('row').find(row => row.props.id === sessions[0]!.id)?.props.name).toBe('Changed 5');
            expect(counts.list).toEqual({ renders: 0, commits: 0 });
            expect(rowCounters.get(sessions[0]!.id)!.read()).toEqual({ renders: 5, commits: 5 });
            for (const session of sessions.slice(1)) {
                expect(rowCounters.get(session.id)!.read()).toEqual({ renders: 0, commits: 0 });
            }
        } finally {
            await act(async () => screen.unmount());
        }
    });

    it('keeps mounted rows off a current Home advancing its list success clock until the Home goes offline', async () => {
        const { storage } = await import('@/sync/domains/state/storage');
        const publishObservation = (phase: 'ready' | 'offline', lastSuccessAt: number) => storage.setState((state) => ({
            ...state,
            concurrentSessionListCacheByServerId: {
                ...state.concurrentSessionListCacheByServerId,
                [serverId]: { serverName: 'Retained attention Home', listObservation: { phase, lastSuccessAt } },
            },
        }));
        await act(async () => publishObservation('ready', 1_000));
        route.pathname = '/';
        mountedRowCost.os = 'ios';
        const delivered: Array<{ extraData: unknown; renderItem: unknown }> = [];
        function List() {
            const state = useSessionListViewState('all', { pathname: '/' });
            delivered.push({ extraData: state.virtualizedRowExtraData, renderItem: state.renderVirtualizedItem });
            return null;
        }
        const screen = await renderScreen(<InjectedAuthProvider credentials={account!.credentials}>
            <InboxSummaryProvider><AppPaneProvider><CommandPaletteProvider><List /></CommandPaletteProvider></AppPaneProvider></InboxSummaryProvider>
        </InjectedAuthProvider>);
        try {
            await flushHookEffects({ cycles: 2, turns: 2 });
            const settled = delivered[delivered.length - 1]!;
            // Each successful refetch of a current Home only moves a clock rows never show.
            for (let refetch = 1; refetch <= 5; refetch += 1) {
                await act(async () => publishObservation('ready', 1_000 + refetch * 1_000));
            }
            const afterRefetches = delivered[delivered.length - 1]!;
            expect(afterRefetches.extraData).toBe(settled.extraData);
            expect(afterRefetches.renderItem).toBe(settled.renderItem);

            await act(async () => publishObservation('offline', 6_000));
            const offline = delivered[delivered.length - 1]!;
            expect(offline.extraData).not.toBe(settled.extraData);
            expect((offline.extraData as { homeObservations: Record<string, { phase: string; lastSuccessAt: number }> })
                .homeObservations[serverId]).toEqual({ phase: 'offline', lastSuccessAt: 6_000 });
        } finally {
            await act(async () => screen.unmount());
        }
    });

    it('retains keyed row projections and confines five new arrivals to the admitted rows', async () => {
        const { storage } = await import('@/sync/domains/state/storage');
        const { useVisibleSessionListViewState } = await import('./useVisibleSessionListViewState');
        const sessions = Array.from({ length: 24 }, (_, index) => createSessionFixture({
            id: `admission-row-${index}`, serverId, owner: 'u1', seq: 1,
            viewer: currentViewer(1, 1), lastViewedSessionSeq: 1, active: false, presence: 0,
            createdAt: 100 + index, updatedAt: 100 + index,
        }));
        storage.getState().applySessions(sessions);
        storage.getState().applyServerScopedSessionListRows(serverId,
            sessions.map(session => storage.getState().sessionListRowsByServerId[serverId]![session.id]!),
            { source: 'ordinary', mode: 'replace' });
        route.pathname = '/';
        const counters = new Map(sessions.map(session => [session.id, createRenderCommitCounter()]));
        const listCounter = createRenderCommitCounter();
        const Row = React.memo(function Row({ item }: { item: Extract<import('@/sync/domains/sessionList/sessionListIndex').SessionListIndexItem, { type: 'session' }> }) {
            const counter = counters.get(item.sessionId);
            if (!counter) throw Error('Missing row counter');
            useRenderCommitCounter(counter);
            return React.createElement('admission-row', { id: item.sessionId });
        });
        function List() {
            useRenderCommitCounter(listCounter);
            const state = useVisibleSessionListViewState();
            return React.createElement(React.Fragment, null, state.visibleSessionListIndex?.flatMap(item =>
                item.type === 'session' ? [React.createElement(Row, { key: item.sessionId, item })] : []));
        }
        const screen = await renderScreen(React.createElement(List));
        try {
            for (const counter of counters.values()) counter.reset();
            listCounter.reset();
            for (let index = 0; index < 5; index++) {
                const session = createSessionFixture({ ...sessions[0]!, id: `new-arrival-${index}`, createdAt: 1_000 + index });
                counters.set(session.id, createRenderCommitCounter());
                await act(async () => {
                    storage.getState().applySessions([session]);
                    storage.getState().applyServerScopedSessionListRows(serverId,
                        [storage.getState().sessionListRowsByServerId[serverId]![session.id]!],
                        { source: 'ordinary', mode: 'append' });
                });
            }
            expect(screen.findAllByType('admission-row')).toHaveLength(29);
            expect(listCounter.read()).toEqual({ renders: 5, commits: 5 });
            expect(sessions.map(session => counters.get(session.id)!.read())).toEqual(
                sessions.map(() => ({ renders: 0, commits: 0 })));
            for (let index = 0; index < 5; index++) expect(counters.get(`new-arrival-${index}`)!.read())
                .toEqual({ renders: 1, commits: 1 });
            console.info('SESSION_LIST_ADMISSION_FANOUT', JSON.stringify({
                list: listCounter.read(), unaffectedRows: sessions.map(session => counters.get(session.id)!.read()),
                admittedRows: Array.from({ length: 5 }, (_, index) => counters.get(`new-arrival-${index}`)!.read()),
            }));
        } finally { await screen.unmount(); }
    });

    it.each(['ordinary', 'query', 'warm query'] as const)('retains multiple pending archive rows in the %s source until their public operations finish', async mode => {
        const { storage } = await import('@/sync/domains/state/storage');
        const { useVisibleSessionListViewState } = await import('./useVisibleSessionListViewState');
        const { stopSessionAndMaybeArchive } = await import('@/components/sessions/sessionStopArchiveFlow');
        const { sessionArchiveWithServerScope } = await import('@/sync/ops/sessions');
        const entered = createDeferred<void>();
        const response = createDeferred<Response>();
        let enteredCount = 0;
        archiveResponse = async () => {
            if (++enteredCount === 2) entered.resolve();
            return (await response.promise).clone();
        };
        route.pathname = '/';
        if (mode !== 'warm query') {
            snapshotResponse.resolve();
            const { getSyncSingleton } = await import('@/sync/runtime/getSyncSingleton');
            await getSyncSingleton().refreshSessions({ awaitSessionListHydration: true });
        }
        let queryHomes: readonly SessionListQueryHomeInput[] | undefined = mode !== 'ordinary' ? [{ serverId,
            query: { v: 1, scope: 'my_work', storage: 'active', includeInactive: true,
                attention: 'any', audiences: [], tagIds: [] },
            ordinaryAdapter: { path: '/v2/sessions', allowV1Fallback: true, membership: 'ordinary' },
        } as const] : undefined;
        const hook = await renderHook(() => useVisibleSessionListViewState('all', { queryHomes }));
        const visibleIds = () => hook.getCurrent()?.visibleSessionListIndex
            ?.flatMap(item => item.type === 'session' ? [item.sessionId] : []);
        expect(visibleIds()).toContain('done');
        if (mode === 'warm query') expect(hook.getCurrent()?.query?.statesByServerId[serverId]?.appliedQueryKey).toBeNull();
        let settledVisibleIds: string[] | undefined;
        let pending: Promise<unknown> = Promise.resolve();
        await act(async () => {
            pending = Promise.all(['done', 'quiet'].map(sessionId => stopSessionAndMaybeArchive({
                address: { serverId, sessionId },
                hideInactiveSessions: false, isPinned: false, archiveAfterStop: 'always',
                stopSession: async () => ({ success: true }),
                archiveSession: () => sessionArchiveWithServerScope(sessionId, { serverId }),
                stopErrorMessage: 'Stop failed', archiveErrorMessage: 'Archive failed',
            })));
        });
        try {
            await entered.promise;
            const { setServerProfileIdentityForUrl } = await import('@/sync/domains/server/serverProfiles');
            const { readSessionArchivePending } = await import('@/sync/domains/session/listing/sessionArchiveState');
            const discoveredHome = 'srv_archive_retained_identity';
            await act(async () => { await setServerProfileIdentityForUrl('https://retained-attention.test', discoveredHome); });
            expect(visibleIds()).toContain('done');
            expect(readSessionArchivePending(storage.getState(), { serverId: discoveredHome, sessionId: 'done' })).toBe(true);
            await act(async () => {
                // The server can publish its committed archival before the HTTP
                // response arrives. Exercise the same canonical row/membership writer.
                storage.getState().applyServerScopedSessionListRowPatches(discoveredHome, [
                    { sessionId: 'done', patch: { archivedAt: 42 } },
                    { sessionId: 'quiet', patch: { archivedAt: 42 } },
                ]);
            });
            expect(storage.getState().ordinarySessionListMembershipByServerId[serverId]).not.toContain('done');
            expect(storage.getState().sessionArchiveOperations[serverId]?.done).toBeDefined();
            expect(storage.getState().sessionArchiveOperations[serverId]?.quiet).toBeDefined();
            expect(visibleIds()).toEqual(expect.arrayContaining(['done', 'quiet']));
            if (queryHomes) {
                queryHomes = queryHomes.map(home => ({ ...home, query: { ...home.query, tagIds: ['different-tag'] } }));
                await hook.rerender();
                expect(visibleIds() ?? []).not.toContain('done');
                expect(visibleIds() ?? []).not.toContain('quiet');
                expect(readSessionArchivePending(storage.getState(), { serverId: discoveredHome, sessionId: 'done' })).toBe(true);
            }
        } finally {
            await act(async () => {
                response.resolve(Response.json({ success: true, archivedAt: 42 }));
                await pending;
            });
            settledVisibleIds = visibleIds();
            await hook.unmount();
        }
        expect(storage.getState().sessionArchiveOperations).toEqual({});
        expect(settledVisibleIds ?? []).not.toContain('done');
        expect(settledVisibleIds ?? []).not.toContain('quiet');
    });

    it('holds attention membership only while the mounted interaction remains held', async () => {
        const { storage } = await import('@/sync/domains/state/storage');
        const requesting = completedSession(2, serverId);
        storage.getState().applySessions([{ ...requesting, viewer: currentViewer(3, 2, 3, 1),
            pendingPermissionRequestCount: 1, pendingRequestObservedAt: Date.now() }]);
        expect(storage.getState().ordinarySessionListMembershipByServerId[serverId]).toEqual(['done', 'quiet']);
        expect(storage.getState().sessionListIndexByServerId[serverId]?.filter((item) => item.type === 'session')
            .map((item) => item.sessionId)).toEqual(['done', 'quiet']);
        const { useVisibleSessionListViewState } = await import('./useVisibleSessionListViewState');
        const expectedIndex = [
            expect.objectContaining({ type: 'header', headerKind: 'attention' }),
            expect.objectContaining({ type: 'session', sessionId: 'done', groupKind: 'attention' }),
            expect.objectContaining({ type: 'header', headerKind: 'date' }),
            expect.objectContaining({ type: 'session', sessionId: 'quiet', groupKind: 'date' }),
        ];
        let options = { pathname: '/', attentionInteractionHeld: true };
        const hook = await renderHook(() => useVisibleSessionListViewState('all', options));
        await flushHookEffects();
        expect(hook.getCurrent()?.visibleSessionListIndex).toEqual(expectedIndex);

        storage.getState().applySessions([completedSession(3, serverId)]);
        await hook.rerender();
        await flushHookEffects();
        expect(hook.getCurrent()?.visibleSessionListIndex).toEqual(expectedIndex);
        await hook.rerender();
        expect(hook.getCurrent()?.visibleSessionListIndex).toEqual(expectedIndex);

        // P5-R04 holds the interaction, not ordinary clicked-row focus.
        // Releasing the held interaction applies its latest live membership once.
        options = { ...options, attentionInteractionHeld: false };
        await hook.rerender();
        expect(hook.getCurrent()?.visibleSessionListIndex).toEqual([
            expect.objectContaining({ type: 'header', headerKind: 'date' }),
            expect.objectContaining({ type: 'session', sessionId: 'done', groupKind: 'date' }),
            expect.objectContaining({ type: 'session', sessionId: 'quiet', groupKind: 'date' }),
        ]);
        await hook.unmount();
    });
});
