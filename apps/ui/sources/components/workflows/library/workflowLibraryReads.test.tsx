import { createNearViewportTracker, isSpanNearViewport } from '@/components/widgets/nearViewport';
import { PluginUiScrollActivityProvider, type PluginUiScrollActivityTracker } from '@happier-dev/plugin-ui/advanced';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeferred, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createAutomationRunFixture, createWorkflowDefinitionFixture, createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { materializeWorkflowAcceptedSnapshotV1 } from '@happier-dev/protocol/workflows/materializeWorkflowAcceptedSnapshotV1';
import { sealWorkflowAcceptedSnapshotStoredEnvelopeV1, serializeWorkflowStoredContentEnvelopeV1 } from '@happier-dev/protocol/workflows/workflowStoredContentV1';
import { WorkflowRunRecipientCensusResponseV1Schema } from '@happier-dev/protocol/workflows/workflowRunKeyV1';
import { PluginProjectionV2Schema, WorkflowTriggerSetV1Schema } from '@happier-dev/protocol';
import { encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES } from '@happier-dev/protocol/actions/externalActionLimits';
import { WORKFLOW_DEFINITION_PLUGIN_CURSOR_PREFIX_V1, WorkflowRunListRequestV1Schema } from '@happier-dev/protocol/workflows/actionsV1';
import { TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1 } from '@happier-dev/protocol/changes';

// Only Home HTTP/credentials and the native Machine RPC leave the real path.
const machineRpc = vi.hoisted(() => vi.fn());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: machineRpc }));
const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
installDisconnectedServerSocketBoundary();
beforeAll(loadSyncSingletonForTests);
const { storage } = await import('@/sync/domains/state/storageStore');
const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
const { getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable, publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
const { retireActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
const { disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
const { apiSocket } = await import('@/sync/api/session/apiSocket');
const { TokenStorage } = await import('@/auth/storage/tokenStorage');
const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
const { workflowRunRowFromSummary, workflowRunListWindowStoreKey, workflowRunStoreKey } = await import('@/sync/store/domains/workflowRuns');
const { createWorkflowDefinition, getWorkflowDefinition, listWorkflowDefinitions } = await import('@/sync/domains/workflows/workflowDefinitionActions');
const { ScheduledWorkflowRows } = await import('../triggers/ScheduledWorkflowSection');
const { projectScheduledWorkflowRows } = await import('../triggers/scheduledWorkflowRows');
const { listBuiltinWorkflowReferenceOptions, useWorkflowReferenceTitles } = await import('../presentation/workflowReferenceOptions');
const { useWorkflowDefinitionLibrary, useWorkflowRunWindow, resetWorkflowLibraryReadsForTests } = await import('./workflowLibraryReads');
const { useWorkflowLibraryView } = await import('./useWorkflowLibraryView');
const { useAccountWorkflowEditor } = await import('../triggers/AccountTriggersSection');
const { clearDaemonMergedProjectionCacheForTests } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
const { WorkflowTriggerSection } = await import('../triggers/WorkflowTriggerSection');
const { WorkflowTriggerRunHistory } = await import('../triggers/WorkflowTriggerRunHistory');
const { WorkflowRunItemBody } = await import('@/components/sessions/shell/row/WorkflowRunItemBody');
const { EMPTY_WORKFLOW_TRIGGER_DRAFT } = await import('../triggers/workflowTriggerDraft');
const route = '/v3/automations/runs/workflow-storage';
const definitionId = '00000000-0000-4000-8000-000000000001';
const secondId = '00000000-0000-4000-8000-000000000002';
const content = createWorkflowDefinitionFixture({ blocks: [{ kind: 'wait', id: 'wait', document: { text: 'Continue', references: [], attachments: [] } }] });
let accountId = 'account-a';
let serverId: string;
let previous = storage.getState();
let applied = getAppliedActiveServerSnapshot();
let available = isAppliedActiveServerRuntimeAvailable();

beforeEach(async () => {
    previous = storage.getState(); applied = getAppliedActiveServerSnapshot(); available = isAppliedActiveServerRuntimeAvailable();
    await home.reset(); accountId = 'account-a';
    // Synthetic logical Homes must not borrow an earlier test's installed HTTP configuration.
    await disconnectActiveServerConnection();
    apiSocket.disconnect();
    serverId = await home.addHome({ name: 'Library Home', serverUrl: 'https://workflow-library.test', accountId });
    const target = getActiveServerSnapshot();
    const credentials = await TokenStorage.getCredentialsForServerUrl(target.serverUrl, { serverId: target.serverId });
    if (!credentials) throw new Error('Workflow library fixture requires its captured Home credentials');
    apiSocket.initialize({ endpoint: target.serverUrl, serverId: target.serverId, generation: target.generation,
        token: credentials.token, credentials }, null);
    publishAppliedActiveServerSnapshot(target);
    storage.setState({ profileScope: { serverId, accountId }, workflowRunsById: {}, workflowRunListWindows: {}, workflowRunInvocationsByRunId: {}, machines: {}, machineListByServerId: {} });
    home.answer(serverId, '/v3/automations', { body: { automations: [], nextCursor: null } });
    home.answer(serverId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture() });
    machineRpc.mockReset();
});
afterEach(async () => {
    await standardCleanup(); resetWorkflowLibraryReadsForTests(); retireActiveServerAccountScopeLifetime();
    await disconnectActiveServerConnection();
    apiSocket.disconnect();
    clearDaemonMergedProjectionCacheForTests(); await home.reset();
    storage.setState(previous); publishAppliedActiveServerSnapshot(applied, available);
});

async function saved(id = definitionId, title = 'Saved', description?: string) {
    return await createWorkflowDefinition({ definitionId: id, definition: content, metadata: { title, ...(description ? { description } : {}) } });
}

async function runPage(runs: readonly ReturnType<typeof createWorkflowRunSummaryFixture>[], nextCursor?: string, destination?: string, title?: string) {
    const acceptedEnvelopesByRunId: Record<string, string> = {};
    const keyCensusByRunId: Record<string, ReturnType<typeof WorkflowRunRecipientCensusResponseV1Schema.parse>> = {};
    for (const run of runs) {
        const definition = destination ? createWorkflowDefinitionFixture({ defaults: {
            agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
            conversation: { kind: 'existing_session', sessionId: destination, machineId: run.machineId },
        } }) : content;
        const materialized = await materializeWorkflowAcceptedSnapshotV1({ definition, admission: { kind: 'user' },
            effects: { resolveTargetAvailability: async () => true }, context: { source: run.origin.kind === 'automation'
                ? { kind: 'automation', automationId: run.origin.automationId } : { kind: 'inline' }, inputs: {}, machineId: run.machineId,
                executionTarget: { kind: 'session' }, workspaceTarget: { project: { machineId: run.machineId, directory: '/repo', checkoutRootPath: '/repo' } },
                ...(run.origin.kind === 'direct' ? { origin: run.origin } : { actionCaller: {
                    kind: 'automationRun' as const, runId: run.id, automationId: run.origin.automationId, cause: { kind: 'manual' as const, invokedAt: 1 },
                } }), ...(title ? { metadata: { title } } : {}), authorization: { principal: { kind: 'host' } } } });
        if (!materialized.ok) throw new Error(`fixture_materialization_failed:${materialized.error.code}`);
        acceptedEnvelopesByRunId[run.id] = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
            binding: { v: 1, purpose: 'accepted_snapshot', accountId: run.ownerAccountId, runId: run.id }, acceptedSnapshot: materialized.snapshot }));
        keyCensusByRunId[run.id] = WorkflowRunRecipientCensusResponseV1Schema.parse({ runId: run.id, ownerAccountId: run.ownerAccountId,
            access: 'owner', encryptionMode: 'plain', dataEncryptionKey: null, callerDataEncryptionKey: null, recipients: [], visibleTeamId: null,
            ownerAccountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null } });
    }
    return { runs, acceptedEnvelopesByRunId, keyCensusByRunId, ...(nextCursor ? { nextCursor } : {}) };
}

const run = (id: string, state: 'running' | 'failed' | 'succeeded' = 'running') => createWorkflowRunSummaryFixture({ id, state, ownerAccountId: accountId });
const waitLoaded = (hook: { getCurrent(): { status: string } }) => waitForHomeGovernance(() => expect(hook.getCurrent().status).toBe('loaded'));
const artifactInventoryReads = () => home.requests.filter(request => request.input === null
    && new URL(request.path, request.serverUrl).pathname === '/v1/artifacts');
const artifactHeaderRoute = '/v1/artifacts?limit=500&kinds=%5B%22workflow-definition.v1%22%5D';
// Freeze or shorten a real filtered HTTP page. Keep the canonical transport
// envelope instead of answering a kind-selected read with the old raw array.
async function artifactHeaderPage(selectedIds?: readonly string[]): Promise<unknown> {
    const response = await home.artifacts(serverId).handle(artifactHeaderRoute);
    if (!response) throw new Error('Expected the canonical Artifact list boundary');
    const page: unknown = await response.json();
    if (selectedIds === undefined) return page;
    if (!page || typeof page !== 'object' || !('items' in page) || !Array.isArray(page.items)) {
        throw new Error('Expected a filtered Artifact page');
    }
    return { ...page, items: page.items.filter((row: unknown) => row && typeof row === 'object'
        && 'id' in row && typeof row.id === 'string' && selectedIds.includes(row.id)) };
}

const runWindowKey = (id: Parameters<typeof workflowRunListWindowStoreKey>[0]) => {
    const scope = storage.getState().profileScope;
    if (!scope) throw new Error('Expected a bound Home');
    return workflowRunListWindowStoreKey(id, scope);
};

