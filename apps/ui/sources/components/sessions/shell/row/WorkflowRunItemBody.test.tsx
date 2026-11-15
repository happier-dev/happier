import * as React from 'react';
import { View } from 'react-native';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    WorkflowRunRecipientCensusResponseV1Schema} from '@happier-dev/protocol/workflows/workflowRunKeyV1';
import { WorkflowProgressEnvelopeV1Schema} from '@happier-dev/protocol/workflows/workflowProgressV1';
import {
    materializeWorkflowAcceptedSnapshotV1} from '@happier-dev/protocol/workflows/materializeWorkflowAcceptedSnapshotV1';
import { sealWorkflowAcceptedSnapshotStoredEnvelopeV1,
    sealWorkflowFinalResultStoredEnvelopeV1, sealWorkflowProgressStoredEnvelopeV1,
    serializeWorkflowStoredContentEnvelopeV1,
} from '@happier-dev/protocol/workflows/workflowStoredContentV1';
import type { WorkflowRunSummaryV1 } from '@happier-dev/protocol/workflows/workflowProgressV1';
import { WorkflowTriggerSetV1Schema } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import { AutomationRunCauseSchema } from '@happier-dev/protocol/automations/automationRunCause';
import { HappierStatusDot } from '@happier-dev/plugin-ui/presentation';
import { t } from '@/text';

