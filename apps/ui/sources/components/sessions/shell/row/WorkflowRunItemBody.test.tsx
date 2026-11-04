import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    WorkflowRunRecipientCensusResponseV1Schema, WorkflowProgressEnvelopeV1Schema,
    materializeWorkflowAcceptedSnapshotV1, sealWorkflowAcceptedSnapshotStoredEnvelopeV1,
    sealWorkflowFinalResultStoredEnvelopeV1, sealWorkflowProgressStoredEnvelopeV1,
    serializeWorkflowStoredContentEnvelopeV1,
} from '@happier-dev/protocol';
import type { WorkflowRunSummaryV1 } from '@happier-dev/protocol/workflows/workflowProgressV1';
import { t } from '@/text';

import { createDeferred, flushHookEffects, invokeTestInstanceHandler, renderScreen, standardCleanup } from '@/dev/testkit';
import { createWorkflowDefinitionFixture, createWorkflowInvocationIndexFixture, createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { clearMachineRequestReachabilityForTest, withdrawMachinePresenceForScope, captureMachinePresenceObservation } from '@/sync/domains/machines/reachability/machineReachability';

const http = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(http);
const { storage } = await import('@/sync/domains/state/storageStore');
const { workflowRunRowFromSummary, workflowRunStoreKey } = await import('@/sync/store/domains/workflowRuns');
const { publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
const { SessionWritesHereSection } = await import('@/components/workflows/triggers/SessionWritesHereSection');
const { resetWorkflowLibraryReadsForTests } = await import('@/components/workflows/library/workflowLibraryReads');
const { WorkViewportContext } = await import('@/components/sessions/work/WorkItemRow');
const { WorkflowRunItemBody } = await import('./WorkflowRunItemBody');
const { SessionTriggerHistoryScope } = await import('@/components/workflows/triggers/SessionTriggerHistoryScope');
const { WorkflowTriggerRunHistory } = await import('@/components/workflows/triggers/WorkflowTriggerRunHistory');
const route = '/v3/automations/runs/workflow-storage';
const resultText = 'Kept the useful fact.\nArchived its predecessor.';
let previous = storage.getState();
let previousSnapshot = getActiveServerSnapshot();
let singleton: Awaited<ReturnType<typeof loadSyncSingletonForTests>> | undefined;

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
const routerPush = vi.hoisted(() => vi.fn());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ router: { push: routerPush } }).module);
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());

afterEach(async () => {
    clearMachineRequestReachabilityForTest();
    await standardCleanup();
    await http.reset();
    singleton?.dispose();
    singleton = undefined;
    resetWorkflowLibraryReadsForTests();
    storage.setState(previous, true);
    routerPush.mockClear();
    publishAppliedActiveServerSnapshot(previousSnapshot);
});