it('expands and pages addressed B trigger History while A stays focused, and keeps explicit-null unavailable', async () => {
    const serverB = await home.addHome({ name: 'B history', serverUrl: 'https://workflow-history-b.test',
        accountId: 'account-b', active: false, currentAccount: true });
    home.answer(serverB, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture() });
    home.answer(serverId, route, { body: { runs: [], acceptedEnvelopesByRunId: {}, keyCensusByRunId: {} } });
    const bRows = ['history-b-first', 'history-b-next'].map(id => createWorkflowRunSummaryFixture({ id, ownerAccountId: 'account-b' }));
    const pages = [await runPage([bRows[0]!], 'b-next', undefined, 'B first Run'),
        await runPage([bRows[1]!], undefined, undefined, 'B next Run')];
    home.answer(serverB, route, { select: input => ({ body: pages[
        WorkflowRunListRequestV1Schema.parse((input as { request: unknown }).request).cursor === 'b-next' ? 1 : 0] }) });
    const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
    const { WorkflowAccountLifetimeProvider } = await import('../workflowAccountScope');
    const account = await captureLazyActionAccountContext(serverB);
    try {
        const set = WorkflowTriggerSetV1Schema.parse({ automationId: 'b-history-automation', revision: 1,
            enabled: true, health: 'available', target: { kind: 'workflow', ref: definitionId }, triggers: [{
                id: 'b-trigger', kind: 'schedule', enabled: true, revision: 1,
                createdAt: 1, updatedAt: 1, nextRunAt: null, triggerDefinitionEnvelope: null,
                schedule: { kind: 'cron', scheduleExpr: '0 9 * * *', everyMs: null, timezone: 'UTC' },
            }] });
        const screen = await renderScreen(<WorkflowAccountLifetimeProvider value={account.accountLifetime}>
            <WorkflowTriggerSection accountLifetime={account.accountLifetime}
                testIDPrefix="addressed-history" set={set} draft={EMPTY_WORKFLOW_TRIGGER_DRAFT} onChangeDraft={() => {}}
                status="ready" onRetry={() => {}} stepsUnsaved={false} whereTarget={null} whereSummary={null} inputs={[]} />
        </WorkflowAccountLifetimeProvider>);
        await screen.pressByTestIdAsync('addressed-history-trigger:saved:b-trigger-history');
        await waitForHomeGovernance(() => expect(screen.getTextContent()).toContain('B first Run'));
        await screen.pressByTestIdAsync('session-work-trigger-history:b-history-automation-loadMore');
        await waitForHomeGovernance(() => expect(screen.getTextContent()).toContain('B next Run'));
        expect(screen.getTextContent()).toContain('B first Run');
        expect(storage.getState().profileScope).toEqual({ serverId, accountId: 'account-a' });
        expect(home.requestsFor(route).filter(request => request.serverId === serverId)).toHaveLength(0);
        const addressedScope = account.accountLifetime.scope;
        expect(storage.getState().workflowRunListWindows[workflowRunListWindowStoreKey('trigger:b-trigger', addressedScope)]?.runIds)
            .toEqual(bRows.map(row => row.id));
        for (const row of bRows) {
            expect(storage.getState().workflowRunsById[workflowRunStoreKey(row.id, addressedScope)]?.summary?.id).toBe(row.id);
            expect(storage.getState().workflowRunsById[workflowRunStoreKey(row.id, { serverId, accountId })]).toBeUndefined();
        }
        const before = home.requestsFor(route).length;
        const unavailable = await renderHook(() => useWorkflowRunWindow('trigger:b-trigger'), {
            wrapper: ({ children }) => <WorkflowAccountLifetimeProvider value={null}>{children}</WorkflowAccountLifetimeProvider>,
        });
        expect(unavailable.getCurrent()).toMatchObject({ status: 'failed', serverId: null, rows: [], runIds: [], hasMore: false });
        await act(async () => { unavailable.getCurrent().retry(); unavailable.getCurrent().loadMore(); });
        expect(home.requestsFor(route)).toHaveLength(before);
    } finally { account.dispose(); }
});

it('windows expensive trigger History rows across appended pages without moving the physical page', async () => {
    const summaries = Array.from({ length: 72 }, (_, index) => createWorkflowRunSummaryFixture({
        id: `history-${index}`, ownerAccountId: accountId, sourceSavedBy: { kind: 'person', accountId },
    }));
    const pages = await Promise.all([0, 24, 48].map(start => runPage(summaries.slice(start, start + 24),
        start === 48 ? undefined : `page-${start + 24}`)));
    home.answer(serverId, route, { select: input => {
        const request = WorkflowRunListRequestV1Schema.parse((input as { request: unknown }).request);
        return { body: pages[request.cursor === 'page-48' ? 2 : request.cursor === 'page-24' ? 1 : 0] };
    } });
    // The platform geometry boundary supplies content positions; the real viewport owner decides admission.
    const rowHeight = 80;
    const physical = createNearViewportTracker({ quantum: rowHeight, initialViewportHeight: rowHeight * 3 });
    const scrollToOffset = vi.fn();
    const tracker: PluginUiScrollActivityTracker = { ...physical, scrollToOffset,
        measureSpan: async node => {
            if (!node || typeof node !== 'object' || !('testID' in node) || typeof node.testID !== 'string') return null;
            const index = Number(node.testID.split(':').at(-1)?.replace('history-', ''));
            return Number.isFinite(index) ? { top: index * rowHeight, height: rowHeight } : null;
        } };
    const screen = await renderScreen(<PluginUiScrollActivityProvider tracker={tracker}>
        <WorkflowTriggerRunHistory automationId="history" triggerId="trigger-history" />
    </PluginUiScrollActivityProvider>, { createNodeMock: element => ({ testID: element.props.testID }) });
    const mounted = () => screen.findAll(node => node.type === WorkflowRunItemBody).map(node => String(node.props.runId));
    const expected = (loaded: number) => summaries.slice(0, loaded).filter((_, index) =>
        isSpanNearViewport(physical.getWindow(), { top: index * rowHeight, height: rowHeight })).map(row => row.id);
    await waitForHomeGovernance(() => expect(mounted()).toEqual(expected(24)));
    expect(mounted().length).toBeLessThan(24);
    // Keep measured shells at their actual height while offscreen, including after pagination.
    for (const shell of screen.findAll(node => typeof node.props.testID === 'string'
        && node.props.testID.startsWith('session-work-trigger-history-row:') && typeof node.props.onLayout === 'function')) {
        await act(async () => shell.props.onLayout({ nativeEvent: { layout: { height: rowHeight } } }));
    }
    await act(async () => physical.onScroll({ nativeEvent: { contentOffset: { y: rowHeight * 12 } } } as never));
    await waitForHomeGovernance(() => expect(mounted()).toEqual(expected(24)));
    const windowBeforeAppend = physical.getWindow();
    for (const loaded of [48, 72]) {
        await screen.pressByTestIdAsync('session-work-trigger-history:history-loadMore');
        await waitForHomeGovernance(() => expect(storage.getState().workflowRunListWindows[runWindowKey('trigger:trigger-history')]?.runIds).toHaveLength(loaded));
        await waitForHomeGovernance(() => expect(mounted()).toEqual(expected(loaded)));
        expect(physical.getWindow()).toBe(windowBeforeAppend);
        expect(scrollToOffset).not.toHaveBeenCalled();
    }
    expect(screen.findByTestId('session-work-trigger-history:history-loadMore')).toBeNull();
    await act(async () => physical.onScroll({ nativeEvent: { contentOffset: { y: rowHeight * 68 } } } as never));
    await waitForHomeGovernance(() => expect(mounted()).toEqual(expected(72)));
    expect(mounted()).toContain('history-71');
    await act(async () => physical.onScroll({ nativeEvent: { contentOffset: { y: 0 } } } as never));
    await waitForHomeGovernance(() => expect(mounted()).toEqual(expected(72)));
    expect(mounted()).toContain('history-0');
    home.answer(serverId, route, { body: await runPage(summaries.slice(0, 1)) });
    const onePage = await renderScreen(<WorkflowTriggerRunHistory automationId="one-page" triggerId="one-page" />);
    await waitForHomeGovernance(() => expect(onePage.findAll(node => node.type === WorkflowRunItemBody)).toHaveLength(1));
    expect(onePage.findByTestId('session-work-trigger-history:one-page-loadMore')).toBeNull();
});

