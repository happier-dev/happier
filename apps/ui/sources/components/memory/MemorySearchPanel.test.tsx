import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { MemoryDocumentSearchCoverageV1, MemorySearchResultHitV1 } from '@happier-dev/protocol/memory/memorySearch';

import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { createDeferred } from '@/dev/testkit';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createPlainSessionCurrentProjectionRecordFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { createRpcCallError } from '@/sync/runtime/rpcErrors';
import { setScreenSharingPrivacyActive } from '@/desktop/capture/useNativeRecordingActive';
import { buildSessionOrganizationSessionKey } from '@/sync/domains/session/organization/keys';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';

const machineRpc = vi.hoisted(() => vi.fn());
const settingsPush = vi.hoisted(() => vi.fn());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: machineRpc }));
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ router: { push: settingsPush } }).module;
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string, options?: Record<string, unknown>) =>
        key === 'memoryContext.memory.factCount' ? `${options?.count} facts`
            : key === 'memoryContext.memory.searchUnavailableOn' || key === 'memoryContext.memory.searchFailedOn'
                || key === 'memoryContext.memory.searchIndexMissingOn' || key === 'memoryContext.memory.documentSearchUnavailableOn'
                || key === 'memoryContext.memory.projectSearchUnsupported'
                ? `${key}:${options?.machine}`
                : key === 'memoryContext.memory.noResultsInProject' ? `${key}:${options?.project}` : key });
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

const homes = createHomeGovernanceHarness();
installDisconnectedServerSocketBoundary();
installHomeGovernanceBoundaries(homes);
const { createMachineAdministrationFixture } = await import('@/dev/testkit/fixtures/machineAdministrationFixture');
await loadSyncSingletonForTests();
const { sync } = await import('@/sync/sync');
const { storage } = await import('@/sync/domains/state/storage');
const { MemorySearchPanel, useMemorySearchPanelModel } = await import('./MemorySearchPanel');
const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
const { ProjectContextBody } = await import('@/components/projects/context/ProjectContextBody');
const { useMemoryDocument } = await import('./useMemoryDocument');
const { useMemoryDocumentSummary } = await import('./useMemoryDocumentSummary');
const { MemoryDocumentBody } = await import('./MemoryDocumentBody');
const { MemoryDocumentScreen } = await import('./MemoryDocumentScreen');
const { ContextMemorySection } = await import('@/components/settings/prompts/context/ContextMemorySection');
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
let administration: Awaited<ReturnType<typeof createMachineAdministrationFixture>>;
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
let webLocks: ReturnType<typeof installWebLockManagerMock>;
let caseSignal: AbortSignal;
const baseline = storage.getState();
const transcript: MemorySearchResultHitV1 = {
    sessionId: 'past-session', seqFrom: 1, seqTo: 2, createdAtFromMs: 1, createdAtToMs: 2,
    summary: 'Matching past conversation', score: 0.5,
};
const document: MemorySearchResultHitV1 = {
    type: 'artifact', ref: { kind: 'doc', serverId: 'server-a', artifactId: 'memory-doc' },
    revision: { headerVersion: 1, bodyVersion: 2 }, location: { type: 'topic', title: 'Archive' },
    factId: 'fact-1', summary: 'Matching archived fact', score: 0.8,
};
const status = {
    v: 1, enabled: true, indexMode: 'deep', hintsIndexReady: false, deepIndexReady: true, activeIndexReady: true,
    embeddingsEnabled: false, embeddingsMode: 'disabled', embeddingsPresetId: null, embeddingsProviderKind: null,
    embeddingsModelId: null, embeddingsRuntimeState: 'unavailable', embeddingsUsingFallback: false,
    tier1DbPath: null, deepDbPath: '/memory/deep.sqlite', tier1DbBytes: null, deepDbBytes: 1,
};

beforeEach(async ({ signal }) => {
    caseSignal = signal;
    webLocks = installWebLockManagerMock();
    await homes.reset();
    storage.setState(baseline, true);
    administration = await createMachineAdministrationFixture('memory.settings');
    const machine = storage.getState().machineListByServerId[administration.serverIds[0]!]![0]!;
    await homes.addHome({ name: 'Memory Home', serverUrl: 'https://prompt-administration-1.example.test',
        serverIdentityId: 'srv_prompt_administration_1', accountId: 'account-a' });
    homes.answer(administration.serverIds[0]!, '/v1/account/encryption/currentness', {
        body: createPlainAccountEncryptionCurrentnessFixture(),
    });
    homes.answer(administration.serverIds[0]!, `/v2/sessions/${transcript.sessionId}?accessProjectionVersion=1`, {
        body: { session: createPlainSessionCurrentProjectionRecordFixture({ id: transcript.sessionId, seq: transcript.seqTo }) },
    });
    homes.answer(administration.serverIds[0]!, '/v1/machines', {
        body: [createPlainMachineRowFixture({ id: machine.id, accountId: 'account-a' })],
    });
    connection = await restoreServerAccountForTest({ serverUrl: 'https://prompt-administration-1.example.test',
        accountId: 'account-a', request: homes.request });
    installHomeGovernanceBoundaries(homes);
    storage.setState({ isDataReady: true, machines: { [machine.id]: machine },
        settings: { ...storage.getState().settings,
            machineAdministrationTargetsLocalV1: { 'memory.settings': administration.targets[0]! } },
    });
    storage.getState().activateProfileScope({ serverId: administration.serverIds[0]!, accountId: 'account-a' });
    await sync.refreshMachines();
});
afterEach(async () => {
    setScreenSharingPrivacyActive(false);
    standardCleanup();
    await connection?.dispose();
    connection = null;
    const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
    await serverScopedRpcSocketPool.stopAll();
    await administration.cleanup();
    await homes.reset();
    machineRpc.mockReset();
    settingsPush.mockClear();
    webLocks.restore();
});

/** Two usable machines and no choice: a sole machine would be initialised as the selection by its owner, which is not "none chosen". */
async function clearMemoryMachineChoice(serverId: string) {
    const first = storage.getState().machines[administration.targets[0]!.machineId]!;
    const second = { ...first, id: 'machine-extra', metadata: { ...first.metadata!, displayName: 'Desktop', host: 'desktop.local' } };
    homes.answer(serverId, '/v1/machines', { body: [first.id, second.id].map(id => createPlainMachineRowFixture({ id, accountId: 'account-a' })) });
    storage.setState(state => ({
        machines: { ...state.machines, [second.id]: second },
        machineListByServerId: { ...state.machineListByServerId, [serverId]: [first, second] },
        settings: { ...state.settings, machineAdministrationTargetsLocalV1: {} },
    }));
    await sync.refreshMachines();
}

async function search(coverage: MemoryDocumentSearchCoverageV1 | null, hits: readonly MemorySearchResultHitV1[], query = 'fact') {
    machineRpc.mockImplementation(async (request: Readonly<{ method: string }>) => request.method === RPC_METHODS.DAEMON_MEMORY_STATUS
        ? { ...status, ...(coverage ? { documentSearchSupported: true } : {}) }
        : { v: 1, ok: true, hits, ...(coverage ? { documents: coverage } : {}) });
    const screen = await renderScreen(<InjectedAuthProvider credentials={connection!.credentials}>
        <MemorySearchPanel testID="search" serverId={administration.serverIds[0]!} />
    </InjectedAuthProvider>);
    await flushHookEffects();
    await waitForHomeGovernance(async () => {
        caseSignal.throwIfAborted();
        await flushHookEffects();
        expect(screen.findByTestId('search.input')?.props.editable).toBe(true);
    });
    await act(async () => screen.findByTestId('search.input')!.props.onChangeText(query));
    await act(async () => {
        await vi.waitFor(() => expect(machineRpc.mock.calls.some(([request]) => request.method === RPC_METHODS.DAEMON_MEMORY_SEARCH)).toBe(true));
    });
    await flushHookEffects();
    return screen;
}

