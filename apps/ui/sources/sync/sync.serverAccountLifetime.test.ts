import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Socket } from 'socket.io-client';
import type { ApiUpdateContainer } from '@/sync/api/types/apiTypes';

vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
import { act } from 'react-test-renderer';
import React from 'react';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import {
    AutomationDefinitionDetailSchema, AutomationDefinitionListItemSchema, AutomationV3RunListItemSchema, AutomationV3RunDetailSchema,
    type AutomationDefinitionDetail,
} from '@happier-dev/protocol/automations/automationApiV3';
import { MachinePoolViewV1Schema} from '@happier-dev/protocol/machines/pools/v1';
import {
    sealAutomationRunResultStoredEnvelopeV1} from '@happier-dev/protocol/automations/automationReplyHandoffStoredContent';
import { workflowRunRowFromAutomationRun, workflowRunStoreKey } from '@/sync/store/domains/workflowRuns';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { createAutomationDefinitionFromDetail } from '@/sync/domains/automations/automationDefinitionProjection';
import { useAutomation, useAutomationRunNextCursor, useAutomationRuns, useAutomations, storage } from '@/sync/domains/state/storage';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { profileDefaults } from '@/sync/domains/profiles/profile';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { upsertServerProfileOnly } from '@/sync/domains/server/serverRuntime';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { executeOccurrenceRunAction } from '@/components/workflows/run/occurrenceRunActions';
import { normalizeActionsSettingsV1, setActionApprovalOverride } from '@happier-dev/protocol/actions/actionSettings';
import { AUTOMATION_OCCURRENCE_ACTION_IDS } from '@happier-dev/protocol/actions';
import { WorkflowRunControlResultV1Schema } from '@happier-dev/protocol/workflows';
import { createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { OS: 'web' } });
});
vi.mock('@/sync/domains/state/browserRecordStorage', async () => {
    const { createBrowserRecordStorageModuleMock } = await import('@/dev/testkit/mocks/browserRecordStorage');
    return createBrowserRecordStorageModuleMock();
});
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { sync } = await import('./sync');

// Requests are the external Home boundary; lifetime, codecs and caches remain real.
const requests: Array<{ origin: string; path: string; method: string; authorization: string | null; body: unknown }> = [];
const replies = new Map<string, () => Promise<Response> | Response>();
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
let homeSocket: Socket | undefined;
let updateSequence = 100;
const initialStorage = storage.getState();
const otherHomeUrl = 'https://sync-lifetime-other.example.test';
const otherHomeCleanups: Array<() => void | Promise<void>> = [];
const occurrencePolicy = [...AUTOMATION_OCCURRENCE_ACTION_IDS, 'workflow.run.cancel' as const].reduce((settings, actionId) => setActionApprovalOverride({
    settings, actionId, surface: 'ui', approvalRequired: false,
}), normalizeActionsSettingsV1({ v: 1, actions: {} }));

function answer(path: string, value: unknown, method = 'GET', origin?: string) {
    replies.set(`${origin ? `${origin} ` : ''}${method} ${path}`, () => Response.json(value));
}
function hold(path: string, method = 'GET', origin?: string) {
    let release!: (value: unknown) => void;
    let reached!: () => void;
    const started = new Promise<void>(resolve => { reached = resolve; });
    const response = new Promise<Response>(resolve => { release = value => resolve(Response.json(value)); });
    replies.set(`${origin ? `${origin} ` : ''}${method} ${path}`, () => { reached(); return response; });
    return { started, release };
}
function runPath(automationId = eventRunDetail.automationId) {
    return `/v3/automations/${automationId}/runs`;
}