describe('Workflow library reads through real Account Actions and HTTP', () => {
    it('Retry replaces a stuck Run read and late old data cannot replace the fresh rows', async () => {
        const held = createDeferred<void>();
        const signals: (AbortSignal | null | undefined)[] = [];
        const stale = await runPage([run('stale-run')]);
        const fresh = await runPage([run('fresh-run', 'succeeded')]);
        home.answer(serverId, route, { select: (_input, request) => {
            signals.push(request.signal);
            return signals.length === 1 ? { respondAfter: held.promise, body: stale } : { body: fresh };
        } });
        const hook = await renderHook(() => useWorkflowRunWindow('all'));
        await waitForHomeGovernance(() => expect(signals).toHaveLength(1));
        await act(async () => hook.getCurrent().retry());
        await waitLoaded(hook);
        expect(signals).toHaveLength(2);
        expect(signals[0]?.aborted).toBe(true);
        expect(hook.getCurrent().runIds).toEqual(['fresh-run']);
        await act(async () => held.resolve());
        expect(hook.getCurrent().runIds).toEqual(['fresh-run']);
        await hook.unmount();
    });

    it('cancels a pending non-exact Run window only when its last borrower leaves', async () => {
        const held = createDeferred<void>();
        let signal: AbortSignal | null | undefined;
        home.answer(serverId, route, { select: (_input, request) => {
            signal = request.signal;
            return { respondAfter: held.promise, body: { runs: [], acceptedEnvelopesByRunId: {}, keyCensusByRunId: {} } };
        } });
        const first = await renderHook(() => useWorkflowRunWindow('all'));
        const second = await renderHook(() => useWorkflowRunWindow('all'));
        await waitForHomeGovernance(() => expect(signal).toBeDefined());
        expect(home.requestsFor(route)).toHaveLength(1);
        await first.unmount();
        expect(signal?.aborted).toBe(false);
        await second.unmount();
        expect(signal?.aborted).toBe(true);
        await act(async () => held.resolve());
    });

    it('shares exact followed Run summaries and retains their outage state without hidden demand', async () => {
        const initialRead = createDeferred<void>();
        const followed = { ...run('followed-run', 'succeeded'), sourceArtifactId: definitionId };
        home.answer(serverId, route, { body: await runPage([followed]), respondAfter: initialRead.promise });
        const first = await renderHook((props: { demanded: boolean }) => useWorkflowRunWindow('exact:["followed-run"]',
            { demanded: props.demanded, readMode: 'complete' }), { initialProps: { demanded: true } });
        const second = await renderHook(() => useWorkflowRunWindow('exact:["followed-run"]', { readMode: 'complete' }));
        await act(async () => initialRead.resolve());
        await waitLoaded(first);
        await waitLoaded(second);
        expect(first.getCurrent().rows).toEqual(second.getCurrent().rows);
        expect(home.requestsFor(route).map(request => request.input)).toEqual([
            expect.objectContaining({ operation: 'list', request: expect.objectContaining({ runIds: ['followed-run'] }) }),
        ]);
        const reads = home.requestsFor(route).length;
        await act(async () => publishHomeAccountChange(serverId, ['workflow-run:unrelated'], { changeKinds: ['account'] }));
        expect(home.requestsFor(route)).toHaveLength(reads);
        home.answer(serverId, route, { status: 403, body: { error: 'forbidden' } });
        await act(async () => publishHomeAccountChange(serverId, [TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1], { changeKinds: ['account'] }));
        await waitForHomeGovernance(() => expect(first.getCurrent().status).toBe('failed'));
        expect(home.requestsFor(route)).toHaveLength(reads + 1);
        home.answer(serverId, route, { body: await runPage([followed]) });
        await act(async () => publishHomeAccountChange(serverId, [definitionId], { changeKinds: ['artifact'] }));
        await waitLoaded(first);
        expect(home.requestsFor(route)).toHaveLength(reads + 2);
        home.answer(serverId, route, { status: 503, body: { error: 'unavailable' } });
        await act(async () => publishHomeAccountChange(serverId, ['workflow-run:followed-run'], { changeKinds: ['account'] }));
        await waitForHomeGovernance(() => expect(first.getCurrent().status).toBe('failed'));
        expect(first.getCurrent().runIds).toEqual(['followed-run']);
        await second.unmount();
        await first.rerender({ demanded: false });
        expect(first.getCurrent().rows).toEqual([]);
        const failedReads = home.requestsFor(route).length;
        await act(async () => publishHomeAccountChange(serverId, ['workflow-run:followed-run'], { changeKinds: ['account'] }));
        expect(home.requestsFor(route)).toHaveLength(failedReads);
        expect(first.getCurrent().status).toBe('failed');
        home.answer(serverId, route, { body: await runPage([followed]) });
        await first.rerender({ demanded: true });
        await waitLoaded(first);
        await first.unmount();
    });

    it('does not reload definition inventory for typed Session-only changes, but refreshes Artifact and unknown wakes', async () => {
        await saved();
        const hook = await renderHook(() => useWorkflowDefinitionLibrary());
        await waitLoaded(hook);
        const initial = artifactInventoryReads().length;
        expect(initial).toBeGreaterThan(0);
        const before = hook.getCurrent().definitions;
        await act(async () => {
            publishHomeAccountChange(serverId, ['session:unrelated'], { changeKinds: ['session'] });
        });
        await waitForHomeGovernance(() => expect(hook.getCurrent().status).toBe('loaded'));
        expect(artifactInventoryReads()).toHaveLength(initial);
        expect(hook.getCurrent().definitions).toBe(before);
        await act(async () => {
            publishHomeAccountChange(serverId, [definitionId], { changeKinds: ['artifact'] });
        });
        await waitForHomeGovernance(() => expect(artifactInventoryReads()).toHaveLength(initial + 1));
        await waitLoaded(hook);
        await act(async () => { publishHomeAccountChange(serverId); });
        await waitForHomeGovernance(() => expect(artifactInventoryReads()).toHaveLength(initial + 2));
    });

    it('names scheduled rows from admitted Artifact headers without demanding the full library', async () => {
        // The production activation owner establishes Settings before Profile scope.
        await storage.getState().activateSettingsScope({ serverId, accountId });
        await saved(definitionId, 'Readable scheduled title');
        await saved(secondId, 'Unreadable scheduled title');
        const stored = home.artifacts(serverId).read(secondId)!;
        home.artifacts(serverId).replaceStoredRow({ ...stored, body: encodePlainArtifactStoredContent({ body: 'invalid workflow JSON' }) });
        await expect(getWorkflowDefinition({ definitionId: secondId })).rejects.toMatchObject({ code: 'content_unavailable' });
        expect(storage.getState().artifacts[secondId]?.rawHeader?.metadata).toMatchObject({ title: 'Unreadable scheduled title' });
        const builtin = listBuiltinWorkflowReferenceOptions()[0]!;
        const sets = [definitionId, secondId, builtin.ref].map((ref, index) => WorkflowTriggerSetV1Schema.parse({
            automationId: `scheduled-${index}`, revision: 1, enabled: true, health: 'available', target: { kind: 'workflow', ref },
            triggers: [{ id: `timer-${index}`, revision: 1, enabled: true, kind: 'schedule', nextRunAt: Date.now() + 120_000,
                createdAt: 1, updatedAt: 1, triggerDefinitionEnvelope: null,
                schedule: { kind: 'interval', everyMs: 60_000, scheduleExpr: null, timezone: null } }],
        }));
        const before = artifactInventoryReads().length;
        const screen = await renderScreen(<ScheduledWorkflowRows read={{ available: true, rows: projectScheduledWorkflowRows(sets),
            status: 'ready', retry: () => {}, serverId }} />);
        await waitForHomeGovernance(() => {
            expect(screen.getTextContent()).toContain('Readable scheduled title');
            expect(screen.getTextContent()).toContain('Unreadable scheduled title');
            expect(screen.getTextContent()).toContain(builtin.title);
        });
        expect(artifactInventoryReads()).toHaveLength(before);
    });

    it('names scheduled plugin rows from the admitted projection without loading unrelated saved bodies', async () => {
        await storage.getState().activateSettingsScope({ serverId, accountId });
        await saved();
        storage.getState().applyMachines([createMachineFixture({ id: 'title-machine', activeAt: Date.now(),
            daemonState: { status: 'running', pid: 17, contributionRegistryProjectionRevision: 0 } })], true, { sourceServerId: serverId });
        machineRpc.mockResolvedValue({ protocolVersion: 1, projection: PluginProjectionV2Schema.parse({ v: 2, generation: 1,
            installedPackagesById: { 'example.recipe': { id: 'example.recipe', displayName: 'Recipe', version: '1.2.3', enabled: true,
                source: { kind: 'path', locator: '/plugins/example.recipe' } } },
            familiesById: { workflows: { family: 'workflows', entriesById: { 'example.recipe/review': {
                id: 'example.recipe/review', pluginId: 'example.recipe', pluginVersion: '1.2.3',
                definition: { id: 'review', title: 'Admitted plugin title', definition: content },
            } } } },
        }) });
        const admitted = await listWorkflowDefinitions({ cursor: `${WORKFLOW_DEFINITION_PLUGIN_CURSOR_PREFIX_V1}0` });
        const plugin = admitted.pluginWorkflows?.[0];
        expect(plugin?.title).toBe('Admitted plugin title');
        if (!plugin) throw new Error('Expected the real plugin projection');
        const set = WorkflowTriggerSetV1Schema.parse({ automationId: 'scheduled-plugin', revision: 1, enabled: true, health: 'available',
            target: { kind: 'workflow', ref: plugin.workflow }, triggers: [{ id: 'plugin-timer', revision: 1, enabled: true,
                kind: 'schedule', nextRunAt: Date.now() + 120_000, createdAt: 1, updatedAt: 1, triggerDefinitionEnvelope: null,
                schedule: { kind: 'interval', everyMs: 60_000, scheduleExpr: null, timezone: null } }],
        });
        const before = artifactInventoryReads().length;
        const rpcBefore = machineRpc.mock.calls.length;
        const screen = await renderScreen(<ScheduledWorkflowRows read={{ available: true, rows: projectScheduledWorkflowRows([set]),
            status: 'ready', retry: () => {}, serverId }} />);
        await waitForHomeGovernance(() => expect(screen.getTextContent()).toContain(plugin.title));
        expect(artifactInventoryReads()).toHaveLength(before);
        expect(machineRpc).toHaveBeenCalledTimes(rpcBefore);
        await act(async () => storage.getState().applyMachines([
            createMachineFixture({ id: 'title-machine', active: false, activeAt: 0,
                daemonState: { status: 'running', pid: 17, contributionRegistryProjectionRevision: 0 } }),
            createMachineFixture({ id: 'successor-title-machine', active: true, activeAt: Date.now(),
                daemonState: { status: 'running', pid: 18, contributionRegistryProjectionRevision: 0 } }),
        ], true, { sourceServerId: serverId }));
        expect(screen.getTextContent()).toContain(plugin.title);
        const successor = storage.getState().machines['successor-title-machine']!;
        const retainedSource = storage.getState().machines['title-machine']!;
        await act(async () => storage.getState().applyMachines([successor], true, { sourceServerId: serverId }));
        expect(screen.getTextContent()).not.toContain(plugin.title);
        await act(async () => storage.getState().applyMachines([retainedSource, successor], true, { sourceServerId: serverId }));
        expect(screen.getTextContent()).toContain(plugin.title);
        await act(async () => {
            accountId = 'account-b';
            await home.switchAccount(serverId, accountId);
            storage.setState({ profileScope: { serverId, accountId } });
        });
        await waitForHomeGovernance(() => expect(screen.getTextContent()).not.toContain(plugin.title));
        expect(machineRpc).toHaveBeenCalledTimes(rpcBefore);
    });

    it('keeps admitted shared titles on the first cached render and withdraws locked, removed, or foreign-scope facts', async () => {
        await storage.getState().activateSettingsScope({ serverId, accountId });
        await saved(definitionId, 'Shared scheduled title');
        const boundary = home.artifacts(serverId);
        boundary.replaceStoredRow({ ...boundary.read(definitionId)!, ownerAccountId: 'sharing-owner' });
        boundary.seedAccountGrant(definitionId, accountId, 'view');
        await getWorkflowDefinition({ definitionId });
        const admitted = storage.getState().artifacts[definitionId]!;
        expect(admitted).toMatchObject({ ownerAccountId: 'sharing-owner', access: 'view', isDecrypted: true });
        const refs = [definitionId];
        const before = artifactInventoryReads().length;
        const first = await renderHook(() => useWorkflowReferenceTitles(refs));
        expect(first.getCurrent()(definitionId)).toBe('Shared scheduled title');
        await first.unmount();
        const renders: (string | null)[] = [];
        const reopened = await renderHook(() => {
            const resolve = useWorkflowReferenceTitles(refs);
            renders.push(resolve(definitionId));
            return resolve;
        });
        expect(renders[0]).toBe('Shared scheduled title');
        await act(async () => storage.getState().updateArtifact({ ...admitted, isDecrypted: false,
            availability: { kind: 'locked', reason: 'encryption_material_unavailable' }, storageMode: 'plain',
            rawHeader: null, header: null, title: null, body: undefined, sessions: undefined, draft: undefined }));
        expect(reopened.getCurrent()(definitionId)).toBeNull();
        await act(async () => storage.getState().updateArtifact(admitted));
        expect(reopened.getCurrent()(definitionId)).toBe('Shared scheduled title');
        await act(async () => storage.getState().deleteArtifact(definitionId));
        expect(reopened.getCurrent()(definitionId)).toBeNull();
        await act(async () => {
            storage.getState().updateArtifact(admitted);
            storage.setState({ profileScope: { serverId, accountId: 'account-b' } });
        });
        expect(reopened.getCurrent()(definitionId)).toBeNull();
        expect(artifactInventoryReads()).toHaveLength(before);
    });

    it('keeps an addressed trigger picker on B while the active library shows the same id from A', async () => {
        await saved(definitionId, 'A workflow');
        const serverB = await home.addHome({ name: 'B library', serverUrl: 'https://workflow-library-b.test',
            accountId: 'account-b', active: false, currentAccount: true });
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        home.answer(serverB, '/v3/automations', { body: { automations: [], nextCursor: null } });
        const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
        const account = await captureLazyActionAccountContext(serverB);
        try {
            await createWorkflowDefinition({ definitionId, definition: content, metadata: { title: 'B workflow' }, accountLifetime: account.accountLifetime });
            const active = await renderHook(() => useWorkflowDefinitionLibrary());
            const addressed = await renderHook(() => useWorkflowDefinitionLibrary({ accountLifetime: account.accountLifetime }));
            await waitLoaded(active); await waitLoaded(addressed);
            expect(active.getCurrent().definitions[0]?.metadata?.title).toBe('A workflow');
            expect(addressed.getCurrent().definitions[0]?.metadata?.title).toBe('B workflow');
            expect(storage.getState().profileScope).toEqual({ serverId, accountId: 'account-a' });
        } finally { account.dispose(); }
    });
    it('settles a missing Account destination instead of inventing a pending read', async () => {
        storage.setState({ profileScope: null });
        const hook = await renderHook(() => useWorkflowRunWindow('destination:stopped-session'));
        expect(hook.getCurrent().status).toBe('failed');
        expect(hook.getCurrent().runIds).toEqual([]);
        expect(home.requestsFor(route)).toEqual([]);
    });

    it('shares visible library demand and preserves row identity and renders on an equal refresh', async () => {
        await saved();
        const pending = createDeferred<void>();
        home.answer(serverId, 'GET /v1/artifacts', { body: await artifactHeaderPage(), respondAfter: pending.promise });
        let renders = 0;
        const first = await renderHook(() => { renders++; return useWorkflowDefinitionLibrary(); });
        const second = await renderHook(() => useWorkflowDefinitionLibrary());
        await waitForHomeGovernance(() => expect(artifactInventoryReads()).toHaveLength(1));
        await act(async () => pending.resolve());
        await waitLoaded(first); await waitForHomeGovernance(() => expect(first.getCurrent().loadingMore).toBe(false));
        expect(first.getCurrent().definitions.map(row => row.definitionId)).toEqual([definitionId]);
        expect(second.getCurrent().definitions).toBe(first.getCurrent().definitions);
        const before = first.getCurrent().definitions;
        const settledRenders = renders;
        await act(async () => first.getCurrent().retry());
        await waitForHomeGovernance(() => expect(first.getCurrent().loadingMore).toBe(false));
        expect(first.getCurrent().definitions).toBe(before);
        expect(second.getCurrent().definitions).toBe(before);
        expect(renders).toBe(settledRenders);
    });

    it('reads nothing without demand and serves the current Account after enable', async () => {
        await saved();
        const before = home.requests.length;
        const hook = await renderHook((props: { enabled: boolean }) => useWorkflowDefinitionLibrary(props), { initialProps: { enabled: false } });
        expect(hook.getCurrent().definitions).toEqual([]);
        expect(home.requests.length).toBe(before);
        await hook.rerender({ enabled: true }); await waitLoaded(hook);
        expect(hook.getCurrent().definitions.map(row => row.definitionId)).toEqual([definitionId]);
    });

    it('refreshes mounted readers after a definition is created through the real writer', async () => {
        const hook = await renderHook(() => useWorkflowDefinitionLibrary()); await waitLoaded(hook);
        expect(hook.getCurrent().definitions).toEqual([]);
        await act(async () => { await saved(); });
        await waitForHomeGovernance(() => expect(hook.getCurrent().definitions.map(row => row.definitionId)).toEqual([definitionId]));
    });

    it('retains known rows while refreshing and rechecks a wake received during the first page', async () => {
        await saved();
        const firstPage = createDeferred<void>();
        const oldRows = await artifactHeaderPage();
        let reads = 0;
        home.answer(serverId, 'GET /v1/artifacts', { select: async () => ++reads === 1
            ? { body: oldRows, respondAfter: firstPage.promise } : { body: await artifactHeaderPage() } });
        const hook = await renderHook(() => useWorkflowDefinitionLibrary());
        await waitForHomeGovernance(() => expect(reads).toBe(1));
        await act(async () => { await saved(secondId, 'Created during read'); });
        await act(async () => firstPage.resolve());
        await waitForHomeGovernance(() => expect(hook.getCurrent().definitions).toHaveLength(2));
        expect(reads).toBe(2);
        const before = hook.getCurrent().definitions;
        const refresh = createDeferred<void>();
        home.answer(serverId, 'GET /v1/artifacts', { body: await artifactHeaderPage(), respondAfter: refresh.promise });
        await act(async () => publishHomeAccountChange(serverId));
        expect(hook.getCurrent().definitions).toBe(before);
        await act(async () => refresh.resolve());
        await waitForHomeGovernance(() => expect(hook.getCurrent().loadingMore).toBe(false));
        expect(hook.getCurrent().definitions).toBe(before);
    });

    it('replaces retired same-Account reads without waiting for their old response', async () => {
        await saved();
        const retired = createDeferred<void>();
        let reads = 0;
        home.answer(serverId, 'GET /v1/artifacts', { select: async () => ++reads === 1
            ? { body: await artifactHeaderPage([]), respondAfter: retired.promise } : { body: await artifactHeaderPage() } });
        const hook = await renderHook(() => useWorkflowDefinitionLibrary());
        await waitForHomeGovernance(() => expect(reads).toBe(1));
        await act(async () => { storage.setState({ profileScope: null }); });
        await act(async () => { storage.setState({ profileScope: { serverId, accountId } }); });
        await waitLoaded(hook);
        expect(hook.getCurrent().definitions.map(row => row.definitionId)).toEqual([definitionId]);
        await act(async () => retired.resolve());
        expect(hook.getCurrent().definitions.map(row => row.definitionId)).toEqual([definitionId]);
    });

    it('retires pending reads during sign-in restore and never discloses another Account\'s rows', async () => {
        await saved();
        const retired = createDeferred<void>();
        let reads = 0;
        const oldRows = await artifactHeaderPage();
        home.answer(serverId, 'GET /v1/artifacts', { select: async () => ++reads === 1
            ? { body: oldRows, respondAfter: retired.promise }
            : { body: await artifactHeaderPage(home.artifacts(serverId).list().filter(row => row.ownerAccountId === accountId).map(row => row.id)) } });
        const hook = await renderHook(() => useWorkflowDefinitionLibrary());
        await waitForHomeGovernance(() => expect(reads).toBe(1));
        await act(async () => retireActiveServerAccountScopeLifetime());
        await waitLoaded(hook);
        expect(hook.getCurrent().definitions.map(row => row.definitionId)).toEqual([definitionId]);
        const accountB = createDeferred<void>();
        home.answer(serverId, 'GET /v1/artifacts', { body: await artifactHeaderPage([]), respondAfter: accountB.promise });
        await act(async () => { accountId = 'account-b'; await home.switchAccount(serverId, accountId); storage.setState({ profileScope: { serverId, accountId } }); });
        expect(hook.getCurrent().status).toBe('loading');
        expect(hook.getCurrent().definitions).toEqual([]);
        await act(async () => accountB.resolve());
        await waitLoaded(hook);
        expect(hook.getCurrent().definitions).toEqual([]);
        await act(async () => retired.resolve());
        expect(hook.getCurrent().definitions).toEqual([]);
    });

    it('retains the complete demanded saved span during remount refresh, then removes authoritative deletions', async () => {
        // Real pagination is defined by the public Action envelope's byte budget.
        // Two individually valid headers exceed that combined budget.
        const description = 'x'.repeat(EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES / 2);
        await saved(definitionId, 'First', description); await saved(secondId, 'Second', description);
        const first = await renderHook(() => useWorkflowDefinitionLibrary()); await waitLoaded(first);
        expect(first.getCurrent().definitions).toHaveLength(1);
        await act(async () => first.getCurrent().loadMore());
        await waitForHomeGovernance(() => { expect(first.getCurrent().definitions).toHaveLength(2); expect(first.getCurrent().loadingMore).toBe(false); });
        const before = first.getCurrent().definitions;
        const refresh = createDeferred<void>();
        home.answer(serverId, `GET ${artifactHeaderRoute}`, { body: await artifactHeaderPage(), respondAfter: refresh.promise });
        const second = await renderHook(() => useWorkflowDefinitionLibrary());
        expect(first.getCurrent().definitions).toBe(before);
        await act(async () => refresh.resolve());
        await waitForHomeGovernance(() => expect(first.getCurrent().loadingMore).toBe(false));
        expect(first.getCurrent().definitions).toBe(before); expect(second.getCurrent().definitions).toBe(before);
        // Return an authoritative smaller collection at the actual network leaf.
        home.answer(serverId, `GET ${artifactHeaderRoute}`, { body: await artifactHeaderPage([definitionId]) });
        await act(async () => first.getCurrent().retry());
        await waitForHomeGovernance(() => expect(first.getCurrent().definitions.map(row => row.definitionId)).toEqual([definitionId]));
        expect(first.getCurrent().hasMore).toBe(false);
    });

    it('clears retired pagination busy state after a failed replacement and allows retry', async () => {
        const description = 'x'.repeat(EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES / 2);
        await saved(definitionId, 'First', description); await saved(secondId, 'Second', description);
        const hook = await renderHook(() => useWorkflowDefinitionLibrary()); await waitLoaded(hook);
        const retired = createDeferred<void>();
        home.answer(serverId, 'GET /v1/artifacts', { body: await artifactHeaderPage([definitionId]), respondAfter: retired.promise });
        await act(async () => hook.getCurrent().loadMore());
        expect(hook.getCurrent().loadingMore).toBe(true);
        home.answer(serverId, 'GET /v1/artifacts', { status: 503, body: { error: 'storage_unavailable' } });
        await act(async () => retireActiveServerAccountScopeLifetime());
        await waitForHomeGovernance(() => expect(hook.getCurrent().status).toBe('failed'));
        expect(hook.getCurrent().loadingMore).toBe(false);
        home.answer(serverId, 'GET /v1/artifacts', { body: await artifactHeaderPage([definitionId]) });
        await act(async () => hook.getCurrent().retry()); await waitLoaded(hook);
        await act(async () => retired.resolve());
        expect(hook.getCurrent().definitions.map(row => row.definitionId)).toEqual([definitionId]);
    });

    it('reissues a wake during retired pagination and preserves the queued refresh on the fresh read', async () => {
        const description = 'x'.repeat(EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES / 2);
        await saved(definitionId, 'First', description); await saved(secondId, 'Second', description);
        const hook = await renderHook(() => useWorkflowDefinitionLibrary()); await waitLoaded(hook);
        const before = hook.getCurrent().definitions;
        const retired = createDeferred<void>();
        home.answer(serverId, 'GET /v1/artifacts', { body: await artifactHeaderPage([definitionId]), respondAfter: retired.promise });
        await act(async () => hook.getCurrent().loadMore());
        await waitForHomeGovernance(() => expect(home.requests.filter(request => request.path.startsWith('/v1/artifacts?'))).toHaveLength(2));
        const fresh = createDeferred<void>();
        home.answer(serverId, 'GET /v1/artifacts', { body: await artifactHeaderPage(), respondAfter: fresh.promise });
        await act(async () => {
            storage.setState({ profileScope: null });
            retireActiveServerAccountScopeLifetime();
            storage.setState({ profileScope: { serverId, accountId } });
            publishHomeAccountChange(serverId);
        });
        await waitForHomeGovernance(() => expect(home.requests.filter(request => request.path.startsWith('/v1/artifacts?'))).toHaveLength(3));
        await act(async () => publishHomeAccountChange(serverId));
        home.answer(serverId, 'GET /v1/artifacts', { body: await artifactHeaderPage([definitionId]) });
        await act(async () => retired.resolve());
        expect(hook.getCurrent().definitions).toBe(before);
        await act(async () => fresh.resolve());
        await waitForHomeGovernance(() => {
            expect(hook.getCurrent().status).toBe('loaded'); expect(hook.getCurrent().loadingMore).toBe(false);
            expect(hook.getCurrent().definitions.map(row => row.definitionId)).toEqual([definitionId]);
        });
    });

    it('keeps saved rows usable while plugin discovery is pending and retains equal plugin descriptors', async () => {
        await saved();
        const machine = createMachineFixture({ id: 'library-machine', activeAt: Date.now(), daemonState: { status: 'running', pid: 17, contributionRegistryProjectionRevision: 0 } });
        storage.getState().applyMachines([machine], true, { sourceServerId: serverId });
        const pending = createDeferred<unknown>(); machineRpc.mockReturnValue(pending.promise);
        const hook = await renderHook(() => useWorkflowDefinitionLibrary()); await waitLoaded(hook);
        await waitForHomeGovernance(() => expect(machineRpc).toHaveBeenCalled());
        expect(hook.getCurrent().definitions.map(row => row.definitionId)).toEqual([definitionId]);
        const savedRows = hook.getCurrent().definitions;
        const projection = { protocolVersion: 1, projection: PluginProjectionV2Schema.parse({ v: 2, generation: 1,
            installedPackagesById: { 'example.recipe': { id: 'example.recipe', displayName: 'Example recipe', version: '1.2.3', enabled: true, source: { kind: 'path', locator: '/plugins/example.recipe' } } },
            familiesById: { workflows: { family: 'workflows', entriesById: { 'example.recipe/review': { id: 'example.recipe/review', pluginId: 'example.recipe', pluginVersion: '1.2.3',
                definition: { id: 'review', title: 'Plugin review', definition: content } } } } },
        }) };
        await act(async () => pending.resolve(projection));
        await waitForHomeGovernance(() => expect(hook.getCurrent().pluginWorkflows).toHaveLength(1));
        expect(hook.getCurrent().definitions).toBe(savedRows);
        const pluginRows = hook.getCurrent().pluginWorkflows;
        const second = await renderHook(() => useWorkflowDefinitionLibrary());
        await waitForHomeGovernance(() => expect(second.getCurrent().loadingMore).toBe(false));
        expect(second.getCurrent().pluginWorkflows).toBe(pluginRows);
        expect(second.getCurrent().definitions).toBe(savedRows);
    });

    it('accumulates real byte-paged plugin sources by qualified identity without discarding saved rows', async () => {
        await saved();
        const machine = createMachineFixture({ id: 'paged-plugin-machine', activeAt: Date.now(), daemonState: { status: 'running', pid: 17, contributionRegistryProjectionRevision: 0 } });
        storage.getState().applyMachines([machine], true, { sourceServerId: serverId });
        const text = 'x'.repeat(EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES / 2);
        const definition = createWorkflowDefinitionFixture({ blocks: [{ kind: 'wait', id: 'wait', document: { text, references: [], attachments: [] } }] });
        machineRpc.mockResolvedValue({ protocolVersion: 1, projection: PluginProjectionV2Schema.parse({ v: 2, generation: 1,
            installedPackagesById: { 'example.recipe': { id: 'example.recipe', displayName: 'Example recipe', version: '1.2.3', enabled: true, source: { kind: 'path', locator: '/plugins/example.recipe' } } },
            familiesById: { workflows: { family: 'workflows', entriesById: Object.fromEntries(['check', 'review'].map(id => [`example.recipe/${id}`, {
                id: `example.recipe/${id}`, pluginId: 'example.recipe', pluginVersion: '1.2.3', definition: { id, title: id, definition },
            }])) } },
        }) });
        const hook = await renderHook(() => useWorkflowDefinitionLibrary());
        await waitForHomeGovernance(() => { expect(hook.getCurrent().pluginWorkflows).toHaveLength(1); expect(hook.getCurrent().loadingMore).toBe(false); });
        const savedRows = hook.getCurrent().definitions;
        await act(async () => hook.getCurrent().loadMore());
        await waitForHomeGovernance(() => expect(hook.getCurrent().pluginWorkflows.map(row => row.workflow)).toEqual(['plugin:example.recipe/check', 'plugin:example.recipe/review']));
        expect(hook.getCurrent().definitions).toBe(savedRows); expect(hook.getCurrent().hasMore).toBe(false);
    });
});

