import * as React from 'react';
import 'fake-indexeddb/auto';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createWorkflowDefinitionFixture, createWorkflowInvocationIndexFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { WorkflowInvocationList } from './WorkflowInvocationList';
import { WorkflowLifecycleStatus } from '../presentation/WorkflowLifecycleStatus';
import { getStorage } from '@/sync/domains/state/storageStore';
import { createWorkflowInvocationStructureProjector } from './workflowInvocationStructure';
import { projectWorkflowFlow } from '../flow/workflowFlowProjection';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';

const costs = vi.hoisted(() => ({ rows: 0, statuses: 0, statusType: null as unknown }));
const themeBoundary = vi.hoisted(() => ({ colors: null as Record<string, unknown> | null }));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => {
    const boundary = await (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock();
    const runtime = await import('react');
    const internals = Reflect.get(runtime, '__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE') as {
        A: null | { getOwner(): null | { type: unknown } };
    };
    return { ...boundary, useUnistyles: () => {
        if (internals.A?.getOwner()?.type === costs.statusType) costs.statuses += 1;
        const state = boundary.useUnistyles();
        return themeBoundary.colors === null ? state : { ...state, theme: { ...state.theme, colors: themeBoundary.colors } };
    } };
});
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
// The external recycler retains unchanged item cells, as Legend does on device.
vi.mock('@legendapp/list/react-native', async (importOriginal) => {
    const { createCapturingLegendListMock } = await import('@/dev/testkit/mocks/legendList');
    return createCapturingLegendListMock({ original: await importOriginal<Record<string, unknown>>(),
        renderItemLimit: 8, memoizeItems: true, onRenderItem: () => { costs.rows += 1; } }).module;
});

afterEach(() => { themeBoundary.colors = null; return standardCleanup(); });
costs.statusType = WorkflowLifecycleStatus;

