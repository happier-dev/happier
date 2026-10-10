import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDeferred, createTestSessionTranscriptSource, renderScreen, standardCleanup,
    wrapWithSessionTranscriptSource } from '@/dev/testkit';
import { createWorkflowInvocationIndexFixture, createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { storage } from '@/sync/domains/state/storage';
import { workflowRunRowFromSummary } from '@/sync/store/domains/workflowRuns';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { getActiveServerSnapshot, upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import type { Message } from '@happier-dev/session-core/messages';
import type { SessionTranscriptSource } from '../source/types';
import { useTranscriptRootMessages } from './useTranscriptRootMessages';
import { refreshWorkflowRunById } from '@/sync/engine/workflows/refreshWorkflowRun';

const execute = vi.hoisted(() => vi.fn());
// The Action transport is the system boundary; readers, schemas and Account/store lifetime are real.
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', () => ({ createFrontDoorActionExecute: () => execute }));
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({ splitStreamingRevealTextParts: () => [] }));

afterEach(() => {
    standardCleanup();
    retireActiveServerAccountScopeLifetime();
    storage.setState(storage.getInitialState(), true);
    execute.mockReset();
});

async function mountTranscript(messages: Message[], kind: SessionTranscriptSource['kind'] = 'app', serverId?: string) {
    const source = { ...createTestSessionTranscriptSource({ sessionId: 'destination', messages }), kind, serverId: serverId ?? null };
    let root: ReturnType<typeof useTranscriptRootMessages> | undefined;
    let renders = 0;
    function Probe() { renders += 1; root = useTranscriptRootMessages('destination'); return null; }
    const screen = await renderScreen(wrapWithSessionTranscriptSource(<Probe />, source));
    return { screen, getRoot: () => root!, getRenders: () => renders };
}

function messagesFor(runId: string, count: number): Message[] {
    return Array.from({ length: count }, (_, n) => ({ kind: 'user-text', id: `${runId}-${n}`, localId: null,
        createdAt: n, text: 'Visible injected text', meta: { happierProvenanceV1: { v: 2,
            kind: 'workflow_invocation', runId, invocationRecordId: `step-${runId}`, ...(n === 0 ? {} : { stepOrdinal: '3' }) } } }));
}

describe('first-display workflow provenance', () => {
    it('hydrates stamped results and refreshes their condition through the existing Run invalidation', async () => {
        const home = await upsertAndActivateServer({ serverUrl: 'http://provenance-stamped.test' });
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        storage.setState({ profileScope: { serverId: home.id, accountId: 'account-1' } });
        const run = createWorkflowRunSummaryFixture({ id: 'run-a' });
        storage.getState().upsertWorkflowRuns([workflowRunRowFromSummary(run)]);
        let evaluated = false;
        execute.mockImplementation(async () => ({ ok: true, result: { runs: [{ ...run, revision: evaluated ? 2 : 1 }], metadataByRunId: {},
            invocationProvenance: [{ index: createWorkflowInvocationIndexFixture({ id: 'step-run-a', runId: 'run-a' }), stepOrdinal: '3',
                ...(evaluated ? { notificationCondition: 'suppressed' } : {}) }] } }));
        const probe = await mountTranscript(messagesFor('run-a', 2).slice(1), 'app', home.id);
        expect(execute).toHaveBeenCalledTimes(1);
        expect(storage.getState().workflowRunInvocationsByRunId['run-a']?.factsById['step-run-a']).toMatchObject({ stepOrdinal: '3' });
        evaluated = true;
        // A history-only index is not a transcript reference and must not be reopened.
        storage.getState().upsertWorkflowRunInvocation({ runId: 'run-a', parentRevision: 1,
            invocation: createWorkflowInvocationIndexFixture({ id: 'unopened-history', runId: 'run-a' }) });
        await act(async () => { await refreshWorkflowRunById('run-a'); });
        expect(execute.mock.calls.at(-1)?.[1]).toMatchObject({ invocationProvenance: [{ runId: 'run-a', invocationRecordIds: ['step-run-a'] }] });
        expect(storage.getState().workflowRunInvocationsByRunId['run-a']?.factsById['step-run-a']).toMatchObject({ notificationCondition: 'suppressed' });
        expect(probe.getRenders()).toBe(1);
    });
    it('batches repeated and distinct Run references, retaining the visible transcript during hydration', async () => {
        const home = await upsertAndActivateServer({ serverUrl: 'http://provenance.test' });
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        storage.setState({ profileScope: { serverId: home.id, accountId: 'account-1' } });
        const pending = createDeferred<unknown>();
        execute.mockReturnValue(pending.promise);
        const messages = [...messagesFor('run-a', 20), ...messagesFor('run-b', 20)];
        const probe = await mountTranscript(messages, 'app', home.id);
        const before = probe.getRoot();
        expect(before.messageIdsOldestFirst).toHaveLength(40);
        expect(execute).toHaveBeenCalledTimes(1);
        expect(execute.mock.calls[0]?.[1]).toEqual({ runIds: ['run-a', 'run-b'],
            invocationProvenance: [{ runId: 'run-a', invocationRecordIds: ['step-run-a'] },
                { runId: 'run-b', invocationRecordIds: ['step-run-b'] }] });
        // A concurrent transcript shares the pending batch, even if its rows are different objects.
        await mountTranscript(messages.map(message => ({ ...message })), 'app', home.id);
        expect(execute).toHaveBeenCalledTimes(1);
        await act(async () => {
            pending.resolve({ ok: true, result: { runs: ['run-a', 'run-b'].map(id => createWorkflowRunSummaryFixture({ id })),
                metadataByRunId: { 'run-a': { kind: 'available', value: { title: 'Daily digest' } } },
                invocationProvenance: [{ index: createWorkflowInvocationIndexFixture({ id: 'step-run-a', runId: 'run-a', memberOrdinal: '8', sequence: '87' }), stepOrdinal: '3', notificationCondition: 'suppressed' }] } });
            await pending.promise;
        });
        expect(storage.getState().workflowRunsById['run-a']?.metadata).toMatchObject({ value: { title: 'Daily digest' } });
        expect(storage.getState().workflowRunInvocationsByRunId['run-a']?.factsById['step-run-a']).toMatchObject({ stepOrdinal: '3', notificationCondition: 'suppressed' });
        expect(probe.getRoot().messagesById).toBe(before.messagesById);
        expect(probe.getRoot().messageIdsOldestFirst).toBe(before.messageIdsOldestFirst);
        expect(probe.getRenders()).toBe(1);
    });

    it('does not request private facts for read-only or other-Home transcripts', async () => {
        const home = await upsertAndActivateServer({ serverUrl: 'http://provenance-private.test' });
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        storage.setState({ profileScope: { serverId: home.id, accountId: 'account-1' } });
        await mountTranscript(messagesFor('run-private', 2), 'readOnly');
        await mountTranscript(messagesFor('run-private', 2), 'app', 'other-home');
        expect(execute).not.toHaveBeenCalled();
    });

    it('discards late private facts after the Account lifetime changes', async () => {
        const home = await upsertAndActivateServer({ serverUrl: 'http://provenance-retire.test' });
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        storage.setState({ profileScope: { serverId: home.id, accountId: 'account-1' } });
        const pending = createDeferred<unknown>();
        execute.mockReturnValue(pending.promise);
        const probe = await mountTranscript(messagesFor('run-a', 2), 'app', home.id);
        // Retire the old transcript before mounting another Account. Its pending batch must
        // not publish; a new Account's legitimately authorized reads are a separate operation.
        await act(async () => probe.screen.tree.unmount());
        await act(async () => {
            storage.setState({ profileScope: { serverId: home.id, accountId: 'other-account' } });
            pending.resolve({ ok: true, result: { runs: [createWorkflowRunSummaryFixture({ id: 'run-a' })], metadataByRunId: { 'run-a': { kind: 'available', value: { title: 'Retired private title' } } } } });
            await pending.promise;
        });
        expect(storage.getState().workflowRunsById['run-a']).toBeUndefined();
    });
});