it('omits recording-private Session hits and restores them when sharing ends', async () => {
    const serverId = administration.serverIds[0]!;
    const screen = await search({ state: 'ready' }, [document, transcript]);
    expect(screen.findByTestId('search.session.0')).not.toBeNull();
    // Let Account/bootstrap reads settle before the person's deliberate privacy preference.
    await act(async () => {
        storage.setState({ settings: { ...storage.getState().settings, sessionListHiddenTagIdsWhileRecording: { [serverId]: ['private'] } },
        sessionOrganizationTagAssignmentsBySessionKey: {
            [buildSessionOrganizationSessionKey(resolveServerProfileScopeIdForIdentifier(serverId), transcript.sessionId)]: { sessionId: transcript.sessionId, tagIds: ['private'] },
        } });
        setScreenSharingPrivacyActive(true);
    });
    const { readSessionRecordingVisibility } = await import('@/sync/store/sessionRecordingVisibility');
    expect(readSessionRecordingVisibility()({ serverId, sessionId: transcript.sessionId })).toBe(false);
    expect(screen.findByTestId('search.remembered.0')).not.toBeNull();
    expect(screen.findByTestId('search.session.0')).toBeNull();
    await act(async () => setScreenSharingPrivacyActive(false));
    expect(screen.findByTestId('search.session.0')).not.toBeNull();
});