describe('Workflow Run windows through real Account storage', () => {
    const membershipPage = (runs: readonly ReturnType<typeof createWorkflowRunSummaryFixture>[], nextCursor?: string) => ({
        projection: 'membership', runs, acceptedEnvelopesByRunId: {}, keyCensusByRunId: {}, ...(nextCursor ? { nextCursor } : {}),
    });

    it.each(['all', 'exact:["selected-run"]'] as const)('ignores 300 unrelated Artifact pushes and targets only changed Runs and referenced sources (%s)', async windowId => {
        await saved();
        const boundary = home.artifacts(serverId);
        const template = boundary.read(definitionId)!;
        const artifactIds = Array.from({ length: 300 }, (_, index) => `unrelated-artifact-${index}`);
        for (const id of artifactIds) boundary.replaceStoredRow({ ...template, id });
        const selected = { ...run('selected-run'), sourceArtifactId: definitionId };
        const untouched = { ...run('untouched-run'), sourceArtifactId: definitionId };
        home.answer(serverId, route, { body: await runPage(windowId === 'all' ? [selected, untouched] : [selected], 'retained-tail') });
        const hook = await renderHook(() => useWorkflowRunWindow(windowId));
        await waitLoaded(hook);
        const before = home.requestsFor(route).length;
        const fullReloads = () => home.requestsFor(route).slice(before).filter(read => {
            const request = WorkflowRunListRequestV1Schema.parse((read.input as { request: unknown }).request);
            return request.runIds === undefined && request.sourceArtifactId === undefined;
        });
        for (const id of artifactIds) await act(async () => publishHomeAccountChange(serverId, [id], { changeKinds: ['artifact'] }));
        expect(home.requestsFor(route)).toHaveLength(before);
        expect(fullReloads()).toHaveLength(0);
        const changed = { ...selected, state: 'succeeded' as const, revision: selected.revision + 1 };
        home.answer(serverId, route, { body: await runPage([changed]) });
        await act(async () => publishHomeAccountChange(serverId, [`workflow-run:${selected.id}`]));
        await waitForHomeGovernance(() => expect(hook.getCurrent().rows.find(row => row.id === selected.id)?.revision).toBe(changed.revision));
        expect(home.requestsFor(route)).toHaveLength(before + 1);
        expect(home.requestsFor(route).at(-1)?.input).toMatchObject({ request: { runIds: [selected.id] } });
        expect(hook.getCurrent().runIds).toEqual(windowId === 'all' ? [selected.id, untouched.id] : [selected.id]);
        expect(hook.getCurrent().hasMore).toBe(true);
        const current = { ...changed, revision: changed.revision + 1 };
        home.answer(serverId, route, { body: await runPage(windowId === 'all' ? [current, untouched] : [current]) });
        await act(async () => publishHomeAccountChange(serverId, [definitionId], { changeKinds: ['artifact'] }));
        await waitForHomeGovernance(() => expect(hook.getCurrent().rows.find(row => row.id === selected.id)?.revision).toBe(current.revision));
        expect(home.requestsFor(route)).toHaveLength(before + 2);
        expect(home.requestsFor(route).at(-1)?.input).toMatchObject({ request: { sourceArtifactId: definitionId } });
        expect(fullReloads()).toHaveLength(0);
        const materialized = { ...current, revision: current.revision + 1 };
        await act(async () => {
            storage.getState().upsertWorkflowRuns([workflowRunRowFromSummary(materialized, null)]);
            publishHomeAccountChange(serverId, [`workflow-run:${selected.id}`], { workflowRunsMaterialized: true });
        });
        expect(hook.getCurrent().rows.find(row => row.id === selected.id)?.revision).toBe(materialized.revision);
        expect(home.requestsFor(route)).toHaveLength(before + 2);
        await act(async () => storage.getState().removeWorkflowRun(selected.id));
        await act(async () => storage.getState().removeWorkflowRun(untouched.id));
        await act(async () => publishHomeAccountChange(serverId, [definitionId], { changeKinds: ['artifact'] }));
        expect(home.requestsFor(route)).toHaveLength(before + 2);
    });

    it.each([undefined, 'membership'] as const)('observes demanded source grant removal without refreshing unrelated sources (%s)', async projection => {
        const selected = { ...run('shared-run'), sourceArtifactId: definitionId, attentionRequired: true };
        home.answer(serverId, route, { body: projection ? membershipPage([selected]) : await runPage([selected]) });
        const hook = await renderHook(() => useWorkflowRunWindow('attention', { projection }));
        await waitLoaded(hook);
        const before = home.requestsFor(route).length;
        await act(async () => publishHomeAccountChange(serverId, ['unrelated-source'], { changeKinds: ['artifact'] }));
        expect(home.requestsFor(route)).toHaveLength(before);
        home.answer(serverId, route, { body: projection ? membershipPage([]) : await runPage([]) });
        await act(async () => publishHomeAccountChange(serverId, [definitionId], { changeKinds: ['artifact'] }));
        await waitForHomeGovernance(() => expect(hook.getCurrent().runIds).toEqual([]));
        expect(home.requestsFor(route)[before]?.input).toMatchObject({ request: { sourceArtifactId: definitionId, attention: 'required' } });
    });

    it('settles 1,000 complete Runs in one byte-bounded request and keeps a genuine arrival current', async () => {
        const summaries = Array.from({ length: 1000 }, (_, index) => createWorkflowRunSummaryFixture({
            ...run(`complete-${index}`), createdAt: new Date(1_000_000 - index).toISOString(),
        }));
        let fullPage = await runPage(summaries);
        expect(Buffer.byteLength(JSON.stringify(fullPage), 'utf8')).toBeLessThan(EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES);
        const pending = createDeferred<void>();
        home.answer(serverId, route, { select: input => {
            const request = WorkflowRunListRequestV1Schema.parse(input && typeof input === 'object' && 'request' in input ? input.request : undefined);
            const offset = Number(request.cursor ?? 0);
            const runIds = request.runIds;
            const selected = runIds ? fullPage.runs.filter(run => runIds.includes(run.id)) : fullPage.runs;
            const rows = selected.slice(offset, request.limit === undefined ? undefined : offset + request.limit);
            const next = offset + rows.length;
            return { body: { ...fullPage, runs: rows,
                ...(next < selected.length ? { nextCursor: String(next) } : {}) }, respondAfter: pending.promise };
        } });
        const complete = await renderHook(() => useWorkflowRunWindow('all', { readMode: 'complete' }));
        const visible = await renderHook(() => useWorkflowRunWindow('all'));
        await waitForHomeGovernance(() => expect(home.requestsFor(route)).toHaveLength(1));
        await act(async () => pending.resolve());
        await waitLoaded(complete);
        expect(complete.getCurrent().runIds).toHaveLength(1000);
        expect(complete.getCurrent().hasMore).toBe(false);
        expect(visible.getCurrent().runIds).toBe(complete.getCurrent().runIds);
        expect(home.requestsFor(route)).toHaveLength(1);
        expect(home.requestsFor(route)[0]?.input).toMatchObject({ request: {} });
        expect(home.requestsFor(route)[0]?.input).not.toMatchObject({ request: { limit: expect.anything() } });
        const changed = { ...summaries[0]!, state: 'succeeded' as const, revision: summaries[0]!.revision + 1 };
        fullPage = await runPage([changed, ...summaries.slice(1)]);
        await act(async () => publishHomeAccountChange(serverId, [`workflow-run:${changed.id}`]));
        await waitForHomeGovernance(() => expect(visible.getCurrent().rows[0]?.summary?.revision).toBe(changed.revision));
        expect(complete.getCurrent().rows[0]?.summary?.state).toBe('succeeded');
        expect(complete.getCurrent().runIds).toHaveLength(1000);
        expect(home.requestsFor(route)).toHaveLength(2);
    });

    it('finishes a complete Run continuation before a queued wake and retains its answer after refresh failure', async () => {
        const head = run('complete-head');
        const tail = { ...run('complete-tail'), createdAt: new Date(1).toISOString() };
        const changedTail = { ...tail, state: 'succeeded' as const, revision: tail.revision + 1 };
        const pending = createDeferred<void>();
        home.answer(serverId, route, { body: await runPage([head], 'complete-tail'), respondAfter: pending.promise });
        const hook = await renderHook(() => useWorkflowRunWindow('all', { readMode: 'complete' }));
        await waitForHomeGovernance(() => expect(home.requestsFor(route)).toHaveLength(1));
        const tailPage = await runPage([changedTail]);
        home.answer(serverId, route, { select: input => {
            const request = WorkflowRunListRequestV1Schema.parse(input && typeof input === 'object' && 'request' in input ? input.request : undefined);
            return request.cursor === 'complete-tail' ? { body: tailPage }
                : { status: 503, body: { error: 'storage_unavailable' } };
        } });
        await act(async () => publishHomeAccountChange(serverId, [`workflow-run:${tail.id}`]));
        await act(async () => pending.resolve());
        await waitForHomeGovernance(() => expect(hook.getCurrent().status).toBe('failed'));
        expect(home.requestsFor(route).map(request => WorkflowRunListRequestV1Schema.parse(
            request.input && typeof request.input === 'object' && 'request' in request.input ? request.input.request : undefined,
        ).cursor ?? null)).toEqual([null, 'complete-tail', null]);
        expect(hook.getCurrent().runIds).toEqual([head.id, tail.id]);
        expect(hook.getCurrent().rows[1]?.summary?.revision).toBe(changedTail.revision);
        expect(hook.getCurrent().hasMore).toBe(false);
        expect(hook.getCurrent().knownAt).not.toBeNull();
    });

    it('joins pending visible Run demand and releases complete demand when disabled', async () => {
        const head = run('joined-head');
        const tail = { ...run('joined-tail'), createdAt: new Date(1).toISOString() };
        const pending = createDeferred<void>();
        home.answer(serverId, route, { body: await runPage([head], 'joined-tail'), respondAfter: pending.promise });
        const visible = await renderHook(() => useWorkflowRunWindow('all'));
        await waitForHomeGovernance(() => expect(home.requestsFor(route)).toHaveLength(1));
        const complete = await renderHook((props: { enabled: boolean }) => useWorkflowRunWindow('all', { ...props, readMode: 'complete' }),
            { initialProps: { enabled: true } });
        expect(home.requestsFor(route)).toHaveLength(1);
        home.answer(serverId, route, { body: await runPage([tail]) });
        await act(async () => pending.resolve());
        await waitLoaded(complete);
        expect(complete.getCurrent().runIds).toEqual([head.id, tail.id]);
        expect(visible.getCurrent().runIds).toBe(complete.getCurrent().runIds);
        expect(home.requestsFor(route)).toHaveLength(2);
        expect(home.requestsFor(route)[1]?.input).not.toMatchObject({ request: { limit: expect.anything() } });
        await complete.rerender({ enabled: false });
        const changedHead = { ...head, revision: head.revision + 1 };
        home.answer(serverId, route, { body: await runPage([changedHead, tail]) });
        await act(async () => publishHomeAccountChange(serverId, [`workflow-run:${head.id}`]));
        await waitForHomeGovernance(() => expect(visible.getCurrent().rows[0]?.summary?.revision).toBe(changedHead.revision));
        expect(home.requestsFor(route)).toHaveLength(3);
        expect(home.requestsFor(route)[2]?.input).toMatchObject({ request: { runIds: [head.id] } });
    });

    it('completes the same window when complete demand joins a visible continuation', async () => {
        const summaries = ['shared-head', 'shared-middle', 'shared-tail'].map((id, index) => createWorkflowRunSummaryFixture({
            ...run(id), createdAt: new Date(1_000 - index).toISOString(),
        }));
        home.answer(serverId, route, { body: await runPage(summaries.slice(0, 1), 'shared-middle') });
        const visible = await renderHook(() => useWorkflowRunWindow('all'));
        await waitLoaded(visible);
        const pending = createDeferred<void>();
        home.answer(serverId, route, { body: await runPage(summaries.slice(1, 2), 'shared-tail'), respondAfter: pending.promise });
        await act(async () => visible.getCurrent().loadMore());
        await waitForHomeGovernance(() => expect(home.requestsFor(route)).toHaveLength(2));
        const complete = await renderHook(() => useWorkflowRunWindow('all', { readMode: 'complete' }));
        expect(home.requestsFor(route)).toHaveLength(2);
        home.answer(serverId, route, { body: await runPage(summaries.slice(2)) });
        await act(async () => pending.resolve());
        await waitForHomeGovernance(() => expect(complete.getCurrent().hasMore).toBe(false));
        expect(complete.getCurrent().runIds).toEqual(summaries.map(summary => summary.id));
        expect(visible.getCurrent().runIds).toBe(complete.getCurrent().runIds);
        expect(home.requestsFor(route)).toHaveLength(3);
    });

    it('promotes completed membership through the same window, then returns to compact demand on a shell-only wake', async () => {
        const summary = run('compact-attention');
        const fullPage = await runPage([summary], undefined, undefined, 'Release review');
        home.answer(serverId, route, { body: membershipPage([summary]) });
        const member = await renderHook(() => useWorkflowRunWindow('attention', { projection: 'membership' }));
        await waitLoaded(member);
        expect(home.requestsFor(route)[0]?.input).toMatchObject({ request: { attention: 'required', projection: 'membership' } });
        expect(member.getCurrent().runIds).toEqual([summary.id]);
        expect(member.getCurrent().rows).toEqual([]);
        const pending = createDeferred<void>();
        home.answer(serverId, route, { body: fullPage, respondAfter: pending.promise });
        const full = await renderHook(() => useWorkflowRunWindow('attention'));
        await waitForHomeGovernance(() => expect(home.requestsFor(route)).toHaveLength(2));
        expect(full.getCurrent().status).toBe('loading');
        expect(full.getCurrent().knownAt).toBeNull();
        expect(full.getCurrent().rows).toEqual([]);
        expect(home.requestsFor(route)[1]?.input).toMatchObject({ request: { attention: 'required' } });
        expect(home.requestsFor(route)[1]?.input).not.toHaveProperty('request.projection');
        await act(async () => pending.resolve()); await waitLoaded(full);
        expect(full.getCurrent().rows[0]?.metadata).toEqual({ kind: 'available', value: { title: 'Release review' } });
        const opened = full.getCurrent().rows[0];
        await full.unmount();
        home.answer(serverId, route, { body: membershipPage([summary]) });
        await act(async () => publishHomeAccountChange(serverId, [`workflow-run:${summary.id}`]));
        await waitForHomeGovernance(() => expect(home.requestsFor(route)).toHaveLength(3));
        await waitLoaded(member);
        expect(home.requestsFor(route).at(-1)?.input).toHaveProperty('request.projection', 'membership');
        expect(storage.getState().workflowRunsById[Object.keys(storage.getState().workflowRunsById)[0]!]).toBe(opened);
        await act(async () => retireActiveServerAccountScopeLifetime());
        await waitForHomeGovernance(() => expect(home.requestsFor(route)).toHaveLength(4));
        expect(home.requestsFor(route).at(-1)?.input).toHaveProperty('request.projection', 'membership');
    });

    it.each([false, true])('honors richer demand while the first membership response is pending (compact failure: %s)', async compactFails => {
        const summary = run('in-flight-attention');
        const pending = createDeferred<void>();
        home.answer(serverId, route, { ...(compactFails ? { status: 503, body: { error: 'storage_unavailable' } }
            : { body: membershipPage([summary]) }), respondAfter: pending.promise });
        await renderHook(() => useWorkflowRunWindow('attention', { projection: 'membership' }));
        await waitForHomeGovernance(() => expect(home.requestsFor(route)).toHaveLength(1));
        const full = await renderHook(() => useWorkflowRunWindow('attention'));
        expect(home.requestsFor(route)).toHaveLength(1);
        home.answer(serverId, route, { body: await runPage([summary], undefined, undefined, 'Current review') });
        await act(async () => pending.resolve());
        await waitLoaded(full);
        expect(home.requestsFor(route)).toHaveLength(2);
        expect(home.requestsFor(route)[1]?.input).not.toHaveProperty('request.projection');
        expect(full.getCurrent().rows[0]?.metadata).toEqual({ kind: 'available', value: { title: 'Current review' } });
    });

    it('retains opened rows and their Home qualification while promoting compact membership', async () => {
        const summary = run('retained-private');
        const opened = workflowRunRowFromSummary(summary, { kind: 'available', value: { title: 'Last known review' } });
        storage.getState().upsertWorkflowRuns([opened]);
        const bodies = storage.getState().workflowRunsById;
        home.answer(serverId, route, { body: membershipPage([summary]) });
        const member = await renderHook(() => useWorkflowRunWindow('attention', { projection: 'membership' })); await waitLoaded(member);
        expect(member.getCurrent().rows).toEqual([]);
        expect(storage.getState().workflowRunsById).toBe(bodies);
        const pending = createDeferred<void>();
        home.answer(serverId, route, { body: await runPage([summary], undefined, undefined, 'Last known review'), respondAfter: pending.promise });
        const full = await renderHook(() => useWorkflowRunWindow('attention'));
        await waitForHomeGovernance(() => expect(home.requestsFor(route)).toHaveLength(2));
        expect(full.getCurrent().status).toBe('loading');
        expect(full.getCurrent().knownAt).toBeNull();
        expect(full.getCurrent().serverId).toBe(serverId);
        expect(full.getCurrent().rows).toEqual([opened]);
        await act(async () => pending.resolve()); await waitLoaded(full);
    });

    it('retires a pending compact read and its queued promotion without letting its late answer affect the new lifetime', async () => {
        const old = run('retired-member');
        const pending = createDeferred<void>();
        home.answer(serverId, route, { body: membershipPage([old]), respondAfter: pending.promise });
        await renderHook(() => useWorkflowRunWindow('attention', { projection: 'membership' }));
        await waitForHomeGovernance(() => expect(home.requestsFor(route)).toHaveLength(1));
        const full = await renderHook(() => useWorkflowRunWindow('attention'));
        const current = run('current-member');
        const fullPage = await runPage([current], undefined, undefined, 'Current lifetime');
        home.answer(serverId, route, { select: input => ({ body: input && typeof input === 'object' && 'request' in input
            && input.request && typeof input.request === 'object' && 'projection' in input.request
            ? membershipPage([current]) : fullPage }) });
        await act(async () => retireActiveServerAccountScopeLifetime());
        await waitLoaded(full);
        expect(full.getCurrent().runIds).toEqual([current.id]);
        const count = home.requestsFor(route).length;
        await act(async () => pending.resolve());
        expect(home.requestsFor(route)).toHaveLength(count);
        expect(full.getCurrent().runIds).toEqual([current.id]);
        expect(full.getCurrent().rows[0]?.metadata).toEqual({ kind: 'available', value: { title: 'Current lifetime' } });
    });

    it('restates compact membership through its body-free frontier and clears an exhausted window', async () => {
        const ordered = [60, 50, 40, 30, 20, 10].map(value => createWorkflowRunSummaryFixture({ ...run(`member-${value}`),
            createdAt: new Date(value * 1000).toISOString() }));
        home.answer(serverId, route, { body: membershipPage(ordered.slice(1, 3), 'member-second') });
        const member = await renderHook(() => useWorkflowRunWindow('attention', { projection: 'membership' })); await waitLoaded(member);
        home.answer(serverId, route, { body: membershipPage(ordered.slice(3, 5), 'member-tail') });
        await act(async () => member.getCurrent().loadMore());
        await waitForHomeGovernance(() => expect(member.getCurrent().runIds).toHaveLength(4));
        const pages = [membershipPage(ordered.slice(0, 2), 'fresh-second'), membershipPage(ordered.slice(2, 4), 'fresh-third'),
            membershipPage(ordered.slice(5))];
        home.answer(serverId, route, { select: input => {
            const request = WorkflowRunListRequestV1Schema.parse(input && typeof input === 'object' && 'request' in input ? input.request : undefined);
            return { body: request.runIds ? membershipPage([]) : pages.shift() };
        } });
        await act(async () => publishHomeAccountChange(serverId, ['workflow-run:member-20']));
        await waitForHomeGovernance(() => expect(member.getCurrent().runIds).toEqual(ordered.filter(row => row.id !== 'member-20').map(row => row.id)));
        expect(storage.getState().workflowRunsById).toEqual({});
        expect(storage.getState().workflowRunListWindows[runWindowKey('attention')]?.frontier).toEqual({ id: 'member-10', createdAt: 10_000 });
        home.answer(serverId, route, { body: membershipPage([]) });
        await act(async () => publishHomeAccountChange(serverId, ['workflow-run:member-10']));
        await waitForHomeGovernance(() => expect(member.getCurrent().runIds).toEqual([]));
        expect(storage.getState().workflowRunListWindows[runWindowKey('attention')]?.frontier).toBeUndefined();
        expect(member.getCurrent().hasMore).toBe(false);
    });

    it('issues one full refresh for one wake while shell and row demand are both mounted', async () => {
        const summary = run('shared-wake');
        home.answer(serverId, route, { body: membershipPage([summary]) });
        const member = await renderHook(() => useWorkflowRunWindow('attention', { projection: 'membership' })); await waitLoaded(member);
        home.answer(serverId, route, { body: await runPage([summary]) });
        const full = await renderHook(() => useWorkflowRunWindow('attention')); await waitLoaded(full);
        expect(home.requestsFor(route)).toHaveLength(2);
        const pending = createDeferred<void>();
        const current = { ...summary, revision: summary.revision + 1 };
        home.answer(serverId, route, { body: await runPage([current]), respondAfter: pending.promise });
        await act(async () => publishHomeAccountChange(serverId, [`workflow-run:${summary.id}`]));
        await waitForHomeGovernance(() => expect(home.requestsFor(route)).toHaveLength(3));
        await act(async () => pending.resolve());
        await waitForHomeGovernance(() => expect(full.getCurrent().rows[0]?.summary?.revision).toBe(current.revision));
        expect(home.requestsFor(route)).toHaveLength(3);
    });

    it('replays the membership frontier through full pages without mixing projection-bound cursors', async () => {
        const ordered = [50, 40, 30, 20].map(value => createWorkflowRunSummaryFixture({ ...run(`frontier-${value}`),
            createdAt: new Date(value * 1000).toISOString() }));
        home.answer(serverId, route, { body: membershipPage(ordered.slice(1), 'compact-tail') });
        const member = await renderHook(() => useWorkflowRunWindow('attention', { projection: 'membership' }));
        await waitLoaded(member);
        const pages = [await runPage(ordered.slice(0, 2), 'full-second'), await runPage(ordered.slice(2), 'full-tail')];
        home.answer(serverId, route, { select: () => ({ body: pages.shift() }) });
        const full = await renderHook(() => useWorkflowRunWindow('attention')); await waitLoaded(full);
        expect(full.getCurrent().runIds).toEqual(ordered.map(row => row.id));
        expect(home.requestsFor(route).slice(1).map(request => request.input)).toEqual([
            expect.objectContaining({ request: expect.objectContaining({ attention: 'required', limit: expect.any(Number) }) }),
            expect.objectContaining({ request: expect.objectContaining({ attention: 'required', cursor: 'full-second', limit: expect.any(Number) }) }),
        ]);
        expect(storage.getState().workflowRunListWindows[runWindowKey('attention')]?.nextCursor).toBe('full-tail');
    });

    it('shares destination demand, keeps destinations distinct from origins, and avoids unrelated renders', async () => {
        const summary = createWorkflowRunSummaryFixture({ id: 'writes-here', ownerAccountId: accountId, origin: { kind: 'direct', originSessionId: 'another-session' } });
        const pending = createDeferred<void>();
        home.answer(serverId, route, { body: await runPage([summary], undefined, 'bot-session'), respondAfter: pending.promise });
        let renders = 0;
        const first = await renderHook(() => { renders++; return useWorkflowRunWindow('destination:bot-session'); });
        const second = await renderHook(() => useWorkflowRunWindow('destination:bot-session'));
        await waitForHomeGovernance(() => expect(home.requestsFor(route)).toHaveLength(1));
        expect(home.requestsFor(route)[0]?.input).toMatchObject({ request: { targetSessionId: 'bot-session', states: ['queued', 'claimed', 'running', 'pause_requested', 'paused', 'interrupted'] } });
        await act(async () => pending.resolve()); await waitLoaded(first);
        expect(first.getCurrent().runIds).toEqual(['writes-here']); expect(second.getCurrent().runIds).toBe(first.getCurrent().runIds);
        expect(first.getCurrent().rows[0]?.summary?.origin).toEqual(summary.origin);
        const windowSnapshot = first.getCurrent();
        await first.rerender();
        expect(first.getCurrent()).toBe(windowSnapshot);
        const ids = first.getCurrent().runIds; const before = renders;
        await act(async () => storage.getState().upsertWorkflowRuns([workflowRunRowFromSummary(run('unrelated'))]));
        expect(first.getCurrent().runIds).toBe(ids); expect(renders).toBe(before);
    });

    it('pages exact Automation history and retains its filter on continuation', async () => {
        home.answer(serverId, route, { body: await runPage([run('newest')], 'next') });
        const first = await renderHook(() => useWorkflowRunWindow('automation:habit')); await waitLoaded(first);
        const second = await renderHook(() => useWorkflowRunWindow('automation:habit'));
        home.answer(serverId, route, { body: await runPage([run('older')]) });
        await act(async () => first.getCurrent().loadMore());
        await waitForHomeGovernance(() => expect(second.getCurrent().runIds).toEqual(['newest', 'older']));
        expect(home.requestsFor(route).at(-1)?.input).toMatchObject({ request: { automationId: 'habit', cursor: 'next' } });
    });

    it.each(['all', 'active', 'attention', 'automationAttention'] as const)('renews %s demand and subsequent Home wakes after retirement', async windowId => {
        home.answer(serverId, route, { body: await runPage([run('run-0')]) });
        home.answer(serverId, '/v3/automations/runs', { body: { runs: [createAutomationRunFixture({ id: 'run-0', state: 'failed' })], nextCursor: null } });
        const hook = await renderHook(() => useWorkflowRunWindow(windowId)); await waitLoaded(hook);
        expect(hook.getCurrent().runIds).toContain('run-0');
        home.answer(serverId, route, { body: await runPage([run('run-1')]) });
        home.answer(serverId, '/v3/automations/runs', { body: { runs: [createAutomationRunFixture({ id: 'run-1', state: 'failed' })], nextCursor: null } });
        await act(async () => retireActiveServerAccountScopeLifetime());
        await waitForHomeGovernance(() => expect(hook.getCurrent().runIds).toContain('run-1'));
        home.answer(serverId, route, { body: await runPage([run('run-2')]) });
        home.answer(serverId, '/v3/automations/runs', { body: { runs: [createAutomationRunFixture({ id: 'run-2', state: 'failed' })], nextCursor: null } });
        await act(async () => publishHomeAccountChange(serverId, [windowId === 'automationAttention' ? 'automation:automation-1' : 'workflow-run:run-2']));
        await waitForHomeGovernance(() => expect(hook.getCurrent().runIds).toContain('run-2'));
    });

    it('does not restart disabled or unmounted Run windows on retirement and wakes', async () => {
        home.answer(serverId, route, { body: await runPage([]) });
        await renderHook(() => useWorkflowRunWindow('attention', { enabled: false }));
        const active = await renderHook(() => useWorkflowRunWindow('active')); await waitLoaded(active); await active.unmount();
        const before = home.requestsFor(route).length;
        await act(async () => { retireActiveServerAccountScopeLifetime(); publishHomeAccountChange(serverId, ['workflow-run:changed']); });
        expect(home.requestsFor(route)).toHaveLength(before);
    });

    it.each(['reactivation', 'restore'] as const)('replaces a pending %s read and refuses its late rows', async kind => {
        const retired = createDeferred<void>();
        home.answer(serverId, route, { body: await runPage([run('retired-run')]), respondAfter: retired.promise });
        const hook = await renderHook(() => useWorkflowRunWindow('all'));
        await waitForHomeGovernance(() => expect(home.requestsFor(route)).toHaveLength(1));
        home.answer(serverId, route, { body: await runPage([run('current-run')]) });
        if (kind === 'restore') await act(async () => retireActiveServerAccountScopeLifetime());
        else {
            await act(async () => storage.setState({ profileScope: null }));
            await act(async () => storage.setState({ profileScope: { serverId, accountId } }));
        }
        await waitLoaded(hook); expect(hook.getCurrent().runIds).toEqual(['current-run']);
        await act(async () => retired.resolve());
        expect(hook.getCurrent().runIds).toEqual(['current-run']); expect(storage.getState().workflowRunsById['retired-run']).toBeUndefined();
    });

    it('keeps one window\'s render scope local while another loads and while disabled', async () => {
        home.answer(serverId, route, { body: await runPage([run('window-run')]) });
        let renders = 0;
        const all = await renderHook((props: { enabled: boolean }) => { renders++; return useWorkflowRunWindow('all', props); }, { initialProps: { enabled: true } });
        await waitLoaded(all); const before = renders;
        const pending = createDeferred<void>();
        home.answer(serverId, route, { body: await runPage([]), respondAfter: pending.promise });
        await renderHook(() => useWorkflowRunWindow('active'));
        await act(async () => pending.resolve()); expect(renders).toBe(before);
        await all.rerender({ enabled: false }); const disabled = renders;
        await act(async () => storage.getState().upsertWorkflowRuns([workflowRunRowFromSummary(createWorkflowRunSummaryFixture({ ...run('window-run', 'succeeded'), revision: 2 }))]));
        expect(renders).toBe(disabled);
        home.answer(serverId, route, { body: await runPage([createWorkflowRunSummaryFixture({ ...run('window-run', 'succeeded'), revision: 2 })]) });
        await all.rerender({ enabled: true }); await waitLoaded(all);
        expect(all.getCurrent().rows[0]?.summary?.state).toBe('succeeded');
    });
});