async function initializeRun() {
    singleton = await loadSyncSingletonForTests();
    previous = storage.getState();
    previousSnapshot = getActiveServerSnapshot();
    await http.reset();
    const id = await http.addHome({ name: 'Habit Home', serverUrl: 'http://habit-result.test', accountId: 'account-1' });
    http.answer(id, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture() });
    storage.getState().activateProfileScope({ serverId: id, accountId: 'account-1' });
    storage.setState({ settings: { ...storage.getState().settings, experiments: true, featureToggles: { automations: true } } });
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
    const summary = createWorkflowRunSummaryFixture({ id: 'habit-run', state: 'succeeded', revision: 3, origin: { kind: 'direct' } });
    storage.getState().upsertWorkflowRuns([workflowRunRowFromSummary(summary, null)]);
    const definition = createWorkflowDefinitionFixture({
        defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } },
        blocks: ['first-session', 'second-session'].map((sessionId, index) => ({
            kind: 'step' as const, id: `writer-${index}`,
            document: { text: 'Write here', references: [], attachments: [] }, input: [], result: { kind: 'text' as const },
            execution: { conversation: { kind: 'existing_session' as const, sessionId, machineId: summary.machineId } },
        })),
    });
    const materialized = await materializeWorkflowAcceptedSnapshotV1({
        definition, admission: { kind: 'user' }, effects: { resolveTargetAvailability: async () => true },
        context: { source: { kind: 'inline' }, inputs: {}, machineId: summary.machineId, executionTarget: { kind: 'session' },
            workspaceTarget: { project: { machineId: summary.machineId, directory: '/repo', checkoutRootPath: '/repo' } },
            origin: { kind: 'direct' }, authorization: { principal: { kind: 'host' } } },
    });
    if (!materialized.ok) throw new Error(`fixture_materialization_failed:${materialized.error.code}`);
    const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
        binding: { v: 1, purpose: 'accepted_snapshot', accountId: summary.ownerAccountId, runId: summary.id }, acceptedSnapshot: materialized.snapshot }));
    const keyCensus = WorkflowRunRecipientCensusResponseV1Schema.parse({ runId: summary.id, ownerAccountId: summary.ownerAccountId,
        access: 'owner', encryptionMode: 'plain', dataEncryptionKey: null, callerDataEncryptionKey: null, recipients: [], visibleTeamId: null,
        ownerAccountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null } });
    const resultEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowFinalResultStoredEnvelopeV1({ mode: 'plain',
        binding: { v: 1, purpose: 'final_result', accountId: summary.ownerAccountId, runId: summary.id },
        finalResult: { kind: 'happier.workflow-final-result.v1', result: { kind: 'text', value: resultText },
            producerInvocation: { recordId: 'chosen-output' } } }));
    const stored = { run: summary, acceptedEnvelope, keyCensus, checkpointEnvelope: null, resultEnvelope };
    const serve = (options: { summary?: WorkflowRunSummaryV1; refuse?: boolean; respondAfter?: Promise<void> } = {}) => {
        const run = options.summary ?? summary;
        http.answer(id, route, { select: (input) => {
            if (!input || typeof input !== 'object' || !('operation' in input)) throw new Error('Missing Workflow operation');
            if (input.operation === 'get') return options.refuse
                ? { status: 503, body: { error: 'content_unavailable' } }
                : { body: stored, respondAfter: options.respondAfter };
            if (input.operation === 'run-key.census') return { body: keyCensus };
            if (input.operation === 'invocations.list') return { body: { invocations: [], parentRevision: run.revision } };
            if (input.operation === 'list') {
                const index = createWorkflowInvocationIndexFixture({ id: 'habit-root', runId: run.id, contentRevision: '8' });
                const progress = WorkflowProgressEnvelopeV1Schema.parse({ kind: 'happier.workflow-progress.v1',
                    invocationPath: { blockId: '$root', scope: [] }, blockKind: 'root', attempt: '0', logicalInvocationRecordId: index.id,
                    ...(run.stepProgress ? { stepProgress: run.stepProgress } : {}) });
                return { body: { runs: [run], acceptedEnvelopesByRunId: { [run.id]: acceptedEnvelope }, keyCensusByRunId: { [run.id]: keyCensus },
                    rootProgressByRunId: { [run.id]: { index,
                        contentEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({ mode: 'plain',
                            binding: { v: 1, purpose: 'invocation_progress', accountId: run.ownerAccountId, runId: run.id,
                                recordId: index.id, sequence: index.sequence, parentRecordId: index.parentRecordId,
                                memberOrdinal: index.memberOrdinal, attempt: index.attempt }, progress })) } } } };
            }
            throw new Error(`Unexpected Workflow operation:${String(input.operation)}`);
        } });
    };
    serve();
    return { home: { id }, detail: { result: resultText }, serve };
}