describe('Activity arrival cost', () => {
    it('renders only a changed visible invocation, with zero row work for an offscreen hold', async () => {
        const wait = (id: string, name = id) => ({ kind: 'wait' as const, id, name,
            document: { text: 'Review the release', references: [], attachments: [] } });
        const definition = createWorkflowDefinitionFixture({ blocks: [{ kind: 'if', id: 'gate',
            when: { kind: 'compare', operator: 'eq', left: { kind: 'literal', value: 1 }, right: { kind: 'literal', value: 1 } },
            then: [wait('resolved', 'Resolved branch step')], otherwise: [wait('other')],
        }, ...Array.from({ length: 499 }, (_, index) => wait(`hold-${index + 1}`))] });
        const root = createWorkflowInvocationIndexFixture({ id: 'root' });
        const gate = createWorkflowInvocationIndexFixture({ id: 'gate', parentRecordId: 'root', sequence: '1' });
        const invocations = Array.from({ length: 500 }, (_, index) => createWorkflowInvocationIndexFixture({
            id: `hold-${index}`, parentRecordId: index === 0 ? 'gate' : 'root',
            memberOrdinal: String(index === 0 ? 0 : index), sequence: String(index + 2), lifecycle: 'waiting_for_review',
        }));
        const openedPage = (rows: readonly typeof root[], parentRevision: number) => ({
            runId: 'run-1', scope: null, invocations: [root, gate, ...rows], mode: 'replace' as const,
            nextCursor: null, parentRevision,
            invocationDetails: rows.filter(index => index.id !== 'hold-0').map(index => ({ index, parentRevision,
                progress: { kind: 'happier.workflow-progress.v1' as const, blockKind: 'wait' as const,
                    invocationPath: { blockId: index.id, scope: [] }, attempt: index.attempt,
                    logicalInvocationRecordId: index.id } })),
        });
        getStorage().getState().applyWorkflowRunInvocationPage(openedPage(invocations, 1));
        const presentation = { scope: null, definition, projection: projectWorkflowFlow(definition),
            project: createWorkflowInvocationStructureProjector({ definition }) };
        const select = vi.fn();
        function Activity({ presented = true }: { presented?: boolean }) {
            const facts = getStorage()(state => state.workflowRunInvocationsByRunId['run-1']!.factsById);
            const rows = invocations.map(row => facts[row.id]!);
            return <PluginSurfaceFocusEligibilityProvider active={presented}>
                <WorkflowInvocationList invocations={rows} selectedInvocationId={null}
                    onSelectInvocation={select} loaded presentation={presentation} />
            </PluginSurfaceFocusEligibilityProvider>;
        }
        const screen = await renderScreen(<Activity />);
        expect(costs.rows).toBeGreaterThan(0);
        costs.rows = 0;
        costs.statuses = 0;
        const offscreen = invocations.map(row => row.id === 'hold-499'
            ? { ...row, lifecycle: 'completed' as const, contentRevision: '1' } : row);
        await act(async () => { getStorage().getState().applyWorkflowRunInvocationPage(structuredClone(openedPage(offscreen, 2))); });
        const offscreenRenders = costs.rows;
        const offscreenStatuses = costs.statuses;
        costs.rows = 0;
        costs.statuses = 0;
        const visible = offscreen.map(row => row.id === 'hold-1'
            ? { ...row, lifecycle: 'completed' as const, contentRevision: '1' } : row);
        await act(async () => { getStorage().getState().applyWorkflowRunInvocationPage(structuredClone(openedPage(visible, 3))); });
        const visibleRenders = costs.rows;
        const visibleStatuses = costs.statuses;
        costs.rows = 0;
        costs.statuses = 0;
        console.info('FIN-FIX-PERF opened-page counts', { offscreenRenders, offscreenStatuses, visibleRenders, visibleStatuses });
        expect(offscreenRenders).toBe(0);
        expect(offscreenStatuses).toBe(0);
        expect(visibleRenders).toBe(1);
        expect(visibleStatuses).toBe(1);
        const unavailable = { kind: 'unavailable' as const, reason: 'workspace_unavailable' as const };
        const recoveryAvailability = { reattach: unavailable, retry: unavailable,
            continueSameConversation: { kind: 'available' as const }, continueFreshAgent: unavailable, restoreWorkspace: unavailable };
        const exact = openedPage(visible, 3).invocationDetails.find(opened => opened.index.id === 'hold-2')!;
        await act(async () => { getStorage().getState().upsertWorkflowRunInvocation({ runId: 'run-1', scope: null,
            invocation: { ...exact.index, opened: { ...exact, recoveryAvailability } }, parentRevision: 3 }); });
        costs.rows = 0;
        costs.statuses = 0;
        // A new Run revision invalidates private recovery, then an exact read restores it.
        // Neither read changes this row's displayed content.
        await act(async () => { getStorage().getState().applyWorkflowRunInvocationPage(structuredClone(openedPage(visible, 4))); });
        await act(async () => { getStorage().getState().upsertWorkflowRunInvocation({ runId: 'run-1', scope: null,
            invocation: { ...exact.index, opened: { ...exact, parentRevision: 4, recoveryAvailability } }, parentRevision: 4 }); });
        console.info('FIN-FIX-PERF private read counts', { recyclerRenders: costs.rows, statusRenders: costs.statuses });
        expect(costs.rows).toBe(0);
        expect(costs.statuses).toBe(0);
        costs.rows = 0;
        costs.statuses = 0;
        // An opened parent resolves its unchanged child through the same structure owner.
        await act(async () => { getStorage().getState().upsertWorkflowRunInvocation({ runId: 'run-1', scope: null,
            invocation: { ...gate, opened: { index: gate, parentRevision: 3,
                progress: { kind: 'happier.workflow-progress.v1', blockKind: 'if',
                    invocationPath: { blockId: 'gate', scope: [] }, attempt: '0', logicalInvocationRecordId: gate.id,
                    container: { kind: 'if', selected: 'then' } } } }, parentRevision: 3 }); });
        expect(screen.findByTestId('workflow-invocations-row-hold-0')?.findAll(node => (
            node.props.children === 'Resolved branch step'
        )).length).toBeGreaterThan(0);
        console.info('FIN-FIX-PERF Activity counts', { items: 500, visible: 8, offscreenRenders, visibleRenders,
            offscreenStatuses, visibleStatuses, parentResolvedStatuses: costs.statuses });
        expect(screen.findByTestId('workflow-invocations-row-hold-1')?.findByType(WorkflowLifecycleStatus).props.lifecycle).toBe('completed');
        expect(offscreenRenders).toBe(0);
        expect(visibleRenders).toBe(1);
        expect(offscreenStatuses).toBe(0);
        expect(visibleStatuses).toBe(1);
        expect(costs.statuses).toBe(1);
        costs.rows = 0;
        costs.statuses = 0;
        // A genuine global color change must still reach every retained visible row.
        const { createThemeFixture } = await import('@/dev/testkit/fixtures/themeFixtures');
        themeBoundary.colors = createThemeFixture().colors;
        await screen.update(<Activity />);
        expect(costs.rows).toBe(8);
        expect(costs.statuses).toBe(8);
        await screen.update(<Activity presented={false} />);
        costs.rows = 0;
        costs.statuses = 0;
        await act(async () => { getStorage().getState().upsertWorkflowRunInvocation({ runId: 'run-1', scope: null,
            invocation: { ...visible[1]!, lifecycle: 'waiting_for_review', contentRevision: '2' }, parentRevision: 4 }); });
        console.info('FIN-FIX-PERF Activity hidden counts', { hiddenRecyclerRenders: costs.rows, hiddenStatusRenders: costs.statuses });
        expect(costs.rows).toBe(0);
        expect(costs.statuses).toBe(0);
        await screen.update(<Activity />);
        expect(screen.findByTestId('workflow-invocations-row-hold-1')?.findByType(WorkflowLifecycleStatus).props.lifecycle).toBe('waiting_for_review');
    });

    it('subscribes opened children only to the ancestor labels their canonical path consumes', async () => {
        const definition = createWorkflowDefinitionFixture({ blocks: [{ kind: 'loop', id: 'files',
            repetition: { kind: 'items', items: { kind: 'literal', value: [] }, execution: 'parallel', failurePolicy: 'collect_outcomes' },
            body: [{ kind: 'wait', id: 'inspect', document: { text: 'Inspect', references: [], attachments: [] } }] }] });
        const root = createWorkflowInvocationIndexFixture({ id: 'demand-root' });
        const frame = createWorkflowInvocationIndexFixture({ id: 'demand-frame', parentRecordId: root.id });
        const leaf = createWorkflowInvocationIndexFixture({ id: 'demand-leaf', parentRecordId: frame.id });
        const plain = createWorkflowInvocationIndexFixture({ id: 'demand-plain', parentRecordId: root.id });
        const scope = [{ kind: 'iteration' as const, blockId: 'files', index: 0 }];
        const publishFrame = (revision: string, label: string) => getStorage().getState().upsertWorkflowRunInvocation({
            runId: 'run-1', scope: null, parentRevision: 1, invocation: { ...frame, contentRevision: revision,
                opened: { index: { ...frame, contentRevision: revision }, parentRevision: 1,
                    progress: { kind: 'happier.workflow-progress.v1', blockKind: 'loop', attempt: '0',
                        logicalInvocationRecordId: frame.id, invocationPath: { blockId: 'files', scope },
                        frame: { ownerBlockId: 'files', source: { kind: 'item', index: '0', displayLabel: label } },
                        loopProgress: { completed: Number(revision), total: 10 } } } } });
        getStorage().getState().applyWorkflowRunInvocationPage({ runId: 'run-1', scope: null, parentRevision: 1,
            invocations: [root, frame, leaf, plain], mode: 'replace', nextCursor: null });
        publishFrame('1', 'First item');
        const presentation = { scope: null, definition, projection: projectWorkflowFlow(definition),
            project: createWorkflowInvocationStructureProjector({ definition }) };
        const screen = await renderScreen(<WorkflowInvocationList invocations={[leaf, plain]} selectedInvocationId={null}
            onSelectInvocation={() => {}} loaded presentation={presentation} />);
        const leafNode = screen.findByTestId('workflow-invocations-row-demand-leaf');
        const publishRoot = (contentRevision: string) => getStorage().getState().upsertWorkflowRunInvocation({
            runId: 'run-1', scope: null, parentRevision: 1,
            invocation: { ...root, contentRevision, opened: { index: { ...root, contentRevision }, parentRevision: 1,
                progress: { kind: 'happier.workflow-progress.v1', blockKind: 'root', attempt: '0',
                    logicalInvocationRecordId: root.id, invocationPath: { blockId: '$root', scope: [] },
                    stepProgress: { completed: Number(contentRevision), total: 10 } } } } });
        costs.statuses = 0;
        await act(async () => { publishRoot('1'); });
        const unopenedAncestorStatuses = costs.statuses;
        costs.statuses = 0;
        await act(async () => { publishFrame('2', 'First item'); });
        const unopenedItemLabelStatuses = costs.statuses;
        // Opening a row's own path must preserve its retained row node.
        await act(async () => { for (const index of [leaf, plain]) getStorage().getState().upsertWorkflowRunInvocation({
            runId: 'run-1', scope: null, parentRevision: 1, invocation: { ...index, opened: { index, parentRevision: 1,
                progress: { kind: 'happier.workflow-progress.v1', blockKind: 'wait', attempt: '0',
                    logicalInvocationRecordId: index.id, invocationPath: { blockId: 'inspect', scope: index === leaf ? scope : [] } } } } }); });
        expect(screen.findByTestId('workflow-invocations-row-demand-leaf')).toBe(leafNode);
        costs.statuses = 0;
        await act(async () => { publishRoot('2'); });
        const unrelatedAncestorStatuses = costs.statuses;
        costs.statuses = 0;
        await act(async () => { publishFrame('3', 'First item'); });
        const unchangedItemLabelStatuses = costs.statuses;
        costs.statuses = 0;
        await act(async () => { publishFrame('4', 'Second item'); });
        const changedItemLabelStatuses = costs.statuses;
        console.info('FIN-FIX-PERF ancestor demand counts', { unopenedAncestorStatuses, unopenedItemLabelStatuses, unrelatedAncestorStatuses, unchangedItemLabelStatuses, changedItemLabelStatuses });
        expect(unopenedItemLabelStatuses).toBe(0);
        expect(unopenedAncestorStatuses).toBe(0);
        expect(unrelatedAncestorStatuses).toBe(0);
        expect(unchangedItemLabelStatuses).toBe(0);
        expect(changedItemLabelStatuses).toBe(1);
        expect(screen.getTextContent()).toContain('Second item');
        expect(screen.findByTestId('workflow-invocations-row-demand-leaf')).toBe(leafNode);
    });

    it('retains recorded elapsed time when the authored definition is unavailable', async () => {
        const invocation = createWorkflowInvocationIndexFixture({ id: 'unavailable', parentRecordId: null });
        getStorage().getState().applyWorkflowRunInvocationPage({ runId: invocation.runId, scope: null,
            invocations: [invocation], mode: 'replace', nextCursor: null, parentRevision: 1 });
        getStorage().getState().upsertWorkflowRunInvocation({ runId: invocation.runId, scope: null,
            invocation: { ...invocation, opened: { index: invocation, parentRevision: 1,
                progress: { kind: 'happier.workflow-progress.v1', blockKind: 'wait',
                    invocationPath: { blockId: 'wait', scope: [] }, attempt: '0', logicalInvocationRecordId: invocation.id,
                    timing: { startedAt: '2026-11-09T10:00:00.000Z', finishedAt: '2026-11-09T10:00:02.000Z' } } } },
            parentRevision: 1 });
        const screen = await renderScreen(<WorkflowInvocationList invocations={[invocation]} selectedInvocationId={null}
            onSelectInvocation={() => {}} loaded presentation={{ scope: null, definition: null, projection: null,
                project: createWorkflowInvocationStructureProjector({ definition: null }) }} />);
        expect(screen.findByTestId('workflow-invocations-elapsed-unavailable')).not.toBeNull();
    });

    it('updates retained row presses when the navigation handler changes', async () => {
        const invocation = createWorkflowInvocationIndexFixture({ id: 'press', parentRecordId: null });
        const invocations = [invocation];
        getStorage().getState().applyWorkflowRunInvocationPage({ runId: invocation.runId, scope: null,
            invocations, mode: 'replace', nextCursor: null, parentRevision: 1 });
        const presentation = { scope: null, definition: null, projection: null,
            project: createWorkflowInvocationStructureProjector({ definition: null }) };
        const previous = vi.fn();
        const current = vi.fn();
        const screen = await renderScreen(<WorkflowInvocationList invocations={invocations} selectedInvocationId={null}
            onSelectInvocation={previous} loaded presentation={presentation} />);
        await screen.update(<WorkflowInvocationList invocations={invocations} selectedInvocationId={null}
            onSelectInvocation={current} loaded presentation={presentation} />);
        await act(async () => { screen.findByTestId('workflow-invocations-row-press')!.props.onPress(); });
        expect(current).toHaveBeenCalledWith(invocation.id, undefined);
        expect(previous).not.toHaveBeenCalled();
    });
});