import { createDeferred, flushHookEffects, invokeTestInstanceHandler, renderScreen, standardCleanup } from '@/dev/testkit';
import { createWorkflowDefinitionFixture, createWorkflowInvocationIndexFixture, createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { publishMachineActivityForTest } from '@/dev/testkit/harness/machinePresence';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { clearMachineRequestReachabilityForTest, withdrawMachinePresenceForScope } from '@/sync/domains/machines/reachability/machineReachability';

const http = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(http);
const { storage } = await import('@/sync/domains/state/storageStore');
const { workflowRunRowFromSummary, workflowRunStoreKey } = await import('@/sync/store/domains/workflowRuns');
const { publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
const { SessionWritesHereSection } = await import('@/components/workflows/triggers/SessionWritesHereSection');
const { useScheduledWorkflowRows } = await import('@/components/workflows/triggers/ScheduledWorkflowSection');
const { resetWorkflowLibraryReadsForTests, useWorkflowRunWindow } = await import('@/components/workflows/library/workflowLibraryReads');
const { WorkViewportContext } = await import('@/components/sessions/work/WorkItemRow');
const { WorkflowRunItemBody } = await import('./WorkflowRunItemBody');
const { SessionTriggerHistoryScope } = await import('@/components/workflows/triggers/SessionTriggerHistoryScope');
const { WorkflowTriggerRunHistory } = await import('@/components/workflows/triggers/WorkflowTriggerRunHistory');
const { WorkflowTriggerSection } = await import('@/components/workflows/triggers/WorkflowTriggerSection');
const { EMPTY_WORKFLOW_TRIGGER_DRAFT } = await import('@/components/workflows/triggers/workflowTriggerDraft');
const { useAccountWorkflowEditor } = await import('@/components/workflows/triggers/AccountTriggersSection');
const { ToolbarButton } = await import('@/components/ui/buttons/ToolbarButton');

function SessionWritesHereTestHost(props: Readonly<{ sessionId: string; serverId: string }>) {
    const scheduled = useScheduledWorkflowRows(props.sessionId);
    const read = useWorkflowRunWindow(`destination:${props.sessionId}`);
    return <SessionWritesHereSection {...props} scheduled={scheduled} read={read} />;
}
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
// The portal is the native/DOM boundary; the trigger form and History action stay real.
vi.mock('@/components/ui/popover', async (importOriginal) =>
    (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(importOriginal,
        { maxHeight: 640, maxWidth: 280, placement: 'bottom' }));

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

async function initializeRun(triggerId?: string) {
    singleton = await loadSyncSingletonForTests();
    previous = storage.getState();
    previousSnapshot = getActiveServerSnapshot();
    await http.reset();
    const id = await http.addHome({ name: 'Habit Home', serverUrl: 'http://habit-result.test', accountId: 'account-1' });
    http.answer(id, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture() });
    storage.getState().activateProfileScope({ serverId: id, accountId: 'account-1' });
    storage.setState({ settings: { ...storage.getState().settings, experiments: true, featureToggles: { automations: true } } });
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
    const cause = triggerId ? AutomationRunCauseSchema.parse({ kind: 'trigger', triggerId, triggerRevision: 1, triggerKind: 'schedule',
        occurrenceKey: 'A'.repeat(43), occurredAt: 1, evidence: { scheduledFor: 1 } }) : null;
    const summary = createWorkflowRunSummaryFixture({ id: 'habit-run', state: 'succeeded', revision: 3,
        origin: cause ? { kind: 'automation', automationId: 'auto-1', cause } : { kind: 'direct' } });
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
        context: { source: cause ? { kind: 'automation', automationId: 'auto-1', definitionId: 'saved-workflow',
                revision: { headerVersion: 1, bodyVersion: 1 }, savedBy: { kind: 'person', accountId: 'account-1' } } : { kind: 'inline' },
            inputs: {}, machineId: summary.machineId, executionTarget: { kind: 'session' },
            workspaceTarget: { project: { machineId: summary.machineId, directory: '/repo', checkoutRootPath: '/repo' } },
            ...(cause ? { actionCaller: { kind: 'automationRun' as const, runId: summary.id, automationId: 'auto-1', cause } }
                : { origin: { kind: 'direct' as const } }), authorization: { principal: { kind: 'host' } } },
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
    const serve = (options: { summary?: WorkflowRunSummaryV1; refuse?: boolean; respondAfter?: Promise<void>; noResult?: boolean } = {}) => {
        const run = options.summary ?? summary;
        http.answer(id, route, { select: (input) => {
            if (!input || typeof input !== 'object' || !('operation' in input)) throw new Error('Missing Workflow operation');
            if (input.operation === 'get') return options.refuse
                ? { status: 503, body: { error: 'content_unavailable' } }
                : { body: options.noResult ? { ...stored, resultEnvelope: null } : stored, respondAfter: options.respondAfter };
            if (input.operation === 'run-key.census') return { body: keyCensus };
            if (input.operation === 'invocations.list') return { body: { invocations: [], parentRevision: run.revision } };
            if (input.operation === 'list') {
                if (triggerId && (!('request' in input) || input.request === null || typeof input.request !== 'object'
                    || !('triggerId' in input.request) || input.request.triggerId !== triggerId)) {
                    return { body: { runs: [], acceptedEnvelopesByRunId: {}, keyCensusByRunId: {}, rootProgressByRunId: {} } };
                }
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
    it.each(['machine_offline', 'machine_presence_at_due_unavailable'] as const)('retains a missed one-time occurrence and its reason in schedule History (%s)', async errorCode => {
        const { serve } = await initializeRun('timer');
        const cause = AutomationRunCauseSchema.parse({ kind: 'trigger', triggerId: 'timer', triggerRevision: 1,
            triggerKind: 'schedule', occurrenceKey: 'A'.repeat(43), occurredAt: 1, evidence: { scheduledFor: 1 } });
        const summary = createWorkflowRunSummaryFixture({ id: 'habit-run', revision: 4, state: 'missed', errorCode,
            workflowCustodyState: 'settled', origin: { kind: 'automation', automationId: 'auto-1', cause } });
        serve({ summary });
        storage.getState().upsertWorkflowRuns([workflowRunRowFromSummary(summary, null)]);
        const set = WorkflowTriggerSetV1Schema.parse({ automationId: 'auto-1', revision: 1, enabled: true, health: 'available',
            triggers: [{ id: 'timer', revision: 1, enabled: true, kind: 'schedule', nextRunAt: null, remainingOccurrences: 0,
                createdAt: 1, updatedAt: 1, triggerDefinitionEnvelope: null, schedule: { kind: 'once', scheduledAt: 1 } }] });
        const screen = await renderScreen(<WorkflowTriggerSection testIDPrefix="missed-once" set={set}
            draft={EMPTY_WORKFLOW_TRIGGER_DRAFT} onChangeDraft={() => {}} status="ready" onRetry={() => {}}
            stepsUnsaved={false} whereTarget={null} whereSummary={null} inputs={[]} />);
        expect(screen.getTextContent()).toContain('common.done');
        await screen.pressByTestIdAsync('missed-once-trigger:saved:timer-more');
        await screen.pressByTestIdAsync('missed-once-trigger:saved:timer-history');
        await waitForHomeGovernance(() => expect(screen.findHostByTestId('workflow-run-row:habit-run')).not.toBeNull());
        expect(screen.getTextContent()).toContain(errorCode === 'machine_offline'
            ? 'workflows.triggers.once.missedOffline' : 'workflows.triggers.once.missedUnavailable');
        expect(screen.getTextContent()).not.toContain('workflows.finalOutput.none');
    });
    it('opens a saved workflow schedule History on demand with its frozen editor attribution', async () => {
        await initializeRun('timer');
        const set = WorkflowTriggerSetV1Schema.parse({ automationId: 'auto-1', revision: 1, enabled: true, health: 'available',
            // The current definition changed since this occurrence; History must read the accepted source.
            sourceSavedBy: { kind: 'agent', accountId: 'account-1' },
            triggers: ['timer', 'sibling-timer'].map(id => ({ id, revision: 1, enabled: true, kind: 'schedule', nextRunAt: null,
                createdAt: 1, updatedAt: 1, triggerDefinitionEnvelope: null,
                schedule: { kind: 'interval', everyMs: 60_000, scheduleExpr: null, timezone: null } })) });
        const before = http.requests.length;
        const screen = await renderScreen(<WorkflowTriggerSection testIDPrefix="saved-workflow" set={set}
            draft={EMPTY_WORKFLOW_TRIGGER_DRAFT} onChangeDraft={() => {}} status="ready" onRetry={() => {}}
            stepsUnsaved={false} whereTarget={null} whereSummary={null} inputs={[]} />);
        await flushHookEffects();
        expect(http.requests.slice(before).filter(request => request.path === route)).toHaveLength(0);
        expect(screen.findHostByTestId('workflow-run-row:habit-run')).toBeNull();
        // History waits behind the row's ⋯ (owner 0936 #14), and opening the menu reads nothing.
        await screen.pressByTestIdAsync('saved-workflow-trigger:saved:timer-more');
        expect(screen.findHostByTestId('saved-workflow-trigger:saved:timer-history')).not.toBeNull();
        expect(http.requests.slice(before).filter(request => request.path === route)).toHaveLength(0);
        await screen.pressByTestIdAsync('saved-workflow-trigger:saved:timer-history');
        await waitForHomeGovernance(() => expect(screen.findHostByTestId('workflow-run-row:habit-run')).not.toBeNull());
        expect(screen.getTextContent()).toContain('workflows.run.editedByYou');
        // Attribution takes its own line, so a long progress or result line never clips it.
        expect(screen.findHostByTestId('workflow-run-row:habit-run:edited-by')).not.toBeNull();
        const reads = http.requests.slice(before).filter(request => request.path === route && request.input !== null
            && typeof request.input === 'object' && 'operation' in request.input && request.input.operation === 'list');
        expect(reads.length).toBeGreaterThan(0);
        for (const request of reads) expect(request.input).toMatchObject({ request: { triggerId: 'timer' } });
        const beforeSibling = http.requests.length;
        await screen.pressByTestIdAsync('saved-workflow-trigger:saved:sibling-timer-more');
        await screen.pressByTestIdAsync('saved-workflow-trigger:saved:sibling-timer-history');
        await waitForHomeGovernance(() => expect(http.requests.slice(beforeSibling).some(request => request.path === route)).toBe(true));
        await flushHookEffects();
        const siblingReads = http.requests.slice(beforeSibling).filter(request => request.path === route
            && request.input !== null && typeof request.input === 'object' && 'operation' in request.input
            && request.input.operation === 'list');
        expect(siblingReads.length).toBeGreaterThan(0);
        for (const request of siblingReads) expect(request.input).toMatchObject({ request: { triggerId: 'sibling-timer' } });
        expect(screen.findHostByTestId('workflow-run-row:habit-run')).toBeNull();
        await screen.pressByTestIdAsync('saved-workflow-trigger:saved:timer');
        expect(screen.findHostByTestId('saved-workflow-trigger-popover-history')).not.toBeNull();
        await screen.pressByTestIdAsync('saved-workflow-trigger-popover-history');
        await waitForHomeGovernance(() => expect(screen.findHostByTestId('workflow-run-row:habit-run')).not.toBeNull());
        expect(screen.getTextContent()).toContain('workflows.run.editedByYou');
    });
    it('opens an inline Account workflow occurrence from its settings History action', async () => {
        await initializeRun('timer');
        const set = WorkflowTriggerSetV1Schema.parse({ automationId: 'auto-1', revision: 1, enabled: true, health: 'available',
            target: { kind: 'inline', definition: createWorkflowDefinitionFixture() },
            triggers: [{ id: 'timer', revision: 1, enabled: true, kind: 'schedule', nextRunAt: null,
                createdAt: 1, updatedAt: 1, triggerDefinitionEnvelope: null,
                schedule: { kind: 'interval', everyMs: 60_000, scheduleExpr: null, timezone: null } }] });
        const read = { sets: [set], status: 'ready' as const, retry: () => {}, acknowledge: () => {} };
        function InlineAccountWorkflow() {
            const anchorRef = React.useRef<View>(null);
            const editor = useAccountWorkflowEditor({ read });
            return <>
                <View ref={anchorRef}><ToolbarButton testID="inline-workflow-settings" label="Open settings"
                    onPress={() => { void editor.open({ automationId: set.automationId, triggerId: set.triggers[0]!.id }, anchorRef); }} /></View>
                {editor.popover}
            </>;
        }
        const screen = await renderScreen(<InlineAccountWorkflow />);
        const before = http.requests.length;
        await screen.pressByTestIdAsync('inline-workflow-settings');
        expect(screen.findHostByTestId('workflows-column-trigger-popover-history')).not.toBeNull();
        expect(http.requests.slice(before).filter(request => request.path === route)).toHaveLength(0);
        await screen.pressByTestIdAsync('workflows-column-trigger-popover-history');
        await waitForHomeGovernance(() => expect(screen.findHostByTestId('workflow-run-row:habit-run')).not.toBeNull());
        expect(screen.getTextContent()).toContain('workflows.run.editedByYou');
    });
    it.each(['list', 'work'] as const)('mounts the held request outside navigation in its %s row without loading a closed body', async (presentation) => {
        const { home } = await initializeRun();
        storage.getState().upsertWorkflowRuns([workflowRunRowFromSummary(createWorkflowRunSummaryFixture({
            id: 'habit-run', revision: 4, state: 'waiting_for_review', invocationAttentionRequired: true,
            heldStep: { invocationId: 'review-step', label: 'Review changes' },
        }))]);
        const before = http.requests.length;
        const screen = await renderScreen(<WorkflowRunItemBody kind="workflow_run" runId="habit-run" serverId={home.id} presentation={presentation} />);
        const trigger = screen.findHostByTestId('workflow-run-request-peek:habit-run');
        expect(trigger).not.toBeNull();
        expect(screen.findByTestId('workflow-run-request-peek:habit-run:peek')).toBeNull();
        for (let node = trigger?.parent; node; node = node.parent) {
            if (typeof node.type !== 'string') continue;
            expect(node.props.testID).not.toBe('workflow-run-row:habit-run');
        }
        expect(storage.getState().workflowRunsById[workflowRunStoreKey('habit-run')]?.detail).toBeUndefined();
        expect(http.requests.slice(before).filter(request => request.path === route)).toHaveLength(0);
    });
    it.each([
        { name: 'running offline', state: 'running', offline: true, dot: false, spinning: false },
        { name: 'live running', state: 'running', offline: false, dot: false, spinning: true },
        { name: 'acknowledged failure', state: 'failed', offline: false, dot: false, spinning: false },
        { name: 'review hold', state: 'waiting_for_review', offline: false, dot: true, spinning: false },
        { name: 'stopped with pending cleanup', state: 'cancelled', offline: false, dot: false, spinning: false },
    ] as const)('draws the calm row mark for $name (ruling 2026-11-01)', async ({ state, offline, dot, spinning }) => {
        const { home } = await initializeRun();
        const machine = createMachineFixture({ id: 'machine-1', active: !offline,
            activeAt: offline ? Date.now() - 120_000 : Date.now() });
        storage.setState({ machines: { [machine.id]: machine } });
        publishMachineActivityForTest([machine]);
        storage.getState().upsertWorkflowRuns([workflowRunRowFromSummary(createWorkflowRunSummaryFixture({
            id: 'habit-run', revision: 4, state, failureUnseen: false,
            attentionRequired: state === 'waiting_for_review', invocationAttentionRequired: state === 'waiting_for_review',
            workflowCustodyState: state === 'cancelled' ? 'pending' : 'settled',
        }))]);
        const screen = await renderScreen(<WorkflowRunItemBody kind="workflow_run" runId="habit-run" serverId={home.id} />);
        const spinner = screen.findHostByTestId('session-row-attention-indicator-spinner-workflow-run-habit-run');
        expect(Boolean(spinner)).toBe(spinning);
        const id = 'session-row-attention-indicator-dot-workflow-run-habit-run';
        expect(Boolean(screen.findHostByTestId(id))).toBe(dot);
        // A row mark is a plain dot: the state's shape lives in the word, never a glyph on the row.
        expect(screen.findAllByType(HappierStatusDot).find(node => node.props.testID === id)?.props.glyph).toBeUndefined();
    });
    it('keeps a stopped Run terminal after its Home withdraws Machine presence and observes it offline', async () => {
        const { home } = await initializeRun();
        const machine = createMachineFixture({ id: 'machine-1', active: true, activeAt: Date.now() });
        storage.setState({ machines: { [machine.id]: machine } });
        publishMachineActivityForTest([machine]);
        storage.getState().upsertWorkflowRuns([workflowRunRowFromSummary(createWorkflowRunSummaryFixture({
            id: 'habit-run', revision: 4, state: 'cancelled', workflowCustodyState: 'pending', attentionRequired: true,
        }))]);
        const screen = await renderScreen(<WorkflowRunItemBody kind="workflow_run" runId="habit-run" serverId={home.id} presentation="work" />);
        await act(async () => withdrawMachinePresenceForScope({ serverId: home.id, accountId: 'account-1' }));
        expect(screen.getTextContent()).not.toContain('workflows.run.stopWhenMachineReconnects');
        expect(screen.getTextContent()).toContain('workflows.runState.cancelled');
        await act(async () => {
            const offlineMachine = { ...machine, active: false, activeAt: Date.now() - 120_000 };
            storage.setState({ machines: { [machine.id]: offlineMachine } });
            publishMachineActivityForTest([offlineMachine]);
        });
        expect(screen.getTextContent()).not.toContain('workflows.run.stopWhenMachineReconnects');
        expect(screen.getTextContent()).toContain('workflows.runState.cancelled');
        expect(screen.findHostByTestId('session-row-attention-indicator-spinner-workflow-run-habit-run')).toBeNull();
    });
    it('keeps a stopped Run terminal with pending cleanup while its Machine reconnects', async () => {
        const { home } = await initializeRun();
        const machine = createMachineFixture({ id: 'machine-1', active: false, activeAt: Date.now() - 120_000,
            metadata: { ...createMachineFixture().metadata!, displayName: 'Build box' } });
        storage.setState({ machines: { [machine.id]: machine } });
        publishMachineActivityForTest([machine]);
        const stopping = createWorkflowRunSummaryFixture({ id: 'habit-run', revision: 4,
            state: 'cancelled', workflowCustodyState: 'pending', attentionRequired: true });
        storage.getState().upsertWorkflowRuns([workflowRunRowFromSummary(stopping)]);
        const screen = await renderScreen(<WorkflowRunItemBody kind="workflow_run" runId="habit-run" serverId={home.id} presentation="work" />);
        expect(screen.getTextContent()).not.toContain('workflows.run.stopWhenMachineReconnects');
        expect(screen.getTextContent()).not.toContain('workflows.run.stopping');
        expect(screen.getTextContent()).toContain('workflows.runState.cancelled');
        await act(async () => {
            const reconnectedMachine = { ...machine, active: true, activeAt: Date.now() };
            storage.setState({ machines: { [machine.id]: reconnectedMachine } });
            publishMachineActivityForTest([reconnectedMachine]);
        });
        expect(screen.getTextContent()).not.toContain('workflows.run.stopping');
        expect(screen.getTextContent()).not.toContain('workflows.run.stopWhenMachineReconnects');
        expect(screen.getTextContent()).toContain('workflows.runState.cancelled');
        expect(screen.findHostByTestId('session-row-attention-indicator-spinner-workflow-run-habit-run')).toBeNull();
        expect(storage.getState().workflowRunsById[workflowRunStoreKey('habit-run')]?.summary?.workflowCustodyState).toBe('pending');
    });
    it.each(['list', 'work'] as const)('does not re-render its %s row for a Machine heartbeat that keeps presence', async (presentation) => {
        const { home } = await initializeRun();
        const machine = createMachineFixture({ id: 'machine-1', active: true, activeAt: Date.now(),
            metadata: { ...createMachineFixture().metadata!, displayName: 'Build box' } });
        storage.setState({ machines: { [machine.id]: machine } });
        publishMachineActivityForTest([machine]);
        storage.getState().upsertWorkflowRuns([workflowRunRowFromSummary(createWorkflowRunSummaryFixture({
            id: 'habit-run', revision: 4, state: 'running' }))]);
        let commits = 0;
        const screen = await renderScreen(<React.Profiler id="row" onRender={() => { commits += 1; }}>
            <WorkflowRunItemBody kind="workflow_run" runId="habit-run" serverId={home.id} presentation={presentation} />
        </React.Profiler>);
        await flushHookEffects();
        const settled = commits;
        // A live Machine republishes its record on every heartbeat (activeAt, updatedAt, daemon state).
        for (let beat = 1; beat <= 3; beat += 1) {
            await act(async () => {
                const heartbeatMachine = { ...machine, activeAt: (machine.activeAt ?? 0) + beat * 1000,
                    updatedAt: (machine.updatedAt ?? 0) + beat };
                storage.setState({ machines: { [machine.id]: heartbeatMachine } });
                publishMachineActivityForTest([heartbeatMachine]);
            });
        }
        expect(commits - settled).toBe(0);
        await act(async () => storage.setState({ machines: { [machine.id]: { ...machine,
            metadata: { ...machine.metadata!, displayName: 'Release box' } } } }));
        expect(commits - settled).toBe(1);
        expect(screen).toBeTruthy();
    });
    it.each(['work', 'list'] as const)('retains the Run source Home when opening its %s row', async (presentation) => {
        const { home } = await initializeRun();
        const screen = await renderScreen(<WorkflowRunItemBody kind="workflow_run" runId="habit-run" serverId={home.id} presentation={presentation} />);
        await screen.pressByTestIdAsync('workflow-run-row:habit-run');
        expect(routerPush).toHaveBeenCalledWith(`/workflows/runs/habit-run?serverId=${encodeURIComponent(home.id)}`);
    });
    it('keeps the stopped headline while physical cleanup is pending and after it settles', async () => {
        const { home } = await initializeRun();
        const stopping = createWorkflowRunSummaryFixture({ id: 'habit-run', revision: 4,
            state: 'cancelled', workflowCustodyState: 'pending', attentionRequired: true });
        storage.getState().upsertWorkflowRuns([workflowRunRowFromSummary(stopping)]);
        const screen = await renderScreen(<WorkflowRunItemBody kind="workflow_run" runId="habit-run" serverId={home.id} presentation="work" />);
        // FIN-RUN-CONTROLS: terminal lifecycle owns the headline independently of cleanup custody.
        expect(screen.getTextContent()).toContain('workflows.runState.cancelled');
        expect(screen.getTextContent()).not.toContain('workflows.run.stopping');
        expect(screen.findHostByTestId('session-row-attention-indicator-spinner-workflow-run-habit-run')).toBeNull();
        expect(storage.getState().workflowRunsById[workflowRunStoreKey('habit-run')]?.summary?.workflowCustodyState).toBe('pending');
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
    it('announces a trigger origin once in its History row', async () => {
        const { home } = await initializeRun();
        const summary = createWorkflowRunSummaryFixture({ id: 'habit-run', state: 'running', revision: 4, startedBy: 'trigger' });
        storage.getState().upsertWorkflowRuns([workflowRunRowFromSummary(summary, null)]);
        const screen = await renderScreen(<WorkflowRunItemBody kind="workflow_run" runId="habit-run" serverId={home.id} inTriggerHistory />);
        const label = String(screen.findHostByTestId('workflow-run-row:habit-run')?.props.accessibilityLabel);
        expect(label.split(t('workflows.list.startedByTrigger'))).toHaveLength(2);
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
                <SessionWritesHereTestHost sessionId="first-session" serverId={home.id} />
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
            <SessionWritesHereTestHost sessionId="first-session" serverId={home.id} />
        </WorkViewportContext.Provider>);
        const second = await renderScreen(<WorkViewportContext.Provider value={viewport}>
            <SessionWritesHereTestHost sessionId="second-session" serverId={home.id} />
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
        // The real Action executor loads asynchronously; await its observable result.
        await waitForHomeGovernance(() => {
            expect(JSON.stringify(screen.tree.toJSON())).toContain('Kept the useful fact. Archived its predecessor.');
        });
        expect(storage.getState().workflowRunsById[workflowRunStoreKey('habit-run')]?.detail)
            .toMatchObject({ result: detail.result, finalOutputInvocationId: 'chosen-output' });
        expect(http.requestsFor(route).filter(request => request.input && typeof request.input === 'object'
            && 'operation' in request.input && request.input.operation === 'get').map(request => request.input))
            .toEqual([{ operation: 'get', runId: 'habit-run' }]);
    });

    it('keeps the Run status line when the Run has no final output, never the editor\'s "no final output selected"', async () => {
        const { home, serve } = await initializeRun();
        serve({ noResult: true });
        const screen = await renderScreen(<WorkflowRunItemBody kind="workflow_run" runId="habit-run" serverId={home.id}
            {...{ includeResult: true }} />);
        await waitForHomeGovernance(() => {
            expect(storage.getState().workflowRunsById[workflowRunStoreKey('habit-run')]?.detail).toBeDefined();
        });
        await flushHookEffects({ cycles: 10 });
        expect(screen.getTextContent()).not.toContain('workflows.finalOutput.none');
        expect(screen.getTextContent()).not.toContain('common.loading');
    });

    it.each([true, false])('refuses an unavailable exact result and keeps the summary and retry reachable (press event: %s)', async (withPressEvent) => {
        const { home, serve } = await initializeRun();
        serve({ refuse: true });
        const screen = await renderScreen(<WorkflowRunItemBody kind="workflow_run" runId="habit-run" serverId={home.id}
            {...{ includeResult: true }} />);
        await waitForHomeGovernance(() => {
            expect(JSON.stringify(screen.tree.toJSON())).toContain('workflows.contentUnavailable');
        });
        expect(storage.getState().workflowRunsById[workflowRunStoreKey('habit-run')]?.detail).toBeUndefined();
        serve();
        const stopPropagation = vi.fn();
        await act(async () => {
            invokeTestInstanceHandler(screen.findHostByTestId('workflow-run-result:habit-run:retry'), 'onPress', withPressEvent ? { stopPropagation } : undefined);
        });
        expect(stopPropagation).toHaveBeenCalledTimes(withPressEvent ? 1 : 0);
        await waitForHomeGovernance(() => {
            expect(JSON.stringify(screen.tree.toJSON())).toContain('Kept the useful fact. Archived its predecessor.');
        });
    });

    it('discards an exact-result response after the Account changes', async () => {
        const { home, serve } = await initializeRun();
        const pending = createDeferred<void>();
        serve({ respondAfter: pending.promise });
        const screen = await renderScreen(<WorkflowRunItemBody kind="workflow_run" runId="habit-run" serverId={home.id}
            {...{ includeResult: true }} />);
        await waitForHomeGovernance(() => {
            expect(http.requestsFor(route).map(request => request.input)).toEqual([{ operation: 'get', runId: 'habit-run' }]);
        });
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
