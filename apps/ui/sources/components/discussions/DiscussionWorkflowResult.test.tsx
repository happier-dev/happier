import 'fake-indexeddb/auto';
import '@happier-dev/protocol/actions/actionApprovalPolicy';
import * as React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WorkflowInvocationDetailV1Schema } from '@happier-dev/protocol/workflows/workflowProgressV1';
import { act, renderScreen, standardCleanup } from '@/dev/testkit';
import { createWorkflowInvocationIndexFixture, createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createExternalActionAccountHttpBoundary } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { setRuntimeFetch } from '@/utils/system/runtimeFetch';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { DiscussionWorkflowInvocationRetry } = await import('./DiscussionWorkflowResult');
const { storage } = await import('@/sync/domains/state/storageStore');
const { workflowRunRowFromSummary, workflowRunStoreKey } = await import('@/sync/store/domains/workflowRuns');
const { useWorkflowInlineRunInvocations } = await import('@/components/workflows/run/useWorkflowInlineRunControls');
beforeEach(() => homes.reset());
afterEach(async () => { await standardCleanup(); await homes.reset(); });

it('does not reopen an already loaded Run when another referenced Run arrives', async () => {
    const { WorkflowRunRecipientCensusResponseV1Schema } = await import('@happier-dev/protocol/workflows/workflowRunKeyV1');
    const serverId = await homes.addHome({ name: 'Round Home', serverUrl: 'https://round-reader.test', accountId: 'alice' });
    const lifetime = { scope: { serverId, accountId: 'alice' }, isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
    const runs = ['first', 'second'].map(id => createWorkflowRunSummaryFixture({ id, ownerAccountId: 'alice', revision: 3 }));
    storage.getState().upsertWorkflowRuns(runs.map(run => workflowRunRowFromSummary(run)), lifetime.scope);
    const route = '/v3/automations/runs/workflow-storage';
    homes.answer(serverId, route, { select: input => {
        const request = input as { operation: string; runId: string };
        expect(request.operation).toBe('invocations.list');
        return { body: { invocations: [], parentRevision: 3, progressEnvelopesByInvocationId: {},
            keyCensus: WorkflowRunRecipientCensusResponseV1Schema.parse({ runId: request.runId, ownerAccountId: 'alice',
                access: 'owner', encryptionMode: 'plain', dataEncryptionKey: null, callerDataEncryptionKey: null,
                recipients: [], visibleTeamId: null, ownerAccountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }) } };
    } });
    function Reader(props: Readonly<{ runIds: readonly string[] }>) {
        useWorkflowInlineRunInvocations({ runIds: props.runIds, accountLifetime: lifetime, enabled: true });
        return null;
    }
    const loaded = (id: string) => storage.getState().workflowRunInvocationsByRunId[workflowRunStoreKey(id, lifetime.scope)]?.history.loaded;
    const screen = await renderScreen(<Reader runIds={['first']} />);
    await waitForHomeGovernance(() => expect(loaded('first')).toBe(true));
    await act(async () => screen.update(<Reader runIds={['first', 'second']} />));
    await waitForHomeGovernance(() => expect(loaded('second')).toBe(true));
    expect(homes.requestsFor(route).map(request => request.input)).toHaveLength(2);
});

function failedInvocation(uncertain = false) {
    const unavailable = { kind: 'unavailable', reason: 'invocation_not_recoverable' };
    return WorkflowInvocationDetailV1Schema.parse({
        index: createWorkflowInvocationIndexFixture({ id: 'answer-attempt-2', runId: 'debate', lifecycle: uncertain ? 'outcome_uncertain' : 'failed' }),
        progress: { kind: 'happier.workflow-progress.v1', logicalInvocationRecordId: 'answer-logical', invocationPath: { blockId: 'reply', scope: [] }, blockKind: 'step', attempt: '0',
            ...(uncertain ? { reason: { code: 'outcome_uncertain', message: 'Prior effect needs review' } } : {}) },
        parentRevision: 7,
        recoveryAvailability: { reattach: unavailable, retry: { kind: 'available', causalInvocationIds: ['answer-attempt-2'] },
            continueSameConversation: { kind: 'available' }, continueFreshAgent: unavailable, restoreWorkspace: unavailable },
    });
}

it('retries only the recorded failed reply through the native Action with the current Run revision', async () => {
    const serverId = await homes.addHome({ name: 'Debate Home', serverUrl: 'https://discussion-retry.test',
        serverIdentityId: 'srv_discussion_retry', accountId: 'alice', currentAccount: true });
    const lifetime = { scope: { serverId, accountId: 'alice' }, isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
    const run = createWorkflowRunSummaryFixture({ id: 'debate', ownerAccountId: 'alice', revision: 7, state: 'failed', workflowCustodyState: 'settled' });
    const received: unknown[] = [];
    const boundary = await createExternalActionAccountHttpBoundary({ serverUrl: 'https://discussion-retry.test',
        serverIdentityId: 'srv_discussion_retry', accountId: 'alice', machineId: 'machine-1',
        actionId: 'workflow.run.invocations.retry', tokenEpoch: 0, execute: input => {
            received.push(input);
            return { run: { ...run, revision: 9, state: 'running' }, invocation: failedInvocation().index, disposition: 'accepted' };
        } });
    setRuntimeFetch(async (url, init) => await boundary.handle(new URL(String(url)), init) ?? homes.request(url, init));
    homes.answer(serverId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture() });
    storage.setState({ machineListByServerId: { [serverId]: [createMachineFixture({ id: 'machine-1', activeAt: Date.now(),
        access: { custodian: { accountId: 'alice', displayName: 'Alice' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' } })] } });
    storage.getState().upsertWorkflowRuns([workflowRunRowFromSummary({ ...run, revision: 8 })], lifetime.scope);
    const invocation = failedInvocation();
    const unavailable = { kind: 'unavailable' as const, reason: 'workspace_unavailable' as const };
    storage.getState().upsertWorkflowRunInvocation({ runId: run.id, scope: lifetime.scope, parentRevision: 7,
        invocation: { ...invocation.index, opened: { ...invocation,
            recoveryAvailability: { ...invocation.recoveryAvailability!, retry: unavailable } } } });
    const screen = await renderScreen(<DiscussionWorkflowInvocationRetry messageId="failed-reply" run={run}
        invocation={invocation} canEdit accountLifetime={lifetime} />);
    expect(screen.findHostByTestId('discussion-workflow-retry:failed-reply')).toBeNull();
    const content = storage.getState().workflowRunInvocationsByRunId[workflowRunStoreKey(run.id, lifetime.scope)]!.factsById[invocation.index.id];
    await act(async () => { storage.getState().upsertWorkflowRunInvocation({ runId: run.id, scope: lifetime.scope,
        parentRevision: 7, invocation: { ...invocation.index, opened: invocation } }); });
    expect(storage.getState().workflowRunInvocationsByRunId[workflowRunStoreKey(run.id, lifetime.scope)]!.factsById[invocation.index.id]).toBe(content);
    await screen.pressByTestIdAsync('discussion-workflow-retry:failed-reply');
    await waitForHomeGovernance(() => expect(received, screen.getTextContent()).toEqual([{ runId: 'debate', expectedRevision: 8,
        invocation: { recordId: 'answer-attempt-2' }, causalInvocationIds: ['answer-attempt-2'],
        conversation: 'same_conversation', input: { kind: 'original' } }]));
    expect(storage.getState().workflowRunsById[workflowRunStoreKey(run.id, lifetime.scope)]?.summary?.revision).toBe(9);
    expect(screen.findHostByTestId('discussion-workflow-retry:failed-reply')).toBeNull();
});

it('sends uncertain effects to Open run and never offers inline Retry to a reader', async () => {
    const run = createWorkflowRunSummaryFixture({ id: 'debate', state: 'failed' });
    const lifetime = { scope: { serverId: 'home-a', accountId: 'alice' }, isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
    const screen = await renderScreen(<DiscussionWorkflowInvocationRetry messageId="uncertain" run={run}
        invocation={failedInvocation(true)} canEdit accountLifetime={lifetime} />);
    expect(screen.findHostByTestId('discussion-workflow-retry:uncertain')).toBeNull();
    expect(screen.findHostByTestId('discussion-workflow-open-run:uncertain')).not.toBeNull();
    await screen.update(<DiscussionWorkflowInvocationRetry messageId="reader" run={run}
        invocation={failedInvocation()} canEdit={false} accountLifetime={lifetime} />);
    expect(screen.findHostByTestId('discussion-workflow-retry:reader')).toBeNull();
});
