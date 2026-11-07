import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    WorkflowRunRecipientCensusResponseV1Schema} from '@happier-dev/protocol/workflows/workflowRunKeyV1';
import {
    materializeWorkflowAcceptedSnapshotV1} from '@happier-dev/protocol/workflows/materializeWorkflowAcceptedSnapshotV1';
import {
    sealWorkflowAcceptedSnapshotStoredEnvelopeV1,
    serializeWorkflowStoredContentEnvelopeV1,
} from '@happier-dev/protocol/workflows/workflowStoredContentV1';

import { createDeferred, createRootLayoutFeaturesResponse, flushHookEffects, renderHook, standardCleanup, waitForTestEvent } from '@/dev/testkit';
import { createWorkflowDefinitionFixture, createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { workflowRunRowFromSummary, workflowRunStoreKey } from '@/sync/store/domains/workflowRuns';

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
await loadSyncSingletonForTests();
const { primeServerFeaturesSnapshot, resetServerFeaturesClientForTests } = await import('@/sync/api/capabilities/serverFeaturesClient');
const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
const { getActiveServerSnapshot, setActiveServer } = await import('@/sync/domains/server/serverRuntime');
const { getStorage } = await import('@/sync/domains/state/storageStore');
const { publishAppliedActiveServerRuntimeAvailability, publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
const { useSessionManagedWorkflowRuns } = await import('@/components/workflows/run/useContextManagedWorkflowRuns');
const { resetWorkflowLibraryReadsForTests } = await import('@/components/workflows/library/workflowLibraryReads');
const { useSessionWorkSourcesOwner } = await import('../work/sessionWorkSources');
const { useSessionAgentActivity } = await import('@/hooks/session/useSessionAgentActivity');

const accountId = 'managed-home-account';
const run = createWorkflowRunSummaryFixture({
    id: 'same-run', ownerAccountId: accountId,
    attentionRequired: true, invocationAttentionRequired: true,
    origin: { kind: 'direct', originSessionId: 'session-1' },
});
const route = '/v3/automations/runs/workflow-storage';
let listResponse: Record<string, unknown>;
let homeA: string;
let homeB: string;
let previous = getStorage().getState();
let previousSnapshot = getActiveServerSnapshot();

async function activateHome(serverId: string): Promise<void> {
    publishAppliedActiveServerRuntimeAvailability(false);
    await setActiveServer({ serverId });
    getStorage().getState().activateProfileScope({ serverId, accountId });
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
}

beforeEach(async () => {
    previous = getStorage().getState();
    previousSnapshot = getActiveServerSnapshot();
    await home.reset();
    resetWorkflowLibraryReadsForTests();
    resetServerFeaturesClientForTests();
    getStorage().getState().clearProfileScope();
    getStorage().setState({
        workflowRunsById: {}, workflowRunListWindows: {}, workflowRunInvocationsByRunId: {},
        settings: { ...getStorage().getState().settings, experiments: true, featureToggles: { automations: true } },
    });
    homeA = await home.addHome({ name: 'Managed Home A', serverUrl: 'https://managed-home-a.test', accountId });
    homeB = await home.addHome({ name: 'Managed Home B', serverUrl: 'https://managed-home-b.test', accountId, active: false });
    if (run.origin.kind !== 'direct') throw new Error('Managed Home fixture requires direct Run provenance');
    const materialized = await materializeWorkflowAcceptedSnapshotV1({
        definition: createWorkflowDefinitionFixture({ defaults: {
            agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
            conversation: { kind: 'origin_session' },
        } }),
        admission: { kind: 'user' }, effects: { resolveTargetAvailability: async () => true },
        context: { source: { kind: 'inline' }, inputs: {}, machineId: run.machineId,
            executionTarget: { kind: 'session' }, workspaceTarget: { project: { machineId: run.machineId, directory: '/repo', checkoutRootPath: '/repo' } },
            origin: run.origin, authorization: { principal: { kind: 'host' } } },
    });
    if (!materialized.ok) throw new Error(`fixture_materialization_failed:${materialized.error.code}`);
    const accepted = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
        binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId: run.id }, acceptedSnapshot: materialized.snapshot }));
    const census = WorkflowRunRecipientCensusResponseV1Schema.parse({ runId: run.id, ownerAccountId: accountId,
        access: 'owner', encryptionMode: 'plain', dataEncryptionKey: null, callerDataEncryptionKey: null, recipients: [], visibleTeamId: null,
        ownerAccountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null } });
    listResponse = { runs: [run], acceptedEnvelopesByRunId: { [run.id]: accepted }, keyCensusByRunId: { [run.id]: census } };
    for (const serverId of [homeA, homeB]) {
        primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features: createRootLayoutFeaturesResponse() } });
        home.answer(serverId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture() });
        home.answer(serverId, route, { body: listResponse });
    }
    await activateHome(homeA);
});