describe('Automation attention through real HTTP and the shared Run store', () => {
    it.each([false, true])('rechecks a Home wake during the first read or continuation (%s)', async continuation => {
        const pending = createDeferred<void>();
        const failed = createAutomationRunFixture({ id: 'cleared', state: 'failed' });
        home.answer(serverId, '/v3/automations/runs', { body: { runs: continuation ? [] : [failed], nextCursor: continuation ? 'tail' : null }, ...(continuation ? {} : { respondAfter: pending.promise }) });
        const hook = await renderHook(() => useWorkflowRunWindow('automationAttention'));
        if (continuation) {
            await waitLoaded(hook);
            home.answer(serverId, '/v3/automations/runs', { body: { runs: [failed], nextCursor: null }, respondAfter: pending.promise });
            await act(async () => hook.getCurrent().loadMore());
        }
        await waitForHomeGovernance(() => expect(home.requests.filter(request => request.path.startsWith('/v3/automations/runs?'))).toHaveLength(continuation ? 2 : 1));
        home.answer(serverId, '/v3/automations/runs', { body: { runs: [], nextCursor: null } });
        await act(async () => publishHomeAccountChange(serverId, ['automation:automation-1']));
        await act(async () => pending.resolve());
        await waitForHomeGovernance(() => { expect(hook.getCurrent().status).toBe('loaded'); expect(hook.getCurrent().runIds).toEqual([]); });
        expect(hook.getCurrent().hasMore).toBe(false);
    });

    it('refreshes every loaded attention page, removing cleared failures while retaining older selection', async () => {
        const failed = (createdAt: number) => createAutomationRunFixture({ id: `run-${createdAt}`, createdAt, state: 'failed' });
        home.answer(serverId, '/v3/automations/runs', { body: { runs: [failed(40), failed(30)], nextCursor: 'next' } });
        const hook = await renderHook(() => useWorkflowRunWindow('automationAttention')); await waitLoaded(hook);
        home.answer(serverId, '/v3/automations/runs', { body: { runs: [failed(20), failed(10)], nextCursor: 'tail' } });
        await act(async () => hook.getCurrent().loadMore());
        await waitForHomeGovernance(() => expect(hook.getCurrent().runIds).toEqual(['run-40', 'run-30', 'run-20', 'run-10']));
        const pages = [{ runs: [failed(60), failed(50)], nextCursor: 'current-2' }, { runs: [failed(40), failed(30)], nextCursor: 'current-3' }, { runs: [failed(10), failed(5)], nextCursor: 'current-4' }];
        home.answer(serverId, '/v3/automations/runs', { select: () => ({ body: pages.shift() }) });
        await act(async () => hook.getCurrent().retry());
        await waitForHomeGovernance(() => expect(hook.getCurrent().runIds).toEqual(['run-60', 'run-50', 'run-40', 'run-30', 'run-10', 'run-5']));
        expect(storage.getState().workflowRunListWindows.automationAttention?.nextCursor).toBe('current-4');
        expect(home.requests.filter(request => request.path.startsWith('/v3/automations/runs?')).map(request => request.path)).toEqual([
            '/v3/automations/runs?limit=20&attention=required', '/v3/automations/runs?limit=20&cursor=next&attention=required',
            '/v3/automations/runs?limit=20&attention=required', '/v3/automations/runs?limit=20&cursor=current-2&attention=required',
            '/v3/automations/runs?limit=20&cursor=current-3&attention=required',
        ]);
    });

    it('shares attention, retains known rows on failure, and removes cleared rows on retry', async () => {
        const target = getActiveServerSnapshot();
        expect(() => apiSocket.createReadTransportForActiveServer({ endpoint: target.serverUrl,
            serverId: target.serverId, generation: target.generation })).not.toThrow();
        const failed = createAutomationRunFixture({ id: 'pre-session', state: 'failed', errorCode: 'machine_unavailable' });
        const pending = createDeferred<void>();
        home.answer(serverId, '/v3/automations/runs', { body: { runs: [failed], nextCursor: null }, respondAfter: pending.promise });
        const first = await renderHook(() => useWorkflowRunWindow('automationAttention'));
        const second = await renderHook(() => useWorkflowRunWindow('automationAttention'));
        await act(async () => pending.resolve()); await waitLoaded(first);
        expect(first.getCurrent().rows[0]?.automation).toEqual(failed); expect(second.getCurrent().rows[0]).toBe(first.getCurrent().rows[0]);
        expect(second.getCurrent().runIds).toBe(first.getCurrent().runIds);
        home.answer(serverId, '/v3/automations/runs', { status: 503, body: { error: 'storage_unavailable' } });
        await act(async () => first.getCurrent().retry());
        await waitForHomeGovernance(() => expect(first.getCurrent().status).toBe('failed')); expect(first.getCurrent().rows[0]?.automation).toEqual(failed);
        home.answer(serverId, '/v3/automations/runs', { body: { runs: [], nextCursor: null } });
        await act(async () => second.getCurrent().retry()); await waitLoaded(first); expect(first.getCurrent().rows).toEqual([]);
    });

    it('discards an old Account\'s late attention page after a real credential switch', async () => {
        const pending = createDeferred<void>();
        home.answer(serverId, '/v3/automations/runs', { body: { runs: [createAutomationRunFixture({ id: 'foreign-late', state: 'failed' })], nextCursor: null }, respondAfter: pending.promise });
        const hook = await renderHook(() => useWorkflowRunWindow('automationAttention'));
        await waitForHomeGovernance(() => expect(home.requests.filter(request => request.path.startsWith('/v3/automations/runs?'))).toHaveLength(1));
        home.answer(serverId, '/v3/automations/runs', { body: { runs: [], nextCursor: null } });
        await act(async () => { accountId = 'account-b'; await home.switchAccount(serverId, accountId); storage.setState({ profileScope: { serverId, accountId } }); });
        await waitLoaded(hook); await act(async () => pending.resolve());
        expect(hook.getCurrent().rows).toEqual([]); expect(storage.getState().workflowRunsById['foreign-late']).toBeUndefined();
    });

    it.each([[1, 1], [3, 4]])('joins %i definitions and %i Account Workflows with batch reads and one search', async (definitionCount, triggerCount) => {
        const [{ AutomationDefinitionDetailSchema}, { AutomationStoredWorkflowDefinitionRecipeV2Schema}] = await Promise.all([import('@happier-dev/protocol/automations/automationApiV3'), import('@happier-dev/protocol/automations/automationWorkflowRecipeV2')]);
        const { createWorkflowAutomationLastRunSummaryFixture } = await import('@/dev/testkit/fixtures/workflowRunFixtures');
        await storage.getState().activateSettingsScope({ serverId, accountId });
        storage.setState({ settingsVersion: 1 });
        const { resolveCollectionSpacesV1 } = await import('@happier-dev/protocol/collections/spaces/collectionSpacesV1');
        const { writeCollectionSpaceSelectionV1 } = await import('@/sync/domains/session/listing/sessionListSpaces');
        const defaultSpace = resolveCollectionSpacesV1(storage.getState().settings.collectionSpacesV1, 'workflow')[0]!;
        expect(await writeCollectionSpaceSelectionV1({ scope: { serverId, accountId }, entityKind: 'workflow', spaceId: defaultSpace.id,
            isCurrent: () => true, readSettings: () => storage.getState().settings })).toEqual({ ok: true });
        const ids = Array.from({ length: definitionCount }, (_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`);
        for (const [index, id] of ids.entries()) {
            await saved(id, `Saved ${index}`);
            const stored = home.artifacts(serverId).read(id)!;
            home.artifacts(serverId).replaceStoredRow({ ...stored, updatedAt: 10 + index });
        }
        const triggers = Array.from({ length: triggerCount }, (_, index) => AutomationDefinitionDetailSchema.parse({
            id: index === 0 ? ids[0] : `inline-${index}`, name: `Account workflow ${index}`, description: null,
            enabled: true, workflowDefinitionId: null, scopeSessionId: null, templateVersion: 1,
            targetType: null, existingSessionId: null, lastRunAt: null, createdAt: 1, updatedAt: 20 + index,
            assignments: [{ machineId: 'machine-one', enabled: true, priority: 0, updatedAt: 1 }], triggers: [],
            executionRecipe: AutomationStoredWorkflowDefinitionRecipeV2Schema.parse({ v: 2, templateVersion: 1,
                workflow: { t: 'plain', v: { workspace: { directory: '/repo' }, executionTarget: { kind: 'session' }, inlineDefinition: content } }, triggerEvidence: null }),
        }));
        home.answer(serverId, 'POST /v3/automations/query', { select: input => ({ body: {
            automations: input && typeof input === 'object' && 'scope' in input && input.scope === 'account_inline' ? triggers : [], nextCursor: null,
        } }) });
        const lastRun = createWorkflowAutomationLastRunSummaryFixture({ id: 'account-last-run', state: 'running',
            attentionRequired: true, invocationAttentionRequired: true });
        home.answer(serverId, route, { select: input => {
            const request = input && typeof input === 'object' && 'request' in input ? input.request : null;
            if (request && typeof request === 'object' && 'automationIds' in request && Array.isArray(request.automationIds)) return { body: {
                automationSummaries: request.automationIds.map(automationId => ({ automationId, lastRun })), remainingAutomationIds: [],
            } };
            return { body: { summaries: ids.map(sourceArtifactId => ({ sourceArtifactId, lastRun: null, recent: [], needsYouCount: 0, needsYouRunId: null })), remainingSourceArtifactIds: [] } };
        } });
        const readStart = home.requests.length;
        const hook = await renderHook(() => {
            const view = useWorkflowLibraryView(true);
            // The next renderer consumes this same read; mounting its incumbent editor must not
            // create another membership/options read or one read per Workflow row.
            const editor = useAccountWorkflowEditor({ read: view.accountWorkflows });
            return { ...view, editor };
        });
        await waitForHomeGovernance(() => expect(hook.getCurrent().libraryRows).toHaveLength(definitionCount + triggerCount));
        await waitForHomeGovernance(() => expect(hook.getCurrent().libraryRows[0]?.lastRunSummary?.lastRun).toMatchObject({ id: 'account-last-run' }));
        const rows = hook.getCurrent().libraryRows;
        expect(rows.map(row => row.name)).toEqual([
            ...[...triggers].reverse().map(row => row.name), ...[...ids].reverse().map((_id, index) => `Saved ${definitionCount - index - 1}`),
        ]);
        expect(new Set(rows.map(row => row.key)).size).toBe(rows.length);
        expect(rows[0]).toMatchObject({ triggerSummary: expect.any(String), openTarget: { kind: 'accountTrigger', automationId: triggers.at(-1)!.id } });
        expect(rows.at(-1)?.openTarget).toEqual({ kind: 'definition', definitionId: ids[0], href: `/workflows/${ids[0]}` });
        expect(hook.getCurrent().libraryCount).toBe(definitionCount + triggerCount);
        expect(hook.getCurrent().editor.popover).toBeNull();
        const inventories = () => home.requests.filter(request => request.path.startsWith('/v1/artifacts?') || request.path.startsWith('/v3/automations?') || request.path === '/v3/automations/query');
        expect(artifactInventoryReads()).toHaveLength(1);
        expect(inventories()).toHaveLength(3); // One definition page, its existing enrichment, and the selected Account-inline page.
        expect(home.requestsFor(route)).toHaveLength(2); // Existing source and Automation summary batches, never per row.
        const recordReads = home.requests.slice(readStart).filter(request => request.path.startsWith('/v1/artifacts') || request.path.startsWith('/v3/automations'));
        expect(recordReads).toHaveLength(6); // Also count the existing body batch, so N singleton detail reads cannot hide.
        expect(recordReads.filter(request => request.path === '/v1/artifacts/read')).toHaveLength(1);
        const before = home.requests.length;
        await act(async () => hook.getCurrent().setView('running'));
        expect(hook.getCurrent().visibleLibraryRows).toHaveLength(triggerCount);
        await act(async () => hook.getCurrent().setView('all'));
        await act(async () => hook.getCurrent().setSearchQuery('Account workflow'));
        await waitForHomeGovernance(() => expect(hook.getCurrent().visibleLibraryRows).toHaveLength(triggerCount));
        await act(async () => hook.getCurrent().setSearchQuery('Saved'));
        await waitForHomeGovernance(() => expect(hook.getCurrent().visibleLibraryRows).toHaveLength(definitionCount));
        expect(home.requests.length).toBe(before);
        const accountRow = rows.find(row => 'accountTrigger' in row);
        if (!accountRow || !('accountTrigger' in accountRow)) throw new Error('Expected the admitted Account Workflow');
        await act(async () => storage.getState().upsertWorkflowTriggerSet({ queryKey: 'account_inline', set: {
            ...accountRow.accountTrigger, name: 'Updated Account Workflow', revision: accountRow.accountTrigger.revision + 1,
        } }));
        expect(hook.getCurrent().libraryRows.find(row => row.key === accountRow.key)?.name).toBe('Updated Account Workflow');
        const unchangedDefinition = rows.find(row => 'definition' in row)!;
        expect(hook.getCurrent().libraryRows.find(row => row.key === unchangedDefinition.key)).toBe(unchangedDefinition);
        expect(home.requests.length).toBe(before);
        const { getPreferredLanguage, setPreferredLanguageFromSettings, preloadTranslations } = await import('@/text/i18n');
        const { formatTriggerSetSummary } = await import('../triggers/formatTriggerSummary');
        const language = getPreferredLanguage();
        const alternate = language === 'fr' ? 'en' : 'fr';
        const beforeLanguage = hook.getCurrent().libraryRows.find(row => row.key === accountRow.key)!.triggerSummary;
        await preloadTranslations(alternate);
        try {
            await act(async () => setPreferredLanguageFromSettings(alternate));
            expect(formatTriggerSetSummary([])).not.toBe(beforeLanguage);
            expect(hook.getCurrent().libraryRows.find(row => row.key === accountRow.key)!.triggerSummary).toBe(formatTriggerSetSummary([]));
            expect(home.requests.length).toBe(before);
        } finally {
            await act(async () => setPreferredLanguageFromSettings(language));
        }
        await act(async () => { await hook.getCurrent().editor.open(accountRow.openTarget, { current: null }); });
        expect(hook.getCurrent().editor.popover).not.toBeNull();
    });
});
