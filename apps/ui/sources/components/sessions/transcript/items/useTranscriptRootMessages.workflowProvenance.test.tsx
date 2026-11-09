import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDeferred, createTestSessionTranscriptSource, flushHookEffects, renderScreen, standardCleanup,
    wrapWithSessionTranscriptSource } from '@/dev/testkit';
import { createWorkflowInvocationIndexFixture, createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import {
    materializeWorkflowAcceptedSnapshotV1} from '@happier-dev/protocol/workflows/materializeWorkflowAcceptedSnapshotV1';
import {
    sealWorkflowAcceptedSnapshotStoredEnvelopeV1,
    serializeWorkflowStoredContentEnvelopeV1,
    sealWorkflowProgressStoredEnvelopeV1,
} from '@happier-dev/protocol/workflows/workflowStoredContentV1';
import {
    WorkflowRunRecipientCensusResponseV1Schema} from '@happier-dev/protocol/workflows/workflowRunKeyV1';
import {
    WorkflowRunListResultV1Schema} from '@happier-dev/protocol/workflows/actionsV1';
import {
    WorkflowProgressEnvelopeV1Schema} from '@happier-dev/protocol/workflows/workflowProgressV1';
import { createWorkflowDefinitionFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import type { Message } from '@happier-dev/session-core/messages';
import type { SessionTranscriptSource } from '../source/types';

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
await loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storageStore');
const { workflowRunRowFromSummary, workflowRunStoreKey } = await import('@/sync/store/domains/workflowRuns');
const { publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
const { useTranscriptRootMessages } = await import('./useTranscriptRootMessages');
const { refreshWorkflowRunById } = await import('@/sync/engine/workflows/refreshWorkflowRun');
const route = '/v3/automations/runs/workflow-storage';
let previous = storage.getState();
let previousSnapshot = getActiveServerSnapshot();

vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({ splitStreamingRevealTextParts: () => [] }));

afterEach(async () => {
    await standardCleanup();
    await home.reset();
    storage.setState(previous, true);
    publishAppliedActiveServerSnapshot(previousSnapshot);
});

async function initializeHome(serverUrl: string) {
    previous = storage.getState();
    previousSnapshot = getActiveServerSnapshot();
    await home.reset();
    const id = await home.addHome({ name: 'Transcript Home', serverUrl, accountId: 'account-1' });
    home.answer(id, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture() });
    storage.setState({ workflowRunsById: {}, workflowRunInvocationsByRunId: {} });
    storage.getState().activateProfileScope({ serverId: id, accountId: 'account-1' });
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
    return { id };
}

async function storedPage(runs: readonly ReturnType<typeof createWorkflowRunSummaryFixture>[], metadataByRunId: Readonly<Record<string, { title: string }>> = {}, invocationProvenance: NonNullable<ReturnType<typeof WorkflowRunListResultV1Schema.parse>['invocationProvenance']> = []) {
    const acceptedEnvelopesByRunId: Record<string, string> = {};
    const keyCensusByRunId: Record<string, ReturnType<typeof WorkflowRunRecipientCensusResponseV1Schema.parse>> = {};
    const invocationProgressByRunId: Record<string, Array<{ index: ReturnType<typeof createWorkflowInvocationIndexFixture>; contentEnvelope: string }>> = {};
    const rootProgressByRunId: Record<string, { index: ReturnType<typeof createWorkflowInvocationIndexFixture>; contentEnvelope: string }> = {};
    for (const run of runs) {
        if (run.origin.kind !== 'direct') throw new Error('Transcript fixture requires direct Run provenance');
        const materialized = await materializeWorkflowAcceptedSnapshotV1({
            definition: createWorkflowDefinitionFixture({ blocks: ['before-one', 'before-two', 'wait'].map(id => ({
                kind: 'wait', id, document: { text: 'Continue', references: [], attachments: [] },
            })) }),
            admission: { kind: 'user' }, effects: { resolveTargetAvailability: async () => true },
            context: { source: { kind: 'inline' }, inputs: {}, machineId: run.machineId, executionTarget: { kind: 'session' },
                workspaceTarget: { project: { machineId: run.machineId, directory: '/repo', checkoutRootPath: '/repo' } },
                origin: run.origin, authorization: { principal: { kind: 'host' } },
                ...(metadataByRunId[run.id] ? { metadata: metadataByRunId[run.id] } : {}) },
        });
        if (!materialized.ok) throw new Error(`fixture_materialization_failed:${materialized.error.code}`);
        acceptedEnvelopesByRunId[run.id] = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
            binding: { v: 1, purpose: 'accepted_snapshot', accountId: run.ownerAccountId, runId: run.id }, acceptedSnapshot: materialized.snapshot }));
        keyCensusByRunId[run.id] = WorkflowRunRecipientCensusResponseV1Schema.parse({ runId: run.id, ownerAccountId: run.ownerAccountId,
            access: 'owner', encryptionMode: 'plain', dataEncryptionKey: null, callerDataEncryptionKey: null, visibleTeamId: null, recipients: [],
            ownerAccountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null } });
        const facts = invocationProvenance.filter(fact => fact.index.runId === run.id);
        const sealProgress = (index: ReturnType<typeof createWorkflowInvocationIndexFixture>, progress: ReturnType<typeof WorkflowProgressEnvelopeV1Schema.parse>) =>
            serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({ mode: 'plain',
                binding: { v: 1, purpose: 'invocation_progress', accountId: run.ownerAccountId, runId: run.id,
                    recordId: index.id, sequence: index.sequence, parentRecordId: index.parentRecordId,
                    memberOrdinal: index.memberOrdinal, attempt: index.attempt }, progress }));
        invocationProgressByRunId[run.id] = facts.map(({ index }) => ({ index,
            contentEnvelope: sealProgress(index, WorkflowProgressEnvelopeV1Schema.parse({ kind: 'happier.workflow-progress.v1',
                invocationPath: { blockId: 'wait', scope: [] }, blockKind: 'wait', attempt: index.attempt,
                logicalInvocationRecordId: index.id })),
        }));
        const root = createWorkflowInvocationIndexFixture({ id: `root-${run.id}`, runId: run.id });
        rootProgressByRunId[run.id] = { index: root,
            contentEnvelope: sealProgress(root, WorkflowProgressEnvelopeV1Schema.parse({ kind: 'happier.workflow-progress.v1',
                invocationPath: { blockId: '$root', scope: [] }, blockKind: 'root', attempt: root.attempt,
                logicalInvocationRecordId: root.id, resultProvenance: Object.fromEntries(facts.flatMap(fact =>
                    fact.notificationCondition ? [[fact.index.id, { notificationCondition: fact.notificationCondition }]] : [])) })),
        };
    }
    return { runs, acceptedEnvelopesByRunId, keyCensusByRunId, invocationProgressByRunId, rootProgressByRunId };
}