afterEach(async () => {
    await standardCleanup();
    resetWorkflowLibraryReadsForTests();
    await home.reset();
    getStorage().setState(previous, true);
    publishAppliedActiveServerSnapshot(previousSnapshot);
    resetServerFeaturesClientForTests();
});

describe('Session-managed Workflow exact Home reads through the real Account owner', () => {
    it('reads Discussion membership from its captured Home while another Home has the same Run id', async () => {
        const { useServerCredentialAccountScopeBindings } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
        const { useContextManagedWorkflowRuns } = await import('@/components/workflows/run/useContextManagedWorkflowRuns');
        const addressedRun = { ...run, state: 'running' as const, origin: { kind: 'direct' as const } };
        const materialized = await materializeWorkflowAcceptedSnapshotV1({
            definition: createWorkflowDefinitionFixture({ blocks: [{ kind: 'wait', id: 'wait',
                document: { text: 'Wait', references: [], attachments: [] } }] }),
            admission: { kind: 'user' }, effects: { resolveTargetAvailability: async () => true },
            context: { source: { kind: 'inline' }, inputs: {}, machineId: run.machineId,
                executionTarget: { kind: 'session' }, workspaceTarget: { project: { machineId: run.machineId, directory: '/repo', checkoutRootPath: '/repo' } },
                origin: { kind: 'direct', discussion: { discussion: { serverId: homeB, discussionId: 'discussion-1' }, messageId: 'question-1', throughSeq: 1 } },
                authorization: { principal: { kind: 'host' } } },
        });
        if (!materialized.ok) throw new Error('discussion_fixture_materialization_failed');
        const accepted = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
            binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId: run.id }, acceptedSnapshot: materialized.snapshot }));
        home.answer(homeB, route, { body: { ...listResponse, runs: [addressedRun],
            acceptedEnvelopesByRunId: { [run.id]: accepted } } });
        getStorage().getState().upsertWorkflowRuns([workflowRunRowFromSummary({ ...run, state: 'failed' })], { serverId: homeA, accountId });
        const requestedHomes = [homeB];
        const hook = await renderHook(() => {
            const bindings = useServerCredentialAccountScopeBindings(requestedHomes);
            return useContextManagedWorkflowRuns({ resource: { kind: 'discussion', id: 'discussion-1' }, serverId: homeB,
                accountLifetime: bindings.get(homeB) ?? undefined });
        });
        await flushHookEffects({ cycles: 40 });
        await waitForTestEvent(hook.subscribe, () => expect(hook.getCurrent().phase).toBe('loaded'));
        expect(hook.getCurrent().runs.map(value => [value.id, value.state])).toEqual([[run.id, 'running']]);
        expect(getStorage().getState().workflowRunsById[workflowRunStoreKey(run.id, { serverId: homeA, accountId })]?.summary?.state).toBe('failed');
        expect(home.requestsFor(route).every(request => request.serverId === homeB)).toBe(true);
        expect(home.requestsFor(route)[0]?.input).toMatchObject({ operation: 'list', request: { originDiscussionId: 'discussion-1' } });
    });
    it('retains Work membership and attention after an offline consumer remount, then replaces them on recovery', async () => {
        const useWork = () => useSessionWorkSourcesOwner({
            sessionId: 'session-1', serverId: homeA, ownerMetadata: null,
            agentActivity: useSessionAgentActivity({ sessionId: 'session-1', serverId: homeA }),
        });
        const first = await renderHook(useWork);
        await waitForTestEvent(first.subscribe, () => expect(first.getCurrent().managedRuns.phase).toBe('loaded'));
        expect(first.getCurrent().projection.workflows.map(item => item.key)).toEqual([`run:${run.id}`]);
        expect([...first.getCurrent().managedRuns.attentionRunIds]).toEqual([run.id]);
        const readAt = first.getCurrent().managedRuns.lastSuccessfulReadAt;
        await first.unmount();
        home.answer(homeA, route, { status: 503, body: {} });

        const remounted = await renderHook(useWork);
        expect(remounted.getCurrent().projection.workflows.map(item => item.key)).toEqual([`run:${run.id}`]);
        expect([...remounted.getCurrent().managedRuns.attentionRunIds]).toEqual([run.id]);
        await waitForTestEvent(remounted.subscribe, () => expect(remounted.getCurrent().managedRuns.refreshFailed).toBe(true));
        expect(remounted.getCurrent().managedRuns).toMatchObject({
            phase: 'loaded', refreshFailed: true, lastSuccessfulReadAt: readAt,
        });
        // A fresh empty result is authoritative even though the exact Run body remains loaded.
        home.answer(homeA, route, { body: { runs: [], acceptedEnvelopesByRunId: {}, keyCensusByRunId: {} } });
        await act(async () => { remounted.getCurrent().managedRuns.retry(); });
        await waitForTestEvent(remounted.subscribe, () => expect(remounted.getCurrent().projection.workflows).toEqual([]));
        expect(remounted.getCurrent().projection.workflows).toEqual([]);
        expect([...remounted.getCurrent().managedRuns.attentionRunIds]).toEqual([]);
        expect(remounted.getCurrent().managedRuns).toMatchObject({ phase: 'loaded', refreshFailed: false });
        await remounted.unmount();
    });

    it.each(['Session', 'relation', 'Home', 'Account'] as const)('does not reuse a successful window for another %s on offline remount', async changed => {
        const first = await renderHook(() => useSessionManagedWorkflowRuns({ sessionId: 'session-1', serverId: homeA }));
        await waitForTestEvent(first.subscribe, () => expect(first.getCurrent().phase).toBe('loaded'));
        expect(first.getCurrent().runs.map(entry => entry.id)).toEqual([run.id]);
        await first.unmount();
        home.answer(homeA, route, { status: 503, body: {} });
        home.answer(homeB, route, { status: 503, body: {} });
        if (changed === 'Home') await act(async () => { await activateHome(homeB); });
        if (changed === 'Account') await act(async () => {
            await home.switchAccount(homeA, 'other-account');
            getStorage().getState().activateProfileScope({ serverId: homeA, accountId: 'other-account' });
            publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        });
        const next = await renderHook(() => useSessionManagedWorkflowRuns({
            sessionId: changed === 'Session' ? 'session-2' : 'session-1',
            serverId: changed === 'Home' ? homeB : homeA,
            relation: changed === 'relation' ? 'destination' : 'origin',
        }));
        expect(next.getCurrent().runs).toEqual([]);
        expect([...next.getCurrent().attentionRunIds]).toEqual([]);
        expect(next.getCurrent().lastSuccessfulReadAt).toBeNull();
        await next.unmount();
    });

    it('retains a destination window across an offline remount without borrowing origin membership', async () => {
        const useDestination = () => useSessionManagedWorkflowRuns({ sessionId: 'session-1', serverId: homeA, relation: 'destination' });
        const first = await renderHook(useDestination);
        await waitForTestEvent(first.subscribe, () => expect(first.getCurrent().phase).toBe('loaded'));
        expect(first.getCurrent().runs.map(entry => entry.id)).toEqual([run.id]);
        await first.unmount();
        home.answer(homeA, route, { status: 503, body: {} });
        const next = await renderHook(useDestination);
        expect(next.getCurrent().runs.map(entry => entry.id)).toEqual([run.id]);
        await waitForTestEvent(next.subscribe, () => expect(next.getCurrent().refreshFailed).toBe(true));
        expect(next.getCurrent()).toMatchObject({ phase: 'loaded', refreshFailed: true });
        await next.unmount();
    });

    it('keeps the Work projection and its successful-read time through Home failure, loading and retry', async () => {
        const now = vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
        const hook = await renderHook(() => useSessionWorkSourcesOwner({
            sessionId: 'session-1', serverId: homeA, ownerMetadata: null,
            agentActivity: useSessionAgentActivity({ sessionId: 'session-1', serverId: homeA }),
        }));
        try {
            await waitForTestEvent(hook.subscribe, () => expect(hook.getCurrent().managedRuns.phase).toBe('loaded'));
            expect(hook.getCurrent().projection.workflows.map(item => item.key)).toEqual([`run:${run.id}`]);
            const retained = hook.getCurrent().projection.workflows;
            const asOf = 1_800_000_000_000;
            // A network failure is not a new Account or evidence that Work is empty.
            await act(async () => {
                primeServerFeaturesSnapshot({ serverId: homeA, snapshot: { status: 'error', reason: 'network' } });
            });
            expect(hook.getCurrent().projection.workflows).toBe(retained);
            expect(hook.getCurrent().managedRuns).toMatchObject({
                phase: 'loaded', refreshFailed: true, lastSuccessfulReadAt: asOf,
            });

            const response = createDeferred<void>();
            home.answer(homeA, route, { body: listResponse, respondAfter: response.promise });
            home.answer(homeA, '/v1/features', { body: createRootLayoutFeaturesResponse() });
            now.mockReturnValue(1_800_000_060_000);
            await act(async () => {
                hook.getCurrent().managedRuns.retry();
            });
            await flushHookEffects();
            expect(hook.getCurrent().projection.workflows).toBe(retained);
            expect(hook.getCurrent().managedRuns).toMatchObject({ lastSuccessfulReadAt: asOf });
            await act(async () => { response.resolve(); });
            await waitForTestEvent(hook.subscribe, () => expect(hook.getCurrent().managedRuns.lastSuccessfulReadAt).toBe(1_800_000_060_000));
            expect(hook.getCurrent().managedRuns).toMatchObject({
                phase: 'loaded', refreshFailed: false, lastSuccessfulReadAt: 1_800_000_060_000,
            });

            home.answer(homeA, route, { status: 503, body: {} });
            now.mockReturnValue(1_800_000_120_000);
            await act(async () => { hook.getCurrent().managedRuns.retry(); });
            await waitForTestEvent(hook.subscribe, () => expect(hook.getCurrent().managedRuns.refreshFailed).toBe(true));
            expect(hook.getCurrent().projection.workflows).toBe(retained);
            expect(hook.getCurrent().managedRuns).toMatchObject({
                phase: 'loaded', refreshFailed: true, lastSuccessfulReadAt: 1_800_000_060_000,
            });
            // The existing retry re-reads the canonical window and may legitimately prove it empty.
            home.answer(homeA, route, { body: { runs: [], acceptedEnvelopesByRunId: {}, keyCensusByRunId: {} } });
            await act(async () => { hook.getCurrent().managedRuns.retry(); });
            await waitForTestEvent(hook.subscribe, () => expect(hook.getCurrent().projection.workflows).toEqual([]));
            expect(hook.getCurrent().projection.workflows).toEqual([]);
            expect(hook.getCurrent().managedRuns).toMatchObject({ phase: 'loaded', refreshFailed: false });
            // An explicit feature decision still withdraws the retained window.
            home.answer(homeA, route, { body: listResponse });
            await act(async () => { hook.getCurrent().managedRuns.retry(); });
            await waitForTestEvent(hook.subscribe, () => expect(hook.getCurrent().projection.workflows).toHaveLength(1));
            expect(hook.getCurrent().projection.workflows).toHaveLength(1);
            await act(async () => {
                primeServerFeaturesSnapshot({ serverId: homeA, snapshot: { status: 'ready',
                    features: createRootLayoutFeaturesResponse({ features: { workflows: { enabled: false } } }) } });
            });
            expect(hook.getCurrent().projection.workflows).toEqual([]);
            expect(hook.getCurrent().managedRuns).toMatchObject({ phase: 'idle', lastSuccessfulReadAt: null });
        } finally {
            now.mockRestore();
            await hook.unmount();
        }
    });

    it.each(['other Home', 'missing Home'] as const)('fails closed for %s without reading or publishing active Home Runs', async (target) => {
        expect(captureActiveServerAccountScopeLifetime()?.scope).toEqual({ serverId: homeA, accountId });
        const hook = await renderHook(() => useSessionManagedWorkflowRuns({
            sessionId: 'session-1', serverId: target === 'other Home' ? homeB : null,
        }));

        expect(hook.getCurrent().phase).toBe('failed');
        expect(hook.getCurrent().refreshFailed).toBe(true);
        expect(hook.getCurrent().runs).toEqual([]);
        expect(getStorage().getState().workflowRunsById).toEqual({});
        expect(home.requestsFor(route)).toEqual([]);
    });

    it('retires a loaded Home-qualified window when the real active Home changes', async () => {
        const lifetime = captureActiveServerAccountScopeLifetime();
        const hook = await renderHook(() => useSessionManagedWorkflowRuns({ sessionId: 'session-1', serverId: homeA }));
        await waitForTestEvent(hook.subscribe, () => expect(hook.getCurrent().phase).toBe('loaded'));
        expect(hook.getCurrent().phase).toBe('loaded');
        expect(hook.getCurrent().runs.map((entry) => entry.id)).toEqual([run.id]);
        expect(getStorage().getState().workflowRunsById[workflowRunStoreKey(run.id)]?.summary).toEqual({
            ...run,
            startedBy: 'user',
            where: { machineId: run.machineId, directory: '/repo' },
            stepProgress: undefined,
            stepProgressCurrentness: undefined,
            heldStep: undefined,
        });
        expect(home.requestsFor(route)).toHaveLength(1);
        expect(home.requestsFor(route).every(request => request.serverId === homeA && request.input
            && typeof request.input === 'object' && 'operation' in request.input && request.input.operation === 'list')).toBe(true);
        home.requests.length = 0;

        await act(async () => { publishAppliedActiveServerRuntimeAvailability(false); });
        expect(hook.getCurrent().phase).toBe('failed');
        expect(hook.getCurrent().runs).toEqual([]);
        expect(home.requestsFor(route)).toEqual([]);
        await act(async () => { publishAppliedActiveServerRuntimeAvailability(true); });
        await waitForTestEvent(hook.subscribe, () => expect(home.requestsFor(route)).toHaveLength(1));
        expect(hook.getCurrent().phase).toBe('loaded');
        expect(hook.getCurrent().runs.map((entry) => entry.id)).toEqual([run.id]);
        expect(home.requestsFor(route)).toHaveLength(1);
        home.requests.length = 0;

        await act(async () => { await activateHome(homeB); });
        await flushHookEffects();

        expect(lifetime?.isCurrent()).toBe(false);
        expect(captureActiveServerAccountScopeLifetime()?.scope).toEqual({ serverId: homeB, accountId });
        expect(hook.getCurrent().phase).toBe('failed');
        expect(hook.getCurrent().runs).toEqual([]);
        expect(home.requestsFor(route)).toEqual([]);
    });

    it('does not seed the active Run store with a response delivered after its Home lifetime retires', async () => {
        const response = createDeferred<void>();
        home.answer(homeA, route, { body: listResponse, respondAfter: response.promise });
        const lifetime = captureActiveServerAccountScopeLifetime();
        const hook = await renderHook(() => useSessionManagedWorkflowRuns({ sessionId: 'session-1', serverId: homeA }));
        expect(hook.getCurrent().phase).toBe('loading');
        expect(home.requestsFor(route)).toHaveLength(1);

        await act(async () => { await activateHome(homeB); });
        await act(async () => { response.resolve(); });
        await flushHookEffects();

        expect(lifetime?.isCurrent()).toBe(false);
        expect(hook.getCurrent().phase).toBe('failed');
        expect(hook.getCurrent().runs).toEqual([]);
        expect(getStorage().getState().workflowRunsById).toEqual({});
    });
});
