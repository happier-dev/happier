import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createWorkflowRunSummaryFixture, createWorkflowInvocationIndexFixture, createWorkflowDefinitionFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createSessionItemRowViewModel } from './sessionItemRowViewModelTestFixture';
import { WorkflowRunGetResultV1Schema } from '@happier-dev/protocol/workflows/actionsV1';
import type { WorkflowProgressEnvelopeV1 } from '@happier-dev/protocol/workflows/workflowProgressV1';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { storage } from '@/sync/domains/state/storageStore';
import { workflowRunRowFromSummary } from '@/sync/store/domains/workflowRuns';

const push = vi.hoisted(() => vi.fn());
// Third-party rendering boundary; this row does not render Markdown.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({ splitStreamingRevealTextParts: () => [] }));
vi.mock('react-native-reanimated', async () =>
    (await import('@/dev/testkit/mocks/reanimated')).createReanimatedModuleMock());
vi.mock('react-native-gesture-handler', async () =>
    (await import('@/dev/testkit/mocks/gestureHandler')).createGestureHandlerMock());
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ pathname: '/workflows/runs', router: { push } }).module;
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

const { SessionItem } = await import('./SessionItem');
afterEach(async () => { await standardCleanup(); push.mockReset(); });

describe('SessionItem workflow body', () => {
    it('keeps the saved step title while exact Run occurrence evidence is unavailable', async () => {
        const previous = storage.getState();
        try {
            storage.setState({ profileScope: { serverId: 'server-a', accountId: 'account-a' } });
            const session = createSessionFixture({ id: 'step-without-loaded-run',
                origin: { kind: 'run_step', runId: 'unloaded-run' },
                metadata: { name: '2 · Verify changes', path: '/repo', host: 'test', machineId: 'machine-1' } });
            const screen = await renderScreen(<InjectedAuthProvider credentials={null}>
                <SessionItem serverId="server-a" session={session} reportsDepth={1}
                    rowViewModel={createSessionItemRowViewModel({ session, serverId: 'server-a', overrides: { identityDisplay: 'none' } })} />
            </InjectedAuthProvider>);
            expect(screen.findByTestId(`session-list-item-${session.id}`)?.props.accessibilityLabel)
                .toContain('2 · Verify changes');
        } finally { act(() => storage.setState(previous)); }
    });

    it.each([true, false])('pairs the shared conversation with its exact held occurrence and stable step label (named: %s)', async (named) => {
        const previous = storage.getState();
        const sessionId = 'shared-step-session';
        const runId = 'run-shared-items';
        const definition = createWorkflowDefinitionFixture({ blocks: [{ kind: 'loop', id: 'items',
            repetition: { kind: 'items', items: { kind: 'literal', value: ['alpha', 'beta'] },
                execution: 'parallel', failurePolicy: 'collect_outcomes' },
            body: [{ kind: 'step', id: 'review', ...(named ? { name: 'Review item' } : {}), document: { text: 'Review', references: [], attachments: [] },
                input: [], result: { kind: 'text' }, execution: { conversation: { kind: 'shared_run' } } }] }] });
        const run = createWorkflowRunSummaryFixture({ id: runId, state: 'running' });
        const detail = WorkflowRunGetResultV1Schema.parse({ run, definition, authoredDefinition: definition,
            callerAccess: { canEdit: true }, checkpoint: null, acceptedContext: {
                startedBy: 'user', source: { kind: 'inline' }, inputs: {}, machineId: 'machine-1',
                executionTarget: { kind: 'session' }, materializedLeaves: [], frozenChildren: {},
                workspaceTarget: { project: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' } },
                origin: { kind: 'direct' },
            } });
        const fact = (id: string, item: number, lifecycle: 'running' | 'waiting_for_review' | 'completed') => {
            const index = createWorkflowInvocationIndexFixture({ id, runId, parentRecordId: `frame-${item}`,
                sequence: String(item + 2), lifecycle, contentRevision: lifecycle === 'waiting_for_review' ? '1' : '0' });
            const progress: WorkflowProgressEnvelopeV1 = { kind: 'happier.workflow-progress.v1',
                blockKind: 'step', attempt: '0', logicalInvocationRecordId: id,
                invocationPath: { blockId: 'review', scope: [{ kind: 'iteration', blockId: 'items', index: item }] },
                execution: { kind: 'session', sessionId, localInputId: `input-${id}` } };
            return { ...index, opened: { index, progress, parentRevision: 1 } };
        };
        try {
            storage.setState({ profileScope: { serverId: 'server-a', accountId: 'account-a' } });
            storage.getState().upsertWorkflowRuns([{ ...workflowRunRowFromSummary(run, null), detail }]);
            for (const [item, displayLabel] of ['alpha', 'beta'].entries()) {
                const index = createWorkflowInvocationIndexFixture({ id: `frame-${item}`, runId, sequence: String(item) });
                const progress: WorkflowProgressEnvelopeV1 = { kind: 'happier.workflow-progress.v1', blockKind: 'loop',
                    attempt: '0', logicalInvocationRecordId: index.id,
                    invocationPath: { blockId: 'items', scope: [{ kind: 'iteration', blockId: 'items', index: item }] },
                    frame: { ownerBlockId: 'items', source: { kind: 'item', index: String(item), displayLabel } } };
                storage.getState().upsertWorkflowRunInvocation({ runId, parentRevision: 1,
                    invocation: { ...index, opened: { index, progress, parentRevision: 1 } } });
            }
            for (const invocation of [fact('alpha', 0, 'running'), fact('beta', 1, 'waiting_for_review')]) {
                storage.getState().upsertWorkflowRunInvocation({ runId, invocation, parentRevision: 1 });
            }
            const session = createSessionFixture({ id: sessionId, active: true, activeAt: Date.now(),
                latestTurnStatus: 'completed', origin: { kind: 'run_step', runId },
                metadata: { name: '1 · Review item · alpha', path: '/repo', host: 'test', machineId: 'machine-1' } });
            const screen = await renderScreen(<InjectedAuthProvider credentials={null}>
                <SessionItem serverId="server-a" session={session} reportsDepth={1}
                    rowViewModel={createSessionItemRowViewModel({ session, serverId: 'server-a', overrides: { identityDisplay: 'none' } })} />
            </InjectedAuthProvider>);
            const label = () => screen.findByTestId(`session-list-item-${sessionId}`)?.props.accessibilityLabel;
            expect(label()).toContain(named ? '1 · Review item' : '1 · Review');
            expect(label()).toContain('beta');
            expect(label()).not.toContain('alpha');
            expect(label()).toContain('workflows.invocationState.waiting_for_review');
            // A newly settled sibling changes the same row through the sole fact store.
            act(() => storage.getState().upsertWorkflowRunInvocation({ runId, parentRevision: 1,
                invocation: { ...fact('alpha', 0, 'waiting_for_review'), contentRevision: '1' } }));
            expect(label()).toContain('alpha');
            act(() => storage.getState().upsertWorkflowRunInvocation({ runId, parentRevision: 1,
                invocation: { ...fact('beta', 1, 'completed'), contentRevision: '2' } }));
            act(() => storage.getState().upsertWorkflowRuns([{ ...workflowRunRowFromSummary({ ...run,
                state: 'cancelled', revision: 2, workflowCustodyState: 'pending' }, null), detail }]));
            expect(label()).toContain('alpha');
            expect(label()).toContain('workflows.run.stopping');
            expect(label()).not.toContain('workflows.invocationState.waiting_for_review');
            await screen.update(<InjectedAuthProvider credentials={null}>
                <SessionItem serverId="server-a" session={session}
                    rowViewModel={createSessionItemRowViewModel({ session, serverId: 'server-a', overrides: { identityDisplay: 'none' } })} />
            </InjectedAuthProvider>);
            // Outside the nested Run preview, this remains the person's Session identity.
            expect(label()).toContain('1 · Review item · alpha');
            expect(label()).not.toContain('workflows.invocationState.waiting_for_review');
        } finally { act(() => storage.setState(previous)); }
    });
    it('does not retain another Run when a hidden recycled cell changes identity', async () => {
        const previous = storage.getState();
        try {
            storage.setState({ profileScope: { serverId: 'server-a', accountId: 'account-a' } });
            for (const [id, title] of [['run-first', 'First Run'], ['run-second', 'Second Run']]) {
                storage.getState().upsertWorkflowRuns([workflowRunRowFromSummary(
                    createWorkflowRunSummaryFixture({ id, startedBy: 'user' }),
                    { kind: 'available', value: { title } },
                )]);
            }
            const row = (id: string) => <SessionItem kind="workflow_run" runId={id} serverId="server-a" dataActive={false} />;
            const screen = await renderScreen(row('run-first'));
            expect(screen.findByTestId('workflow-run-row:run-first')?.props.accessibilityLabel).toContain('First Run');
            await act(async () => screen.tree.update(row('run-second')));
            expect(screen.findByTestId('workflow-run-row:run-second')?.props.accessibilityLabel).toContain('Second Run');
            expect(screen.findByTestId('workflow-run-row:run-second')?.props.accessibilityLabel).not.toContain('First Run');
        } finally { act(() => storage.setState(previous)); }
    });

    it('opens its Run and freezes its exact reader while inactive, then resumes current progress', async () => {
        const previous = storage.getState();
        const seed = (completed: number) => storage.getState().upsertWorkflowRuns([workflowRunRowFromSummary(
            createWorkflowRunSummaryFixture({ id: 'run-row', state: 'failed', startedBy: 'trigger',
                revision: completed + 1, stepProgress: { completed, total: 5 } }),
            { kind: 'available', value: { title: 'Prepare the release' } },
        )]);
        try {
            storage.setState({ profileScope: { serverId: 'server-a', accountId: 'account-a' } });
            seed(2);
            // The new kind is the missing observable row behavior, not a mocked row.
            const row = (active: boolean) => <SessionItem kind="workflow_run" runId="run-row" serverId="server-a" dataActive={active} density="default" />;
            const screen = await renderScreen(row(true));
            expect(screen.findByTestId('workflow-run-row:run-row')?.props.accessibilityLabel).toContain('Prepare the release');
            expect(screen.findByTestId('workflow-run-row:run-row')?.props.accessibilityLabel).toContain('workflows.runState.failed');
            await screen.pressByTestIdAsync('workflow-run-row:run-row');
            expect(push).toHaveBeenCalledWith('/workflows/runs/run-row?serverId=server-a');
            const before = screen.findByTestId('workflow-run-row:run-row')!.props.accessibilityLabel;
            await act(async () => screen.tree.update(row(false)));
            act(() => seed(3));
            expect(screen.findByTestId('workflow-run-row:run-row')!.props.accessibilityLabel).toEqual(before);
            await act(async () => screen.tree.update(row(true)));
            expect(screen.findByTestId('workflow-run-row:run-row')!.props.accessibilityLabel).toContain('completed=3');
        } finally { act(() => storage.setState(previous)); }
    });
});
