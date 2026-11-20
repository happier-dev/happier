import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApprovalRequestV1Schema} from '@happier-dev/protocol/approvals/approvalRequestV1';
import { buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { createGitScmCapabilities } from '@happier-dev/protocol/scm/capabilities';
import { ScmWorkingSnapshotSchema } from '@happier-dev/protocol/scm/workingSnapshot';
import { SessionAgentActivityHeadlineV1Schema } from '@happier-dev/protocol/sessions/work/agentActivity/agentActivityHeadlineV1';
import { SESSION_AWARENESS_RUNTIME_STALE_SIGNAL_MS } from '@happier-dev/protocol/sessions/awareness/runtime';
import { createSessionFixture, createTestSessionTranscriptSource, flushHookEffects,
    renderHookWithSessionTranscriptSource as renderHook, standardCleanup } from '@/dev/testkit';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { initializeRealAppRuntimeForTests } from '@/dev/testkit/harness/realAppRuntimeHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createHomeHubArtifactHttpBoundary } from '@/dev/testkit/harness/homeHubArtifactHttpBoundary';
import { createSessionMetadataHttpBoundary } from '@/dev/testkit/harness/sessionMetadataHttpBoundary';
import { createArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';
import { createMachineFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import type { Session } from '@/sync/domains/state/storageTypes';

vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('react-native', async () =>
    (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () =>
    (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () =>
    (await import('@/dev/testkit/mocks/text')).createTextModuleMock({ translate: key => key }));

installDisconnectedServerSocketBoundary();
await initializeRealAppRuntimeForTests();
const { storage } = await import('@/sync/domains/state/storage');
const { sync } = await import('@/sync/sync');
const { observeServerTimestamp } = await import('@/sync/runtime/time');
const { SESSION_LIST_RELATIVE_TIME_CLOCK_INTERVAL_MS } = await import('@/hooks/session/sessionListRuntimeClock');
const { useSessionSummaryModel } = await import('./useSessionSummaryModel');

let homes: Awaited<ReturnType<typeof serveAccountHomes>>;
let homeA: string;
let homeB: string;
let previousState = storage.getState();
let artifactStore: ReturnType<typeof createArtifactStoreBoundary>;

beforeEach(async () => {
    previousState = storage.getState();
    artifactStore = createArtifactStoreBoundary({ ownerAccountId: () => 'reader', encryptionMode: 'plain' });
    const http = createHomeHubArtifactHttpBoundary('reader', undefined, {
        machines: [createPlainMachineRowFixture({ id: 'machine-1', accountId: 'reader' })],
    });
    const sessionHttp = createSessionMetadataHttpBoundary(() => ({}));
    homes = await serveAccountHomes({ homes: [
        { key: 'a', serverUrl: 'https://summary-a.test', accountId: 'reader' },
        { key: 'b', serverUrl: 'https://summary-b.test', accountId: 'reader' },
    ], route: async ({ url, method, body }) => {
        return artifactStore.handle(url.pathname + url.search, {
            method, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }) ?? sessionHttp.handle(url) ?? http.request(url);
    } });
    homeA = homes.homes.a!.id;
    homeB = homes.homes.b!.id;
    storage.setState({ sessions: {}, sessionMessages: {}, artifacts: {}, workflowRunsById: {}, isDataReady: true });
    const machine = createMachineFixture({ id: 'machine-1', storageMode: 'plain', activeAt: Date.now() });
    // Exact workspace resolution consumes the owning Home's current inventory,
    // not a snapshot's display-only project key or another Home's machines.
    storage.setState({ machines: { [machine.id]: machine },
        machineListByServerId: { [homeA]: [machine], [homeB]: [machine] },
        machineListStatusByServerId: { [homeA]: 'idle', [homeB]: 'idle' } });
    observeServerTimestamp(Date.now());
});
afterEach(async () => {
    standardCleanup();
    vi.useRealTimers();
    await homes?.dispose();
    storage.setState(previousState, true);
    observeServerTimestamp(Date.now());
});

function session(serverId: string | undefined, overrides: Partial<Session> = {}) {
    return createSessionFixture({
        id: 'same-session-id', serverId, active: true, activeAt: Date.now(),
        metadata: { name: 'Shell session', path: '/summary', host: 'tester.local', machineId: 'machine-1' },
        ...overrides,
    });
}
function usage(usedTokens = 2_000): NonNullable<Session['latestUsage']> {
    return { inputTokens: usedTokens, outputTokens: 0, cacheCreation: 0, cacheRead: 0,
        contextSize: usedTokens, timestamp: 1_000,
        contextSnapshot: { v: 1, modelId: 'test-model', usedTokens, windowTokens: 8_000,
        totalProcessedTokens: null, baselineTokens: null, isAutoCompactEnabled: null, categories: null,
        observedAtMs: 1_000, source: 'provider_turn' }, contextSnapshotStale: true };
}
function approval(id: string, serverId: string): DecryptedArtifact {
    const body = ApprovalRequestV1Schema.parse({ v: 1, status: 'open', createdAtMs: 1, updatedAtMs: 1,
        createdBy: { surface: 'agent', sessionId: 'same-session-id' }, requestedSurface: 'agent',
        actionId: 'session.list', actionArgs: {}, summary: 'List sessions' });
    const header = buildApprovalRequestArtifactHeaderV1(body, { legacyServerId: serverId });
    return { id, header, title: header.title, sessions: [body.createdBy.sessionId!], body: JSON.stringify(body),
        headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1, isDecrypted: true };
}
async function publishApprovals(approvals: readonly DecryptedArtifact[]) {
    artifactStore.clear();
    for (const artifact of approvals) {
        if (!artifact.isDecrypted || !artifact.header || typeof artifact.body !== 'string') {
            throw new Error('Approval fixture requires an opened text body and header');
        }
        artifactStore.replaceStoredRow({ id: artifact.id, ownerAccountId: 'reader', access: 'owner', encryptionMode: 'plain',
            publicAudience: 'none', header: encodePlainArtifactStoredContent(artifact.header),
            body: encodePlainArtifactStoredContent({ body: artifact.body }), dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
            headerVersion: artifact.headerVersion, bodyVersion: artifact.bodyVersion,
            seq: artifact.seq, createdAt: artifact.createdAt, updatedAt: artifact.updatedAt });
    }
    // A real inventory owns removal; its batch read supplies the body and matching
    // HTTP custody needed to retain it across later header-only Sync refreshes.
    await sync.fetchArtifactsList();
}
function publishScm(serverId: string, branch: string) {
    const snapshot = ScmWorkingSnapshotSchema.parse({
        projectKey: serverId + ':/summary', fetchedAt: Date.now(),
        repo: { isRepo: true, rootPath: '/summary', backendId: 'git', mode: '.git' },
        capabilities: createGitScmCapabilities(),
        branch: { head: branch, upstream: null, ahead: 0, behind: 0, detached: false },
        hasConflicts: false, entries: [], totals: { includedFiles: 0, pendingFiles: 0, untrackedFiles: 0,
            includedAdded: 0, includedRemoved: 0, pendingAdded: 0, pendingRemoved: 0 },
    });
    storage.getState().updateWorkspaceScmSnapshot({ serverId, machineId: 'machine-1', rootPath: '/summary' }, snapshot);
}

describe('useSessionSummaryModel', () => {
    it('reads the live process-terminal fact for Stopped and returns to working after resume', async () => {
        const shellSession = session(homeA);
        const stopped = session(homeA, { active: false, presence: undefined,
            metadata: { ...shellSession.metadata!, lifecycleState: 'stopped' } });
        storage.setState({ sessions: { [shellSession.id]: stopped } });
        const hook = await renderHook(() => useSessionSummaryModel({ session: shellSession, serverId: homeA }));
        expect(hook.getCurrent().status).toMatchObject({ state: 'stopped', statusText: 'sessionWork.states.stopped' });
        await act(async () => storage.setState({ sessions: { [shellSession.id]: { ...stopped,
            metadata: { ...stopped.metadata!, lifecycleState: 'running' } } } }));
        expect(hook.getCurrent().status).toMatchObject({ state: 'disconnected', statusText: 'status.disconnected' });
        await act(async () => storage.setState({ sessions: { [shellSession.id]: session(homeA, {
            latestTurnStatus: 'in_progress', metadata: { ...stopped.metadata!, lifecycleState: 'running' },
        }) } }));
        expect(hook.getCurrent().status).toMatchObject({ state: 'thinking', statusText: 'status.working' });
        await hook.unmount();
    });

    it('reads waiting questions from its exact Home-bound transcript source', async () => {
        const row = session(homeA);
        const agentState = { requests: {
            question: { tool: 'AskUserQuestion', kind: 'user_action' as const, arguments: { questions: [] }, createdAt: 100 },
            permission: { tool: 'Bash', kind: 'permission' as const, arguments: { command: 'pwd' }, createdAt: 200 },
        } };
        const source = createTestSessionTranscriptSource({ sessionId: row.id, serverId: homeA, agentState });
        const hook = await renderHook(() => useSessionSummaryModel({ session: row }), { source });
        expect(hook.getCurrent().needsYou).toMatchObject({ request: { id: 'question' }, moreCount: 1 });
        await hook.rerender(undefined, createTestSessionTranscriptSource({ sessionId: row.id, serverId: homeB, agentState }));
        expect(hook.getCurrent().needsYou).toBeNull();
        await hook.unmount();
    });

    it('advances awareness freshness on the canonical shared clock while the Session object stays stable', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        observeServerTimestamp(1_000);
        // Thinking freshness is a presentation clock; online liveness is not.
        const row = session(homeA, { thinking: true, thinkingAt: 1_000 });
        const hook = await renderHook(() => useSessionSummaryModel({ session: row, serverId: homeA }));
        const before = hook.getCurrent().status;
        expect(hook.getCurrent().stale).toBe(false);
        await flushHookEffects({
            advanceTimersMs: SESSION_AWARENESS_RUNTIME_STALE_SIGNAL_MS + SESSION_LIST_RELATIVE_TIME_CLOCK_INTERVAL_MS,
            cycles: 1, turns: 2,
        });
        expect(hook.getCurrent().status).not.toEqual(before);
        await hook.unmount();
    });

    it('projects awareness from the live Session row, not the stabilised shell object', async () => {
        const shellSession = session(homeA, { activeAt: Date.now() - SESSION_AWARENESS_RUNTIME_STALE_SIGNAL_MS - 1 });
        storage.setState({ sessions: { [shellSession.id]: session(homeA, {
            metadata: { ...shellSession.metadata!, name: 'Live session',
                sessionWorkStateV1: { v: 1, backendId: 'claude', updatedAt: 1, items: [
                    { id: 'step', kind: 'todo', origin: 'vendor', title: 'Check live state', status: 'active', updatedAt: 1 },
                ] },
            },
        }) } });
        const hook = await renderHook(() => useSessionSummaryModel({ session: shellSession, serverId: homeA }));
        expect(hook.getCurrent()).toMatchObject({ title: 'Live session', stale: false, statusProgress: { done: 0, total: 1 } });
        // Observe a real row-only update while the stabilised shell reference never changes.
        await act(async () => storage.setState({ sessions: { [shellSession.id]: session(homeA, {
            metadata: { ...shellSession.metadata!, name: 'Updated live session' },
            activeAt: shellSession.activeAt,
        }) } }));
        // Online liveness is the server transition: presence age never makes it stale.
        expect(hook.getCurrent()).toMatchObject({ title: 'Updated live session', stale: false, plan: null });
        await act(async () => storage.setState({ sessions: { [shellSession.id]: session(homeB, {
            metadata: { ...shellSession.metadata!, name: 'Other Home session' },
        }) } }));
        expect(hook.getCurrent()).toMatchObject({ title: 'Shell session', stale: false });
        await hook.unmount();
    });

    it('does not borrow an unqualified same-id live row for a different Home', async () => {
        const shellSession = session(undefined);
        storage.setState({ sessions: { [shellSession.id]: session(undefined, {
            metadata: { ...shellSession.metadata!, name: 'Unqualified live session' },
        }) } });
        // Home B is focused; an undeclared live carrier cannot belong to inactive Home A.
        const hook = await renderHook(() => useSessionSummaryModel({ session: shellSession, serverId: homeA }));
        expect(hook.getCurrent().title).toBe('Shell session');
        await hook.unmount();
    });

    it('selects approvals by the exact Home-qualified Session identity', async () => {
        const row = session(homeB);
        const a = approval('approval-a', homeA);
        const b = approval('approval-b', homeB);
        storage.setState({ sessions: { [row.id]: row } });
        await publishApprovals([a, b]);
        const hook = await renderHook(() => useSessionSummaryModel({ session: row, serverId: homeB }));
        expect(hook.getCurrent().rows.find(row => row.kind === 'approvals')).toEqual({
            kind: 'approvals', count: 1, destination: 'approvals',
        });
        await act(async () => publishApprovals([a]));
        expect(hook.getCurrent().rows.some(row => row.kind === 'approvals')).toBe(false);
        await hook.unmount();
    });

    it('uses the Session-owned Home when the route has not supplied a duplicate scope', async () => {
        const row = session(homeB, { latestUsage: usage() });
        const other = session(homeA, { latestUsage: usage(7_000) });
        const a = approval('approval-a', homeA);
        const b = approval('approval-b', homeB);
        storage.setState({ sessions: { [row.id]: row } });
        await publishApprovals([a, b]);
        publishScm(homeA, 'home-a-branch');
        publishScm(homeB, 'home-b-branch');
        const hook = await renderHook(() => useSessionSummaryModel({ session: row }));
        expect(hook.getCurrent().rows).toEqual(expect.arrayContaining([
            { kind: 'approvals', count: 1, destination: 'approvals' },
            expect.objectContaining({ kind: 'workspace', branch: 'home-b-branch' }),
            { kind: 'usage', tokens: 2_000, contextPercent: 25, stale: true, destination: 'usage' },
        ]));
        await act(async () => storage.setState({ sessions: { [row.id]: other } }));
        expect(hook.getCurrent().rows.find(row => row.kind === 'usage')).toMatchObject({ tokens: 2_000 });
        await hook.unmount();
    });

    it('refuses a route Home that conflicts with the Session-owned Home', async () => {
        const row = session(homeA);
        const hook = await renderHook(() => useSessionSummaryModel({ session: row, serverId: homeB }));
        expect(hook.getCurrent()).toMatchObject({ scope: 'realm_unavailable', title: null, rows: [] });
        await hook.unmount();
    });

    it('fails closed instead of borrowing same-id facts from the active Home when no Home can be proven', async () => {
        const row = session(undefined);
        const active = session(homeA, { latestUsage: usage(7_000) });
        const a = approval('approval-a', homeA);
        storage.setState({ sessions: { [row.id]: active }, artifacts: { [a.id]: a } });
        const hook = await renderHook(() => useSessionSummaryModel({ session: row }));
        expect(hook.getCurrent()).toMatchObject({ scope: 'realm_unavailable', title: null, agentLabel: null, rows: [] });
        await hook.unmount();
    });

    it('composes the canonical Agent-activity count without fetching workflow details', async () => {
        const now = Date.now();
        const headline = SessionAgentActivityHeadlineV1Schema.parse({
            v: 1, backendId: 'claude', updatedAt: now,
            activeEntries: [
                { entryId: 'activity-1', kind: 'workflow_agent', title: 'Reviewing access', status: 'running', updatedAt: now },
                { entryId: 'activity-2', kind: 'workflow_agent', title: 'Checking scope', status: 'running', updatedAt: now - 1 },
            ],
            recentEntries: [{ entryId: 'activity-3', kind: 'workflow_agent', title: 'Finished review', status: 'succeeded', updatedAt: now - 2 }],
        });
        const row = session(homeA);
        row.metadata = { ...row.metadata!, sessionAgentActivityHeadlineV1: headline };
        // System Record/Workflow details remain absent; the real headline owns the cold count.
        const hook = await renderHook(() => useSessionSummaryModel({ session: row, serverId: homeA }));
        expect(hook.getCurrent().rows.find(row => row.kind === 'activity')).toEqual({
            kind: 'activity', liveCount: 2, totalCount: 3, title: 'Reviewing access',
            statusLabel: 'sessionAgentActivity.status.running', destination: 'workTab',
        });
        expect(storage.getState().workflowRunsById).toEqual({});
        expect(homes.httpRequests.filter(request => request.url.searchParams.get('kind') === 'workflow_run.v1'
            || request.body && typeof request.body === 'object' && Reflect.get(request.body, 'actionId') === 'workflow.run.get'))
            .toHaveLength(0);
        await hook.unmount();
    });

    it('keeps the last-known context percentage when the canonical usage snapshot is stale', async () => {
        const row = session(homeA, { latestUsage: usage() });
        const hook = await renderHook(() => useSessionSummaryModel({ session: row, serverId: homeA }));
        expect(hook.getCurrent().rows.find(row => row.kind === 'usage')).toEqual({
            kind: 'usage', tokens: 2_000, contextPercent: 25, stale: true, destination: 'usage',
        });
        await hook.unmount();
    });
});
