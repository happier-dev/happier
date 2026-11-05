import 'fake-indexeddb/auto';
import '@happier-dev/protocol/actions/actionApprovalPolicy';
import * as React from 'react';
import { describeWorkflowRunState } from '@/components/workflows/presentation/workflowLifecyclePresentation';
import { resolveWorkflowProblemPresentation } from '@/components/workflows/presentation/workflowProblemPresentation';
import { WorkflowActionError } from '@/sync/domains/workflows/workflowActionError';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DiscussionMessageV1Schema } from '@happier-dev/protocol/discussions/models';
import { createDiscussionMessageRefV1 } from '@happier-dev/protocol/discussions/messageRefs';
import { act, renderScreen, standardCleanup } from '@/dev/testkit';
import { createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { DiscussionWorkflowRunRow } = await import('./DiscussionWorkflowRunRow');
const { projectWorkflowRunPublishedAnswerIds } = await import('./prepareDiscussionSelectionHandoff');
const { storage } = await import('@/sync/domains/state/storageStore');
const { workflowRunStoreKey } = await import('@/sync/store/domains/workflowRuns');

// The shared UI setup resets runtimeFetch after each case; reclaim the real HTTP boundary.
beforeEach(() => homes.reset());

afterEach(async () => {
    await standardCleanup();
    await homes.reset();
});

it('pauses and stops the running inline Pattern through the scoped Run Actions', async () => {
    const serverId = await homes.addHome({ name: 'Pattern Home', serverUrl: 'https://inline-pattern.test', accountId: 'alice' });
    const accountLifetime = { scope: { serverId, accountId: 'alice' }, isCurrent: () => true,
        onRetire: () => ({ dispose: () => undefined }) };
    const run = createWorkflowRunSummaryFixture({ id: 'run-inline', ownerAccountId: 'alice', revision: 7 });
    const paused = createWorkflowRunSummaryFixture({ ...run, state: 'pause_requested', revision: 8,
        availability: { ...run.availability, pause: false } });
    const route = '/v3/automations/runs/workflow-storage';
    homes.answer(serverId, route, { select: input => {
        expect(input).toMatchObject({ runId: run.id });
        if ((input as { operation: string }).operation === 'pause') {
            expect(input).toEqual({ operation: 'pause', runId: run.id, expectedRevision: 7 });
            return { body: { run: paused, intent: 'pause_requested' } };
        }
        expect(input).toEqual({ operation: 'cancel', runId: run.id, expectedRevision: 8 });
        return { body: { run: { ...paused, revision: 9 }, intent: 'cancel_requested' } };
    } });
    const screen = await renderScreen(<DiscussionWorkflowRunRow run={run} metadata={null}
        supportsAnotherRound={false} canEdit={true} accountLifetime={accountLifetime}
        onStarted={() => undefined} onSaveAsPattern={() => undefined} publishedMessageIds={[]} />);
    expect(screen.findHostByTestId('discussion-workflow-run-pause:run-inline')).not.toBeNull();
    expect(screen.findHostByTestId('discussion-workflow-run-stop:run-inline')).not.toBeNull();
    // Rendering reads only the supplied summary; controls must not fetch private Run history.
    expect(homes.requestsFor(route)).toHaveLength(0);
    await screen.pressByTestIdAsync('discussion-workflow-run-pause:run-inline');
    await waitForHomeGovernance(() => expect(storage.getState().workflowRunsById[workflowRunStoreKey(run.id, accountLifetime.scope)]?.summary)
        .toEqual(paused));
    await screen.pressByTestIdAsync('discussion-workflow-run-stop:run-inline');
    await waitForHomeGovernance(() => expect(storage.getState().workflowRunsById[workflowRunStoreKey(run.id, accountLifetime.scope)]?.summary?.revision).toBe(9));
    expect(homes.requestsFor(route)).toHaveLength(2);
    expect(screen.getTextContent()).toContain(describeWorkflowRunState(paused.state,
        { workflowCustodyState: paused.workflowCustodyState, cancelRequested: true }).label);
});

it.each([
    { state: 'succeeded' as const, canEdit: true, pause: false, cancel: false },
    { state: 'running' as const, canEdit: false, pause: true, cancel: true },
    { state: 'running' as const, canEdit: true, pause: false, cancel: false },
])('omits inline lifecycle controls when the Run is $state with edit=$canEdit and pause=$pause', async ({ state, canEdit, pause, cancel }) => {
    const screen = await renderScreen(<DiscussionWorkflowRunRow
        run={createWorkflowRunSummaryFixture({ id: 'run-a', state, availability: { pause, cancel } })}
        metadata={null} supportsAnotherRound={false} canEdit={canEdit}
        accountLifetime={{ scope: { serverId: 'home-a', accountId: 'alice' }, isCurrent: () => true,
            onRetire: () => ({ dispose: () => undefined }) }}
        onStarted={() => undefined} onSaveAsPattern={() => undefined} publishedMessageIds={[]} />);
    expect(screen.findHostByTestId('discussion-workflow-run-pause:run-a')).toBeNull();
    expect(screen.findHostByTestId('discussion-workflow-run-stop:run-a')).toBeNull();
});

it.each(['finished', 'run', 'account'] as const)('retires accepted Stop feedback when the %s changes', async change => {
    const serverId = await homes.addHome({ name: 'Pattern Home', serverUrl: 'https://inline-pattern-receipt.test', accountId: 'alice' });
    const accountLifetime = { scope: { serverId, accountId: 'alice' }, isCurrent: () => true,
        onRetire: () => ({ dispose: () => undefined }) };
    const run = createWorkflowRunSummaryFixture({ id: 'receipt-run', ownerAccountId: 'alice' });
    homes.answer(serverId, '/v3/automations/runs/workflow-storage', {
        body: { run: { ...run, revision: 2 }, intent: 'cancel_requested' },
    });
    const props = { run, accountLifetime, metadata: null, supportsAnotherRound: false, canEdit: true,
        onStarted: () => undefined, onSaveAsPattern: () => undefined, publishedMessageIds: [] };
    const screen = await renderScreen(<DiscussionWorkflowRunRow {...props} />);
    await screen.pressByTestIdAsync('discussion-workflow-run-stop:receipt-run');
    await waitForHomeGovernance(() => expect(storage.getState().workflowRunsById[workflowRunStoreKey(run.id, accountLifetime.scope)]?.summary?.revision,
        JSON.stringify({ text: screen.getTextContent(), requests: homes.requests.map(request => request.path) })).toBe(2));
    const stopping = describeWorkflowRunState(run.state, { cancelRequested: true, workflowCustodyState: run.workflowCustodyState }).label;
    await waitForHomeGovernance(() => expect(screen.getTextContent()).toContain(stopping));
    const nextRun = change === 'finished'
        ? createWorkflowRunSummaryFixture({ ...run, revision: 3, state: 'cancelled', workflowCustodyState: 'settled',
            availability: { pause: false, cancel: false } })
        : change === 'run' ? createWorkflowRunSummaryFixture({ ...run, id: 'different-run' }) : run;
    const nextLifetime = change === 'account'
        ? { ...accountLifetime, scope: { serverId: 'different-home', accountId: 'bob' } } : accountLifetime;
    await act(async () => screen.update(<DiscussionWorkflowRunRow {...props} run={nextRun} accountLifetime={nextLifetime} />));
    expect(screen.getTextContent()).not.toContain(stopping);
    expect(screen.getTextContent()).toContain(describeWorkflowRunState(nextRun.state,
        { workflowCustodyState: nextRun.workflowCustodyState }).label);
});

it('keeps a refused inline control recoverable without claiming Stop was accepted', async () => {
    const serverId = await homes.addHome({ name: 'Pattern Home', serverUrl: 'https://inline-pattern-error.test', accountId: 'alice' });
    const accountLifetime = { scope: { serverId, accountId: 'alice' }, isCurrent: () => true,
        onRetire: () => ({ dispose: () => undefined }) };
    const run = createWorkflowRunSummaryFixture({ id: 'refused-run', ownerAccountId: 'alice' });
    const route = '/v3/automations/runs/workflow-storage';
    homes.answer(serverId, route, { status: 409, body: { error: 'ineligible_state' } });
    const screen = await renderScreen(<DiscussionWorkflowRunRow run={run} metadata={null}
        supportsAnotherRound={false} canEdit={true} accountLifetime={accountLifetime}
        onStarted={() => undefined} onSaveAsPattern={() => undefined} publishedMessageIds={[]} />);
    await screen.pressByTestIdAsync('discussion-workflow-run-stop:refused-run');
    const refusal = resolveWorkflowProblemPresentation(new WorkflowActionError({ message: 'ineligible_state', rawCode: 'ineligible_state' }), 'run');
    await waitForHomeGovernance(() => expect(homes.requestsFor(route),
        JSON.stringify({ text: screen.getTextContent(), requests: homes.requests.map(request => request.path) })).toHaveLength(1));
    await waitForHomeGovernance(async () => {
        await act(async () => undefined);
        expect(screen.getTextContent(), JSON.stringify(homes.requests.map(request => request.path))).toContain(refusal.message);
    });
    expect(screen.getTextContent()).not.toContain(describeWorkflowRunState(run.state, { cancelRequested: true }).label);
    homes.answer(serverId, route, { body: { run: { ...run, revision: 2 }, intent: 'cancel_requested' } });
    await screen.pressByTestIdAsync('discussion-workflow-run-stop:refused-run');
    await waitForHomeGovernance(() => expect(storage.getState().workflowRunsById[workflowRunStoreKey(run.id, accountLifetime.scope)]?.summary?.revision).toBe(2));
    await waitForHomeGovernance(async () => {
        await act(async () => undefined);
        expect(screen.getTextContent()).not.toContain(refusal.message);
    });
    expect(screen.getTextContent()).toContain(describeWorkflowRunState(run.state, { cancelRequested: true }).label);
});

it('offers end-row capture from committed Workflow and Agent answers, bound to the exact Run', async () => {
    const messages = (['agent', 'workflow', 'execution'] as const).map((kind, index) => {
        const committed = DiscussionMessageV1Schema.parse({
            id: `answer-${kind}`, discussionId: 'discussion-a', localId: `answer-${kind}`, seq: index + 1,
            authorAccountId: 'alice', accountActor: { v: 1, accountId: 'alice', profile: null },
            producerV1: kind === 'agent'
                ? { v: 1, kind, sessionId: 'external-plugin-session', runId: 'run-b',
                    replyReturn: { serverId: 'home-a', requestLocalId: 'request-a', outcome: 'answer',
                        workflow: { runId: 'run-a', invocationRecordId: 'invocation-agent', invocationAttempt: '0' } } }
                : kind === 'execution' ? { v: 1, kind: 'agent', sessionId: 'external-plugin-session', runId: 'run-b',
                    replyReturn: { serverId: 'home-a', requestLocalId: 'ordinary-request', outcome: 'answer' } }
                : { v: 1, kind, runId: 'run-a', invocationRecordId: 'invocation-workflow', invocationAttempt: '0',
                    execution: { kind: 'action', actionId: 'external-plugin.answer' }, outcome: 'answer' },
            content: { t: 'plain', v: { v: 1, parts: [{ t: 'text', text: 'Published answer' }] } },
            mentionedAccountIds: [], createdAt: 1,
        });
        return { ...committed, content: { v: 1 as const, parts: [{ t: 'text' as const, text: 'Published answer' }] },
            messageRef: createDiscussionMessageRefV1({ serverId: 'home-a', discussionId: 'discussion-a' }, committed) };
    });
    const byRun = projectWorkflowRunPublishedAnswerIds(messages);
    const save = vi.fn<(ids: readonly string[]) => void>();
    const props = {
        metadata: null, supportsAnotherRound: false, canEdit: true,
        accountLifetime: { scope: { serverId: 'home-a', accountId: 'alice' }, isCurrent: () => true,
            onRetire: () => ({ dispose: () => undefined }) },
        onStarted: () => undefined, onSaveAsPattern: save,
    };
    // Wrong-Run binding must not borrow another Run's published answers.
    const screen = await renderScreen(<>
        <DiscussionWorkflowRunRow {...props} run={createWorkflowRunSummaryFixture({ id: 'run-a', state: 'failed' })}
            publishedMessageIds={byRun.get('run-a') ?? []} />
        <DiscussionWorkflowRunRow {...props} run={createWorkflowRunSummaryFixture({ id: 'run-b', state: 'failed' })}
            publishedMessageIds={byRun.get('run-b') ?? []} />
    </>);
    expect(screen.findHostByTestId('discussion-workflow-run-save-pattern:run-b')).toBeNull();
    await screen.pressByTestIdAsync('discussion-workflow-run-save-pattern:run-a');
    expect(save).toHaveBeenCalledWith(['answer-agent', 'answer-workflow']);
});
