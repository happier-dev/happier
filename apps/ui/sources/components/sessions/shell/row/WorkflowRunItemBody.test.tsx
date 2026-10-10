import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkflowRunGetResultV1Schema } from '@happier-dev/protocol/workflows/actionsV1';
import type { WorkflowRunSummaryV1 } from '@happier-dev/protocol/workflows/workflowProgressV1';

import { createDeferred, invokeTestInstanceHandler, renderScreen, standardCleanup } from '@/dev/testkit';
import { createWorkflowDefinitionFixture, createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { storage } from '@/sync/domains/state/storage';
import { workflowRunRowFromSummary } from '@/sync/store/domains/workflowRuns';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { getActiveServerSnapshot, upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { SessionWritesHereSection } from '@/components/workflows/triggers/SessionWritesHereSection';
import { resetWorkflowLibraryReadsForTests } from '@/components/workflows/library/workflowLibraryReads';
import { WorkViewportContext } from '@/components/sessions/work/WorkItemRow';

import { WorkflowRunItemBody } from './WorkflowRunItemBody';

const execute = vi.hoisted(() => vi.fn());
// Only the outgoing Action transport is replaced; schemas, detail selection and the Account store stay real.
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', () => ({ createFrontDoorActionExecute: () => execute }));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());

afterEach(async () => {
    await standardCleanup();
    retireActiveServerAccountScopeLifetime();
    resetWorkflowLibraryReadsForTests();
    storage.setState(storage.getInitialState(), true);
    execute.mockReset();
});

async function initializeRun() {
    const home = await upsertAndActivateServer({ serverUrl: 'http://habit-result.test' });
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
    storage.setState({ profileScope: { serverId: home.id, accountId: 'account-1' } });
    const summary = createWorkflowRunSummaryFixture({ id: 'habit-run', state: 'succeeded', revision: 3 });
    storage.getState().upsertWorkflowRuns([workflowRunRowFromSummary(summary, null)]);
    const definition = createWorkflowDefinitionFixture();
    const detail = WorkflowRunGetResultV1Schema.parse({ run: summary, callerAccess: { canEdit: true },
        definition, authoredDefinition: definition,
        acceptedContext: { source: { kind: 'inline' }, inputs: {}, machineId: 'machine-1',
            executionTarget: { kind: 'session' }, materializedLeaves: [], frozenChildren: {},
            workspaceTarget: { project: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' } },
            origin: { kind: 'direct' }, startedBy: 'user' }, checkpoint: null,
        result: 'Kept the useful fact.\nArchived its predecessor.', finalOutputInvocationId: 'chosen-output' });
    return { home, detail };
}

describe('opened habit History result', () => {
    it('keeps each destination writer and its observed progress beside aggregate Run progress', async () => {
        const { home } = await initializeRun();
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
        execute.mockImplementation(async (actionId: string) => {
            if (actionId !== 'workflow.run.list') throw new Error(`Destination progress demanded ${actionId}`);
            return { ok: true, result: { runs: [summary], metadataByRunId: {}, nextCursor: undefined } };
        });
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
        expect(first.getTextContent()).toContain('workflows.invocationState.completed');
        expect(first.getTextContent()).not.toContain('Report');
        expect(first.getTextContent()).toContain('workflows.review.waitTitle');
        expect(first.getTextContent()).not.toContain('workflows.invocationState.waiting_for_review');
        expect(second.getTextContent()).toContain('Report');
        expect(second.getTextContent()).toContain('Follow up');
        expect(second.getTextContent()).toContain('workflows.invocationState.running');
        expect(second.getTextContent()).not.toContain('workflows.invocationState.pending');
        expect(second.getTextContent()).toContain('workflows.list.observedProgress');
        for (const screen of [first, second]) {
            expect(screen.getTextContent()).toContain('workflows.list.stepsProgress');
            expect(screen.findHostByTestId('workflow-run-row:habit-run').props.accessibilityLabel)
                .toContain('sessionWork.scheduled.step');
        }
        expect(execute.mock.calls.map(call => call[0])).toEqual(['workflow.run.list', 'workflow.run.list']);
    });
    it('keeps the stopped lifecycle word in visual and spoken attention rows', async () => {
        const { home } = await initializeRun();
        storage.getState().upsertWorkflowRuns([workflowRunRowFromSummary(createWorkflowRunSummaryFixture({
            id: 'habit-run', state: 'cancelled', revision: 4, attentionRequired: true, workflowCustodyState: 'pending',
        }), null)]);
        for (const presentation of ['list', 'work'] as const) {
            const screen = await renderScreen(<WorkflowRunItemBody kind="workflow_run" runId="habit-run"
                serverId={home.id} presentation={presentation} />);
            expect(screen.getTextContent()).toContain('workflows.runState.cancelled');
            expect(screen.findHostByTestId('workflow-run-row:habit-run').props.accessibilityLabel)
                .toContain('workflows.runState.cancelled');
            expect(screen.getTextContent()).not.toContain('workStatus.buckets.needs_you');
        }
    });
    it('reads the exact selected Run result only when demanded and publishes it to the existing body owner', async () => {
        const { home, detail } = await initializeRun();
        execute.mockResolvedValue({ ok: true, result: detail });
        await renderScreen(<WorkflowRunItemBody kind="workflow_run" runId="habit-run" serverId={home.id} />);
        expect(execute).not.toHaveBeenCalled();
        const screen = await renderScreen(<WorkflowRunItemBody kind="workflow_run" runId="habit-run" serverId={home.id}
            {...{ includeResult: true }} />);
        expect(JSON.stringify(screen.tree.toJSON())).toContain('Kept the useful fact. Archived its predecessor.');
        expect(storage.getState().workflowRunsById['habit-run']?.detail)
            .toMatchObject({ result: detail.result, finalOutputInvocationId: 'chosen-output' });
        expect(execute.mock.calls.map(call => call[0])).toEqual(['workflow.run.get']);
    });

    it('refuses an unavailable exact result and keeps the summary and retry reachable', async () => {
        const { home, detail } = await initializeRun();
        execute.mockResolvedValueOnce({ ok: false, errorCode: 'content_unavailable', error: 'Unavailable' });
        const screen = await renderScreen(<WorkflowRunItemBody kind="workflow_run" runId="habit-run" serverId={home.id}
            {...{ includeResult: true }} />);
        expect(JSON.stringify(screen.tree.toJSON())).toContain('workflows.contentUnavailable');
        expect(storage.getState().workflowRunsById['habit-run']?.detail).toBeUndefined();
        execute.mockResolvedValue({ ok: true, result: detail });
        const stopPropagation = vi.fn();
        await act(async () => {
            invokeTestInstanceHandler(screen.findHostByTestId('workflow-run-result:habit-run:retry'), 'onPress', { stopPropagation });
        });
        expect(stopPropagation).toHaveBeenCalledOnce();
        expect(JSON.stringify(screen.tree.toJSON())).toContain('Kept the useful fact. Archived its predecessor.');
    });

    it('discards an exact-result response after the Account changes', async () => {
        const { home, detail } = await initializeRun();
        const pending = createDeferred<unknown>();
        execute.mockReturnValue(pending.promise);
        const screen = await renderScreen(<WorkflowRunItemBody kind="workflow_run" runId="habit-run" serverId={home.id}
            {...{ includeResult: true }} />);
        expect(execute).toHaveBeenCalledWith('workflow.run.get', { runId: 'habit-run' }, expect.anything());
        await act(async () => {
            storage.setState({ profileScope: { serverId: home.id, accountId: 'other-account' }, workflowRunsById: {} });
            pending.resolve({ ok: true, result: detail });
            await pending.promise;
        });
        expect(storage.getState().workflowRunsById['habit-run']).toBeUndefined();
        expect(JSON.stringify(screen.tree.toJSON())).not.toContain('Kept the useful fact.');
    });
});