describe('MemorySearchPanel corpus coverage', () => {
    it.each(['project', 'global'] as const)('shows only Action-admitted Session ranges in %s search', async scopeType => {
        const serverId = administration.serverIds[0]!;
        const scope = scopeType === 'project'
            ? { type: 'project' as const, projectRef: { serverId, projectKey: 'payments' } }
            : { type: 'global' as const };
        const readable = { ...transcript, sessionId: 'readable-session', summary: 'Admitted Session match' };
        const revoked = { ...transcript, sessionId: 'revoked-session', summary: 'Revoked Session match' };
        const beyondFrontier = { ...readable, seqFrom: 3, seqTo: 4, summary: 'Hidden newer Session match' };
        const row = createPlainSessionCurrentProjectionRecordFixture({ id: readable.sessionId, seq: 2 });
        homes.answer(serverId, `/v2/sessions/${readable.sessionId}?accessProjectionVersion=1`, { body: { session: row } });
        homes.answer(serverId, `/v2/sessions/${revoked.sessionId}?accessProjectionVersion=1`, { status: 403, body: { error: 'forbidden' } });
        machineRpc.mockImplementation(async (request: Readonly<{ method: string }>) => request.method === RPC_METHODS.DAEMON_MEMORY_STATUS
            ? { ...status, documentSearchSupported: true, projectSearchSupported: true }
            : { v: 1, ok: true, hits: [document, revoked, beyondFrontier, readable], documents: { state: 'ready' } });
        // Compare the rendered consumer with the real Action; only HTTP and daemon transport are replaced.
        const admitted = await createDefaultActionExecutor().execute('memory.search', {
            machineId: administration.targets[0]!.machineId,
            query: { v: 1, query: 'fact', scope, mode: 'auto', corpora: ['documents', 'sessions'] },
        }, { serverId: administration.targets[0]!.serverIdentityId, surface: 'ui', authority: 'present_user', expectedAccountId: 'account-a', signal: caseSignal });
        expect(admitted, JSON.stringify(admitted)).toMatchObject({ ok: true, result: { hits: [document, readable] } });
        machineRpc.mockClear();
        const requestStart = homes.requests.length;
        const screen = await renderScreen(<InjectedAuthProvider credentials={connection!.credentials}>
            <MemorySearchPanel testID="admitted-search" serverId={serverId} scope={scope} />
        </InjectedAuthProvider>);
        await waitForHomeGovernance(async () => {
            caseSignal.throwIfAborted();
            await flushHookEffects();
            expect(screen.findByTestId('admitted-search.input')?.props.editable).toBe(true);
        });
        await act(async () => screen.findByTestId('admitted-search.input')!.props.onChangeText('fact'));
        await vi.waitFor(async () => {
            await flushHookEffects();
            expect(screen.getTextContent()).toContain(readable.summary);
        });
        expect(screen.getTextContent()).toContain(document.summary);
        expect(screen.getTextContent()).not.toContain(revoked.summary);
        expect(screen.getTextContent()).not.toContain(beyondFrontier.summary);
        // Several ranges from one Session share its one current visibility read.
        const sessionReads = homes.requests.slice(requestStart).filter(request =>
            request.path === `/v2/sessions/${readable.sessionId}?accessProjectionVersion=1`
            || request.path === `/v2/sessions/${revoked.sessionId}?accessProjectionVersion=1`);
        expect(sessionReads.map(request => request.path).sort()).toEqual([
            `/v2/sessions/${readable.sessionId}?accessProjectionVersion=1`,
            `/v2/sessions/${revoked.sessionId}?accessProjectionVersion=1`,
        ]);
    });
    it.each(['A', '猫'])('searches the admitted one-character query %s', async query => {
        const screen = await search({ state: 'ready' }, [document], query);
        expect(machineRpc.mock.calls.find(([request]) => request.method === RPC_METHODS.DAEMON_MEMORY_SEARCH)?.[0].payload)
            .toMatchObject({ query });
        expect(screen.findByTestId('search.remembered.0')).not.toBeNull();
    });
    it('keeps empty queries idle, debounces and cancels superseded reads, and shows pending searches while retaining hits', async () => {
        const pending = createDeferred<unknown>();
        const nextPending = createDeferred<unknown>();
        machineRpc.mockImplementation(async (request: Readonly<{ method: string; payload?: { query?: string } }>) => {
            if (request.method === RPC_METHODS.DAEMON_MEMORY_STATUS) return { ...status, documentSearchSupported: true };
            if (request.payload?.query === 'A') return pending.promise;
            if (request.payload?.query === 'B') return nextPending.promise;
            return { v: 1, ok: true, hits: [document], documents: { state: 'ready' } };
        });
        const screen = await renderScreen(<InjectedAuthProvider credentials={connection!.credentials}>
            <MemorySearchPanel testID="pending-search" serverId={administration.serverIds[0]!} />
        </InjectedAuthProvider>);
        await waitForHomeGovernance(async () => {
            caseSignal.throwIfAborted();
            await flushHookEffects();
            expect(screen.findByTestId('pending-search.input')?.props.editable).toBe(true);
        });
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        try {
            await act(async () => screen.findByTestId('pending-search.input')!.props.onChangeText(' '));
            await act(async () => { await vi.advanceTimersByTimeAsync(250); });
            expect(machineRpc).not.toHaveBeenCalled();
            await act(async () => screen.findByTestId('pending-search.input')!.props.onChangeText('A'));
            await act(async () => { await vi.advanceTimersByTimeAsync(249); });
            expect(machineRpc).not.toHaveBeenCalled();
            await act(async () => { await vi.advanceTimersByTimeAsync(1); });
            await vi.waitFor(async () => {
                await flushHookEffects();
                expect(machineRpc.mock.calls.some(([request]) => request.method === RPC_METHODS.DAEMON_MEMORY_SEARCH)).toBe(true);
            });
            const first = machineRpc.mock.calls.find(([request]) => request.method === RPC_METHODS.DAEMON_MEMORY_SEARCH)?.[0];
            expect(first?.payload).toMatchObject({ query: 'A' });
            expect(screen.getTextContent()).toContain('universalSearch.searchingGroup');
            expect(screen.getTextContent()).not.toContain('memoryContext.memory.resultCount');
            expect(screen.findByTestId('pending-search.empty')).toBeNull();
            await act(async () => screen.findByTestId('pending-search.input')!.props.onChangeText('猫'));
            expect(first.signal.aborted).toBe(true);
            await act(async () => pending.resolve({ v: 1, ok: true, hits: [], documents: { state: 'ready' } }));
            await act(async () => { await vi.advanceTimersByTimeAsync(250); });
            await vi.waitFor(async () => {
                await flushHookEffects();
                expect(screen.findByTestId('pending-search.remembered.0')).not.toBeNull();
            });
            expect(screen.getTextContent()).toContain('memoryContext.memory.resultCount');
            expect(screen.getTextContent()).not.toContain('universalSearch.searchingGroup');
            await act(async () => screen.findByTestId('pending-search.input')!.props.onChangeText('B'));
            await act(async () => { await vi.advanceTimersByTimeAsync(250); });
            await vi.waitFor(async () => {
                await flushHookEffects();
                expect(machineRpc.mock.calls.some(([request]) => request.payload?.query === 'B')).toBe(true);
            });
            expect(screen.findByTestId('pending-search.remembered.0')).not.toBeNull();
            expect(screen.getTextContent()).toContain('universalSearch.searchingGroup');
            expect(screen.getTextContent()).not.toContain('memoryContext.memory.resultCount');
            await act(async () => nextPending.resolve({ v: 1, ok: true, hits: [], documents: { state: 'ready' } }));
            expect(screen.findByTestId('pending-search.remembered.0')).toBeNull();
            expect(screen.findByTestId('pending-search.empty')).not.toBeNull();
            expect(screen.getTextContent()).toContain('memoryContext.memory.resultCount');
            expect(screen.getTextContent()).not.toContain('universalSearch.searchingGroup');
        } finally {
            vi.useRealTimers();
            pending.resolve({ v: 1, ok: true, hits: [] });
            nextPending.resolve({ v: 1, ok: true, hits: [] });
            await act(async () => screen.unmount());
        }
    });
    it.each([false, true])('searches only the qualified Project through its Context entry (Source read-only: %s)', async (sourceReadOnly) => {
        const serverId = administration.serverIds[0]!;
        const projectRef = { serverId, projectKey: 'payments' };
        const workspaceRef = { id: 'payments-checkout', ...projectRef, machineId: administration.targets[0]!.machineId,
            rootPath: '/repo/payments', createdAtMs: 1,
            ...(sourceReadOnly ? { source: { sourceId: 'team-source', revision: 1 } } : {}) };
        const accountScope = { serverId, accountId: 'account-a' };
        storage.getState().activateProjectAccountRowsScope(accountScope);
        storage.getState().applyProjectAccountRowsForScope(accountScope, { scope: accountScope, status: 'ready', coverage: 'complete',
            workspaceRefs: [workspaceRef], relationships: [], organizations: [], revisionsByPhysicalKey: {} });
        const projectHit = { ...document, ref: { kind: 'doc', serverId, artifactId: 'payments-memory' }, summary: 'Payments fact', score: 0.5 };
        const otherHit = { ...document, summary: 'Unrelated higher-ranked Project fact', score: 1 };
        machineRpc.mockImplementation(async (request: Readonly<{ method: string; payload: { scope?: unknown } }>) =>
            request.method === RPC_METHODS.DAEMON_MEMORY_STATUS
                ? { ...status, projectSearchSupported: true, documentSearchSupported: true }
                : { v: 1, ok: true, documents: { state: 'ready' }, project: { state: 'ready' },
                    hits: JSON.stringify(request.payload.scope) === JSON.stringify({ type: 'project', projectRef })
                        ? [projectHit] : [otherHit, projectHit] });
        const screen = await renderScreen(<InjectedAuthProvider credentials={connection!.credentials}>
            <ProjectContextBody workspaceRef={workspaceRef} />
        </InjectedAuthProvider>);
        if (sourceReadOnly) expect(screen.findByTestId('project-context.memory.remember')).toBeNull();
        await screen.pressByTestIdAsync('project-context.memory.search');
        const input = 'project-context.memory.searchPanel.input';
        await act(async () => { await vi.waitFor(() => expect(screen.findByTestId(input)?.props.editable).toBe(true)); });
        await act(async () => screen.findByTestId(input)!.props.onChangeText('fact'));
        await act(async () => { await vi.waitFor(() => expect(machineRpc.mock.calls.some(([request]) =>
            request.method === RPC_METHODS.DAEMON_MEMORY_SEARCH)).toBe(true)); });
        await flushHookEffects();
        expect(machineRpc.mock.calls.find(([request]) => request.method === RPC_METHODS.DAEMON_MEMORY_SEARCH)?.[0].payload)
            .toMatchObject({ scope: { type: 'project', projectRef } });
        expect(screen.getTextContent()).toContain(projectHit.summary);
        expect(screen.getTextContent()).not.toContain(otherHit.summary);
    });
    it('says a Project search found nothing in that Project and widens only when the person chooses Search everything', async () => {
        const serverId = administration.serverIds[0]!;
        const projectRef = { serverId, projectKey: 'payments' };
        const workspaceRef = { id: 'payments-checkout', ...projectRef, machineId: administration.targets[0]!.machineId,
            rootPath: '/repo/payments', createdAtMs: 1 };
        const accountScope = { serverId, accountId: 'account-a' };
        storage.getState().activateProjectAccountRowsScope(accountScope);
        storage.getState().applyProjectAccountRowsForScope(accountScope, { scope: accountScope, status: 'ready', coverage: 'complete',
            workspaceRefs: [workspaceRef], relationships: [], organizations: [], revisionsByPhysicalKey: {} });
        const elsewhere = { ...document, summary: 'Fact from another Project', score: 1 };
        const searchScopes = () => machineRpc.mock.calls.filter(([request]) => request.method === RPC_METHODS.DAEMON_MEMORY_SEARCH)
            .map(([request]) => (request.payload as { scope?: unknown }).scope);
        machineRpc.mockImplementation(async (request: Readonly<{ method: string; payload: { scope?: { type: string } } }>) =>
            request.method === RPC_METHODS.DAEMON_MEMORY_STATUS
                ? { ...status, projectSearchSupported: true, documentSearchSupported: true }
                : { v: 1, ok: true, documents: { state: 'ready' }, project: { state: 'ready' },
                    hits: request.payload.scope?.type === 'global' ? [elsewhere] : [] });
        const screen = await renderScreen(<InjectedAuthProvider credentials={connection!.credentials}>
            <ProjectContextBody workspaceRef={workspaceRef} />
        </InjectedAuthProvider>);
        await screen.pressByTestIdAsync('project-context.memory.search');
        const panel = 'project-context.memory.searchPanel';
        await act(async () => { await vi.waitFor(() => expect(screen.findByTestId(`${panel}.input`)?.props.editable).toBe(true)); });
        await act(async () => screen.findByTestId(`${panel}.input`)!.props.onChangeText('refunds'));
        await vi.waitFor(async () => {
            await flushHookEffects();
            expect(screen.findByTestId(`${panel}.empty`)).not.toBeNull();
        });
        // A zero result names the Project it searched; nothing was searched beyond it.
        expect(screen.getTextContent()).toContain('memoryContext.memory.noResultsInProject:payments');
        expect(screen.getTextContent()).not.toContain(elsewhere.summary);
        expect(searchScopes()).toEqual([{ type: 'project', projectRef }]);
        await screen.pressByTestIdAsync(`${panel}.empty-action`);
        await vi.waitFor(async () => {
            await flushHookEffects();
            expect(screen.getTextContent()).toContain(elsewhere.summary);
        });
        expect(searchScopes()).toEqual([{ type: 'project', projectRef }, { type: 'global' }]);
        expect(screen.findByTestId(`${panel}.widened`)).not.toBeNull();
    });
    it('retains the typed unsupported cause and qualified Machine in the consumed model, clearing it after repair', async () => {
        const serverId = administration.serverIds[0]!;
        const scope = { type: 'project' as const, projectRef: { serverId, projectKey: 'payments' } };
        machineRpc.mockResolvedValue(status);
        const hook = await renderHook(() => useMemorySearchPanelModel({ serverId, scope }), {
            wrapper: ({ children }) => <InjectedAuthProvider credentials={connection!.credentials}>{children}</InjectedAuthProvider>,
        });
        await act(async () => hook.getCurrent().setQuery('fact'));
        await act(async () => { await vi.waitFor(() => expect(machineRpc.mock.calls.some(([request]) =>
            request.method === RPC_METHODS.DAEMON_MEMORY_STATUS)).toBe(true)); });
        await flushHookEffects();
        expect(hook.getCurrent().results?.failure).toMatchObject({
            error: { ok: false, errorCode: 'memory_project_scope_unsupported' },
            target: { serverId: administration.targets[0]!.serverIdentityId, machineId: administration.targets[0]!.machineId },
        });
        expect(machineRpc.mock.calls.some(([request]) => request.method === RPC_METHODS.DAEMON_MEMORY_SEARCH)).toBe(false);
        machineRpc.mockImplementation(async (request: Readonly<{ method: string }>) => request.method === RPC_METHODS.DAEMON_MEMORY_STATUS
            ? { ...status, projectSearchSupported: true, documentSearchSupported: true }
            : { v: 1, ok: true, hits: [document], project: { state: 'ready' }, documents: { state: 'ready' } });
        await act(async () => hook.getCurrent().retry());
        await act(async () => { await vi.waitFor(() => expect(machineRpc.mock.calls.some(([request]) =>
            request.method === RPC_METHODS.DAEMON_MEMORY_SEARCH)).toBe(true)); });
        await flushHookEffects();
        expect(hook.getCurrent().results?.failure).toBeNull();
        expect(hook.getCurrent().results?.documents).toHaveLength(1);
    });
    it('reports unsupported Project search distinctly instead of generic coverage, offline or no matches', async () => {
        const serverId = administration.serverIds[0]!;
        machineRpc.mockResolvedValue(status);
        const screen = await renderScreen(<InjectedAuthProvider credentials={connection!.credentials}>
            <MemorySearchPanel testID="unsupported-project" serverId={serverId}
                scope={{ type: 'project', projectRef: { serverId, projectKey: 'payments' } }} />
        </InjectedAuthProvider>);
        await act(async () => { await vi.waitFor(() => expect(screen.findByTestId('unsupported-project.input')?.props.editable).toBe(true)); });
        await act(async () => screen.findByTestId('unsupported-project.input')!.props.onChangeText('fact'));
        await act(async () => { await vi.waitFor(() => expect(machineRpc.mock.calls.some(([request]) =>
            request.method === RPC_METHODS.DAEMON_MEMORY_STATUS)).toBe(true)); });
        await vi.waitFor(async () => {
            await flushHookEffects();
            expect(screen.findByTestId('unsupported-project.projectUnsupported')).not.toBeNull();
        });
        expect(screen.findByTestId('unsupported-project.documentsCoverage')).toBeNull();
        expect(screen.findByTestId('unsupported-project.failed')).toBeNull();
        expect(screen.findByTestId('unsupported-project.empty')).toBeNull();
        expect(machineRpc.mock.calls.some(([request]) => request.method === RPC_METHODS.DAEMON_MEMORY_SEARCH)).toBe(false);
    });
    describe('names the selected Machine and the known cause of a failed search', () => {
        async function failedSearch(answer: () => Promise<unknown>) {
            machineRpc.mockImplementation(async (request: Readonly<{ method: string }>) => request.method === RPC_METHODS.DAEMON_MEMORY_STATUS
                ? { ...status, documentSearchSupported: true }
                : await answer());
            const screen = await renderScreen(<InjectedAuthProvider credentials={connection!.credentials}>
                <MemorySearchPanel testID="failure" serverId={administration.serverIds[0]!} />
            </InjectedAuthProvider>);
            await waitForHomeGovernance(async () => {
                caseSignal.throwIfAborted();
                await flushHookEffects();
                expect(screen.findByTestId('failure.input')?.props.editable).toBe(true);
            });
            await act(async () => screen.findByTestId('failure.input')!.props.onChangeText('fact'));
            await act(async () => { await vi.waitFor(() => expect(machineRpc.mock.calls.some(([request]) =>
                request.method === RPC_METHODS.DAEMON_MEMORY_SEARCH)).toBe(true)); });
            await flushHookEffects();
            const machine = storage.getState().machines[administration.targets[0]!.machineId]!;
            return { screen, machineName: machine.metadata?.displayName ?? machine.metadata?.host };
        }
        const searchCalls = () => machineRpc.mock.calls.filter(([request]) => request.method === RPC_METHODS.DAEMON_MEMORY_SEARCH).length;

        it('leads a search turned off after selection to the setting, never to a Retry that cannot repair it', async () => {
            const { screen, machineName } = await failedSearch(async () =>
                ({ v: 1, ok: false, errorCode: 'memory_disabled', error: 'memory_disabled' }));
            await vi.waitFor(async () => { await flushHookEffects(); expect(screen.findByTestId('failure.unavailable')).not.toBeNull(); });
            expect(screen.getTextContent()).toContain(`memoryContext.memory.searchUnavailableOn:${machineName}`);
            expect(screen.findByTestId('failure.failed')).toBeNull();
            expect(screen.findByTestId('failure.failed-action')).toBeNull();
            await screen.pressByTestIdAsync('failure.unavailable-action');
            expect(settingsPush).toHaveBeenCalledWith((await import('@/components/settings/catalog/routes')).SETTINGS_ROUTES.search);
        });
        it('says the Machine has not built its memory index yet, and Retry asks again', async () => {
            const { screen, machineName } = await failedSearch(async () =>
                ({ v: 1, ok: false, errorCode: 'memory_index_missing', error: 'memory_index_missing' }));
            await vi.waitFor(async () => { await flushHookEffects(); expect(screen.findByTestId('failure.indexMissing')).not.toBeNull(); });
            expect(screen.getTextContent()).toContain(`memoryContext.memory.searchIndexMissingOn:${machineName}`);
            expect(screen.findByTestId('failure.failed')).toBeNull();
            const before = searchCalls();
            await screen.pressByTestIdAsync('failure.indexMissing-action');
            await act(async () => { await vi.waitFor(() => expect(searchCalls()).toBeGreaterThan(before)); });
        });
        it('keeps a generic Retry, naming the Machine, for a failure with no known cause', async () => {
            const { screen, machineName } = await failedSearch(async () => { throw new Error('socket closed'); });
            await vi.waitFor(async () => { await flushHookEffects(); expect(screen.findByTestId('failure.failed')).not.toBeNull(); });
            expect(screen.getTextContent()).toContain(`memoryContext.memory.searchFailedOn:${machineName}`);
            expect(screen.findByTestId('failure.unavailable')).toBeNull();
            expect(screen.findByTestId('failure.indexMissing')).toBeNull();
            const before = searchCalls();
            await screen.pressByTestIdAsync('failure.failed-action');
            await act(async () => { await vi.waitFor(() => expect(searchCalls()).toBeGreaterThan(before)); });
        });
        it('names the Machine whose remembered facts cannot be searched, with no result count beside it', async () => {
            const screen = await search({ state: 'unavailable' }, []);
            const machine = storage.getState().machines[administration.targets[0]!.machineId]!;
            await vi.waitFor(async () => { await flushHookEffects(); expect(screen.findByTestId('search.documentsCoverage')).not.toBeNull(); });
            expect(screen.getTextContent()).toContain(
                `memoryContext.memory.documentSearchUnavailableOn:${machine.metadata?.displayName ?? machine.metadata?.host}`);
            expect(screen.getTextContent()).not.toContain('memoryContext.memory.resultCount');
        });
    });
    describe('names the Machine of the exact Home, never the same-id Machine of the active Home map', () => {
        const ACTIVE_NAME = 'Active map neighbour';
        const EXACT_NAME = 'Exact Home Machine';
        /** The same Machine id answers to two names: the active-Home map's and the exact Home's settled inventory. */
        function splitHomeNames() {
            const machineId = administration.targets[0]!.machineId;
            const named = (machine: Machine, displayName: string) => ({ ...machine, metadata: { ...machine.metadata!, displayName } });
            storage.setState(state => ({
                machines: { ...state.machines, [machineId]: named(state.machines[machineId]!, ACTIVE_NAME) },
                // Every Home inventory that lists the Machine names it as the exact Home does.
                machineListByServerId: Object.fromEntries(Object.entries(state.machineListByServerId).map(([homeId, list]) =>
                    [homeId, list === null ? null : list.map(machine => machine.id === machineId ? named(machine, EXACT_NAME) : machine)])),
            }));
        }
        async function typeFact(screen: Awaited<ReturnType<typeof renderScreen>>, testID: string) {
            await waitForHomeGovernance(async () => {
                caseSignal.throwIfAborted();
                await flushHookEffects();
                expect(screen.findByTestId(`${testID}.input`)?.props.editable).toBe(true);
            });
            await act(async () => screen.findByTestId(`${testID}.input`)!.props.onChangeText('fact'));
            await flushHookEffects();
        }
        it.each([
            ['documents coverage', 'memoryContext.memory.documentSearchUnavailableOn', 'coverage'],
            ['a failed search', 'memoryContext.memory.searchFailedOn', 'failed'],
            ['an unavailable (switched off) search', 'memoryContext.memory.searchUnavailableOn', 'disabled'],
            ['an unsupported Project search', 'memoryContext.memory.projectSearchUnsupported', 'unsupported'],
        ] as const)('for %s', async (_label, key, flow) => {
            const serverId = administration.serverIds[0]!;
            const scope = flow === 'unsupported'
                ? { type: 'project' as const, projectRef: { serverId, projectKey: 'payments' } } : undefined;
            machineRpc.mockImplementation(async (request: Readonly<{ method: string }>) => {
                if (request.method === RPC_METHODS.DAEMON_MEMORY_STATUS) return { ...status, documentSearchSupported: true };
                if (flow === 'failed') throw new Error('socket closed');
                if (flow === 'disabled') return { v: 1, ok: false, errorCode: 'memory_disabled', error: 'memory_disabled' };
                return { v: 1, ok: true, hits: [], documents: { state: 'unavailable' } };
            });
            const screen = await renderScreen(<InjectedAuthProvider credentials={connection!.credentials}>
                <MemorySearchPanel testID="exact" serverId={serverId} scope={scope} />
            </InjectedAuthProvider>);
            await typeFact(screen, 'exact');
            await vi.waitFor(async () => {
                await flushHookEffects();
                expect(screen.getTextContent()).toContain(key);
            });
            // Only now, with the Home's own inventory settled, do the two maps disagree about the Machine's name.
            await act(async () => splitHomeNames());
            await flushHookEffects();
            const text = screen.getTextContent();
            expect(text).toContain(EXACT_NAME);
            expect(text).not.toContain(ACTIVE_NAME);
        });
    });
    it('preserves qualified Project scope and retained hits when the selected Machine goes offline', async () => {
        const serverId = administration.serverIds[0]!;
        const scope = { type: 'project' as const, projectRef: { serverId, projectKey: 'payments' } };
        machineRpc.mockImplementation(async (request: Readonly<{ method: string }>) => request.method === RPC_METHODS.DAEMON_MEMORY_STATUS
            ? { ...status, projectSearchSupported: true, documentSearchSupported: true }
            : { v: 1, ok: true, hits: [document], documents: { state: 'ready' }, project: { state: 'partial' } });
        const screen = await renderScreen(<InjectedAuthProvider credentials={connection!.credentials}>
            <MemorySearchPanel testID="project-search" serverId={serverId} scope={scope} />
        </InjectedAuthProvider>);
        await waitForHomeGovernance(async () => {
            caseSignal.throwIfAborted();
            await flushHookEffects();
            expect(screen.findByTestId('project-search.input')?.props.editable).toBe(true);
        });
        await act(async () => screen.findByTestId('project-search.input')!.props.onChangeText('fact'));
        await act(async () => { await vi.waitFor(() => expect(machineRpc.mock.calls.some(([request]) =>
            request.method === RPC_METHODS.DAEMON_MEMORY_SEARCH)).toBe(true)); });
        await flushHookEffects();
        expect(screen.findByTestId('project-search.remembered.0')).not.toBeNull();
        expect(machineRpc.mock.calls.find(([request]) => request.method === RPC_METHODS.DAEMON_MEMORY_SEARCH)?.[0].payload).toMatchObject({ scope });
        expect(screen.findByTestId('project-search.documentsCoverage')).not.toBeNull();
        const machineId = administration.targets[0]!.machineId;
        const selectedMachine = storage.getState().machines[machineId];
        if (!selectedMachine) throw new Error('Expected the selected Machine fixture');
        homes.answer(serverId, '/v1/machines', { body: [{
            ...createPlainMachineRowFixture({ id: machineId, accountId: 'account-a' }), active: false,
        }] });
        const lastSeenAt = Date.now();
        const clock = vi.spyOn(Date, 'now').mockReturnValue(lastSeenAt + 1);
        try {
            await act(async () => storage.getState().applyMachines([{ ...selectedMachine, active: false, activeAt: lastSeenAt }],
                false, { sourceServerId: serverId }));
            await flushHookEffects();
            expect(screen.findByTestId('project-search.unavailable')).not.toBeNull();
            // The Machine the person chose is the one named, never a generic "a machine".
            expect(screen.getTextContent()).toContain(
                `memoryContext.memory.searchUnavailableOn:${selectedMachine.metadata?.displayName ?? selectedMachine.metadata?.host}`);
            // A search that cannot run says what it needs and leads to the setting that provides it.
            expect(screen.findByTestId('project-search.unavailable-action')).not.toBeNull();
            await screen.pressByTestIdAsync('project-search.unavailable-action');
            expect(settingsPush).toHaveBeenCalledWith((await import('@/components/settings/catalog/routes')).SETTINGS_ROUTES.search);
            expect(screen.findByTestId('project-search.remembered.0')).not.toBeNull();
            await act(async () => administration.selectTarget(administration.targets[1]!));
            await flushHookEffects();
            expect(screen.findByTestId('project-search.remembered.0')).toBeNull();
        } finally { clock.mockRestore(); }
    });
    it('leaves the offline Home to the page instead of blaming the selected Machine while nothing is typed', async () => {
        const serverId = administration.serverIds[0]!;
        const scope = { type: 'project' as const, projectRef: { serverId, projectKey: 'payments' } };
        machineRpc.mockImplementation(async (request: Readonly<{ method: string }>) => request.method === RPC_METHODS.DAEMON_MEMORY_STATUS
            ? { ...status, projectSearchSupported: true, documentSearchSupported: true }
            : { v: 1, ok: true, hits: [], documents: { state: 'ready' } });
        const screen = await renderScreen(<InjectedAuthProvider credentials={connection!.credentials}>
            <MemorySearchPanel testID="idle-search" serverId={serverId} scope={scope} />
        </InjectedAuthProvider>);
        await waitForHomeGovernance(async () => {
            caseSignal.throwIfAborted();
            await flushHookEffects();
            expect(screen.findByTestId('idle-search.input')?.props.editable).toBe(true);
        });
        const machineId = administration.targets[0]!.machineId;
        const selectedMachine = storage.getState().machines[machineId];
        if (!selectedMachine) throw new Error('Expected the selected Machine fixture');
        homes.answer(serverId, '/v1/machines', { body: [{
            ...createPlainMachineRowFixture({ id: machineId, accountId: 'account-a' }), active: false,
        }] });
        const lastSeenAt = Date.now();
        const clock = vi.spyOn(Date, 'now').mockReturnValue(lastSeenAt + 1);
        try {
            await act(async () => storage.getState().applyMachines([{ ...selectedMachine, active: false, activeAt: lastSeenAt }],
                false, { sourceServerId: serverId }));
            await flushHookEffects();
            // Online, a Machine that cannot search says so and leads to the setting.
            expect(screen.findByTestId('idle-search.unavailable')).not.toBeNull();
            await act(async () => storage.getState().setEndpointConnectivity({
                status: 'offline', reason: null, attempt: 1, nextRetryAt: null,
                lastConnectedAt: 1, lastDisconnectedAt: 2, lastErrorMessage: null,
            }));
            await flushHookEffects();
            expect(screen.findByTestId('idle-search.unavailable')).toBeNull();
        } finally { clock.mockRestore(); }
    });
    it('renders admitted loaded and indexed facts through the real selected-daemon summary path', async () => {
        const serverId = administration.serverIds[0]!;
        const artifactId = await sync.createArtifactWithHeader({ v: 1, kind: 'memory_doc.v1', title: 'Memory' }, JSON.stringify({
            v: 1, index: ['one', 'two'].map(id => ({ id, text: id, createdAtMs: 1, sourceSessionRef: null })),
            topics: [{ title: 'detail', summary: 'Topic', facts: [{ id: 'topic', text: 'Detail', createdAtMs: 1, sourceSessionRef: null }] }],
        }));
        homes.answer(serverId, '/v1/public-shares?' + new URLSearchParams({ subjectKind: 'artifact', subjectId: artifactId }), { body: { publicShares: [] } });
        const ref = { kind: 'doc' as const, serverId, artifactId };
        machineRpc.mockResolvedValue({ ...status, documents: { state: 'ready', facts: [{
            ref, revision: { headerVersion: 1, bodyVersion: 1 }, loadedFactCount: 1, indexedFactCount: 5,
        }] } });
        function Summary() {
            const source = useMemoryDocument({ ref, serverId });
            return <MemoryDocumentBody testID="summary-doc" source={source} serverId={serverId}
                preparationScope={{ type: 'session', sessionId: 'current-session' }}
                composing={false} onComposingChange={() => {}} emptyText="empty" />;
        }
        const screen = await renderScreen(<InjectedAuthProvider credentials={connection!.credentials}><Summary /></InjectedAuthProvider>);
        await vi.waitFor(async () => { await flushHookEffects(); expect(screen.getTextContent()).toContain('5 facts'); });
        expect(screen.getTextContent()).toContain('1 facts');
        expect(screen.getTextContent()).not.toContain('2 facts');
    });
    it('reports the selected unavailable Machine for counts while the document remains readable, then recovers on the same Machine', async () => {
        const serverId = administration.serverIds[0]!;
        const artifactId = await sync.createArtifactWithHeader({ v: 1, kind: 'memory_doc.v1', title: 'Memory' }, JSON.stringify({
            v: 1, index: [{ id: 'key', text: 'Keep the saved fact readable.', createdAtMs: 1, sourceSessionRef: null }], topics: [],
        }));
        homes.answer(serverId, '/v1/public-shares?' + new URLSearchParams({ subjectKind: 'artifact', subjectId: artifactId }), { body: { publicShares: [] } });
        const ref = { kind: 'doc' as const, serverId, artifactId };
        const machineId = administration.targets[0]!.machineId;
        const machine = storage.getState().machines[machineId]!;
        const lastSeenAt = Date.now();
        const clock = vi.spyOn(Date, 'now').mockReturnValue(lastSeenAt + 1);
        homes.answer(serverId, '/v1/machines', { body: [{ ...createPlainMachineRowFixture({ id: machineId, accountId: 'account-a' }), active: false }] });
        await act(async () => storage.getState().applyMachines([{ ...machine, active: false, activeAt: lastSeenAt }], false, { sourceServerId: serverId }));
        const hook = await renderHook(() => {
            const source = useMemoryDocument({ ref, serverId });
            return { source, summary: useMemoryDocumentSummary({ source, serverId }) };
        }, { wrapper: ({ children }) => <InjectedAuthProvider credentials={connection!.credentials}>{children}</InjectedAuthProvider> });
        try {
            await vi.waitFor(async () => { await flushHookEffects(); expect(hook.getCurrent().source.status).toBe('ready'); });
            expect(hook.getCurrent().source.view?.facts[0]?.text).toBe('Keep the saved fact readable.');
            expect(hook.getCurrent().summary).toMatchObject({ state: 'unavailable', cause: {
                reason: 'machine_unavailable', target: { serverId: administration.targets[0]!.serverIdentityId, machineId },
            } });
            expect(machineRpc).not.toHaveBeenCalled();
            machineRpc.mockResolvedValue({ ...status, documents: { state: 'ready', facts: [{
                ref, revision: { headerVersion: 1, bodyVersion: 1 }, indexedFactCount: 5, loadedFactCount: 1,
            }] } });
            homes.answer(serverId, '/v1/machines', { body: [createPlainMachineRowFixture({ id: machineId, accountId: 'account-a' })] });
            await act(async () => storage.getState().applyMachines([{ ...machine, active: true, activeAt: Date.now() }], false, { sourceServerId: serverId }));
            await vi.waitFor(async () => {
                await flushHookEffects();
                expect(hook.getCurrent().summary).toEqual({ state: 'ready', indexedFactCount: 5, loadedFactCount: 1 });
            });
        } finally { await hook.unmount(); clock.mockRestore(); }
    });
    it('says no Memory Machine is chosen, never reads one implicitly, and loads the counts once the person chooses', async () => {
        const serverId = administration.serverIds[0]!;
        const artifactId = await sync.createArtifactWithHeader({ v: 1, kind: 'memory_doc.v1', title: 'Memory' }, JSON.stringify({
            v: 1, index: [{ id: 'key', text: 'Keep the saved fact readable.', createdAtMs: 1, sourceSessionRef: null }], topics: [],
        }));
        homes.answer(serverId, '/v1/public-shares?' + new URLSearchParams({ subjectKind: 'artifact', subjectId: artifactId }), { body: { publicShares: [] } });
        const ref = { kind: 'doc' as const, serverId, artifactId };
        await clearMemoryMachineChoice(serverId);
        machineRpc.mockResolvedValue({ ...status, documents: { state: 'ready', facts: [{
            ref, revision: { headerVersion: 1, bodyVersion: 1 }, indexedFactCount: 2, loadedFactCount: 1,
        }] } });
        const hook = await renderHook(() => {
            const source = useMemoryDocument({ ref, serverId });
            return { source, summary: useMemoryDocumentSummary({ source, serverId }) };
        }, { wrapper: ({ children }) => <InjectedAuthProvider credentials={connection!.credentials}>{children}</InjectedAuthProvider> });
        try {
            await vi.waitFor(async () => { await flushHookEffects(); expect(hook.getCurrent().source.status).toBe('ready'); });
            expect(hook.getCurrent().summary).toEqual({ state: 'unavailable', cause: { reason: 'machine_not_chosen' } });
            expect(machineRpc).not.toHaveBeenCalled();
            await act(async () => storage.setState(state => ({ settings: { ...state.settings,
                machineAdministrationTargetsLocalV1: { 'memory.settings': administration.targets[0]! } } })));
            await vi.waitFor(async () => {
                await flushHookEffects();
                expect(hook.getCurrent().summary).toEqual({ state: 'ready', indexedFactCount: 2, loadedFactCount: 1 });
            });
        } finally { await hook.unmount(); }
    });
    it('reads nothing for a switched-off document, says it is not in use even with no Machine chosen, and loads the counts once it is in use', async () => {
        const serverId = administration.serverIds[0]!;
        const artifactId = await sync.createArtifactWithHeader({ v: 1, kind: 'memory_doc.v1', title: 'Memory' }, JSON.stringify({
            v: 1, index: [{ id: 'key', text: 'Keep the saved fact readable.', createdAtMs: 1, sourceSessionRef: null }], topics: [],
        }));
        homes.answer(serverId, '/v1/public-shares?' + new URLSearchParams({ subjectKind: 'artifact', subjectId: artifactId }), { body: { publicShares: [] } });
        const ref = { kind: 'doc' as const, serverId, artifactId };
        await clearMemoryMachineChoice(serverId);
        machineRpc.mockResolvedValue({ ...status, documents: { state: 'ready', facts: [{
            ref, revision: { headerVersion: 1, bodyVersion: 1 }, indexedFactCount: 2, loadedFactCount: 1,
        }] } });
        const hook = await renderHook(({ inUse }: { inUse: boolean }) => {
            const source = useMemoryDocument({ ref, serverId });
            return { source, summary: useMemoryDocumentSummary({ source, serverId, inUse }) };
        }, { initialProps: { inUse: false }, wrapper: ({ children }) =>
            <InjectedAuthProvider credentials={connection!.credentials}>{children}</InjectedAuthProvider> });
        try {
            await vi.waitFor(async () => { await flushHookEffects(); expect(hook.getCurrent().source.status).toBe('ready'); });
            expect(hook.getCurrent().summary).toEqual({ state: 'unavailable', cause: { reason: 'not_in_use' } });
            expect(machineRpc).not.toHaveBeenCalled();
            // Switching it on brings back the ordinary path: no Machine chosen asks for one, a chosen Machine loads the counts.
            await hook.rerender({ inUse: true });
            await vi.waitFor(async () => { await flushHookEffects(); expect(hook.getCurrent().summary).toEqual({ state: 'unavailable', cause: { reason: 'machine_not_chosen' } }); });
            await act(async () => storage.setState(state => ({ settings: { ...state.settings,
                machineAdministrationTargetsLocalV1: { 'memory.settings': administration.targets[0]! } } })));
            await vi.waitFor(async () => {
                await flushHookEffects();
                expect(hook.getCurrent().summary).toEqual({ state: 'ready', indexedFactCount: 2, loadedFactCount: 1 });
            });
            await hook.rerender({ inUse: false });
            expect(hook.getCurrent().summary).toEqual({ state: 'unavailable', cause: { reason: 'not_in_use' } });
        } finally { await hook.unmount(); }
    });
    it('offers the Memory Machine choice in search when none is chosen, and never queries', async () => {
        await clearMemoryMachineChoice(administration.serverIds[0]!);
        const screen = await renderScreen(<InjectedAuthProvider credentials={connection!.credentials}>
            <MemorySearchPanel testID="unchosen-search" serverId={administration.serverIds[0]!} />
        </InjectedAuthProvider>);
        await waitForHomeGovernance(async () => {
            caseSignal.throwIfAborted();
            await flushHookEffects();
            expect(screen.findByTestId('unchosen-search.machine.state')).toBeTruthy();
        });
        expect(screen.getTextContent()).toContain('memoryContext.memory.searchNeedMachine');
        expect(screen.findByTestId('unchosen-search.input')?.props.editable).toBe(false);
        expect(screen.findByTestId('unchosen-search.unavailable')).toBeNull();
        expect(machineRpc).not.toHaveBeenCalled();
        await act(async () => screen.unmount());
    });
    it.each(['session', 'project'] as const)('keeps a fresh summary narrow to %s and refuses late scoped status after its context changes', async scopeType => {
        const serverId = administration.serverIds[0]!;
        const artifactId = await sync.createArtifactWithHeader({ v: 1, kind: 'memory_doc.v1', title: 'Memory' }, JSON.stringify({
            v: 1, index: [{ id: 'key', text: 'Key fact', createdAtMs: 1, sourceSessionRef: null }], topics: [],
        }));
        homes.answer(serverId, '/v1/public-shares?' + new URLSearchParams({ subjectKind: 'artifact', subjectId: artifactId }), { body: { publicShares: [] } });
        const ref = { kind: 'doc' as const, serverId, artifactId };
        const response = (loadedFactCount: number) => ({ ...status, documents: { state: 'ready', facts: [{
            ref, revision: { headerVersion: 1, bodyVersion: 1 }, loadedFactCount, indexedFactCount: 5,
        }] } });
        const pending: ((value: unknown) => void)[] = [];
        machineRpc.mockResolvedValueOnce(response(1)).mockImplementation(() => new Promise(resolve => pending.push(resolve)));
        const scope = scopeType === 'session' ? { type: 'session' as const, sessionId: 'current-session' }
            : { type: 'project' as const, projectRef: { serverId, projectKey: 'payments' } };
        const hook = await renderHook(({ basis, projectKey }: { basis: string; projectKey: string }) => {
            const source = useMemoryDocument({ ref, serverId });
            return useMemoryDocumentSummary({ source, serverId, scope: scopeType === 'project'
                ? { type: 'project', projectRef: { serverId, projectKey } } : scope, preparationBasis: basis });
        }, { initialProps: { basis: 'initial', projectKey: 'payments' }, wrapper: ({ children }) =>
            <InjectedAuthProvider credentials={connection!.credentials}>{children}</InjectedAuthProvider> });
        await vi.waitFor(async () => { await flushHookEffects(); expect(hook.getCurrent()).toEqual({ state: 'ready', loadedFactCount: 1, indexedFactCount: 5 }); });
        expect(machineRpc.mock.calls.filter(([request]) => request.payload.scope.type === 'global')).toHaveLength(0);
        expect(machineRpc.mock.calls[0]![0].payload.scope).toEqual(scope);
        await hook.rerender();
        expect(machineRpc.mock.calls).toHaveLength(1);
        await hook.rerender({ basis: 'changed', projectKey: 'payments' });
        expect(hook.getCurrent()).toMatchObject({ state: 'unavailable', cause: { reason: 'status_pending' } });
        await hook.rerender({ basis: 'latest', projectKey: 'payments' });
        expect(machineRpc.mock.calls[1]?.[0].signal.aborted).toBe(true);
        await act(async () => pending[0]!(response(2)));
        expect(hook.getCurrent()).toMatchObject({ state: 'unavailable', cause: { reason: 'status_pending' } });
        await act(async () => pending[1]!(response(3)));
        expect(hook.getCurrent()).toEqual({ state: 'ready', loadedFactCount: 3, indexedFactCount: 5 });
        await hook.rerender();
        expect(machineRpc.mock.calls).toHaveLength(3);
        if (scopeType === 'project') {
            await hook.rerender({ basis: 'latest', projectKey: 'billing' });
            expect(hook.getCurrent()).toMatchObject({ state: 'unavailable', cause: { reason: 'status_pending' } });
            expect(machineRpc.mock.calls[2]?.[0].signal.aborted).toBe(true);
            expect(machineRpc.mock.calls[3]?.[0].payload.scope).toEqual({
                type: 'project', projectRef: { serverId, projectKey: 'billing' },
            });
            await act(async () => pending[2]!(response(4)));
            expect(hook.getCurrent()).toEqual({ state: 'ready', loadedFactCount: 4, indexedFactCount: 5 });
            await hook.rerender();
            expect(machineRpc.mock.calls).toHaveLength(4);
            machineRpc.mockRejectedValue(createRpcCallError({ error: 'Project status unavailable', errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE }));
            await hook.rerender({ basis: 'unsupported', projectKey: 'billing' });
            await vi.waitFor(async () => {
                await flushHookEffects();
                expect(hook.getCurrent()).toMatchObject({ state: 'unavailable', cause: {
                    reason: 'status_failed', errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
                } });
            });
            await hook.rerender();
            expect(machineRpc.mock.calls).toHaveLength(5);
            // Predecessor status ignores scoped payloads and returns no document coverage.
            machineRpc.mockResolvedValue(status);
            await hook.rerender({ basis: 'older-daemon', projectKey: 'billing' });
            await vi.waitFor(async () => {
                await flushHookEffects();
                expect(hook.getCurrent()).toEqual({ state: 'unavailable' });
            });
            await hook.rerender();
            expect(machineRpc.mock.calls).toHaveLength(6);
            expect(machineRpc.mock.calls.filter(([request]) => request.payload.scope.type === 'global')).toHaveLength(0);
        }
        await hook.unmount();
    });
    it.each(['page', 'context'] as const)('keeps Project %s counts narrow with zero global Session/context admissions', async surface => {
        const serverId = administration.serverIds[0]!;
        const artifactId = await sync.createArtifactWithHeader({ v: 1, kind: 'memory_doc.v1', title: 'Memory' }, JSON.stringify({
            v: 1, index: [{ id: 'key', text: 'Key fact', createdAtMs: 1, sourceSessionRef: null }], topics: [],
        }));
        homes.answer(serverId, '/v1/public-shares?' + new URLSearchParams({ subjectKind: 'artifact', subjectId: artifactId }), { body: { publicShares: [] } });
        const searchScope = { type: 'project' as const, projectRef: { serverId, projectKey: 'payments' } };
        machineRpc.mockResolvedValue({ ...status, documents: { state: 'ready', facts: [{
            ref: { kind: 'doc', serverId, artifactId }, revision: { headerVersion: 1, bodyVersion: 1 },
            loadedFactCount: 1, indexedFactCount: 5,
        }] } });
        const screen = await renderScreen(<InjectedAuthProvider credentials={connection!.credentials}>
            {surface === 'page' ? <MemoryDocumentScreen artifactId={artifactId} serverId={serverId}
                project={{ name: 'Payments', searchScope, href: () => '/projects/payments/memory' }} />
                : <ContextMemorySection testID="project-context.memory" serverId={serverId} searchScope={searchScope}
                    title="Memory" description="Project memory" footer="" emptyText=""
                    entry={{ id: 'memory', ref: { kind: 'doc', serverId, artifactId }, enabled: true, placement: 'system_append' }} />}
        </InjectedAuthProvider>);
        try {
            await vi.waitFor(async () => {
                await flushHookEffects();
                expect(screen.getTextContent()).toContain('5 facts');
            });
            const requests = machineRpc.mock.calls.filter(([request]) => request.method === RPC_METHODS.DAEMON_MEMORY_STATUS);
            expect(requests.filter(([request]) => request.payload.scope.type === 'global')).toHaveLength(0);
            expect(requests).toHaveLength(1);
            expect(requests[0]![0].payload.scope).toEqual(searchScope);
        } finally { await screen.unmount(); }
    });
    it.each(['ready', 'pending', 'failed'] as const)('reports unavailable counts with the selected-daemon cause while an unanswered read remains cancellable, then accepts a late %s result', async outcome => {
        const serverId = administration.serverIds[0]!;
        const artifactId = await sync.createArtifactWithHeader({ v: 1, kind: 'memory_doc.v1', title: 'Memory' }, JSON.stringify({
            v: 1, index: [{ id: 'key', text: 'Key fact', createdAtMs: 1, sourceSessionRef: null }], topics: [],
        }));
        homes.answer(serverId, '/v1/public-shares?' + new URLSearchParams({ subjectKind: 'artifact', subjectId: artifactId }), { body: { publicShares: [] } });
        const ref = { kind: 'doc' as const, serverId, artifactId };
        const response = { ...status, documents: { state: 'ready', facts: [{
            ref, revision: { headerVersion: 1, bodyVersion: 1 }, loadedFactCount: 1, indexedFactCount: 5,
        }] } };
        const pending = createDeferred<unknown>();
        machineRpc.mockImplementation(() => pending.promise);
        const hook = await renderHook(() => {
            const source = useMemoryDocument({ ref, serverId });
            return useMemoryDocumentSummary({ source, serverId });
        }, { wrapper: ({ children }) => <InjectedAuthProvider credentials={connection!.credentials}>{children}</InjectedAuthProvider> });
        try {
            await vi.waitFor(async () => {
                await flushHookEffects();
                expect(machineRpc.mock.calls.some(([request]) => request.method === RPC_METHODS.DAEMON_MEMORY_STATUS)).toBe(true);
            });
            expect(hook.getCurrent()).toMatchObject({ state: 'unavailable', cause: {
                reason: 'status_pending', target: { serverId: administration.targets[0]!.serverIdentityId,
                    machineId: administration.targets[0]!.machineId },
            } });
            const request = machineRpc.mock.calls[0]![0];
            expect(request.signal.aborted).toBe(false);
            await hook.rerender();
            expect(machineRpc.mock.calls).toHaveLength(1);
            await act(async () => {
                if (outcome === 'failed') pending.reject(createRpcCallError({ error: 'Status method unavailable', errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE }));
                else pending.resolve(outcome === 'pending' ? { ...status, documents: { state: 'pending' } } : response);
            });
            if (outcome === 'ready') expect(hook.getCurrent()).toEqual({ state: 'ready', loadedFactCount: 1, indexedFactCount: 5 });
            else expect(hook.getCurrent()).toMatchObject({ state: 'unavailable', cause: {
                reason: outcome === 'pending' ? 'coverage_pending' : 'status_failed',
                ...(outcome === 'failed' ? { errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE } : {}),
            } });
        } finally {
            pending.resolve(response);
            await hook.unmount();
            expect(machineRpc.mock.calls[0]?.[0].signal.aborted).toBe(true);
        }
    });
    it('keeps older-daemon Session hits usable while identifying unavailable document search', async () => {
        const screen = await search(null, [transcript]);
        expect(screen.findByTestId('search.session.0')).toBeTruthy();
        expect(screen.findByTestId('search.documentsCoverage')).toBeTruthy();
        expect(screen.findByTestId('search.empty')).toBeNull();
    });
    it('shows pending document coverage alongside mixed usable hits', async () => {
        const screen = await search({ state: 'pending' }, [document, transcript]);
        expect(screen.findByTestId('search.remembered.0')).toBeTruthy();
        expect(screen.findByTestId('search.session.0')).toBeTruthy();
        expect(screen.findByTestId('search.documentsCoverage-loading-spinner')).toBeTruthy();
    });
    it.each(['pending', 'unavailable'] as const)('does not claim ready-empty while document coverage is %s', async (state) => {
        const screen = await search({ state }, []);
        expect(screen.findByTestId('search.documentsCoverage')).toBeTruthy();
        expect(screen.findByTestId('search.empty')).toBeNull();
    });
    it('shows ready-empty only when the document corpus is ready', async () => {
        const screen = await search({ state: 'ready' }, []);
        expect(screen.findByTestId('search.documentsCoverage')).toBeNull();
        expect(screen.findByTestId('search.empty')).toBeTruthy();
        // A global zero has nothing wider to offer.
        expect(screen.findByTestId('search.empty-action')).toBeNull();
    });
});
