import * as React from 'react';
import { act } from 'react-test-renderer';
import { PluginUiScrollActivityProvider, type PluginUiScrollActivityTracker } from '@happier-dev/plugin-ui/advanced';
import { createNearViewportTracker, isSpanNearViewport } from '@/components/widgets/nearViewport';
import { t } from '@/text';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeferred, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createAutomationRunFixture, createWorkflowDefinitionFixture, createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { createMachineFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { observeMachinePresenceForTest } from '@/dev/testkit/harness/machinePresence';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { materializeWorkflowAcceptedSnapshotV1 } from '@happier-dev/protocol/workflows/materializeWorkflowAcceptedSnapshotV1';
import { sealWorkflowAcceptedSnapshotStoredEnvelopeV1, serializeWorkflowStoredContentEnvelopeV1 } from '@happier-dev/protocol/workflows/workflowStoredContentV1';
import { WorkflowRunRecipientCensusResponseV1Schema } from '@happier-dev/protocol/workflows/workflowRunKeyV1';
import { PluginProjectionV2Schema} from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { WorkflowTriggerSetV1Schema } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import { encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { deriveArtifactStoredKindV1 } from '@happier-dev/protocol/artifacts/artifactKindV1';
import { decodeBase64 } from '@/encryption/base64';
import { EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES } from '@happier-dev/protocol/actions/externalActionLimits';
import { WORKFLOW_DEFINITION_PLUGIN_CURSOR_PREFIX_V1, WorkflowRunListRequestV1Schema } from '@happier-dev/protocol/workflows/actionsV1';
import { TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1 } from '@happier-dev/protocol/changes';
import { deriveAutomationOccurrenceKeyV1 } from '@happier-dev/protocol/automations/automationOccurrenceV1';

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
const { createWorkflowDefinition, getWorkflowDefinition, listWorkflowDefinitions, updateWorkflowDefinition } = await import('@/sync/domains/workflows/workflowDefinitionActions');
const { ScheduledWorkflowRows } = await import('../triggers/ScheduledWorkflowSection');
const { projectScheduledWorkflowRows } = await import('../triggers/scheduledWorkflowRows');
const { listBuiltinWorkflowReferenceOptions, useWorkflowReferenceTitles } = await import('../presentation/workflowReferenceOptions');
const { useWorkflowDefinitionLibrary, useWorkflowPluginSource, useWorkflowRunWindow, refreshRunWindow, resetWorkflowLibraryReadsForTests } = await import('./workflowLibraryReads');
const { useWorkflowLibraryView } = await import('./useWorkflowLibraryView');
const { useAccountWorkflowEditor } = await import('../triggers/AccountTriggersSection');
const { WorkflowTriggerSection } = await import('../triggers/WorkflowTriggerSection');
const { WorkflowTriggerRunHistory } = await import('../triggers/WorkflowTriggerRunHistory');
const { WorkflowRunItemBody } = await import('@/components/sessions/shell/row/WorkflowRunItemBody');
const { EMPTY_WORKFLOW_TRIGGER_DRAFT } = await import('../triggers/workflowTriggerDraft');
const { useContextManagedWorkflowRuns, useSessionManagedWorkflowRuns } = await import('../run/useContextManagedWorkflowRuns');
const { clearDaemonMergedProjectionCacheForTests } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
const { publishMachineContributionRegistryProjectionInvalidation } = await import('@/sync/ops/machineContributionRegistryProjectionRevision');
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
    const result = await createWorkflowDefinition({ definitionId: id, definition: content, metadata: { title, ...(description ? { description } : {}) } });
    // These reader tests supply the committed-feed input explicitly. The composed
    // definition-change suite covers the real writer/socket/feed registration.
    publishHomeAccountChange(serverId, [id], { changeKinds: ['artifact'], feedPageConsumed: true });
    return result;
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
const runWindowKey = (id: Parameters<typeof workflowRunListWindowStoreKey>[0]) => {
    const scope = storage.getState().profileScope;
    if (!scope) throw new Error('Expected a bound Home');
    return workflowRunListWindowStoreKey(id, scope);
};

it('lists a fired Once Run while its accepted snapshot is pending, then opens initialized content', async () => {
    const trigger = { kind: 'schedule' as const, schedule: { kind: 'once' as const, scheduleExpr: null,
        everyMs: null, timezone: 'UTC' }, remainingOccurrences: 0 };
    const pending = createWorkflowRunSummaryFixture({ id: 'fired-once', ownerAccountId: accountId,
        state: 'claimed', workflowCustodyState: 'pending', origin: { kind: 'automation', automationId: 'once',
            cause: { kind: 'trigger', triggerId: 'once-trigger', triggerRevision: 0, triggerKind: 'schedule',
                occurrenceKey: deriveAutomationOccurrenceKeyV1({ triggerId: 'once-trigger', evidence: { v: 1, kind: 'schedule', scheduledFor: 1 } }),
                occurredAt: 1, evidence: { scheduledFor: 1 } } } });
    home.answer(serverId, route, { body: { runs: [pending], acceptedEnvelopesByRunId: {},
        keyCensusByRunId: { [pending.id]: WorkflowRunRecipientCensusResponseV1Schema.parse({ runId: pending.id,
            ownerAccountId: accountId, access: 'owner', encryptionMode: 'plain', dataEncryptionKey: null,
            callerDataEncryptionKey: null, recipients: [], visibleTeamId: null,
            ownerAccountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }) } } });
    const screen = await renderScreen(<WorkflowTriggerRunHistory automationId="once" triggerId="once-trigger"
        triggerName="One-time work" trigger={trigger} />);
    await waitForHomeGovernance(() => expect(screen.findAll(node => node.type === WorkflowRunItemBody)).toHaveLength(1));
    await waitForHomeGovernance(() => expect(storage.getState().workflowRunsById[workflowRunStoreKey(pending.id,
        { serverId, accountId })]?.summary?.state).toBe('claimed'));
    expect(screen.getTextContent()).toContain('One-time work');
    expect(screen.getTextContent()).not.toContain(t('workflows.contentUnavailable'));
    expect(screen.getTextContent()).not.toContain(t('workflows.readState.historyTitle'));
    home.answer(serverId, route, { body: await runPage([{ ...pending, state: 'running', revision: 2 }], undefined, undefined, 'Initialized work') });
    await act(async () => refreshRunWindow('trigger:once-trigger', true));
    await waitForHomeGovernance(() => expect(screen.getTextContent()).toContain('Initialized work'));
});

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
            <WorkflowTriggerSection accountLifetime={account.accountLifetime} workflowDefinitionId={definitionId}
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

it.each(['later-schedule', 'disabled-schedule', 'event', 'older-summary'] as const)('shows only the exact shared trigger occurrence in History (%s)', async kind => {
    await saved();
    const workflowNextRunAt = Date.now() + 3_600_000;
    const triggerNextRunAt = kind === 'later-schedule' ? workflowNextRunAt + 7 * 86_400_000 : null;
    home.answer(serverId, 'POST /v3/automations/query', { body: {
        automations: [], nextCursor: null,
        sharedWorkflowSummaries: [{ workflowDefinitionId: definitionId, nextRunAt: workflowNextRunAt, triggers: [
            kind === 'event' ? {
                automationId: 'team-owner-automation', triggerId: 'team-schedule', kind: 'pluginEvent',
                eventRef: { pluginId: 'test-events', localId: 'changed' },
            } : {
                automationId: 'team-owner-automation', triggerId: 'team-schedule', kind: 'schedule',
                schedule: { kind: 'cron', scheduleExpr: '0 9 * * *', everyMs: null, timezone: 'UTC' },
                ...(kind === 'older-summary' ? {} : { nextRunAt: triggerNextRunAt }),
            },
        ] }],
    } });
    home.answer(serverId, route, { select: input => {
        const operation = input && typeof input === 'object' && 'operation' in input ? input.operation : null;
        if (operation !== 'list') throw new Error('Trigger History must use the canonical Run list');
        return { body: { runs: [], acceptedEnvelopesByRunId: {}, keyCensusByRunId: {} } };
    } });
    const screen = await renderScreen(<WorkflowTriggerSection workflowDefinitionId={definitionId}
        testIDPrefix="team-workflow" set={null} draft={EMPTY_WORKFLOW_TRIGGER_DRAFT} onChangeDraft={() => {}}
        status="ready" onRetry={() => {}} stepsUnsaved={false}
        whereTarget={null} whereSummary={null} inputs={[]} />);
    const historyId = 'team-workflow-trigger:team-owner-automation:team-schedule-history';
    await waitForHomeGovernance(() => expect(screen.findHostByTestId(historyId)).not.toBeNull());
    expect(screen.findByTestId('team-workflow-triggers-manual')).toBeNull();
    expect(artifactInventoryReads()).toHaveLength(0);
    expect(home.requestsFor(route)).toHaveLength(0);
    await screen.pressByTestIdAsync(historyId);
    await waitForHomeGovernance(() => expect(home.requestsFor(route)).toHaveLength(1));
    expect(home.requestsFor(route)[0]?.input).toMatchObject({ operation: 'list', request: { triggerId: 'team-schedule' } });
    await waitForHomeGovernance(() => expect(screen.getTextContent()).toContain(t('workflows.empty.runsTitle')));
    const { formatNextScheduledRun } = await import('../triggers/formatTriggerSummary');
    expect(screen.getTextContent()).not.toContain(formatNextScheduledRun(workflowNextRunAt));
    if (triggerNextRunAt !== null) expect(screen.getTextContent()).toContain(formatNextScheduledRun(triggerNextRunAt));
});

const artifactInventoryReads = () => home.requests.filter(request => request.input === null
    && new URL(request.path, request.serverUrl).pathname === '/v1/artifacts');

it('refreshes only changed saved Flow children and retains their unchanged siblings and last good preview', async () => {
    await saved(); await saved(secondId, 'Second');
    const { useWorkflowFlowChildren } = await import('../flow/useWorkflowFlowChildren');
    const parent = createWorkflowDefinitionFixture({ blocks: [definitionId, secondId].map((workflowRef, index) => ({
        kind: 'workflow' as const, id: `child-${index}`, workflowRef, input: {},
    })) });
    const hook = await renderHook(() => useWorkflowFlowChildren(parent, true));
    await waitForHomeGovernance(() => expect(Object.keys(hook.getCurrent().children)).toHaveLength(2));
    const initial = hook.getCurrent().children;
    const bodyReads = () => home.requests.filter(request => [definitionId, secondId]
        .some(id => new URL(request.path, request.serverUrl).pathname === `/v1/artifacts/${id}`));
    const before = bodyReads().length;
    await act(async () => {
        for (const id of ['unrelated-a', 'unrelated-b', 'unrelated-c']) {
            publishHomeAccountChange(serverId, [id], { changeKinds: ['artifact'], feedPageConsumed: true });
        }
    });
    expect(bodyReads()).toHaveLength(before);
    expect(hook.getCurrent().children).toBe(initial);
    const changed = createWorkflowDefinitionFixture({ blocks: [{ kind: 'wait', id: 'changed',
        document: { text: 'Changed', references: [], attachments: [] } }] });
    const stored = home.artifacts(serverId).read(definitionId)!;
    const revision = { headerVersion: stored.headerVersion + 1, bodyVersion: stored.bodyVersion! + 1 };
    // A remote revision cannot reuse the earlier body's bound attribution.
    home.artifacts(serverId).replaceStoredRow({ ...stored, ...revision, provenance: null, provenanceDataEncryptionKey: null,
        header: encodePlainArtifactStoredContent({ kind: 'workflow-definition.v1', definitionId, revision, metadata: { title: 'Saved' } }),
        body: encodePlainArtifactStoredContent({ body: JSON.stringify({ kind: 'workflow-definition.v1', definition: changed }) }) });
    const beforeRelevant = bodyReads().length;
    await act(async () => publishHomeAccountChange(serverId, [definitionId], { changeKinds: ['artifact'], feedPageConsumed: true }));
    await waitForHomeGovernance(() => expect(hook.getCurrent().children[definitionId]).toEqual(changed));
    expect(bodyReads()).toHaveLength(beforeRelevant + 1);
    expect(hook.getCurrent().children[secondId]).toBe(initial[secondId]);
    const good = hook.getCurrent().children;
    home.answer(serverId, `/v1/artifacts/${definitionId}`, { status: 503, body: { error: 'storage_unavailable' } });
    await act(async () => publishHomeAccountChange(serverId, [definitionId], { changeKinds: ['artifact'], feedPageConsumed: true }));
    await waitForHomeGovernance(() => expect(hook.getCurrent().problem).not.toBeNull());
    expect(hook.getCurrent().children).toBe(good);
});

it('ignores unclassified Artifact deletion receipts and keeps explicit Workflow deletion landing feedback before a list', async () => {
    const { deleteWorkflowDefinition } = await import('@/sync/domains/workflows/workflowDefinitionActions');
    await saved();
    // The Workflow domain follows acknowledgements before the library's first demand.
    publishHomeAccountChange(serverId, ['ordinary-document'], { source: 'socket', changeKinds: ['artifact'],
        workflowDefinitionsAffect: false });
    const hook = await renderHook(() => useWorkflowDefinitionLibrary());
    await waitLoaded(hook);
    expect(hook.getCurrent().deletedDefinitionId).toBeNull();
    await hook.unmount();
    resetWorkflowLibraryReadsForTests();
    const { Modal } = await import('@/modal');
    const confirmation = vi.spyOn(Modal, 'confirm').mockResolvedValue(true);
    try {
        await act(async () => { await deleteWorkflowDefinition({ definitionId, title: 'Saved' }); });
        const landed = await renderHook(() => useWorkflowDefinitionLibrary());
        expect(landed.getCurrent().deletedDefinitionId).toBe(definitionId);
        expect(landed.getCurrent().deletedDefinitionTitle).toBe('Saved');
    } finally { confirmation.mockRestore(); }
});
const artifactHeaderRoute = '/v1/artifacts?limit=500&kinds=%5B%22workflow-definition.v1%22%5D';

function pluginMachine(id: string, owningAccountId = accountId) {
    return createMachineFixture({ id, activeAt: Date.now(),
        access: createPlainMachineRowFixture({ id, accountId: owningAccountId }).access,
        daemonState: { status: 'running', pid: 17, contributionRegistryProjectionRevision: 0 } });
}

describe('unified Workflow Library', () => {
    it('FIN B2 withdraws retained rows when an explicitly addressed Account lifetime retires', async () => {
        storage.setState({ settings: { ...storage.getState().settings, experiments: true, featureToggles: { automations: true } } });
        const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime) throw new Error('Missing Account lifetime');
        const summary = run('addressed-run');
        home.answer(serverId, route, { body: await runPage([summary]) });
        const hook = await renderHook(() => useContextManagedWorkflowRuns({ resource: { kind: 'discussion', id: 'addressed' },
            serverId, accountLifetime: lifetime }));
        await waitForHomeGovernance(() => expect(hook.getCurrent().runs).toHaveLength(1));
        await act(async () => retireActiveServerAccountScopeLifetime());
        expect(hook.getCurrent().runs).toEqual([]);
        expect(hook.getCurrent().lastSuccessfulReadAt).toBeNull();
        expect(hook.getCurrent().phase).toBe('failed');
    });

    it('FIN B2 shares the complete Session read when transcript mounts after Work at 1,000 Runs', async () => {
        storage.setState({ settings: { ...storage.getState().settings, experiments: true, featureToggles: { automations: true } } });
        const summaries = Array.from({ length: 1000 }, (_, index) => createWorkflowRunSummaryFixture({
            ...run(`context-${index}`), origin: { kind: 'direct', originSessionId: 'context-session' },
        }));
        const pending = createDeferred<void>();
        home.answer(serverId, route, { body: await runPage(summaries), respondAfter: pending.promise });
        const work = await renderHook(() => useSessionManagedWorkflowRuns({ sessionId: 'context-session', serverId }));
        await act(async () => pending.resolve());
        await waitForHomeGovernance(() => expect(work.getCurrent().phase).toBe('loaded'));
        const transcript = await renderHook(() => useSessionManagedWorkflowRuns({ sessionId: 'context-session', serverId }));
        await waitForHomeGovernance(() => expect(transcript.getCurrent().runs).toHaveLength(summaries.length));
        expect(home.requestsFor(route)).toHaveLength(1);
    });

    it('FIN B2 reads only changed Session Run identities and consumes materialized unrelated pushes without reads', async () => {
        storage.setState({ settings: { ...storage.getState().settings, experiments: true, featureToggles: { automations: true } } });
        const summaries = Array.from({ length: 1000 }, (_, index) => createWorkflowRunSummaryFixture({
            ...run(`context-${index}`), origin: { kind: 'direct', originSessionId: 'context-session' },
        }));
        let page = await runPage(summaries);
        let servedRows = 0;
        home.answer(serverId, route, { select: input => {
            const request = WorkflowRunListRequestV1Schema.parse(input && typeof input === 'object' ? Reflect.get(input, 'request') : null);
            const runs = request.runIds ? page.runs.filter(row => request.runIds?.includes(row.id)) : page.runs;
            servedRows += runs.length;
            return { body: { ...page, runs } };
        } });
        const hook = await renderHook(() => useSessionManagedWorkflowRuns({ sessionId: 'context-session', serverId }));
        await waitForHomeGovernance(() => expect(hook.getCurrent().runs).toHaveLength(summaries.length));
        const initial = home.requestsFor(route).length;
        const initiallyServed = servedRows;
        const changed = { ...summaries[0]!, revision: 2, attentionRequired: true, invocationAttentionRequired: true };
        page = await runPage([changed, ...summaries.slice(1)]);
        await act(async () => publishHomeAccountChange(serverId, [`workflow-run:${changed.id}`]));
        await waitForHomeGovernance(() => expect(hook.getCurrent().runs[0]?.revision).toBe(2));
        expect(home.requestsFor(route).length - initial).toBe(1);
        expect(servedRows - initiallyServed).toBe(1);
        expect(home.requestsFor(route).at(-1)?.input).toMatchObject({ request: { originSessionId: 'context-session', runIds: [changed.id] } });
        expect(hook.getCurrent().runs).toHaveLength(summaries.length);
        expect(hook.getCurrent().attentionRunIds.has(changed.id)).toBe(true);
        const materialized = { ...changed, revision: 3, attentionRequired: false, invocationAttentionRequired: false };
        const beforeMaterialized = home.requestsFor(route).length;
        await act(async () => {
            storage.getState().upsertWorkflowRuns([workflowRunRowFromSummary(materialized)]);
            publishHomeAccountChange(serverId, [`workflow-run:${changed.id}`], { workflowRunsMaterialized: true });
        });
        await waitForHomeGovernance(() => expect(hook.getCurrent().runs[0]?.revision).toBe(3));
        expect(hook.getCurrent().attentionRunIds.has(changed.id)).toBe(false);
        expect(home.requestsFor(route)).toHaveLength(beforeMaterialized);
        const beforeUnrelated = home.requestsFor(route).length;
        const beforeUnrelatedState = hook.getCurrent();
        for (let index = 0; index < 10; index++) {
            const unrelated = createWorkflowRunSummaryFixture({ ...run(`elsewhere-${index}`),
                origin: { kind: 'direct', originSessionId: 'another-session' } });
            await act(async () => {
                storage.getState().upsertWorkflowRuns([workflowRunRowFromSummary(unrelated)]);
                publishHomeAccountChange(serverId, [`workflow-run:${unrelated.id}`], { workflowRunsMaterialized: true });
            });
        }
        expect(home.requestsFor(route)).toHaveLength(beforeUnrelated);
        expect(hook.getCurrent()).toBe(beforeUnrelatedState);
    });

    it.each(['origin', 'destination'] as const)('reads a complete %s Session relation once and derives changing attention from its admitted summaries', async relation => {
        const sessionId = 'context-session';
        const summary = createWorkflowRunSummaryFixture({ id: 'context-run', ownerAccountId: accountId,
            origin: { kind: 'direct', originSessionId: relation === 'origin' ? sessionId : 'other-session' } });
        storage.setState({ settings: { ...storage.getState().settings, experiments: true,
            featureToggles: { automations: true } } });
        const destination = relation === 'destination' ? sessionId : undefined;
        const serveRelation = async (current: typeof summary) => {
            const all = await runPage([current], undefined, destination);
            const empty = await runPage([]);
            home.answer(serverId, route, { select: input => {
                const request = WorkflowRunListRequestV1Schema.parse(input && typeof input === 'object' ? Reflect.get(input, 'request') : null);
                return { body: request.attention === 'required' && !current.attentionRequired ? empty : all };
            } });
        };
        await serveRelation(summary);
        const hook = await renderHook(() => useSessionManagedWorkflowRuns({ sessionId, serverId, relation }));
        await waitForHomeGovernance(() => expect(hook.getCurrent().phase).toBe('loaded'));
        expect(hook.getCurrent().runs.map(row => row.id)).toEqual([summary.id]);
        expect([...hook.getCurrent().attentionRunIds]).toEqual([]);
        expect(home.requestsFor(route)).toHaveLength(1);
        expect(home.requestsFor(route)[0]?.input).toMatchObject({ request: relation === 'origin'
            ? { originSessionId: sessionId } : { targetSessionId: sessionId } });

        const changed = { ...summary, revision: summary.revision + 1, attentionRequired: true, invocationAttentionRequired: true };
        await serveRelation(changed);
        await act(async () => publishHomeAccountChange(serverId, [`workflow-run:${summary.id}`]));
        await waitForHomeGovernance(() => expect(hook.getCurrent().attentionRunIds.has(summary.id)).toBe(true));
        expect(hook.getCurrent().runs[0]?.revision).toBe(changed.revision);
        expect(home.requestsFor(route)).toHaveLength(2);

        await serveRelation({ ...changed, revision: changed.revision + 1, attentionRequired: false, invocationAttentionRequired: false });
        await act(async () => publishHomeAccountChange(serverId, [`workflow-run:${summary.id}`]));
        await waitForHomeGovernance(() => expect(hook.getCurrent().attentionRunIds.size).toBe(0));
        expect(home.requestsFor(route)).toHaveLength(3);
    });

    it.each([[1, 1], [3, 4]])('joins %i definitions and %i Account Workflows with batch reads and one search', async (definitionCount, triggerCount) => {
        const [{ AutomationDefinitionDetailSchema}, { AutomationStoredWorkflowDefinitionRecipeV2Schema}] = await Promise.all([import('@happier-dev/protocol/automations/automationApiV3'), import('@happier-dev/protocol/automations/automationWorkflowRecipeV2')]);
        const { createWorkflowAutomationLastRunSummaryFixture } = await import('@/dev/testkit/fixtures/workflowRunFixtures');
        await storage.getState().activateSettingsScope({ serverId, accountId });
        storage.setState({ settingsVersion: 1 });
        const { resolveCollectionSpacesV1 } = await import('@happier-dev/protocol/collections/spaces/collectionSpacesV1');
        const { selectCollectionSpace } = await import('@/sync/domains/session/listing/sessionListSpaces');
        const defaultSpace = resolveCollectionSpacesV1(storage.getState().settings.collectionSpacesV1, 'workflow')[0]!;
        expect(await selectCollectionSpace({ serverId, accountId }, 'workflow', defaultSpace.id)).toBeUndefined();
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
        expect(inventories()).toHaveLength(4); // One definition page, its existing enrichment, the selected Account-inline page and the Account census for retained triggers.
        expect(home.requestsFor(route)).toHaveLength(2); // Existing source and Automation summary batches, never per row.
        const recordReads = home.requests.slice(readStart).filter(request => request.path.startsWith('/v1/artifacts') || request.path.startsWith('/v3/automations'));
        // Every record read is counted, so N singleton detail reads cannot hide. The list is
        // header-only (rows carry `previewSteps`), so it opens no definition bodies.
        expect(recordReads).toHaveLength(6);
        expect(recordReads.filter(request => request.path === '/v1/artifacts/read')).toHaveLength(0);
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

function externalWorkflowProjection() {
    return { protocolVersion: 1, projection: PluginProjectionV2Schema.parse({ v: 2, generation: 1,
        installedPackagesById: { 'external.recipe': { id: 'external.recipe', displayName: 'Recipe', version: '1.2.3', enabled: true,
            source: { kind: 'path', locator: '/plugins/external.recipe' } } },
        familiesById: { workflows: { family: 'workflows', entriesById: { 'external.recipe/review': {
            id: 'external.recipe/review', pluginId: 'external.recipe', pluginVersion: '1.2.3',
            definition: { id: 'review', title: 'Exact plugin workflow', definition: content },
        } } } },
    }) };
}

describe('Workflow library reads through real Account Actions and HTTP', () => {
    it('Retry supersedes a pending definition read and departing demand cancels its replacement', async () => {
        const held = createDeferred<void>();
        const signals: (AbortSignal | null | undefined)[] = [];
        home.answer(serverId, artifactHeaderRoute, { select: async (_input, request) => {
            signals.push(request.signal);
            return { respondAfter: held.promise, body: await artifactHeaderPage() };
        } });
        const hook = await renderHook(() => useWorkflowDefinitionLibrary());
        await waitForHomeGovernance(() => expect(signals).toHaveLength(1));
        await act(async () => hook.getCurrent().retry());
        await waitForHomeGovernance(() => expect(signals).toHaveLength(2));
        expect(signals[0]?.aborted).toBe(true);
        await hook.unmount();
        expect(signals[1]?.aborted).toBe(true);
        await act(async () => held.resolve());
    });

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

    it('opens one external plugin workflow without reading the saved definition library', async () => {
        await storage.getState().activateSettingsScope({ serverId, accountId });
        await saved();
        const boundary = home.artifacts(serverId);
        const template = boundary.read(definitionId)!;
        for (let index = 1; index <= 2000; index++) {
            const id = `00000000-0000-4000-8000-${String(index + 10).padStart(12, '0')}`;
            boundary.replaceStoredRow({ ...template, id, header: encodePlainArtifactStoredContent({
                kind: 'workflow-definition.v1', definitionId: id, revision: { headerVersion: 1, bodyVersion: 1 },
                metadata: { title: `Unrelated saved workflow ${index}` },
            }) });
        }
        storage.getState().applyMachines([pluginMachine('exact-plugin-machine')], true, { sourceServerId: serverId });
        observeMachinePresenceForTest({ serverId, accountId }, ['exact-plugin-machine']);
        machineRpc.mockResolvedValue(externalWorkflowProjection());
        const before = artifactInventoryReads().length;
        const hook = await renderHook(() => useWorkflowPluginSource('plugin:external.recipe/review'));
        await waitForHomeGovernance(() => expect(hook.getCurrent().status).toBe('ready'));
        expect(hook.getCurrent().source?.title).toBe('Exact plugin workflow');
        expect(artifactInventoryReads()).toHaveLength(before);
    });

    it('settles an unavailable plugin without scanning saved bodies and cancels disabled demand', async () => {
        await saved();
        const before = artifactInventoryReads().length;
        const hook = await renderHook((props: { enabled: boolean }) => useWorkflowPluginSource('plugin:external.recipe/missing', props.enabled),
            { initialProps: { enabled: false } });
        expect(hook.getCurrent().status).toBe('idle');
        expect(artifactInventoryReads()).toHaveLength(before);
        await hook.rerender({ enabled: true });
        await waitForHomeGovernance(() => expect(hook.getCurrent().status).toBe('missing'));
        expect(artifactInventoryReads()).toHaveLength(before);
    });

    it.each(['disable', 'account'] as const)('withdraws pending exact plugin demand on %s before its late reply', async change => {
        await storage.getState().activateSettingsScope({ serverId, accountId });
        storage.getState().applyMachines([pluginMachine('pending-plugin-machine')], true, { sourceServerId: serverId });
        observeMachinePresenceForTest({ serverId, accountId }, ['pending-plugin-machine']);
        const pending = createDeferred<ReturnType<typeof externalWorkflowProjection>>();
        machineRpc.mockReturnValue(pending.promise);
        const hook = await renderHook((props: { enabled: boolean }) => useWorkflowPluginSource('plugin:external.recipe/review', props.enabled),
            { initialProps: { enabled: true } });
        await waitForHomeGovernance(() => expect(machineRpc).toHaveBeenCalled());
        if (change === 'disable') await hook.rerender({ enabled: false });
        else await act(async () => {
            accountId = 'account-b';
            await home.switchAccount(serverId, accountId);
            storage.setState({ profileScope: { serverId, accountId }, machines: {}, machineListByServerId: {} });
        });
        await act(async () => pending.resolve(externalWorkflowProjection()));
        expect(hook.getCurrent().source).toBeNull();
        expect(hook.getCurrent().status).not.toBe('ready');
        expect(artifactInventoryReads()).toHaveLength(0);
    });

    it('does not restart held definition inventory for unrelated Home wakes and still rechecks relevant changes once', async () => {
        await saved();
        const session = createSessionFixture({ id: 'session-library-independent', serverId, active: false,
            metadata: { machineId: 'machine-a', path: '/repo', host: 'test', homeDir: '/home/test' } });
        storage.getState().applySessions([session]);
        const pending = createDeferred<void>();
        const started = createDeferred<AbortSignal | null>();
        const page = await artifactHeaderPage();
        home.answer(serverId, 'GET /v1/artifacts', { select: (_input, request) => {
            started.resolve(request.signal ?? null);
            return { body: page, respondAfter: pending.promise };
        } });
        const hook = await renderHook(() => useWorkflowDefinitionLibrary());
        try {
            await waitForHomeGovernance(() => expect(artifactInventoryReads()).toHaveLength(1));
            const physicalSignal = await started.promise;
            expect(physicalSignal).not.toBeNull();
            for (const kind of ['session', 'discussion', 'feed'] as const) {
                await act(async () => {
                    storage.getState().applySessions([{ ...session }]);
                    publishHomeAccountChange(serverId, [session.id], { changeKinds: [kind] });
                });
                expect(hook.getCurrent().status).toBe('loading');
                expect(artifactInventoryReads()).toHaveLength(1);
                expect(physicalSignal?.aborted).toBe(false);
            }
            await act(async () => pending.resolve());
            await waitLoaded(hook);
            const initial = artifactInventoryReads().length;
            expect(initial).toBe(1);
            const before = hook.getCurrent().definitions;
            expect(before.map(row => row.definitionId)).toEqual([definitionId]);
            await act(async () => {
                publishHomeAccountChange(serverId, ['session:unrelated'], { changeKinds: ['session'] });
            });
            await waitLoaded(hook);
            expect(artifactInventoryReads()).toHaveLength(initial);
            expect(hook.getCurrent().definitions).toBe(before);
            await act(async () => {
                await saved(secondId);
            });
            await waitForHomeGovernance(() => expect(hook.getCurrent().definitions.map(row => row.definitionId)).toContain(secondId));
            expect(artifactInventoryReads()).toHaveLength(initial);
            await waitLoaded(hook);
            await act(async () => { publishHomeAccountChange(serverId); });
            await waitForHomeGovernance(() => expect(artifactInventoryReads()).toHaveLength(initial + 1));
        } finally {
            await act(async () => pending.resolve());
            await hook.unmount();
        }
    });

    it('does zero library rechecks for Discussion wakes and reads one real definition change', async () => {
        await saved();
        const hook = await renderHook(() => useWorkflowDefinitionLibrary());
        await waitLoaded(hook);
        const initial = artifactInventoryReads().length;
        await act(async () => {
            for (const kind of ['discussion', 'feed', 'session'] as const) {
                publishHomeAccountChange(serverId, ['unrelated-row'], { source: 'socket', changeKinds: [kind] });
            }
            await saved(secondId);
        });
        // The real writer settles the following relevant refresh. A recheck queued
        // by an unrelated wake cannot hide behind an unchanged 'loaded' status.
        await waitForHomeGovernance(() => expect(hook.getCurrent().definitions.map(row => row.definitionId)).toContain(secondId));
        expect(artifactInventoryReads()).toHaveLength(initial);
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
        storage.getState().applyMachines([pluginMachine('title-machine')], true, { sourceServerId: serverId });
        observeMachinePresenceForTest({ serverId, accountId }, ['title-machine']);
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
        await act(async () => {
            storage.getState().applyMachines([
                { ...pluginMachine('title-machine'), active: false, activeAt: 0 },
                pluginMachine('successor-title-machine'),
            ], true, { sourceServerId: serverId });
            observeMachinePresenceForTest({ serverId, accountId }, ['title-machine', 'successor-title-machine']);
        });
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

    it('names an addressed closed picker from B admitted plugin projection without inventory or another RPC', async () => {
        await storage.getState().activateSettingsScope({ serverId, accountId });
        const serverB = await home.addHome({ name: 'B plugin titles', serverUrl: 'https://workflow-plugin-title-b.test',
            accountId: 'account-b', active: false, currentAccount: true });
        storage.getState().applyMachines([pluginMachine('b-title-machine', 'account-b')], true, { sourceServerId: serverB });
        observeMachinePresenceForTest({ serverId: serverB, accountId: 'account-b' }, ['b-title-machine']);
        machineRpc.mockResolvedValue({ protocolVersion: 1, projection: PluginProjectionV2Schema.parse({ v: 2, generation: 1,
            installedPackagesById: { 'example.recipe': { id: 'example.recipe', displayName: 'Recipe', version: '1.2.3', enabled: true,
                source: { kind: 'path', locator: '/plugins/example.recipe' } } },
            familiesById: { workflows: { family: 'workflows', entriesById: { 'example.recipe/review': {
                id: 'example.recipe/review', pluginId: 'example.recipe', pluginVersion: '1.2.3',
                definition: { id: 'review', title: 'B admitted plugin', definition: content },
            } } } },
        }) });
        const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
        const account = await captureLazyActionAccountContext(serverB);
        try {
            const ref = 'plugin:example.recipe/review';
            const admitted = await listWorkflowDefinitions({ workflow: ref, accountLifetime: account.accountLifetime });
            expect(admitted.pluginWorkflows?.[0]?.title).toBe('B admitted plugin');
            const { useTriggerThenOptions } = await import('../triggers/useTriggerThenOptions');
            const sets = [WorkflowTriggerSetV1Schema.parse({ automationId: 'addressed-plugin-habit', revision: 1,
                enabled: true, health: 'available', target: { kind: 'workflow', ref }, triggers: [] })];
            const before = artifactInventoryReads().length;
            const rpcBefore = machineRpc.mock.calls.length;
            const hook = await renderHook(() => useTriggerThenOptions({ libraryEnabled: false,
                accountLifetime: account.accountLifetime, sets }));
            await waitForHomeGovernance(() => expect(hook.getCurrent().resolveWorkflowTitle(ref)).toBe('B admitted plugin'));
            expect(hook.getCurrent().workflowOptions).toEqual([]);
            expect(artifactInventoryReads()).toHaveLength(before);
            expect(machineRpc).toHaveBeenCalledTimes(rpcBefore);
            expect(storage.getState().settingsScope).toEqual({ serverId, accountId: 'account-a' });
        } finally { account.dispose(); }
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
            const bContent = createWorkflowDefinitionFixture({ blocks: [{ kind: 'wait', id: 'b-child',
                document: { text: 'B child', references: [], attachments: [] } }] });
            await createWorkflowDefinition({ definitionId, definition: bContent, metadata: { title: 'B workflow' }, accountLifetime: account.accountLifetime });
            const active = await renderHook(() => useWorkflowDefinitionLibrary());
            const addressed = await renderHook(() => useWorkflowDefinitionLibrary({ accountLifetime: account.accountLifetime }));
            await waitLoaded(active); await waitLoaded(addressed);
            expect(active.getCurrent().definitions[0]?.metadata?.title).toBe('A workflow');
            expect(addressed.getCurrent().definitions[0]?.metadata?.title).toBe('B workflow');
            const { useTriggerThenOptions } = await import('../triggers/useTriggerThenOptions');
            const sets = [WorkflowTriggerSetV1Schema.parse({ automationId: 'addressed-habit', revision: 1,
                enabled: true, health: 'available', target: { kind: 'workflow', ref: definitionId }, triggers: [] })];
            const exactHeaders = () => home.requests.filter(request => new URL(request.path, request.serverUrl).pathname === '/v1/artifacts/read'
                && request.input !== null && typeof request.input === 'object' && 'projection' in request.input
                && request.input.projection === 'headers');
            const inventoryBeforeLabels = artifactInventoryReads().length;
            const headersBeforeLabels = exactHeaders().length;
            const labels = await renderHook(() => useTriggerThenOptions({ libraryEnabled: false,
                accountLifetime: account.accountLifetime, sets }));
            await waitForHomeGovernance(() => expect(exactHeaders()).toHaveLength(headersBeforeLabels + 1));
            await waitForHomeGovernance(() => expect(labels.getCurrent().resolveWorkflowTitle(definitionId)).toBe('B workflow'));
            expect(labels.getCurrent().workflowOptions).toEqual([]);
            expect(artifactInventoryReads()).toHaveLength(inventoryBeforeLabels);
            expect(exactHeaders()).toHaveLength(headersBeforeLabels + 1);
            expect(exactHeaders().at(-1)?.input).toMatchObject({ artifactIds: [definitionId], projection: 'headers' });
            const { WorkflowAccountLifetimeProvider } = await import('../workflowAccountScope');
            const { useWorkflowFlowChildren } = await import('../flow/useWorkflowFlowChildren');
            const parent = createWorkflowDefinitionFixture({ blocks: [{ kind: 'workflow', id: 'call', workflowRef: definitionId, input: {} }] });
            const beforeFlow = artifactInventoryReads().length;
            const flow = await renderHook(() => useWorkflowFlowChildren(parent, true), {
                wrapper: ({ children }) => <WorkflowAccountLifetimeProvider value={account.accountLifetime}>{children}</WorkflowAccountLifetimeProvider>,
            });
            await waitForHomeGovernance(() => expect(flow.getCurrent().children[definitionId]).toEqual(bContent));
            expect(flow.getCurrent().problem).toBeNull();
            expect(artifactInventoryReads()).toHaveLength(beforeFlow);
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
        await storage.getState().activateSettingsScope({ serverId, accountId });
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
        const beforeArtifacts = storage.getState().artifacts;
        const settledRenders = renders;
        for (let index = 0; index < 3; index++) {
            await act(async () => first.getCurrent().retry());
            await waitForHomeGovernance(() => expect(first.getCurrent().loadingMore).toBe(false));
            expect(first.getCurrent().definitions).toBe(before);
            expect(second.getCurrent().definitions).toBe(before);
            expect(storage.getState().artifacts).toBe(beforeArtifacts);
            expect(renders).toBe(settledRenders);
        }
    });

    it('reuses admitted Workflow header content across three current-Account list Actions and observes an edit', async () => {
        await storage.getState().activateSettingsScope({ serverId, accountId });
        await saved();
        const before = storage.getState().artifacts;
        const admitted = before[definitionId];
        const encodedHeader = admitted?.storageIdentity?.header;
        if (!admitted || !encodedHeader || admitted.bodyVersion === undefined) throw new Error('Expected admitted stored Workflow header evidence');
        const expectedRevision = { headerVersion: admitted.headerVersion, bodyVersion: admitted.bodyVersion };
        const headerJson = new TextDecoder().decode(decodeBase64(encodedHeader));
        // Observe the real decoder beneath the Account Action, not its retained UI result.
        const parse = vi.spyOn(JSON, 'parse');
        try {
            for (let index = 0; index < 3; index++) {
                const page = await listWorkflowDefinitions();
                expect(page.definitions.map(row => row.definitionId)).toContain(definitionId);
                expect(storage.getState().artifacts).toBe(before);
            }
            expect(parse.mock.calls.filter(([text]) => text === headerJson)).toHaveLength(0);
            await updateWorkflowDefinition({ definitionId, definition: content, metadata: { title: 'Changed saved Workflow' },
                expectedRevision });
            const updated = await listWorkflowDefinitions();
            expect(updated.definitions.find(row => row.definitionId === definitionId)?.metadata?.title).toBe('Changed saved Workflow');
            const editedHeader = storage.getState().artifacts[definitionId]?.storageIdentity?.header;
            expect(editedHeader).not.toBe(encodedHeader);
            if (!editedHeader) throw new Error('Expected acknowledged header evidence');
            const editedJson = new TextDecoder().decode(decodeBase64(editedHeader));
            parse.mockClear();
            await listWorkflowDefinitions();
            expect(parse.mock.calls.filter(([text]) => text === editedJson)).toHaveLength(0);
        } finally { parse.mockRestore(); }
    });

    it('reads nothing without demand and serves the current Account after enable', async () => {
        await saved();
        const libraryReads = () => home.requests.filter(request => request.path.startsWith('/v1/artifacts'));
        const before = libraryReads().length;
        const beforeMachineReads = machineRpc.mock.calls.length;
        const hook = await renderHook((props: { enabled: boolean }) => useWorkflowDefinitionLibrary(props), { initialProps: { enabled: false } });
        expect(hook.getCurrent().definitions).toEqual([]);
        expect(libraryReads()).toHaveLength(before);
        expect(machineRpc).toHaveBeenCalledTimes(beforeMachineReads);
        await hook.rerender({ enabled: true }); await waitLoaded(hook);
        expect(hook.getCurrent().definitions.map(row => row.definitionId)).toEqual([definitionId]);
    });

    it('refreshes mounted readers from the committed feed after a definition is created', async () => {
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
        expect(reads).toBe(1);
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
        // Both inventory and exact reads agree that the record was deleted.
        home.answer(serverId, `GET ${artifactHeaderRoute}`, { body: await artifactHeaderPage([definitionId]) });
        home.answer(serverId, `GET /v1/artifacts/${secondId}`, { status: 404, body: { error: 'not_found' } });
        // A retained refresh does not toggle loadingMore. The genuine Artifact
        // wake queues a recheck even if the remount's equal answer is still pending.
        await act(async () => publishHomeAccountChange(serverId, [secondId], { changeKinds: ['artifact'] }));
        await waitForHomeGovernance(() => {
            expect(first.getCurrent().definitions.map(row => row.definitionId)).toEqual([definitionId]);
            expect(first.getCurrent().hasMore).toBe(false);
        });
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
        const machine = pluginMachine('library-machine');
        storage.getState().applyMachines([machine], true, { sourceServerId: serverId });
        observeMachinePresenceForTest({ serverId, accountId }, [machine.id]);
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
        const beforeExact = artifactInventoryReads().length;
        const exact = await renderHook(() => useWorkflowPluginSource('plugin:example.recipe/review'));
        expect(exact.getCurrent().source).toBe(pluginRows[0]);
        expect(exact.getCurrent().status).toBe('ready');
        expect(artifactInventoryReads()).toHaveLength(beforeExact);
        const second = await renderHook(() => useWorkflowDefinitionLibrary());
        await waitForHomeGovernance(() => expect(second.getCurrent().loadingMore).toBe(false));
        expect(second.getCurrent().pluginWorkflows).toBe(pluginRows);
        expect(second.getCurrent().definitions).toBe(savedRows);
    });

    it('accumulates real byte-paged plugin sources by qualified identity without discarding saved rows', async () => {
        await saved();
        const machine = pluginMachine('paged-plugin-machine');
        storage.getState().applyMachines([machine], true, { sourceServerId: serverId });
        observeMachinePresenceForTest({ serverId, accountId }, [machine.id]);
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

    it('keeps saved rows for Settings and source-status rows and re-reads only the row an Automation row changes', async () => {
        const { planSyncActionsFromChanges, plannedChangesAffectWorkflowDefinitions, plannedChangesAffectWorkflowPluginSources,
            plannedWorkflowDefinitionAutomationIds } = await import('@/sync/runtime/orchestration/changesPlanner');
        const otherId = '00000000-0000-4000-8000-000000000099';
        const summaryFor = (scheduleExpr: string) => ({ automations: [], nextCursor: null, sharedWorkflowSummaries: [{
            workflowDefinitionId: definitionId, nextRunAt: null, triggers: [{ automationId: 'team-owner-automation', triggerId: 'team-schedule',
                kind: 'schedule', schedule: { kind: 'cron', scheduleExpr, everyMs: null, timezone: 'UTC' } }] }] });
        home.answer(serverId, 'POST /v3/automations/query', { body: summaryFor('0 9 * * *') });
        await saved();
        await saved(otherId, 'Other');
        const hook = await renderHook(() => useWorkflowDefinitionLibrary());
        await waitForHomeGovernance(() => { expect(hook.getCurrent().definitions).toHaveLength(2); expect(hook.getCurrent().loadingMore).toBe(false); });
        const other = hook.getCurrent().definitions.find(row => row.definitionId === otherId);
        const inventoryReads = artifactInventoryReads().length;
        // The feed publisher's decisions, from the canonical planner, for the rows a busy Account writes.
        const publishFeedPage = async (changes: readonly Readonly<{ kind: 'account' | 'automation'; entityId: string }>[]) => {
            const planned = planSyncActionsFromChanges(changes.map((change, index) => ({ ...change, cursor: index + 1, changedAt: 1 })));
            const automationIds = plannedWorkflowDefinitionAutomationIds(planned);
            await act(async () => { publishHomeAccountChange(serverId, changes.map(change => change.entityId), { feedPageConsumed: true,
                changeKinds: changes.map(change => change.kind),
                workflowDefinitionsAffect: plannedChangesAffectWorkflowDefinitions(planned),
                workflowPluginSourcesAffect: plannedChangesAffectWorkflowPluginSources(planned),
                ...(automationIds === undefined ? {} : { workflowDefinitionAutomationIds: automationIds }) }); });
            await waitForHomeGovernance(() => expect(hook.getCurrent().loadingMore).toBe(false));
        };
        for (let index = 0; index < 5; index += 1) {
            await publishFeedPage([{ kind: 'account', entityId: 'settings' }]);
            await publishFeedPage([{ kind: 'automation', entityId: 'automation-source-status' }]);
        }
        expect(artifactInventoryReads()).toHaveLength(inventoryReads);
        // The Team owner edits the schedule: only the row that shows this Automation is re-read.
        home.answer(serverId, 'POST /v3/automations/query', { body: summaryFor('0 10 * * *') });
        await publishFeedPage([{ kind: 'automation', entityId: 'team-owner-automation' }]);
        await waitForHomeGovernance(() => expect(hook.getCurrent().definitions.find(row => row.definitionId === definitionId)?.triggers)
            .toMatchObject([{ schedule: { scheduleExpr: '0 10 * * *' } }]));
        expect(artifactInventoryReads()).toHaveLength(inventoryReads);
        expect(hook.getCurrent().definitions.find(row => row.definitionId === otherId)).toBe(other);
        await hook.unmount();
    });

    it('reads no library rows for Artifact rows of other kinds, and still re-reads a changed saved workflow', async () => {
        const { planSyncActionsFromChanges, plannedArtifactKinds, plannedChangesAffectWorkflowDefinitions, plannedChangesAffectWorkflowPluginSources } =
            await import('@/sync/runtime/orchestration/changesPlanner');
        const { publishHomeAccountChangeWake } = await import('@/sync/runtime/orchestration/homeAccountChange');
        const { deriveArtifactStoredKindV1 } = await import('@happier-dev/protocol/artifacts/artifactKindV1');
        await saved();
        const hook = await renderHook(() => useWorkflowDefinitionLibrary());
        await waitForHomeGovernance(() => { expect(hook.getCurrent().definitions).toHaveLength(1); expect(hook.getCurrent().loadingMore).toBe(false); });
        const savedRows = hook.getCurrent().definitions;
        const artifactReads = () => home.requests.filter(request => new URL(request.path, request.serverUrl).pathname.startsWith('/v1/artifacts')).length;
        const before = artifactReads();
        // A busy Account writes Runs, Discussions and documents all the time. None of them is a saved workflow.
        const unrelated = ['workflow-run.v1', 'document', 'discussion.v1'].map(kind => deriveArtifactStoredKindV1({ kind }));
        for (let index = 0; index < 6; index += 1) {
            const entityId = `00000000-0000-4000-8000-0000000010${String(index).padStart(2, '0')}`;
            const artifactKinds = [unrelated[index % unrelated.length]!];
            const planned = planSyncActionsFromChanges([{ kind: 'artifact', entityId, cursor: index + 1, changedAt: 1, hint: { artifactKinds } }]);
            await act(async () => {
                publishHomeAccountChangeWake(serverId, { t: 'account-change', changeKinds: ['artifact'], entityIds: [entityId], artifactKinds }, 'socket');
                publishHomeAccountChange(serverId, [entityId], { feedPageConsumed: true, changeKinds: ['artifact'],
                    artifactKinds: plannedArtifactKinds(planned),
                    workflowDefinitionsAffect: plannedChangesAffectWorkflowDefinitions(planned),
                    workflowPluginSourcesAffect: plannedChangesAffectWorkflowPluginSources(planned) });
            });
            await waitForHomeGovernance(() => expect(hook.getCurrent().loadingMore).toBe(false));
        }
        expect(artifactReads() - before).toBe(0);
        expect(hook.getCurrent().definitions).toBe(savedRows);
        // The saved workflow itself changes: its row is read again.
        await act(async () => { publishHomeAccountChangeWake(serverId, { t: 'account-change', changeKinds: ['artifact'], entityIds: [definitionId],
            artifactKinds: [deriveArtifactStoredKindV1({ kind: 'workflow-definition.v1' })] }, 'socket'); });
        await waitForHomeGovernance(() => expect(artifactReads()).toBeGreaterThan(before));
        await hook.unmount();
    });

    it('re-derives only plugin sources for Machine row wakes, never re-listing saved definitions', async () => {
        await saved();
        const machine = pluginMachine('machine-wake-machine');
        storage.getState().applyMachines([machine], true, { sourceServerId: serverId });
        observeMachinePresenceForTest({ serverId, accountId }, [machine.id]);
        const projection = (ids: readonly string[]) => ({ protocolVersion: 1, projection: PluginProjectionV2Schema.parse({ v: 2, generation: ids.length,
            installedPackagesById: { 'example.recipe': { id: 'example.recipe', displayName: 'Example recipe', version: '1.2.3', enabled: true, source: { kind: 'path', locator: '/plugins/example.recipe' } } },
            familiesById: { workflows: { family: 'workflows', entriesById: Object.fromEntries(ids.map(id => [`example.recipe/${id}`, {
                id: `example.recipe/${id}`, pluginId: 'example.recipe', pluginVersion: '1.2.3', definition: { id, title: id, definition: content },
            }])) } },
        }) });
        machineRpc.mockResolvedValue(projection(['review']));
        const hook = await renderHook(() => useWorkflowDefinitionLibrary());
        await waitForHomeGovernance(() => { expect(hook.getCurrent().pluginWorkflows).toHaveLength(1); expect(hook.getCurrent().loadingMore).toBe(false); });
        const savedRows = hook.getCurrent().definitions;
        const inventoryReads = artifactInventoryReads().length;
        // Ten Machine rows (presence, metadata) as the feed delivers them: no saved definition can change.
        for (let index = 0; index < 10; index += 1) {
            await act(async () => { publishHomeAccountChange(serverId, [machine.id], { source: 'socket', changeKinds: ['machine'] }); });
            await waitForHomeGovernance(() => expect(hook.getCurrent().loadingMore).toBe(false));
        }
        expect(artifactInventoryReads()).toHaveLength(inventoryReads);
        expect(hook.getCurrent().definitions).toBe(savedRows);
        // The serving Machine's projection changes: the next Machine wake still brings its new plugin source.
        machineRpc.mockResolvedValue(projection(['check', 'review']));
        await act(async () => {
            publishMachineContributionRegistryProjectionInvalidation({ machineId: machine.id, serverId }, 'refresh');
            publishHomeAccountChange(serverId, [machine.id], { source: 'socket', changeKinds: ['machine'] });
        });
        await waitForHomeGovernance(() => expect(hook.getCurrent().pluginWorkflows.map(row => row.workflow))
            .toEqual(['plugin:example.recipe/check', 'plugin:example.recipe/review']));
        expect(artifactInventoryReads()).toHaveLength(inventoryReads);
        expect(hook.getCurrent().definitions).toBe(savedRows);
        await hook.unmount();
    });

    it('reopens from last-good rows with zero reads and catches up only the definition that changed while closed', async () => {
        await saved();
        const definitionReads = () => home.requests.filter(request => request.method === 'GET'
            && new URL(request.path, request.serverUrl).pathname.startsWith('/v1/artifacts')).length;
        const first = await renderHook(() => useWorkflowDefinitionLibrary()); await waitLoaded(first);
        const rows = first.getCurrent().definitions;
        await first.unmount();
        const beforeReopen = definitionReads();
        const reopened = await renderHook(() => useWorkflowDefinitionLibrary());
        await act(async () => {});
        expect(reopened.getCurrent().status).toBe('loaded');
        expect(reopened.getCurrent().definitions).toBe(rows);
        expect(definitionReads() - beforeReopen).toBe(0);
        await reopened.unmount();
        // A wake while nothing shows the library reads nothing; the next open reads that one row.
        await act(async () => { await saved(secondId, 'Created while closed'); });
        const inventory = artifactInventoryReads().length;
        const beforeCatchUp = definitionReads();
        const again = await renderHook(() => useWorkflowDefinitionLibrary());
        await waitForHomeGovernance(() => expect(again.getCurrent().definitions.map(row => row.definitionId)).toContain(secondId));
        expect(definitionReads() - beforeCatchUp).toBe(1);
        expect(artifactInventoryReads()).toHaveLength(inventory);
        await again.unmount();
    });
});

describe('Workflow Run windows through real Account storage', () => {
    const membershipPage = (runs: readonly ReturnType<typeof createWorkflowRunSummaryFixture>[], nextCursor?: string) => ({
        projection: 'membership', runs, acceptedEnvelopesByRunId: {}, keyCensusByRunId: {}, ...(nextCursor ? { nextCursor } : {}),
    });

    it.each(['trigger:scheduled-trigger', 'automation:automation-1', 'all', 'active'] as const)(
        'keeps %s loaded on the first materialized occurrence push and its stopped update', async windowId => {
            const { refreshWorkflowRunsByIds } = await import('@/sync/engine/workflows/refreshWorkflowRun');
            home.answer(serverId, route, { body: await runPage([]) });
            const hook = await renderHook(() => useWorkflowRunWindow(windowId));
            await waitLoaded(hook);
            expect(hook.getCurrent().runIds).toEqual([]);
            const before = home.requestsFor(route).length;
            for (let index = 0; index < 10; index++) {
                await act(async () => publishHomeAccountChange(serverId, [`unrelated-${index}`], {
                    changeKinds: ['artifact'], artifactKinds: [deriveArtifactStoredKindV1({ kind: 'document' })],
                }));
            }
            expect(home.requestsFor(route)).toHaveLength(before);
            const occurrence = createWorkflowRunSummaryFixture({ id: 'first-scheduled-occurrence', ownerAccountId: accountId,
                state: windowId === 'active' ? 'running' : 'waiting_for_review',
                origin: { kind: 'automation', automationId: 'automation-1' } });
            home.answer(serverId, route, { body: await runPage([occurrence]) });
            await act(async () => {
                // The feed materializes the summary before publishing this typed wake.
                await refreshWorkflowRunsByIds([occurrence.id]);
                publishHomeAccountChange(serverId, [`workflow-run:${occurrence.id}`], { workflowRunsMaterialized: true });
            });
            await waitForHomeGovernance(() => {
                expect(hook.getCurrent().status).toBe('loaded');
                expect(hook.getCurrent().runIds).toEqual([occurrence.id]);
            });
            expect(hook.getCurrent().failure).toBeNull();
            expect(hook.getCurrent().rows[0]?.summary?.state).toBe(occurrence.state);
            // One materialization, one selected membership read, one changed-window read.
            expect(home.requestsFor(route).length - before).toBe(3);
            const stopped = createWorkflowRunSummaryFixture({ ...occurrence, state: 'cancelled', revision: occurrence.revision + 1 });
            const stoppedPage = await runPage([stopped]);
            const emptyPage = await runPage([]);
            home.answer(serverId, route, { select: input => {
                const request = WorkflowRunListRequestV1Schema.parse(input && typeof input === 'object' ? Reflect.get(input, 'request') : null);
                return { body: request.states ? emptyPage : stoppedPage };
            } });
            const beforeStop = home.requestsFor(route).length;
            await act(async () => {
                await refreshWorkflowRunsByIds([stopped.id]);
                publishHomeAccountChange(serverId, [`workflow-run:${stopped.id}`], { workflowRunsMaterialized: true });
            });
            await waitForHomeGovernance(() => {
                expect(hook.getCurrent().status).toBe('loaded');
                expect(hook.getCurrent().runIds).toEqual(windowId === 'active' ? [] : [stopped.id]);
            });
            expect(hook.getCurrent().failure).toBeNull();
            if (windowId !== 'active') expect(hook.getCurrent().rows[0]?.summary?.state).toBe('cancelled');
            expect(home.requestsFor(route).length - beforeStop).toBe(windowId === 'active' ? 3 : windowId === 'all' ? 1 : 2);
        },
    );

    it.each(['all', 'exact:["selected-run"]'] as const)('ignores 300 unrelated Artifact kinds and discovers changed Run sources (%s)', async windowId => {
        await saved();
        const boundary = home.artifacts(serverId);
        const template = boundary.read(definitionId)!;
        const artifactIds = Array.from({ length: 300 }, (_, index) => `00000000-0000-4000-8000-${String(1000 + index).padStart(12, '0')}`);
        for (const id of artifactIds) boundary.replaceStoredRow({ ...template, id,
            kind: deriveArtifactStoredKindV1({ kind: 'document' }),
            header: encodePlainArtifactStoredContent({ kind: 'document' }),
        });
        const selected = { ...run('selected-run'), sourceArtifactId: definitionId };
        const untouched = { ...run('untouched-run'), sourceArtifactId: definitionId };
        home.answer(serverId, route, { body: await runPage(windowId === 'all' ? [selected, untouched] : [selected],
            windowId === 'all' ? 'retained-tail' : undefined) });
        const hook = await renderHook(() => useWorkflowRunWindow(windowId));
        await waitLoaded(hook);
        const before = home.requestsFor(route).length;
        const fullReloads = () => home.requestsFor(route).slice(before).filter(read => {
            const request = WorkflowRunListRequestV1Schema.parse((read.input as { request: unknown }).request);
            return request.runIds === undefined && request.sourceArtifactId === undefined;
        });
        for (const id of artifactIds) await act(async () => publishHomeAccountChange(serverId, [id], {
            changeKinds: ['artifact'], artifactKinds: [deriveArtifactStoredKindV1({ kind: 'document' })],
        }));
        expect(home.requestsFor(route)).toHaveLength(before);
        expect(fullReloads()).toHaveLength(0);
        const changed = { ...selected, state: 'succeeded' as const, revision: selected.revision + 1 };
        home.answer(serverId, route, { body: await runPage([changed]) });
        await act(async () => publishHomeAccountChange(serverId, [`workflow-run:${selected.id}`]));
        await waitForHomeGovernance(() => expect(hook.getCurrent().rows.find(row => row.id === selected.id)?.revision).toBe(changed.revision));
        expect(home.requestsFor(route)).toHaveLength(before + 1);
        expect(home.requestsFor(route).at(-1)?.input).toMatchObject({ request: { runIds: [selected.id] } });
        expect(hook.getCurrent().runIds).toEqual(windowId === 'all' ? [selected.id, untouched.id] : [selected.id]);
        expect(hook.getCurrent().hasMore).toBe(windowId === 'all');
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
        await waitForHomeGovernance(() => expect(hook.getCurrent().runIds).toContain(selected.id));
        expect(home.requestsFor(route)[before + 2]?.input).toMatchObject({ request: { sourceArtifactId: definitionId } });
    });

    it.each([
        { windowId: 'all', projection: undefined },
        { windowId: 'attention', projection: undefined },
        { windowId: 'attention', projection: 'membership' },
    ] as const)('discovers Runs again after source grant removal and regrant with a scoped read ($windowId, $projection)', async ({ windowId, projection }) => {
        const selected = { ...run('shared-run'), sourceArtifactId: definitionId, attentionRequired: true };
        home.answer(serverId, route, { body: projection ? membershipPage([selected]) : await runPage([selected]) });
        const hook = await renderHook(() => useWorkflowRunWindow(windowId, { projection }));
        await waitLoaded(hook);
        const before = home.requestsFor(route).length;
        await act(async () => publishHomeAccountChange(serverId, [secondId], {
            changeKinds: ['artifact'], artifactKinds: [deriveArtifactStoredKindV1({ kind: 'document' })],
        }));
        expect(home.requestsFor(route)).toHaveLength(before);
        home.answer(serverId, route, { body: projection ? membershipPage([]) : await runPage([]) });
        await act(async () => publishHomeAccountChange(serverId, [definitionId], { changeKinds: ['artifact'] }));
        await waitForHomeGovernance(() => expect(hook.getCurrent().runIds).toEqual([]));
        expect(home.requestsFor(route)[before]?.input).toMatchObject({ request: { sourceArtifactId: definitionId,
            ...(windowId === 'attention' ? { attention: 'required' } : {}) } });
        expect(storage.getState().workflowRunListWindows[runWindowKey(windowId)]?.sourceArtifactIdsByRunId).toEqual({});
        const beforeRegrant = home.requestsFor(route).length;
        const beforeInventory = artifactInventoryReads().length;
        const fullPage = await runPage([selected]);
        home.answer(serverId, route, { select: input => {
            const request = WorkflowRunListRequestV1Schema.parse((input as { request: unknown }).request);
            const rows = request.runIds && !request.runIds.includes(selected.id) ? [] : [selected];
            return { body: projection ? membershipPage(rows) : { ...fullPage, runs: rows } };
        } });
        await act(async () => publishHomeAccountChange(serverId, [definitionId], {
            changeKinds: ['artifact'], artifactKinds: [deriveArtifactStoredKindV1({ kind: 'workflow-definition.v1' })],
        }));
        await waitForHomeGovernance(() => expect(hook.getCurrent().runIds).toEqual([selected.id]));
        expect(home.requestsFor(route)[beforeRegrant]?.input).toMatchObject({ request: { sourceArtifactId: definitionId,
            ...(windowId === 'attention' ? { attention: 'required' } : {}) } });
        expect((home.requestsFor(route)[beforeRegrant]?.input as { request: { runIds?: string[] } }).request.runIds).toBeUndefined();
        expect(artifactInventoryReads()).toHaveLength(beforeInventory);
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
        home.answer(serverId, route, { body: await runPage([changedHead]) });
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

    it('keeps the shell attention membership from materialized summaries and reads only when attention flips', async () => {
        // P03-WORKFLOW-RUN-E2E: every client mounts this window, so each Run step
        // update used to cost one membership read on every open tab.
        const waiting = createWorkflowRunSummaryFixture({ ...run('waiting-run'), attentionRequired: true, invocationAttentionRequired: true });
        home.answer(serverId, route, { body: membershipPage([waiting]) });
        const member = await renderHook(() => useWorkflowRunWindow('attention', { projection: 'membership' })); await waitLoaded(member);
        const materialize = async (summary: ReturnType<typeof createWorkflowRunSummaryFixture>) => act(async () => {
            storage.getState().upsertWorkflowRuns([workflowRunRowFromSummary(summary)]);
            publishHomeAccountChange(serverId, [`workflow-run:${summary.id}`], { workflowRunsMaterialized: true });
        });
        const before = home.requestsFor(route).length;
        // Progress of a Run that does not need you, then of the one that does.
        let progress = run('progress-run');
        for (let index = 0; index < 5; index++) {
            progress = { ...progress, revision: progress.revision + 1 };
            await materialize(progress);
        }
        for (let index = 0; index < 5; index++) await materialize({ ...waiting, revision: waiting.revision + index + 1 });
        expect(home.requestsFor(route).length - before).toBe(0);
        expect(member.getCurrent().runIds).toEqual([waiting.id]);
        // Attention flips are membership changes: the window reads its server
        // answer as before (the changed selection, then the ordered window).
        const asks = { ...progress, revision: progress.revision + 1, attentionRequired: true, invocationAttentionRequired: true };
        home.answer(serverId, route, { body: membershipPage([asks, waiting]) });
        await materialize(asks);
        await waitForHomeGovernance(() => expect(member.getCurrent().runIds).toEqual([asks.id, waiting.id]));
        expect(home.requestsFor(route).length - before).toBe(2);
        const answered = { ...waiting, revision: waiting.revision + 10, attentionRequired: false, invocationAttentionRequired: false };
        home.answer(serverId, route, { select: input => {
            const request = WorkflowRunListRequestV1Schema.parse(input && typeof input === 'object' ? Reflect.get(input, 'request') : null);
            return { body: membershipPage(request.runIds ? [] : [asks]) };
        } });
        await materialize(answered);
        await waitForHomeGovernance(() => expect(member.getCurrent().runIds).toEqual([asks.id]));
        expect(home.requestsFor(route).length - before).toBe(4);
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
        // Mounting another reader starts a retained refresh. Finish that same
        // owner flight before changing the HTTP leaf to the continuation page.
        await act(async () => { await refreshRunWindow('automation:habit'); });
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

    it('reopens a fixed Run window from the shared store with zero reads and refreshes only a Run that changed while closed', async () => {
        const selected = run('selected-run'); const other = run('other-run');
        home.answer(serverId, route, { body: await runPage([selected, other]) });
        const first = await renderHook(() => useWorkflowRunWindow('all')); await waitLoaded(first);
        await first.unmount();
        const before = home.requestsFor(route).length;
        const reopened = await renderHook(() => useWorkflowRunWindow('all'));
        await act(async () => {});
        expect(reopened.getCurrent().status).toBe('loaded');
        expect(reopened.getCurrent().runIds).toEqual([selected.id, other.id]);
        expect(home.requestsFor(route).length - before).toBe(0);
        await reopened.unmount();
        const changed = { ...selected, state: 'succeeded' as const, revision: selected.revision + 1 };
        home.answer(serverId, route, { body: await runPage([changed]) });
        await act(async () => publishHomeAccountChange(serverId, [`workflow-run:${selected.id}`]));
        expect(home.requestsFor(route).length - before).toBe(0);
        const again = await renderHook(() => useWorkflowRunWindow('all'));
        await waitForHomeGovernance(() => expect(again.getCurrent().rows.find(row => row.id === selected.id)?.revision).toBe(changed.revision));
        expect(home.requestsFor(route).length - before).toBe(1);
        expect(home.requestsFor(route).at(-1)?.input).toMatchObject({ request: { runIds: [selected.id] } });
        expect(again.getCurrent().runIds).toEqual([selected.id, other.id]);
        await again.unmount();
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
        expect(storage.getState().workflowRunListWindows[runWindowKey('automationAttention')]?.nextCursor).toBe('current-4');
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
});