describe('opened habit History result', () => {
    it('does not call pending Stop offline after its Home withdraws Machine presence', async () => {
        const { home } = await initializeRun();
        const machine = createMachineFixture({ id: 'machine-1', active: true, activeAt: Date.now() });
        storage.setState({ machines: { [machine.id]: machine } });
        storage.getState().upsertWorkflowRuns([workflowRunRowFromSummary(createWorkflowRunSummaryFixture({
            id: 'habit-run', revision: 4, state: 'cancelled', workflowCustodyState: 'pending', attentionRequired: true,
        }))]);
        const screen = await renderScreen(<WorkflowRunItemBody kind="workflow_run" runId="habit-run" serverId={home.id} presentation="work" />);
        await act(async () => withdrawMachinePresenceForScope({ serverId: home.id, accountId: 'account-1' }));
        expect(screen.getTextContent()).not.toContain('workflows.run.stopWhenMachineReconnects');
        await act(async () => {
            storage.setState({ machines: { [machine.id]: { ...machine, active: false, activeAt: Date.now() - 120_000 } } });
            captureMachinePresenceObservation({ serverId: home.id, accountId: 'account-1' })([machine.id]);
        });
        expect(screen.getTextContent()).toContain('workflows.run.stopWhenMachineReconnects');
    });
    it('uses offline Stop presentation until the exact Machine reconnects', async () => {
        const { home } = await initializeRun();
        const machine = createMachineFixture({ id: 'machine-1', active: false, activeAt: Date.now() - 120_000,
            metadata: { ...createMachineFixture().metadata!, displayName: 'Build box' } });
        storage.setState({ machines: { [machine.id]: machine } });
        const stopping = createWorkflowRunSummaryFixture({ id: 'habit-run', revision: 4,
            state: 'cancelled', workflowCustodyState: 'pending', attentionRequired: true });
        storage.getState().upsertWorkflowRuns([workflowRunRowFromSummary(stopping)]);
        const screen = await renderScreen(<WorkflowRunItemBody kind="workflow_run" runId="habit-run" serverId={home.id} presentation="work" />);
        expect(screen.getTextContent()).toContain('workflows.run.stopWhenMachineReconnects');
        expect(screen.getTextContent()).not.toContain('workflows.run.stopping');
        await act(async () => storage.setState({ machines: { [machine.id]: { ...machine, active: true, activeAt: Date.now() } } }));
        expect(screen.getTextContent()).toContain('workflows.run.stopping');
        expect(screen.getTextContent()).not.toContain('workflows.run.stopWhenMachineReconnects');
    });
    it.each(['work', 'list'] as const)('retains the Run source Home when opening its %s row', async (presentation) => {
        const { home } = await initializeRun();
        const screen = await renderScreen(<WorkflowRunItemBody kind="workflow_run" runId="habit-run" serverId={home.id} presentation={presentation} />);
        await screen.pressByTestIdAsync('workflow-run-row:habit-run');
        expect(routerPush).toHaveBeenCalledWith(`/workflows/runs/habit-run?serverId=${encodeURIComponent(home.id)}`);
    });
    it('shows pending physical Stop custody and then the settled outcome despite retained attention membership', async () => {
        const { home } = await initializeRun();
        const stopping = createWorkflowRunSummaryFixture({ id: 'habit-run', revision: 4,
            state: 'cancelled', workflowCustodyState: 'pending', attentionRequired: true });
        storage.getState().upsertWorkflowRuns([workflowRunRowFromSummary(stopping)]);
        const screen = await renderScreen(<WorkflowRunItemBody kind="workflow_run" runId="habit-run" serverId={home.id} presentation="work" />);
        expect(screen.getTextContent()).toContain('workflows.run.stopping');
        expect(screen.getTextContent()).not.toContain('workflows.runState.cancelled');
        await act(async () => storage.getState().upsertWorkflowRuns([workflowRunRowFromSummary({ ...stopping,
            revision: 5, workflowCustodyState: 'settled' })]));
        expect(screen.getTextContent()).toContain('workflows.runState.cancelled');
        expect(screen.getTextContent()).not.toContain('workflows.run.stopping');
    });
    it('leads a Writes-here Run with its destination step, then aggregate progress, and never repeats the Run\'s word', async () => {
        // FIX-VIEWER-D item 3 supersedes DESIGN-SESSION #16's differing step-state copy:
        // the lean row keeps destination identity and progress, with one Run status.
        const { home } = await initializeRun();
        const progress = { completed: 1, total: 3, destinations: [
            { sourceKey: '$root', blockId: 'notes', sessionIds: ['writes-here'], ordinal: 2, name: 'Draft the notes',
                observation: { recordId: 'notes-record', sequence: '1', attempt: '0', contentRevision: '1', lifecycle: 'running' as const } },
        ] };
        const summary: WorkflowRunSummaryV1 = { ...createWorkflowRunSummaryFixture({ id: 'habit-run', state: 'running', revision: 4 }),
            stepProgress: progress };
        storage.getState().upsertWorkflowRuns([workflowRunRowFromSummary(summary, null)]);
        const screen = await renderScreen(<WorkflowRunItemBody kind="workflow_run" runId="habit-run" serverId={home.id}
            presentation="work" destinationSessionId="writes-here" />);
        const text = screen.getTextContent();
        expect(text.indexOf('sessionWork.scheduled.step')).toBeGreaterThan(-1);
        expect(text.indexOf('sessionWork.scheduled.step')).toBeLessThan(text.indexOf('workflows.list.stepsProgress'));
        expect(text).not.toContain('workflows.invocationState.running');
        // The fixture Run started on Sep 8; a Writes-here row says what writes here, not when the Run began.
        expect(text).not.toMatch(/Sep(?:tember)? 8/);
    });
    it.each(['work', 'list'] as const)('uses the Run outcome alone when a destination step last failed (%s)', async (presentation) => {
        const { home } = await initializeRun();
        const summary = createWorkflowRunSummaryFixture({ id: 'habit-run', state: 'interrupted', revision: 4,
            stepProgress: { completed: 0, total: 1, destinations: [
                { sourceKey: '$root', blockId: 'notes', sessionIds: ['writes-here'], ordinal: 1, name: 'Draft the notes',
                    observation: { recordId: 'notes-record', sequence: '1', attempt: '0', contentRevision: '1', lifecycle: 'failed' } },
            ] } });
        storage.getState().upsertWorkflowRuns([workflowRunRowFromSummary(summary, null)]);
        const screen = await renderScreen(<WorkflowRunItemBody kind="workflow_run" runId="habit-run" serverId={home.id}
            presentation={presentation} destinationSessionId="writes-here" />);
        const text = screen.getTextContent();
        expect(text).toContain('sessionWork.scheduled.step(ordinal=1,title=Draft the notes)');
        expect(text).toContain(t('workflows.list.stepsProgress', summary.stepProgress!));
        expect(text.split('workflows.runState.interrupted')).toHaveLength(2);
        expect(text).not.toContain('workflows.invocationState.failed');
        expect(screen.findHostByTestId('workflow-run-row:habit-run')?.props.accessibilityLabel)
            .not.toContain('workflows.invocationState.failed');
    });
    it('lists a Run once when an open trigger History already shows it', async () => {
        const { home } = await initializeRun();
        const viewport = { observe: (_target: unknown, onChange: (visible: boolean) => void) => {
            onChange(false);
            return () => {};
        } };
        const mount = (scoped: boolean) => {
            const lists = <>
                <WorkflowTriggerRunHistory automationId="auto-1" triggerId="timer" />
                <SessionWritesHereSection sessionId="first-session" serverId={home.id} />
            </>;
            return renderScreen(<WorkViewportContext.Provider value={viewport}>
                {scoped ? <SessionTriggerHistoryScope>{lists}</SessionTriggerHistoryScope> : lists}
            </WorkViewportContext.Provider>);
        };
        const unscoped = await mount(false);
        await flushHookEffects({ cycles: 40 });
        expect(unscoped.findAllHostsByTestId('workflow-run-row:habit-run').length).toBeGreaterThan(1);
        const scoped = await mount(true);
        await flushHookEffects({ cycles: 40 });
        expect(scoped.findAllHostsByTestId('workflow-run-row:habit-run')).toHaveLength(1);
    });
    it('keeps each destination writer beside aggregate progress with the Run status alone', async () => {
        const { home, serve } = await initializeRun();
        const summary: WorkflowRunSummaryV1 = { ...createWorkflowRunSummaryFixture({ id: 'habit-run', state: 'running', revision: 4 }),
            stepProgressCurrentness: { recordId: 'root-record', attempt: '0', contentRevision: '8' },
            stepProgress: { completed: 1, total: 3, destinations: [
                { sourceKey: '$root', blockId: 'check', sessionIds: ['first-session'], ordinal: 1, name: 'Check',
                    observation: { recordId: 'check-record', sequence: '1', attempt: '0', contentRevision: '2', lifecycle: 'completed' } },
                { sourceKey: '$root', blockId: 'report', sessionIds: ['second-session'], ordinal: 2, name: 'Report',
                    observation: { recordId: 'report-record', sequence: '3', attempt: '0', contentRevision: '1', lifecycle: 'running' } },
                { sourceKey: 'nested', blockId: 'follow-up', sessionIds: ['second-session'], ordinal: 1, name: 'Follow up' },
                { sourceKey: '$root', blockId: 'wait', sessionIds: ['first-session'], ordinal: 3, name: 'Wait',
                    observation: { recordId: 'wait-record', sequence: '4', attempt: '0', contentRevision: '1',
                        lifecycle: 'waiting_for_review', blockKind: 'wait' } },
            ] } };
        serve({ summary });
        // The platform viewport reports these mounted rows as off-screen: the
        // existing optional live mini-map is not demanded by this lean-row test.
        const viewport = { observe: (_target: unknown, onChange: (visible: boolean) => void) => {
            onChange(false);
            return () => {};
        } };
        const first = await renderScreen(<WorkViewportContext.Provider value={viewport}>
            <SessionWritesHereSection sessionId="first-session" serverId={home.id} />
        </WorkViewportContext.Provider>);
        const second = await renderScreen(<WorkViewportContext.Provider value={viewport}>
            <SessionWritesHereSection sessionId="second-session" serverId={home.id} />
        </WorkViewportContext.Provider>);
        expect(first.getTextContent()).toContain('Check');
        expect(first.getTextContent()).not.toContain('workflows.invocationState.completed');
        expect(first.getTextContent()).not.toContain('Report');
        expect(first.getTextContent()).toContain('Wait');
        expect(first.getTextContent()).not.toContain('workflows.review.waitTitle');
        expect(first.getTextContent()).not.toContain('workflows.invocationState.waiting_for_review');
        expect(second.getTextContent()).toContain('Report');
        expect(second.getTextContent()).toContain('Follow up');
        expect(second.getTextContent()).not.toContain('workflows.invocationState.running');
        expect(second.getTextContent()).not.toContain('workflows.invocationState.pending');
        expect(second.getTextContent()).not.toContain('workflows.list.observedProgress');
        for (const screen of [first, second]) {
            expect(screen.getTextContent()).toContain('workflows.list.stepsProgress');
            expect(screen.findHostByTestId('workflow-run-row:habit-run')?.props.accessibilityLabel)
                .toContain('sessionWork.scheduled.step');
        }
        expect(http.requestsFor(route).map(request => request.input)).toMatchObject([
            { operation: 'list', request: { targetSessionId: 'first-session' } },
            { operation: 'list', request: { targetSessionId: 'second-session' } },
        ]);
    });
    it.each(['list', 'work'] as const)('names a Run whose title is unreadable by its trigger, and says why quietly (%s)', async (presentation) => {
        const { home } = await initializeRun();
        const summary = createWorkflowRunSummaryFixture({ id: 'habit-run', state: 'running', revision: 4,
            stepProgress: { completed: 0, total: 1 } });
        storage.getState().upsertWorkflowRuns([workflowRunRowFromSummary(summary, { kind: 'unavailable', reason: 'content_unavailable' })]);
        const screen = await renderScreen(<WorkflowRunItemBody kind="workflow_run" runId="habit-run"
            serverId={home.id} presentation={presentation} fallbackName="Memory upkeep" />);
        const label = String(screen.findHostByTestId('workflow-run-row:habit-run')?.props.accessibilityLabel);
        // The accessible name leads with the trigger's name; the read failure is a later, quiet fragment.
        expect(label.startsWith('Memory upkeep.')).toBe(true);
        expect(label).toContain('workflows.contentUnavailable');
    });
    it('keeps the stopped lifecycle word in visual and spoken attention rows', async () => {
        const { home } = await initializeRun();
        storage.getState().upsertWorkflowRuns([workflowRunRowFromSummary(createWorkflowRunSummaryFixture({
            id: 'habit-run', state: 'cancelled', revision: 4, attentionRequired: true, workflowCustodyState: 'settled',
        }), null)]);
        for (const presentation of ['list', 'work'] as const) {
            const screen = await renderScreen(<WorkflowRunItemBody kind="workflow_run" runId="habit-run"
                serverId={home.id} presentation={presentation} />);
            expect(screen.getTextContent()).toContain('workflows.runState.cancelled');
            expect(screen.findHostByTestId('workflow-run-row:habit-run')?.props.accessibilityLabel)
                .toContain('workflows.runState.cancelled');
            expect(screen.getTextContent()).not.toContain('workStatus.buckets.needs_you');
        }
    });
    it('reads the exact selected Run result only when demanded and publishes it to the existing body owner', async () => {
        const { home, detail } = await initializeRun();
        await renderScreen(<WorkflowRunItemBody kind="workflow_run" runId="habit-run" serverId={home.id} />);
        expect(http.requestsFor(route)).toEqual([]);
        const screen = await renderScreen(<WorkflowRunItemBody kind="workflow_run" runId="habit-run" serverId={home.id}
            {...{ includeResult: true }} />);
        await flushHookEffects({ cycles: 40 });
        expect(JSON.stringify(screen.tree.toJSON())).toContain('Kept the useful fact. Archived its predecessor.');
        expect(storage.getState().workflowRunsById[workflowRunStoreKey('habit-run')]?.detail)
            .toMatchObject({ result: detail.result, finalOutputInvocationId: 'chosen-output' });
        expect(http.requestsFor(route).filter(request => request.input && typeof request.input === 'object'
            && 'operation' in request.input && request.input.operation === 'get').map(request => request.input))
            .toEqual([{ operation: 'get', runId: 'habit-run' }]);
    });

    it.each([true, false])('refuses an unavailable exact result and keeps the summary and retry reachable (press event: %s)', async (withPressEvent) => {
        const { home, serve } = await initializeRun();
        serve({ refuse: true });
        const screen = await renderScreen(<WorkflowRunItemBody kind="workflow_run" runId="habit-run" serverId={home.id}
            {...{ includeResult: true }} />);
        expect(JSON.stringify(screen.tree.toJSON())).toContain('workflows.contentUnavailable');
        expect(storage.getState().workflowRunsById[workflowRunStoreKey('habit-run')]?.detail).toBeUndefined();
        serve();
        const stopPropagation = vi.fn();
        await act(async () => {
            invokeTestInstanceHandler(screen.findHostByTestId('workflow-run-result:habit-run:retry'), 'onPress', withPressEvent ? { stopPropagation } : undefined);
        });
        await flushHookEffects({ cycles: 40 });
        expect(stopPropagation).toHaveBeenCalledTimes(withPressEvent ? 1 : 0);
        expect(JSON.stringify(screen.tree.toJSON())).toContain('Kept the useful fact. Archived its predecessor.');
    });

    it('discards an exact-result response after the Account changes', async () => {
        const { home, serve } = await initializeRun();
        const pending = createDeferred<void>();
        serve({ respondAfter: pending.promise });
        const screen = await renderScreen(<WorkflowRunItemBody kind="workflow_run" runId="habit-run" serverId={home.id}
            {...{ includeResult: true }} />);
        expect(http.requestsFor(route).map(request => request.input)).toEqual([{ operation: 'get', runId: 'habit-run' }]);
        await act(async () => {
            storage.setState({ profileScope: { serverId: home.id, accountId: 'other-account' }, workflowRunsById: {} });
            pending.resolve();
            await pending.promise;
        });
        await flushHookEffects({ cycles: 40 });
        expect(storage.getState().workflowRunsById[workflowRunStoreKey('habit-run', { serverId: home.id, accountId: 'account-1' })]).toBeUndefined();
        expect(JSON.stringify(screen.tree.toJSON())).not.toContain('Kept the useful fact.');
    });
});