async function restoreAccount(accountId: string) {
    connection = await restoreServerAccountForTest({
        serverUrl: 'https://sync-lifetime.example.test', accountId,
        additionalRequestOrigins: [otherHomeUrl],
        configureSocket: socket => { homeSocket = socket; },
        request: async (url, init) => {
            const { origin, pathname: path } = new URL(String(url));
            const method = init?.method ?? 'GET';
            requests.push({ origin, path, method, authorization: new Headers(init?.headers).get('authorization'),
                body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
            const reply = replies.get(`${origin} ${method} ${path}`) ?? replies.get(`${method} ${path}`);
            if (reply) return await reply();
            if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(
                createRootLayoutFeaturesResponse({ features: { automations: { enabled: true }, workflows: { enabled: true } } }));
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (path === '/v1/account/profile') return Response.json({ ...profileDefaults, id: accountId });
            if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: { actionsSettingsV1: occurrencePolicy } }, version: 1 });
            if (path === '/v2/sessions' || path === '/v2/sessions/active' || path === '/v2/sessions/query') return Response.json({
                sessions: [], nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false,
            });
            if (path === '/v1/machines' || path === '/v1/artifacts') return Response.json([]);
            if (path === '/v1/friends') return Response.json({ friends: [] });
            if (path === '/v1/kv') return Response.json({ items: [] });
            if (path === '/v2/cursor') return Response.json({ cursor: 0, changesFloor: 0 });
            if (path === '/v2/changes') return Response.json({ changes: [], nextCursor: 0 });
            if (path === '/v3/automations') return Response.json({ automations: [], nextCursor: null });
            if (path.endsWith('/runs')) return Response.json({ runs: [], nextCursor: null });
            return new Response('{}', { status: 404 });
        },
    });
    expect(captureActiveServerAccountScopeLifetime()?.isCurrent()).toBe(true);
    await vi.waitFor(() => expect(storage.getState().isDataReady).toBe(true));
    await sync.refreshAutomations();
}
async function changeAccount() {
    await connection!.dispose();
    await restoreAccount('account-b');
}
async function captureOtherHomeAccount() {
    const home = await upsertServerProfileOnly({ serverUrl: otherHomeUrl, name: 'Other Home' });
    const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'account-b' })).toString('base64url')}.signature` };
    const write = await TokenStorage.setCredentialsForServerUrlWithRollback(otherHomeUrl, { serverId: home.id }, credentials);
    if (!write) throw new Error('Other Home credentials could not be stored');
    otherHomeCleanups.push(async () => { await write.rollback(); });
    const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
    const account = await captureLazyActionAccountContext(home.id);
    otherHomeCleanups.push(() => account.dispose());
    return account;
}
beforeEach(async () => {
    replies.clear();
    await restoreAccount('account-a');
    requests.length = 0;
});
afterEach(async () => {
    await standardCleanup();
    for (const cleanup of otherHomeCleanups.splice(0).reverse()) await cleanup();
    await connection?.dispose();
    connection = undefined;
    storage.setState(initialStorage, true);
    replies.clear();
});
function eventDetail(templateVersion: number): AutomationDefinitionDetail {
    return AutomationDefinitionDetailSchema.parse({
        id: 'automation-event-owner',
        name: 'Repository updates',
        description: 'Review incoming repository activity',
        enabled: true,
        triggers: [{
            id: '11111111-1111-4111-8111-111111111111',
            revision: 2,
            enabled: true,
            createdAt: 1,
            updatedAt: templateVersion,
            kind: 'pluginEvent',
            eventRef: {
                pluginId: 'happier.scm.github',
                localId: 'push',
            },
            sourceSelectorId: '22222222-2222-4222-8222-222222222222',
            sourceContractVersion: 1,
            observation: {
                kind: 'checkpointedPull',
                watcher: {
                    machineId: 'machine-1',
                    machineInstallationId: 'installation-1',
                    pluginId: 'happier.scm.github',
                    materializationId: 'materialization-1',
                },
            },
            sourceStatus: null,
            sourceCatalogStatus: null,
            triggerDefinitionEnvelope: '{"t":"plain","v":{}}',
        }],
        targetType: 'existingSession',
        existingSessionId: 'session-event-1',
        templateVersion,
        lastRunAt: null,
        createdAt: 1,
        updatedAt: templateVersion,
        assignments: [{ machineId: 'machine-1', enabled: true, priority: 0, updatedAt: null }],
        executionRecipe: {
            v: 1,
            templateVersion,
            template: { t: 'plain', v: { v: 1, prompt: 'Review {{input}}' } },
            triggerEvidence: null,
            target: { kind: 'existingSession', sessionId: 'session-event-1' },
        },
    });
}

function automationSummary() {
    const { executionRecipe: _recipe, triggers, ...fields } = eventDetail(3);
    return AutomationDefinitionListItemSchema.parse({ ...fields,
        triggers: triggers.map(trigger => {
            if (trigger.kind !== 'pluginEvent') return trigger;
            const { triggerDefinitionEnvelope: _definition, ...row } = trigger;
            return row;
        }),
    });
}

function emitAutomationUpdate(body: ApiUpdateContainer['body'], socket = homeSocket) {
    expect(socket?.listenersAny().length).toBeGreaterThan(0);
    const update = { id: `automation-${++updateSequence}`, seq: updateSequence, createdAt: 4, body };
    for (const listener of socket!.listenersAny()) listener('update', update);
}

function emitRunUpdate() {
    emitAutomationUpdate({ t: 'automation-run-updated', automationId: runSummary.automationId,
        runId: runSummary.id, state: 'running', scheduledAt: 1, startedAt: 5, finishedAt: null,
        updatedAt: 5, machineId: 'machine-1', attempt: 1 });
}

// Wait for the real queue; only its inputs/HTTP boundary are driven by these tests.
function drainAutomationQueue() {
    return (Reflect.get(sync, 'automationsSync') as { awaitQueue(): Promise<unknown> }).awaitQueue();
}

const eventRunDetail = AutomationV3RunDetailSchema.parse({
    id: 'automation-event-run-owner',
    automationId: 'automation-event-owner',
    revision: 2,
    state: 'queued',
    triggerId: '11111111-1111-4111-8111-111111111111',
    triggerRetired: false,
    cause: {
        kind: 'trigger',
        triggerId: '11111111-1111-4111-8111-111111111111',
        triggerRevision: 2,
        triggerKind: 'pluginEvent',
        occurrenceKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        occurredAt: 1,
        evidence: {
            eventRef: { pluginId: 'happier.scm.github', localId: 'push' },
            sourceSelectorId: '22222222-2222-4222-8222-222222222222',
        },
    },
    dueAt: 1,
    claimedAt: null,
    startedAt: null,
    finishedAt: null,
    claimedByMachineId: null,
    leaseExpiresAt: null,
    attempt: 0,
    errorCode: null,
    producedSessionId: null,
    executionDispatchState: null,
    executionAttempt: 0,
    replyHandoffState: 'none',
    replyHandoffAttempt: 0,
    replyHandoffDueAt: null,
    createdAt: 1,
    updatedAt: 1,
    triggerEvidenceEnvelope: null,
    executionInputEnvelope: null,
    resultEnvelope: null,
    legacySummaryCiphertext: null,
    executionNativeRunId: null,
    executionNativeCallId: null,
    executionNativeSidechainId: null,
    events: [],
});

const runSummary = AutomationV3RunListItemSchema.parse({
    id: eventRunDetail.id,
    automationId: eventRunDetail.automationId,
    revision: eventRunDetail.revision,
    state: eventRunDetail.state,
    triggerId: eventRunDetail.triggerId,
    triggerRetired: eventRunDetail.triggerRetired,
    cause: eventRunDetail.cause,
    dueAt: eventRunDetail.dueAt,
    claimedAt: eventRunDetail.claimedAt,
    startedAt: eventRunDetail.startedAt,
    finishedAt: eventRunDetail.finishedAt,
    claimedByMachineId: eventRunDetail.claimedByMachineId,
    leaseExpiresAt: eventRunDetail.leaseExpiresAt,
    attempt: eventRunDetail.attempt,
    errorCode: eventRunDetail.errorCode,
    producedSessionId: eventRunDetail.producedSessionId,
    executionDispatchState: eventRunDetail.executionDispatchState,
    executionAttempt: eventRunDetail.executionAttempt,
    replyHandoffState: eventRunDetail.replyHandoffState,
    replyHandoffAttempt: eventRunDetail.replyHandoffAttempt,
    replyHandoffDueAt: eventRunDetail.replyHandoffDueAt,
    createdAt: eventRunDetail.createdAt,
    updatedAt: eventRunDetail.updatedAt,
});

function createCancellationResponse(ownerAccountId: string, revision = runSummary.revision + 1) {
    return WorkflowRunControlResultV1Schema.parse({
        run: createWorkflowRunSummaryFixture({
            id: eventRunDetail.id, ownerAccountId, revision, state: 'cancelled', workflowCustodyState: null,
            origin: { kind: 'automation', automationId: eventRunDetail.automationId },
            finishedAt: '2026-10-30T20:00:00.000Z',
            availability: { pause: false, cancel: false },
        }),
        intent: 'cancelled',
    });
}

describe('Sync Server/Account lifetime reset boundary', () => {
    it('reopens the Home history consumer freshly and releases its demand while hidden or unmounted', async () => {
        const { AutomationsLatestRunsSection } = await import('@/components/automations/home/AutomationsLatestRunsSection');
        const { PluginSurfaceFocusEligibilityProvider } = await import('@/components/ui/presentation/PluginSurfaceFocusEligibility');
        const { settingsDefaults } = await import('@/sync/domains/settings/settings');
        storage.setState({ settings: { ...settingsDefaults, experiments: true, featureToggles: { automations: true } } });
        const summary = { ...automationSummary(), lastRunAt: 1 };
        answer('/v3/automations', { automations: [summary], nextCursor: null });
        answer(runPath(), { runs: [runSummary], nextCursor: null });
        await sync.refreshAutomations();
        const widget = (presented: boolean) => React.createElement(PluginSurfaceFocusEligibilityProvider, {
            active: presented, children: React.createElement(AutomationsLatestRunsSection, {}),
        });
        const screen = await renderScreen(widget(true));
        await vi.waitFor(() => expect(storage.getState().automationRunIdsByAutomationId[summary.id]).toEqual([runSummary.id]));
        await drainAutomationQueue();
        await screen.update(widget(false));
        requests.length = 0;
        emitRunUpdate();
        await drainAutomationQueue();
        expect(requests.filter(request => request.path === runPath())).toHaveLength(0);
        answer(runPath(), { runs: [{ ...runSummary, revision: 3, state: 'running', startedAt: 5, updatedAt: 5 }], nextCursor: null });
        await screen.update(widget(true));
        await drainAutomationQueue();
        await vi.waitFor(() => expect(storage.getState().workflowRunsById[workflowRunStoreKey(runSummary.id)]?.automation?.revision).toBe(3));
        expect(requests.filter(request => request.path === runPath())).toHaveLength(1);
        await screen.unmount();
        requests.length = 0;
        emitRunUpdate();
        await drainAutomationQueue();
        expect(requests.filter(request => request.path === runPath())).toHaveLength(0);
    });

    it('refreshes presented history once and keeps retained closed windows inert until reopening', async () => {
        const summary = automationSummary();
        answer('/v3/automations', { automations: [summary], nextCursor: null });
        answer(runPath(), { runs: [runSummary], nextCursor: null });
        await sync.refreshAutomations();
        await sync.fetchAutomationRuns(summary.id);
        const first = await renderHook(() => useAutomationRuns(summary.id));
        const second = await renderHook(() => useAutomationRuns(summary.id));
        await first.unmount();
        requests.length = 0;
        await sync.refreshAutomations();
        expect(requests.filter(request => request.path === runPath())).toHaveLength(1);
        await second.unmount();
        requests.length = 0;
        answer(runPath(), { runs: [{ ...runSummary, revision: 3, state: 'running', startedAt: 5, updatedAt: 5 }], nextCursor: null });
        emitRunUpdate();
        await drainAutomationQueue();
        expect(requests.filter(request => request.path === runPath())).toHaveLength(0);
        expect(storage.getState().automationRunIdsByAutomationId[summary.id]).toEqual([runSummary.id]);
        const reopened = await renderHook(() => useAutomationRuns(summary.id));
        await act(async () => { await sync.refreshAutomations(); });
        expect(requests.filter(request => request.path === runPath())).toHaveLength(1);
        expect(reopened.getCurrent()[0]?.revision).toBe(3);
        requests.length = 0;
        const pending = hold('/v3/automations');
        const refresh = sync.refreshAutomations();
        await pending.started;
        await reopened.unmount();
        pending.release({ automations: [summary], nextCursor: null });
        await refresh;
        expect(requests.filter(request => request.path === runPath())).toHaveLength(0);
    });

    it.each(['socket', 'changes'] as const)('keeps status-only %s wakes out of cached Run windows while reading current summaries', async source => {
        const summary = automationSummary();
        answer('/v3/automations', { automations: [summary], nextCursor: null });
        answer(runPath(), { runs: [runSummary], nextCursor: null });
        await sync.refreshAutomations();
        await sync.fetchAutomationRuns(summary.id);
        await renderHook(() => useAutomationRuns(summary.id));
        requests.length = 0;
        answer('/v3/automations', { automations: [{ ...summary, name: 'Current status', updatedAt: 4 }], nextCursor: null });
        answer('/v2/changes', { changes: [{ cursor: 1, kind: 'automation', entityId: 'automation-source-status', changedAt: 4 }], nextCursor: 1 });
        const deliver = async (body: ApiUpdateContainer['body']) => {
            emitAutomationUpdate(body);
            await vi.waitFor(() => expect(storage.getState().automations[summary.id]?.name).toBe('Current status'));
            // Observe the real queue's terminal boundary, without replacing its command.
            await drainAutomationQueue();
        };
        await deliver(source === 'socket' ? { t: 'automation-source-status-updated' } : { t: 'account-change' });
        expect(requests.filter(request => request.path === '/v3/automations')).toHaveLength(1);
        expect(requests.filter(request => request.path === runPath())).toHaveLength(0);
        expect(requests.filter(request => request.path === `/v3/automations/${summary.id}`)).toHaveLength(0);
        // A real Run event still restates its current window, including a changed revision.
        answer(runPath(), { runs: [{ ...runSummary, revision: 3, state: 'running', startedAt: 5, updatedAt: 5 }], nextCursor: null });
        answer('/v3/automations', { automations: [{ ...summary, name: 'Current status', updatedAt: 5 }], nextCursor: null });
        if (source === 'changes') {
            answer('/v2/changes', { changes: [
                { cursor: 2, kind: 'automation', entityId: 'automation-source-status', changedAt: 5 },
                { cursor: 3, kind: 'automation', entityId: summary.id, changedAt: 5 },
            ], nextCursor: 3 });
            emitAutomationUpdate({ t: 'account-change' });
        } else emitRunUpdate();
        await vi.waitFor(() => expect(storage.getState().workflowRunsById[workflowRunStoreKey(runSummary.id)]?.automation?.revision).toBe(3));
        await drainAutomationQueue();
        expect(requests.filter(request => request.path === runPath())).toHaveLength(1);
    });

    it('retains a stronger Run wake arriving during a status-only HTTP read', async () => {
        const summary = automationSummary();
        answer('/v3/automations', { automations: [summary], nextCursor: null });
        answer(runPath(), { runs: [runSummary], nextCursor: null });
        await sync.refreshAutomations();
        await sync.fetchAutomationRuns(summary.id);
        await renderHook(() => useAutomationRuns(summary.id));
        requests.length = 0;
        const pending = hold('/v3/automations');
        emitAutomationUpdate({ t: 'automation-source-status-updated' });
        await pending.started;
        emitRunUpdate();
        answer('/v3/automations', { automations: [{ ...summary, updatedAt: 5 }], nextCursor: null });
        answer(runPath(), { runs: [{ ...runSummary, revision: 3, state: 'running', startedAt: 5, updatedAt: 5 }], nextCursor: null });
        pending.release({ automations: [summary], nextCursor: null });
        await drainAutomationQueue();
        expect(storage.getState().workflowRunsById[workflowRunStoreKey(runSummary.id)]?.automation?.revision).toBe(3);
        expect(requests.filter(request => request.path === '/v3/automations')).toHaveLength(2);
        expect(requests.filter(request => request.path === runPath())).toHaveLength(1);
    });

    it('retries status-only and full Automation demand without losing or inventing Run reads', async () => {
        const summary = automationSummary();
        answer('/v3/automations', { automations: [summary], nextCursor: null });
        answer(runPath(), { runs: [runSummary], nextCursor: null });
        await sync.refreshAutomations();
        await sync.fetchAutomationRuns(summary.id);
        await renderHook(() => useAutomationRuns(summary.id));
        requests.length = 0;
        let attempts = 0;
        replies.set('GET /v3/automations', () => ++attempts === 1 ? new Response('{}', { status: 503 })
            : Response.json({ automations: [{ ...summary, name: 'Retried status' }], nextCursor: null }));
        emitAutomationUpdate({ t: 'automation-source-status-updated' });
        await vi.waitFor(() => expect(attempts).toBeGreaterThan(0));
        await drainAutomationQueue();
        expect(storage.getState().automations[summary.id]?.name).toBe('Retried status');
        expect(requests.filter(request => request.path === '/v3/automations')).toHaveLength(2);
        expect(requests.filter(request => request.path === runPath())).toHaveLength(0);
        let runAttempts = 0;
        replies.set(`GET ${runPath()}`, () => ++runAttempts === 1 ? new Response('{}', { status: 503 })
            : Response.json({ runs: [{ ...runSummary, revision: 3, state: 'running', startedAt: 5, updatedAt: 5 }], nextCursor: null }));
        emitRunUpdate();
        await vi.waitFor(() => expect(runAttempts).toBeGreaterThan(0));
        await drainAutomationQueue();
        expect(storage.getState().workflowRunsById[workflowRunStoreKey(runSummary.id)]?.automation?.revision).toBe(3);
        expect(requests.filter(request => request.path === runPath())).toHaveLength(2);
    });

    it('retires synchronously before advancing generation and never waits for consumer cleanup', () => {
        const lifetime = captureActiveServerAccountScopeLifetime()!;
        const generation = Reflect.get(sync, 'serverScopeGeneration');
        const neverSettles = new Promise<void>(() => {});
        let retired = false;
        lifetime.onRetire(() => {
            expect(lifetime.isCurrent()).toBe(false);
            expect(Reflect.get(sync, 'serverScopeGeneration')).toBe(generation);
            retired = true;
            return neverSettles;
        });
        sync.disconnectServer();
        expect(retired).toBe(true);
        expect(Reflect.get(sync, 'serverScopeGeneration')).toBe(generation + 1);
        expect(sync.getCredentials()).toBeNull();
    });

    it('preserves per-Home Pool rows across active-sync teardown until credential ownership changes', () => {
        const activeServerId = connection!.home.id;
        const otherServerId = `${activeServerId}-other`;
        // Empty membership is a valid cached Pool; transport teardown is not credential replacement.
        const row = MachinePoolViewV1Schema.parse({ pool: { id: '11111111-1111-4111-8111-111111111111', name: 'Private', description: null,
            revision: 0, createdAt: 1, updatedAt: 1, members: [] }, availability: { state: 'unknown' } });
        storage.setState({
            machinePoolListByServerId: { [activeServerId]: [row], [otherServerId]: [row] },
            machinePoolListStatusByServerId: { [activeServerId]: 'idle', [otherServerId]: 'idle' },
            machinePoolAccountIdByServerId: { [activeServerId]: 'account-a', [otherServerId]: 'other-account' },
        });
        sync.disconnectServer();
        expect(storage.getState().machinePoolListByServerId).toEqual({ [activeServerId]: [row], [otherServerId]: [row] });
        expect(storage.getState().machinePoolAccountIdByServerId).toEqual({ [activeServerId]: 'account-a', [otherServerId]: 'other-account' });
        expect(storage.getState().machinePoolListStatusByServerId[otherServerId]).toBe('idle');
    });

    it('keeps signed-out Pool rows visible but inert when the active Sync runtime disconnects', () => {
        const serverId = connection!.home.id;
        const row = MachinePoolViewV1Schema.parse({ pool: { id: '11111111-1111-4111-8111-111111111111', name: 'Private', description: null,
            revision: 0, createdAt: 1, updatedAt: 1, members: [] }, availability: { state: 'unknown' } });
        storage.setState({
            machinePoolListByServerId: { [serverId]: [row] },
            machinePoolListStatusByServerId: { [serverId]: 'idle' },
            machinePoolAccountIdByServerId: { [serverId]: 'account-a' },
        });
        sync.disconnectServer();
        expect(storage.getState().machinePoolListByServerId[serverId]).toEqual([row]);
        expect(storage.getState().machinePoolListStatusByServerId[serverId]).toBe('signedOut');
        expect(storage.getState().machinePoolAccountIdByServerId[serverId]).toBe('account-a');
    });

    it('removes Automation definition, run history, and cursor from a retained route when its Server/Account scope retires', async () => {
        const definition = createAutomationDefinitionFromDetail(eventDetail(3));
        storage.setState({
            isDataReady: true,
            automations: { [definition.id]: definition },
            workflowRunsById: { [workflowRunStoreKey(runSummary.id)]: workflowRunRowFromAutomationRun(runSummary) },
            automationRunIdsByAutomationId: { [definition.id]: [runSummary.id] },
            automationRunNextCursorByAutomationId: { [definition.id]: 'older-runs' },
        });
        const hook = await renderHook(() => ({
            all: useAutomations().map(automation => automation.id),
            definition: useAutomation(definition.id)?.id ?? null,
            runs: useAutomationRuns(definition.id).map(run => run.id),
            nextCursor: useAutomationRunNextCursor(definition.id),
        }));
        try {
            expect(hook.getCurrent()).toEqual({ all: [definition.id], definition: definition.id, runs: [runSummary.id], nextCursor: 'older-runs' });
            await act(async () => { sync.disconnectServer(); });
            expect(hook.getCurrent()).toEqual({ all: [], definition: null, runs: [], nextCursor: null });
            expect(storage.getState()).toMatchObject({
                automations: {}, workflowRunsById: {}, automationRunIdsByAutomationId: {},
                automationRunNextCursorByAutomationId: {}, automationRunTraversalsByAutomationId: {},
            });
        } finally { await hook.unmount(); }
    });

    it('does not return a direct Automation definition after its server-account scope expires', async () => {
        const pending = hold('/v3/automations/automation-event-owner');
        const operation = sync.refreshAutomationDefinitionDetail('automation-event-owner');
        const rejected = expect(operation).rejects.toThrow();
        await pending.started;
        sync.disconnectServer();
        pending.release(eventDetail(1));
        await rejected;
        expect(storage.getState().automations).toEqual({});
    });

    it('fences a direct Run-detail inspection when its server-account scope changes', async () => {
        const runKey = workflowRunStoreKey(eventRunDetail.id);
        const pending = hold(`${runPath()}/${eventRunDetail.id}`);
        const operation = sync.getAutomationRunDetailInspection(eventRunDetail.automationId, eventRunDetail.id);
        const rejected = expect(operation).rejects.toThrow();
        await pending.started;
        sync.disconnectServer();
        pending.release(eventRunDetail);
        await rejected;
        expect(storage.getState().workflowRunsById[runKey]).toBeUndefined();
    });

    it('returns route-local currentness unavailability without writing private Run detail into the cache', async () => {
        answer(`${runPath()}/${eventRunDetail.id}`, eventRunDetail);
        replies.set('GET /v1/account/encryption/currentness', () => new Response('{}', { status: 503 }));
        await expect(sync.getAutomationRunDetailInspection(eventRunDetail.automationId, eventRunDetail.id)).resolves.toEqual({
            detail: eventRunDetail,
            privateContent: {
                recipe: { kind: 'unavailable', reason: 'currentnessUnavailable' },
                result: { kind: 'unavailable', reason: 'currentnessUnavailable' },
                failureDetail: { kind: 'unavailable', reason: 'currentnessUnavailable' },
            },
        });
        expect(storage.getState().workflowRunsById[workflowRunStoreKey(eventRunDetail.id)]).toBeUndefined();
        expect(requests.filter(request => request.path === '/v1/account/encryption/currentness')).toEqual([
            expect.objectContaining({ authorization: `Bearer ${connection!.credentials.token}` }),
        ]);
    });

    it('inspects the exact other Home Run with its own credentials while unqualified inspection keeps the active Home', async () => {
        const account = await captureOtherHomeAccount();
        const detailPath = `${runPath()}/${eventRunDetail.id}`;
        answer(detailPath, eventRunDetail);
        answer(detailPath, { ...eventRunDetail, revision: 9, resultEnvelope: JSON.stringify(sealAutomationRunResultStoredEnvelopeV1({
            mode: 'plain',
            correspondence: { accountId: account.accountId, automationId: eventRunDetail.automationId, runId: eventRunDetail.id },
            result: { v: 1, kind: 'text', text: 'The result from Home B' },
        })) }, 'GET', otherHomeUrl);
        storage.getState().setAutomationRuns(eventRunDetail.automationId, [runSummary], null);
        const incumbent = storage.getState().workflowRunsById;

        await expect(sync.getAutomationRunDetailInspection(eventRunDetail.automationId, eventRunDetail.id, {
            accountLifetime: account.accountLifetime,
        })).resolves.toMatchObject({
            detail: { id: eventRunDetail.id, revision: 9 },
            privateContent: { result: { kind: 'available', result: { kind: 'text', text: 'The result from Home B' } } },
        });
        expect(requests.filter(request => request.origin === otherHomeUrl && (
            request.path === detailPath || request.path === '/v1/account/encryption/currentness'
        ))).toEqual([
            expect.objectContaining({ path: detailPath, authorization: `Bearer ${account.credentials.token}` }),
            expect.objectContaining({ path: '/v1/account/encryption/currentness', authorization: `Bearer ${account.credentials.token}` }),
        ]);
        expect(storage.getState().workflowRunsById).toBe(incumbent);
        await expect(sync.getAutomationRunDetailInspection(eventRunDetail.automationId, eventRunDetail.id))
            .resolves.toMatchObject({ detail: { revision: eventRunDetail.revision } });
    });

    it('never labels another Home occurrence with the active Home same-id Automation definition', async () => {
        const account = await captureOtherHomeAccount();
        const definition = createAutomationDefinitionFromDetail(eventDetail(4));
        storage.getState().upsertAutomation(definition);
        const hook = await renderHook(() => ({
            incumbent: useAutomation(definition.id),
            active: useAutomation(definition.id, { serverId: connection!.serverId }),
            otherHome: useAutomation(definition.id, { serverId: account.serverId }),
            unknownHome: useAutomation(definition.id, { serverId: 'unknown-home' }),
            unresolvedHome: useAutomation(definition.id, { serverId: null }),
        }));
        try {
            expect(hook.getCurrent()).toEqual({
                incumbent: definition, active: definition, otherHome: null, unknownHome: null, unresolvedHome: null,
            });
        } finally { await hook.unmount(); }
    });

    const occurrenceOperations = [
        { name: 'inspection', path: `${runPath()}/${eventRunDetail.id}`, method: 'GET',
            invoke: (accountLifetime: ServerAccountScopeLifetime | null) => sync.getAutomationRunDetailInspection(
                eventRunDetail.automationId, eventRunDetail.id, { accountLifetime }) },
        { name: 'cancel', path: '/v3/automations/runs/workflow-storage', method: 'POST',
            invoke: (accountLifetime: ServerAccountScopeLifetime | null) => executeOccurrenceRunAction('workflow.run.cancel', {
                runId: eventRunDetail.id, expectedRevision: eventRunDetail.revision,
            }, accountLifetime) },
        { name: 'retry handoff', path: `/v3/automations/runs/${eventRunDetail.id}/retry-reply-handoff`, method: 'POST',
            invoke: (accountLifetime: ServerAccountScopeLifetime | null) => executeOccurrenceRunAction('automation.run.reply_handoff.retry', { runId: eventRunDetail.id }, accountLifetime) },
        { name: 'deliver again', path: `/v3/automations/runs/${eventRunDetail.id}/deliver-result-again`, method: 'POST',
            invoke: (accountLifetime: ServerAccountScopeLifetime | null) => executeOccurrenceRunAction('automation.run.result.redeliver', {
                runId: eventRunDetail.id, expectedRevision: runSummary.revision,
            }, accountLifetime) },
    ] as const;

    it.each(occurrenceOperations)('refuses $name for an unresolved, unknown or mismatched Home without active-Home fallback', async operation => {
        const account = await captureOtherHomeAccount();
        answer(operation.path, operation.method === 'GET' ? eventRunDetail
            : operation.name === 'cancel' ? createCancellationResponse('account-a') : { run: runSummary }, operation.method);
        const invalidLifetimes = [
            null,
            { ...account.accountLifetime, scope: { serverId: 'unknown-home', accountId: 'account-b' } },
            { ...account.accountLifetime, scope: { ...account.accountLifetime.scope, accountId: 'another-account' } },
        ];
        const before = requests.length;
        for (const accountLifetime of invalidLifetimes) await expect(operation.invoke(accountLifetime)).rejects.toThrow();
        expect(requests.slice(before).filter(request => request.path === operation.path)).toEqual([]);
    });

    it.each(occurrenceOperations.filter(operation => operation.method === 'POST'))('controls $name on the exact other Home without replacing the active Home Run', async operation => {
        const account = await captureOtherHomeAccount();
        storage.getState().setAutomationRuns(eventRunDetail.automationId, [runSummary], null);
        const incumbent = storage.getState().workflowRunsById;
        const updated = { ...runSummary, revision: 9, state: 'cancelled', finishedAt: 2, updatedAt: 2 };
        answer(operation.path, operation.name === 'cancel' ? createCancellationResponse(account.accountId, 9) : { run: updated }, operation.method, otherHomeUrl);
        // A same-id active Run deliberately returns another revision if the transport is mis-bound.
        answer(operation.path, operation.name === 'cancel' ? createCancellationResponse('account-a', runSummary.revision) : { run: runSummary }, operation.method);
        await expect(operation.invoke(account.accountLifetime)).resolves.toBe(true);
        expect(requests.filter(request => request.path === operation.path)).toEqual([
            expect.objectContaining({ origin: otherHomeUrl, authorization: `Bearer ${account.credentials.token}` }),
        ]);
        expect(storage.getState().workflowRunsById).toBe(incumbent);
    });

    it.each(occurrenceOperations)('fences an in-flight exact-Home $name when that Home changes Account', async operation => {
        const account = await captureOtherHomeAccount();
        const pending = hold(operation.path, operation.method, otherHomeUrl);
        const promise = operation.invoke(account.accountLifetime);
        const rejected = expect(promise).rejects.toThrow();
        await pending.started;
        const replacement = await TokenStorage.setCredentialsForServerUrlWithRollback(otherHomeUrl, {
            serverId: account.serverId,
        }, { token: `e30.${Buffer.from(JSON.stringify({ sub: 'replacement-account-b' })).toString('base64url')}.signature` });
        if (!replacement) throw new Error('Other Home credentials could not be replaced');
        otherHomeCleanups.push(async () => { await replacement.rollback(); });
        pending.release(operation.method === 'GET' ? eventRunDetail
            : operation.name === 'cancel' ? createCancellationResponse(account.accountId) : { run: runSummary });
        await rejected;
        expect(sync.getCredentials()?.token).toBe(connection!.credentials.token);
        expect(storage.getState().workflowRunsById[workflowRunStoreKey(eventRunDetail.id)]).toBeUndefined();
    });

    it('withdraws an exact-Home inspection when its route credential binding retires before the response', async () => {
        const account = await captureOtherHomeAccount();
        const binding = await renderHook(() => useServerCredentialAccountScopeBinding(account.serverId));
        try {
            await vi.waitFor(() => expect(binding.getCurrent().binding?.isCurrent()).toBe(true));
            const lifetime = binding.getCurrent().binding!;
            const pending = hold(`${runPath()}/${eventRunDetail.id}`, 'GET', otherHomeUrl);
            const rejected = expect(sync.getAutomationRunDetailInspection(eventRunDetail.automationId, eventRunDetail.id, {
                accountLifetime: lifetime,
            })).rejects.toThrow();
            await pending.started;
            await binding.unmount();
            expect(lifetime.isCurrent()).toBe(false);
            pending.release(eventRunDetail);
            await rejected;
        } finally { await binding.unmount(); }
    });

    it('submits current cancellation through Workflow storage without fabricating an occurrence projection', async () => {
        storage.getState().setAutomationRuns(eventRunDetail.automationId, [runSummary], null);
        const incumbent = storage.getState().workflowRunsById;
        answer('/v3/automations/runs/workflow-storage', createCancellationResponse('account-a'), 'POST');
        await expect(executeOccurrenceRunAction('workflow.run.cancel', {
            runId: eventRunDetail.id, expectedRevision: eventRunDetail.revision,
        }, captureActiveServerAccountScopeLifetime())).resolves.toBe(true);
        expect(requests.filter(request => request.path === '/v3/automations/runs/workflow-storage')).toEqual([
            expect.objectContaining({ method: 'POST', body: { operation: 'cancel',
                runId: eventRunDetail.id, expectedRevision: eventRunDetail.revision,
            } }),
        ]);
        expect(storage.getState().workflowRunsById).toBe(incumbent);
    });

    it('projects reply handoff recovery through the incumbent Automation Run cache owner', async () => {
        answer(`/v3/automations/runs/${eventRunDetail.id}/retry-reply-handoff`, {
            run: { ...runSummary, revision: runSummary.revision + 1, replyHandoffState: 'ready', replyHandoffDueAt: 2, updatedAt: 2 },
        }, 'POST');
        await expect(executeOccurrenceRunAction('automation.run.reply_handoff.retry', { runId: eventRunDetail.id }, captureActiveServerAccountScopeLifetime())).resolves.toBe(true);
        expect(storage.getState().workflowRunsById[workflowRunStoreKey(eventRunDetail.id)]?.automation).toMatchObject({ id: eventRunDetail.id, replyHandoffState: 'ready' });
    });

    it('keeps account Automation settings direct and refreshes the canonical Run projection after clearing history', async () => {
        const settings = { maxActiveRunsPerMachine: 4, runRetention: 'thirtyDays' as const };
        answer('/v3/automations/settings', settings);
        answer('/v3/automations/settings', { maxActiveRunsPerMachine: 2, runRetention: 'keepForever' }, 'PUT');
        answer(`${runPath()}/clear-history`, { clearedRuns: 3 }, 'POST');
        answer(runPath(), { runs: [runSummary], nextCursor: null });
        await expect(sync.getAutomationSettings()).resolves.toEqual(settings);
        await expect(sync.updateAutomationSettings(settings)).resolves.toEqual({ maxActiveRunsPerMachine: 2, runRetention: 'keepForever' });
        await expect(sync.clearAutomationRunHistory(eventRunDetail.automationId)).resolves.toEqual({ clearedRuns: 3 });
        expect(requests).toContainEqual(expect.objectContaining({ path: '/v3/automations/settings', method: 'PUT', body: settings }));
        expect(storage.getState().automationRunIdsByAutomationId[eventRunDetail.automationId]).toEqual([runSummary.id]);
    });

    it('does not refresh a different account Run projection after clear-history loses currentness', async () => {
        const pending = hold(`${runPath()}/clear-history`, 'POST');
        const operation = sync.clearAutomationRunHistory(eventRunDetail.automationId);
        const rejected = expect(operation).rejects.toThrow();
        await pending.started;
        await changeAccount();
        const currentRun = { ...runSummary, revision: 10 };
        storage.getState().setAutomationRuns(eventRunDetail.automationId, [currentRun], null);
        pending.release({ clearedRuns: 3 });
        await rejected;
        expect(requests.filter(request => request.path === runPath())).toEqual([]);
        expect(storage.getState().workflowRunsById[workflowRunStoreKey(runSummary.id)]?.automation).toEqual(currentRun);
    });

    it('does not install an equal-version pause response over newer canonical socket truth', async () => {
        const initialDetail = eventDetail(4);
        storage.getState().upsertAutomation(createAutomationDefinitionFromDetail(initialDetail));
        const pending = hold(`/v3/automations/${initialDetail.id}/pause`, 'POST');
        const operation = sync.pauseAutomation(initialDetail.id);
        await pending.started;
        const socketCurrent = createAutomationDefinitionFromDetail({ ...initialDetail, name: 'Current socket truth', updatedAt: initialDetail.updatedAt + 1 });
        storage.getState().upsertAutomation(socketCurrent);
        pending.release({ ...initialDetail, enabled: false });
        await expect(operation).resolves.toBe(socketCurrent);
        expect(storage.getState().automations[initialDetail.id]).toBe(socketCurrent);
    });

    it('clears Account-scoped Run traversal tokens and rejects a late prior-Account token mutation', async () => {
        answer(runPath(), { runs: [runSummary], nextCursor: 'account-a-cursor' });
        await sync.fetchAutomationRuns(eventRunDetail.automationId);
        expect(storage.getState().automationRunNextCursorByAutomationId[eventRunDetail.automationId]).toBe('account-a-cursor');
        const pending = hold(runPath());
        const operation = sync.fetchAutomationRuns(eventRunDetail.automationId, 20, 'account-a-cursor');
        const rejected = expect(operation).rejects.toThrow();
        await pending.started;
        sync.disconnectServer();
        pending.release({ runs: [runSummary], nextCursor: 'late-account-a-cursor' });
        await rejected;
        expect(storage.getState().automationRunTraversalsByAutomationId).toEqual({});
        expect(storage.getState().automationRunNextCursorByAutomationId).toEqual({});
    });

    it('does not remove an Automation after the delete request Server/Account scope expires', async () => {
        const pending = hold(`/v3/automations/${eventRunDetail.automationId}`, 'DELETE');
        const operation = sync.deleteAutomation(eventRunDetail.automationId);
        const rejected = expect(operation).rejects.toThrow();
        await pending.started;
        await changeAccount();
        const currentDefinition = createAutomationDefinitionFromDetail({ ...eventDetail(9), name: 'Account B definition' });
        storage.getState().upsertAutomation(currentDefinition);
        pending.release({ success: true });
        await rejected;
        expect(storage.getState().automations[currentDefinition.id]).toBe(currentDefinition);
    });

});
