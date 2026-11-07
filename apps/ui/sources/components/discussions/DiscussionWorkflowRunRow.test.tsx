import 'fake-indexeddb/auto';
import '@happier-dev/protocol/actions/actionApprovalPolicy';
import * as React from 'react';
import { projectWorkflowDiscussionResultContentV1 } from '@happier-dev/protocol/workflows/workflowDiscussionPublicationV1';
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

const viewport = vi.hoisted(() => ({ width: 1440, height: 900, scale: 1, fontScale: 1 }));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({ useWindowDimensions: () => viewport }));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { DiscussionWorkflowRunEndRow, DiscussionWorkflowRunRow } = await import('./DiscussionWorkflowRunRow');
const { projectWorkflowRunPublishedAnswerIds } = await import('./prepareDiscussionSelectionHandoff');
const { storage } = await import('@/sync/domains/state/storageStore');
const { workflowRunStoreKey } = await import('@/sync/store/domains/workflowRuns');

// The shared UI setup resets runtimeFetch after each case; reclaim the real HTTP boundary.
beforeEach(() => homes.reset());

afterEach(async () => {
    viewport.width = 1440;
    viewport.height = 900;
    await standardCleanup();
    await homes.reset();
});

it.each([
    { state: 'running' as const, availability: { pause: true, cancel: true }, shown: ['pause', 'stop'] as const },
    { state: 'paused' as const, availability: { pause: false, cancel: true, resumeBoundary: true }, shown: ['resume', 'stop'] as const },
])('keeps a $state phone band to one line: its lifecycle controls are icons named for assistive technology (L2)', async ({ state, availability, shown }) => {
    viewport.width = 390;
    viewport.height = 844;
    const { t } = await import('@/text');
    const labels = { pause: t('workflows.run.pauseAtBoundary'), resume: t('workflows.run.resume'), stop: t('workflows.run.stop') };
    const screen = await renderScreen(<DiscussionWorkflowRunRow
        run={createWorkflowRunSummaryFixture({ id: 'phone-run', state, attentionRequired: state === 'paused', availability })}
        metadata={null} supportsAnotherRound={false} canEdit={true}
        accountLifetime={{ scope: { serverId: 'home-a', accountId: 'alice' }, isCurrent: () => true,
            onRetire: () => ({ dispose: () => undefined }) }}
        onStarted={() => undefined} onSaveAsPattern={() => undefined} publishedMessageIds={[]} />);
    const text = screen.getTextContent();
    for (const control of shown) {
        const host = screen.findHostByTestId(`discussion-workflow-run-${control}:phone-run`);
        expect(host?.props.accessibilityLabel ?? host?.props['aria-label']).toBe(labels[control]);
        expect(text).not.toContain(labels[control]);
    }
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

it('resumes a paused band through the same boundary Resume Action as the Run page (RUN-BAND B2)', async () => {
    const serverId = await homes.addHome({ name: 'Pattern Home', serverUrl: 'https://inline-resume.test', accountId: 'alice' });
    const accountLifetime = { scope: { serverId, accountId: 'alice' }, isCurrent: () => true,
        onRetire: () => ({ dispose: () => undefined }) };
    const run = createWorkflowRunSummaryFixture({ id: 'resume-run', ownerAccountId: 'alice', revision: 7,
        state: 'paused', attentionRequired: true, availability: { pause: false, cancel: true, resumeBoundary: true } });
    const route = '/v3/automations/runs/workflow-storage';
    homes.answer(serverId, route, { select: input => {
        // The real Action consumes mode=boundary before forwarding the key-free storage control.
        expect(input).toEqual({ operation: 'resume', runId: run.id, expectedRevision: 7 });
        return { body: { run: { ...run, state: 'running', revision: 8 }, intent: 'resumed' } };
    } });
    const screen = await renderScreen(<DiscussionWorkflowRunRow run={run} metadata={null}
        supportsAnotherRound={false} canEdit={true} accountLifetime={accountLifetime}
        onStarted={() => undefined} onSaveAsPattern={() => undefined} publishedMessageIds={[]} />);
    expect(screen.getTextContent()).toContain(describeWorkflowRunState('paused').label);
    expect(screen.findHostByTestId('discussion-workflow-run-pause:resume-run')).toBeNull();
    await screen.pressByTestIdAsync('discussion-workflow-run-resume:resume-run');
    await waitForHomeGovernance(() => expect(storage.getState().workflowRunsById[workflowRunStoreKey(run.id, accountLifetime.scope)]?.summary)
        .toMatchObject({ state: 'running', revision: 8 }));
    expect(homes.requestsFor(route)).toHaveLength(1);
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
    expect(screen.findHostByTestId('discussion-workflow-run-resume:run-a')).toBeNull();
    expect(screen.findHostByTestId('discussion-workflow-run-stop:run-a')).toBeNull();
});

it.each([
    { state: 'cancelled' as const, canEdit: true, supportsAnotherRound: false, offered: true },
    { state: 'failed' as const, canEdit: true, supportsAnotherRound: false, offered: true },
    { state: 'succeeded' as const, canEdit: true, supportsAnotherRound: true, offered: true },
    { state: 'running' as const, canEdit: true, supportsAnotherRound: false, offered: false },
    { state: 'cancelled' as const, canEdit: true, supportsAnotherRound: false, offered: false, stopping: true },
    { state: 'cancelled' as const, canEdit: false, supportsAnotherRound: false, offered: false },
    { state: 'cancelled' as const, canEdit: true, supportsAnotherRound: undefined, offered: false },
])('uses the Run page replay eligibility for $state with edit=$canEdit, continuation=$supportsAnotherRound (RUN-BAND B3)', async ({ state, canEdit, supportsAnotherRound, offered, stopping }) => {
    const screen = await renderScreen(<DiscussionWorkflowRunRow
        run={createWorkflowRunSummaryFixture({ id: 'replay-run', state, workflowCustodyState: stopping ? 'pending' : 'settled',
            availability: { pause: false, cancel: false } })}
        metadata={null} supportsAnotherRound={supportsAnotherRound} canEdit={canEdit}
        accountLifetime={{ scope: { serverId: 'home-a', accountId: 'alice' }, isCurrent: () => true,
            onRetire: () => ({ dispose: () => undefined }) }}
        onStarted={() => undefined} onSaveAsPattern={() => undefined} publishedMessageIds={[]} />);
    expect(screen.findHostByTestId('discussion-workflow-run-again:replay-run') !== null).toBe(offered);
    expect(homes.requestsFor('/v3/automations/runs/workflow-storage')).toHaveLength(0);
});

it('offers replay only below the replies when a completed band has an end row (RUN-BAND B3)', async () => {
    const props = {
        run: createWorkflowRunSummaryFixture({ id: 'replay-run', state: 'succeeded' }),
        metadata: null, supportsAnotherRound: false, canEdit: true,
        accountLifetime: { scope: { serverId: 'home-a', accountId: 'alice' }, isCurrent: () => true,
            onRetire: () => ({ dispose: () => undefined }) },
        onStarted: () => undefined, onSaveAsPattern: () => undefined, publishedMessageIds: ['answer-a'],
    };
    const header = await renderScreen(<DiscussionWorkflowRunRow {...props} endRow />);
    expect(header.findHostByTestId('discussion-workflow-run-again:replay-run')).toBeNull();
    await standardCleanup();
    const end = await renderScreen(<DiscussionWorkflowRunEndRow {...props} replyTextInset={0} />);
    expect(end.findHostByTestId('discussion-workflow-run-again:replay-run')).not.toBeNull();
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

it.each(['cancelled', 'failed'] as const)('renders the %s Run state without a published outcome message', async state => {
    const content = projectWorkflowDiscussionResultContentV1({ runId: 'run-a', invocationRecordId: 'leaf',
        invocationAttempt: '0', lifecycle: state, result: { checked: true } });
    expect(content).toBeNull();
    const screen = await renderScreen(<DiscussionWorkflowRunRow
        run={createWorkflowRunSummaryFixture({ id: 'run-a', state, workflowCustodyState: 'settled' })}
        metadata={null} supportsAnotherRound={false} canEdit={true}
        accountLifetime={{ scope: { serverId: 'home-a', accountId: 'alice' }, isCurrent: () => true,
            onRetire: () => ({ dispose: () => undefined }) }}
        onStarted={() => undefined} onSaveAsPattern={() => undefined} publishedMessageIds={[]} />);
    expect(screen.getTextContent()).toContain(describeWorkflowRunState(state).label);
    expect(screen.findHostByTestId('discussion-workflow-run-save-pattern:run-a')).toBeNull();
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

it('shows committed answer coverage in a completed Discussion run instead of internal step progress', async () => {
    const screen = await renderScreen(<DiscussionWorkflowRunRow
        run={createWorkflowRunSummaryFixture({ id: 'run-a', state: 'succeeded',
            stepProgress: { completed: 2, total: 4 } })}
        metadata={{ kind: 'available', value: { title: 'Fresh opinions' } }}
        supportsAnotherRound={false} canEdit={true}
        accountLifetime={{ scope: { serverId: 'home-a', accountId: 'alice' }, isCurrent: () => true,
            onRetire: () => ({ dispose: () => undefined }) }}
        onStarted={() => undefined} onSaveAsPattern={() => undefined}
        publishedMessageIds={['answer-a', 'answer-b']} />);
    expect(screen.getTextContent()).toContain('Fresh opinions');
    expect(screen.getTextContent()).toContain('2 answers');
    expect(screen.getTextContent()).not.toContain('2 of 4');
});

it.each(['running', 'failed'] as const)('keeps %s lifecycle truthful when no published answers are available', async state => {
    const screen = await renderScreen(<DiscussionWorkflowRunRow
        run={createWorkflowRunSummaryFixture({ id: 'run-a', state, stepProgress: { completed: 2, total: 4 } })}
        metadata={{ kind: 'available', value: { title: 'Fresh opinions' } }}
        supportsAnotherRound={false} canEdit={true}
        accountLifetime={{ scope: { serverId: 'home-a', accountId: 'alice' }, isCurrent: () => true,
            onRetire: () => ({ dispose: () => undefined }) }}
        onStarted={() => undefined} onSaveAsPattern={() => undefined} publishedMessageIds={[]} />);
    expect(screen.getTextContent()).not.toContain('0 answers');
    if (state === 'running') expect(screen.getTextContent()).toContain('2 of 4');
    else {
        expect(screen.getTextContent()).toContain('Failed');
        expect(screen.getTextContent()).not.toContain('2 of 4');
    }
});

it('keeps a finished run\'s header to its state and Open run, and closes it with Another round and Save as pattern below its replies', async () => {
    const save = vi.fn<(ids: readonly string[]) => void>();
    const props = {
        run: createWorkflowRunSummaryFixture({ id: 'run-a', state: 'succeeded' }),
        metadata: { kind: 'available' as const, value: { title: 'Fresh opinions' } },
        supportsAnotherRound: true, canEdit: true,
        accountLifetime: { scope: { serverId: 'home-a', accountId: 'alice' }, isCurrent: () => true,
            onRetire: () => ({ dispose: () => undefined }) },
        onStarted: () => undefined, onSaveAsPattern: save, publishedMessageIds: ['answer-a', 'answer-b'],
    };
    const header = await renderScreen(<DiscussionWorkflowRunRow {...props} endRow />);
    expect(header.findHostByTestId('workflow-run-fold-open:run-a')).not.toBeNull();
    expect(header.findHostByTestId('discussion-workflow-run-another-round:run-a')).toBeNull();
    expect(header.findHostByTestId('discussion-workflow-run-save-pattern:run-a')).toBeNull();
    await standardCleanup();

    const end = await renderScreen(<DiscussionWorkflowRunEndRow {...props} replyTextInset={0} />);
    expect(end.findHostByTestId('discussion-workflow-run-another-round:run-a')).not.toBeNull();
    expect(end.findHostByTestId('workflow-run-fold-open:run-a')).toBeNull();
    await end.pressByTestIdAsync('discussion-workflow-run-save-pattern:run-a');
    expect(save).toHaveBeenCalledWith(['answer-a', 'answer-b']);
});