async function mountTranscript(messages: Message[], kind: SessionTranscriptSource['kind'] = 'app', serverId?: string) {
    const source = { ...createTestSessionTranscriptSource({ sessionId: 'destination', messages }), kind, serverId: serverId ?? null };
    let root: ReturnType<typeof useTranscriptRootMessages> | undefined;
    let renders = 0;
    function Probe() { renders += 1; root = useTranscriptRootMessages('destination'); return null; }
    const screen = await renderScreen(wrapWithSessionTranscriptSource(<Probe />, source));
    await flushHookEffects({ cycles: 40 });
    return { screen, getRoot: () => root!, getRenders: () => renders };
}

function messagesFor(runId: string, count: number): Message[] {
    return Array.from({ length: count }, (_, n) => ({ kind: 'user-text', id: `${runId}-${n}`, localId: null,
        createdAt: n, text: 'Visible injected text', meta: { happierProvenanceV1: { v: 2,
            kind: 'workflow_invocation', runId, invocationRecordId: `step-${runId}`, retired: true,
            ...(n === 0 ? {} : { stepOrdinal: '3' }) } } }));
}

describe('first-display workflow provenance', () => {
    it('hydrates stamped results and refreshes their condition through the existing Run invalidation', async () => {
        const currentHome = await initializeHome('http://provenance-stamped.test');
        const run = createWorkflowRunSummaryFixture({ id: 'run-a', ownerAccountId: 'account-1', origin: { kind: 'direct' } });
        storage.getState().upsertWorkflowRuns([workflowRunRowFromSummary(run)]);
        let evaluated = false;
        home.answer(currentHome.id, route, { select: async () => ({ body: await storedPage(
            [{ ...run, revision: evaluated ? 2 : 1 }], {},
            [{ index: createWorkflowInvocationIndexFixture({ id: 'step-run-a', runId: 'run-a' }), stepOrdinal: '3',
                ...(evaluated ? { notificationCondition: 'suppressed' } : {}) }],
        ) }) });
        const probe = await mountTranscript(messagesFor('run-a', 2).slice(1), 'app', currentHome.id);
        expect(home.requestsFor(route)).toHaveLength(1);
        expect(storage.getState().workflowRunInvocationsByRunId[workflowRunStoreKey('run-a', { serverId: currentHome.id, accountId: 'account-1' })]?.factsById['step-run-a']).toMatchObject({ stepOrdinal: '3' });
        evaluated = true;
        // A history-only index is not a transcript reference and must not be reopened.
        storage.getState().upsertWorkflowRunInvocation({ runId: 'run-a', parentRevision: 1,
            invocation: createWorkflowInvocationIndexFixture({ id: 'unopened-history', runId: 'run-a' }) });
        await act(async () => { await refreshWorkflowRunById('run-a'); });
        expect(home.requestsFor(route).at(-1)?.input).toMatchObject({ operation: 'list', request: { invocationProvenance: [{ runId: 'run-a', invocationRecordIds: ['step-run-a'] }] } });
        expect(storage.getState().workflowRunInvocationsByRunId[workflowRunStoreKey('run-a', { serverId: currentHome.id, accountId: 'account-1' })]?.factsById['step-run-a']).toMatchObject({ notificationCondition: 'suppressed' });
        expect(probe.getRenders()).toBe(1);
    });
    it('batches repeated and distinct Run references, retaining the visible transcript during hydration', async () => {
        const currentHome = await initializeHome('http://provenance.test');
        const pending = createDeferred<void>();
        const page = await storedPage(
            ['run-a', 'run-b'].map(id => createWorkflowRunSummaryFixture({ id, ownerAccountId: 'account-1', origin: { kind: 'direct' } })),
            { 'run-a': { title: 'Daily digest' } },
            [{ index: createWorkflowInvocationIndexFixture({ id: 'step-run-a', runId: 'run-a', memberOrdinal: '8', sequence: '87' }), stepOrdinal: '3', notificationCondition: 'suppressed' }],
        );
        home.answer(currentHome.id, route, { body: page, respondAfter: pending.promise });
        const messages = [...messagesFor('run-a', 20), ...messagesFor('run-b', 20)];
        const probe = await mountTranscript(messages, 'app', currentHome.id);
        const before = probe.getRoot();
        expect(before.messageIdsOldestFirst).toHaveLength(40);
        expect(home.requestsFor(route)).toHaveLength(1);
        expect(home.requestsFor(route)[0]?.input).toMatchObject({ operation: 'list', request: { runIds: ['run-a', 'run-b'],
            invocationProvenance: [{ runId: 'run-a', invocationRecordIds: ['step-run-a'] },
                { runId: 'run-b', invocationRecordIds: ['step-run-b'] }] } });
        // A concurrent transcript shares the pending batch, even if its rows are different objects.
        await mountTranscript(messages.map(message => ({ ...message })), 'app', currentHome.id);
        expect(home.requestsFor(route)).toHaveLength(1);
        await act(async () => {
            pending.resolve();
            await pending.promise;
        });
        await flushHookEffects({ cycles: 40 });
        expect(storage.getState().workflowRunsById[workflowRunStoreKey('run-a', { serverId: currentHome.id, accountId: 'account-1' })]?.metadata).toMatchObject({ value: { title: 'Daily digest' } });
        expect(storage.getState().workflowRunInvocationsByRunId[workflowRunStoreKey('run-a', { serverId: currentHome.id, accountId: 'account-1' })]?.factsById['step-run-a']).toMatchObject({ stepOrdinal: '3', notificationCondition: 'suppressed' });
        expect(probe.getRoot().messagesById).toBe(before.messagesById);
        expect(probe.getRoot().messageIdsOldestFirst).toBe(before.messageIdsOldestFirst);
        expect(probe.getRenders()).toBe(1);
    });

    it('does not request private facts for read-only or other-Home transcripts', async () => {
        const currentHome = await initializeHome('http://provenance-private.test');
        await mountTranscript(messagesFor('run-private', 2), 'readOnly');
        await mountTranscript(messagesFor('run-private', 2), 'app', 'other-home');
        expect(home.requestsFor(route)).toEqual([]);
    });

    it('discards late private facts after the Account lifetime changes', async () => {
        const currentHome = await initializeHome('http://provenance-retire.test');
        const pending = createDeferred<void>();
        home.answer(currentHome.id, route, { body: await storedPage(
            [createWorkflowRunSummaryFixture({ id: 'run-a', ownerAccountId: 'account-1', origin: { kind: 'direct' } })],
            { 'run-a': { title: 'Retired private title' } },
        ), respondAfter: pending.promise });
        const probe = await mountTranscript(messagesFor('run-a', 2), 'app', currentHome.id);
        expect(home.requestsFor(route)).toHaveLength(1);
        // Retire the old transcript before mounting another Account. Its pending batch must
        // not publish; a new Account's legitimately authorized reads are a separate operation.
        await act(async () => probe.screen.tree.unmount());
        await act(async () => {
            storage.setState({ profileScope: { serverId: currentHome.id, accountId: 'other-account' } });
            pending.resolve();
            await pending.promise;
        });
        await flushHookEffects({ cycles: 40 });
        expect(storage.getState().workflowRunsById[workflowRunStoreKey('run-a', { serverId: currentHome.id, accountId: 'account-1' })]).toBeUndefined();
    });
});
