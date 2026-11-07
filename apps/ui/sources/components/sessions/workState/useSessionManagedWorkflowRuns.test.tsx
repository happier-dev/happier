import * as React from 'react';
import { DISCUSSION_MAX_PAGE_SIZE_V1 } from '@happier-dev/protocol/discussions/api';
import { DiscussionLocalIdSchema } from '@happier-dev/protocol/discussions/references';
import { SessionIndexedIdentifierMaxLengthV1 } from '@happier-dev/protocol/sessions/idsV1';
import { SERVER_HTTP_REQUEST_MAX_BODY_UTF8_BYTES_V1, readServerHttpRequestBodyUtf8ByteLengthV1 } from '@happier-dev/protocol/server/http/requestBodyBoundsV1';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    AutomationRunCauseSchema} from '@happier-dev/protocol/automations/run-cause';
import {
    WorkflowRunListRequestV1Schema} from '@happier-dev/protocol/workflows/actionsV1';
import {
    WorkflowRunRecipientCensusResponseV1Schema} from '@happier-dev/protocol/workflows/workflowRunKeyV1';
import {
    materializeWorkflowAcceptedSnapshotV1} from '@happier-dev/protocol/workflows/materializeWorkflowAcceptedSnapshotV1';
import {
    sealWorkflowAcceptedSnapshotStoredEnvelopeV1,
    sealWorkflowProgressStoredEnvelopeV1,
    serializeWorkflowStoredContentEnvelopeV1,
} from '@happier-dev/protocol/workflows/workflowStoredContentV1';

import { createDeferred, createRootLayoutFeaturesResponse, flushHookEffects, renderHook as renderHookState, standardCleanup, waitForTestEvent } from '@/dev/testkit';
import { createWorkflowDefinitionFixture, createWorkflowInvocationIndexFixture, createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import type { WorkflowRunListPage } from '@/sync/domains/workflows/workflowRunListActions';
import type { SessionManagedWorkflowRunsState } from '@/components/workflows/run/useContextManagedWorkflowRuns';
import { WORKFLOW_PREVIOUS_ROUND_CONTEXT_INPUT_V1 } from '@happier-dev/protocol/workflows';

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
await loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storageStore');
const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
const { publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
const { primeServerFeaturesSnapshot, resetServerFeaturesClientForTests } = await import('@/sync/api/capabilities/serverFeaturesClient');
const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
const { workflowRunRowFromSummary, workflowRunStoreKey } = await import('@/sync/store/domains/workflowRuns');
const { useSessionManagedWorkflowRuns } = await import('@/components/workflows/run/useContextManagedWorkflowRuns');
const { useSessionManagedWorkflowRunFlow } = await import('@/components/workflows/run/useContextManagedWorkflowRuns');
const { retireActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');

const accountId = 'account-a';
const route = '/v3/automations/runs/workflow-storage';
// Supplies only the HTTP Home's answer; list parsing, Action admission, Account scope and store stay real.
const readPage = vi.fn<(params: { filter?: Record<string, unknown> }) => Promise<WorkflowRunListPage>>();
const readStorage = vi.fn<(input: Record<string, unknown>) => Promise<unknown>>();
let serverId: string;
let previousState = storage.getState();
let previousSnapshot = getActiveServerSnapshot();
const discussionOrigins = new Map<string, Readonly<{ discussion: { serverId: string; discussionId: string }; messageId: string; throughSeq: number }>>();

beforeEach(async () => {
    previousState = storage.getState();
    previousSnapshot = getActiveServerSnapshot();
    await home.reset();
    serverId = await home.addHome({ name: 'Managed runs Home', serverUrl: 'https://session-managed-runs.test', accountId });
    home.answer(serverId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture() });
    readPage.mockReset();
    readStorage.mockReset();
    discussionOrigins.clear();
    storage.setState({ workflowRunsById: {}, workflowRunListWindows: {}, workflowRunInvocationsByRunId: {},
        settings: { ...storage.getState().settings, experiments: true, featureToggles: { automations: true } } });
    storage.getState().activateProfileScope({ serverId, accountId });
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
    primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features: createRootLayoutFeaturesResponse() } });
    home.answer(serverId, route, { select: async (input) => {
        if (input && typeof input === 'object' && 'operation' in input && (input.operation === 'get' || input.operation === 'invocations.list')) {
            return { body: await readStorage(input) };
        }
        if (!input || typeof input !== 'object' || !('operation' in input) || input.operation !== 'list' || !('request' in input)) {
            throw new Error('Unexpected Workflow storage operation');
        }
        const request = WorkflowRunListRequestV1Schema.parse(input.request);
        const page = await readPage({ filter: request });
        const acceptedEnvelopesByRunId: Record<string, string> = {};
        const keyCensusByRunId: Record<string, ReturnType<typeof WorkflowRunRecipientCensusResponseV1Schema.parse>> = {};
        for (const run of page.runs) {
            const metadata = page.metadataByRunId[run.id];
            const materialized = await materializeWorkflowAcceptedSnapshotV1({
                definition: createWorkflowDefinitionFixture({ blocks: [{ kind: 'wait', id: 'wait',
                    document: { text: 'Continue', references: [], attachments: [] } }],
                    inputs: discussionOrigins.has(run.id) ? [{ name: WORKFLOW_PREVIOUS_ROUND_CONTEXT_INPUT_V1, valueType: 'json', required: false }] : [] }),
                admission: { kind: 'user' }, effects: { resolveTargetAvailability: async () => true },
                context: { source: run.origin.kind === 'automation' ? { kind: 'automation', automationId: run.origin.automationId } : { kind: 'inline' }, inputs: {}, machineId: run.machineId,
                    executionTarget: { kind: 'session' }, workspaceTarget: { project: { machineId: run.machineId, directory: '/repo', checkoutRootPath: '/repo' } },
                    origin: { kind: 'direct', ...(run.origin.originSessionId ? { originSessionId: run.origin.originSessionId } : {}),
                        ...(discussionOrigins.has(run.id) ? { discussion: discussionOrigins.get(run.id) } : {}) },
                    authorization: { principal: { kind: 'host' } },
                    ...(metadata?.kind === 'available' ? { metadata: metadata.value } : {}) },
            });
            if (!materialized.ok) throw new Error(`fixture_materialization_failed:${materialized.error.code}`);
            acceptedEnvelopesByRunId[run.id] = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
                binding: { v: 1, purpose: 'accepted_snapshot', accountId: run.ownerAccountId, runId: run.id }, acceptedSnapshot: materialized.snapshot }));
            keyCensusByRunId[run.id] = WorkflowRunRecipientCensusResponseV1Schema.parse({ runId: run.id, ownerAccountId: run.ownerAccountId,
                access: 'owner', encryptionMode: 'plain', dataEncryptionKey: null, callerDataEncryptionKey: null, recipients: [], visibleTeamId: null,
                ownerAccountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null } });
        }
        return { body: { runs: page.runs, acceptedEnvelopesByRunId, keyCensusByRunId,
            ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }) } };
    } });
    latest = null;
    probeRenders = 0;
});

afterEach(async () => {
    await standardCleanup();
    await home.reset();
    storage.setState(previousState, true);
    publishAppliedActiveServerSnapshot(previousSnapshot);
    resetServerFeaturesClientForTests();
});

let latest: SessionManagedWorkflowRunsState | null = null;
let probeRenders = 0;

it('restores composer-started Discussion Runs from persisted question ids and refreshes only their pushed changes', async () => {
    const { useDiscussionManagedWorkflowRuns } = await import('@/components/discussions/useDiscussionManagedWorkflowRuns');
    const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!lifetime) throw new Error('Missing test Account lifetime');
    const origin = { discussion: { serverId, discussionId: 'discussion-reload' }, messageId: 'question', throughSeq: 1 };
    let run = createWorkflowRunSummaryFixture({ ownerAccountId: accountId, id: 'no-reply-run', state: 'running',
        origin: { kind: 'direct', discussion: origin } });
    discussionOrigins.set(run.id, origin);
    readPage.mockImplementation(async ({ filter }) => ({
        runs: Array.isArray(filter?.runIds) && filter.runIds.includes(run.id) ? [run] : [],
        metadataByRunId: {}, nextCursor: undefined,
    }));
    // The composer deliberately uses its Run id as the committed question's local id.
    // Match the existing 300-message Discussion fixture: three full owner-sized pages.
    const messages = [{ id: 'question', localId: run.id, producerV1: null },
        ...Array.from({ length: DISCUSSION_MAX_PAGE_SIZE_V1 * 3 - 3 }, (_, index) => ({
            id: `ordinary-message-${index}`, localId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`, producerV1: null,
        }))];
    const exactIds = messages.map(message => message.localId).sort();
    // Valid ordinary Discussion identities are not necessarily valid Run identities.
    messages.push({ id: 'unicode-post', localId: DiscussionLocalIdSchema.parse('界'.repeat(SessionIndexedIdentifierMaxLengthV1)), producerV1: null },
        { id: 'decomposed-post', localId: DiscussionLocalIdSchema.parse('e\u0301'), producerV1: null });
    const useRuns = () => useDiscussionManagedWorkflowRuns({ discussion: origin.discussion, accountLifetime: lifetime, messages });
    const first = await renderHookState(useRuns);
    await act(async () => { first.getCurrent().onStarted({ run, admission: 'created' }); });
    await flushHookEffects({ cycles: 40 });
    expect(first.getCurrent().runs.map(value => value.id)).toEqual([run.id]);
    await first.unmount();
    storage.setState({ workflowRunsById: {}, workflowRunListWindows: {}, workflowRunInvocationsByRunId: {} });
    readPage.mockClear();
    const reloaded = await renderHookState(useRuns);
    await flushHookEffects({ cycles: 40 });
    expect(reloaded.getCurrent().runs.map(value => [value.id, value.state])).toEqual([[run.id, 'running']]);
    expect(readPage.mock.calls.map(([request]) => request.filter)).toEqual([
        expect.objectContaining({ runIds: exactIds }),
    ]);
    const listRequests = home.requestsFor(route);
    expect(listRequests.every(request => request.method === 'POST')).toBe(true);
    expect(readServerHttpRequestBodyUtf8ByteLengthV1(listRequests.at(-1)!.input)).toBeLessThanOrEqual(SERVER_HTTP_REQUEST_MAX_BODY_UTF8_BYTES_V1);
    expect(readStorage).not.toHaveBeenCalled();
    const reads = readPage.mock.calls.length;
    await act(async () => {
        publishHomeAccountChange(serverId, ['workflow-run:unrelated-run'], { changeKinds: ['account'] });
        publishHomeAccountChange(serverId, ['another-discussion'], { changeKinds: ['discussion'] });
        publishHomeAccountChange('another-home', [`workflow-run:${run.id}`], { changeKinds: ['account'] });
    });
    await flushHookEffects({ cycles: 10 });
    expect(readPage).toHaveBeenCalledTimes(reads);
    run = { ...run, state: 'paused', revision: run.revision + 1 };
    await act(async () => { publishHomeAccountChange(serverId, [`workflow-run:${run.id}`], { changeKinds: ['account'] }); });
    await flushHookEffects({ cycles: 40 });
    expect(reloaded.getCurrent().runs[0]?.state).toBe('paused');
    expect(readPage).toHaveBeenCalledTimes(reads + 1);
});

it('discovers a composer Run creation pushed after the committed question initially has no Run', async () => {
    const { useDiscussionManagedWorkflowRuns } = await import('@/components/discussions/useDiscussionManagedWorkflowRuns');
    const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!lifetime) throw new Error('Missing test Account lifetime');
    const origin = { discussion: { serverId, discussionId: 'discussion-admission' }, messageId: 'question', throughSeq: 1 };
    const run = createWorkflowRunSummaryFixture({ ownerAccountId: accountId, id: 'admitting-run', state: 'running',
        origin: { kind: 'direct', discussion: origin } });
    discussionOrigins.set(run.id, origin);
    let admitted = false;
    readPage.mockImplementation(async () => ({ runs: admitted ? [run] : [], metadataByRunId: {}, nextCursor: undefined }));
    const hook = await renderHookState(() => useDiscussionManagedWorkflowRuns({ discussion: origin.discussion, accountLifetime: lifetime,
        messages: [{ id: 'question', localId: run.id, producerV1: null }] }));
    await flushHookEffects({ cycles: 40 });
    expect(hook.getCurrent().phase).toBe('loaded');
    expect(hook.getCurrent().runs).toEqual([]);
    expect(readPage).toHaveBeenCalledTimes(1);
    admitted = true;
    await act(async () => { publishHomeAccountChange(serverId, [`workflow-run:${run.id}`], { changeKinds: ['account'] }); });
    await flushHookEffects({ cycles: 40 });
    expect(hook.getCurrent().runs.map(value => value.id)).toEqual([run.id]);
    expect(readPage).toHaveBeenCalledTimes(2);
    expect(readStorage).not.toHaveBeenCalled();
});

it('reads no Run for an unreferenced Discussion and retains its acknowledged start before a first reply', async () => {
    const { useDiscussionManagedWorkflowRuns } = await import('@/components/discussions/useDiscussionManagedWorkflowRuns');
    const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!lifetime) throw new Error('Missing test Account lifetime');
    const origin = { discussion: { serverId, discussionId: 'discussion-start' }, messageId: 'question', throughSeq: 1 };
    const run = createWorkflowRunSummaryFixture({ ownerAccountId: accountId, id: 'started-run', state: 'running',
        origin: { kind: 'direct', discussion: origin } });
    const { discussionWorkflowRunWindowId } = await import('@/sync/store/domains/workflowRuns');
    storage.getState().applyWorkflowRunListPage({ scope: lifetime.scope, windowId: discussionWorkflowRunWindowId(lifetime.scope, origin.discussion.discussionId),
        runs: [createWorkflowRunSummaryFixture({ ...run, id: 'off-page-run',
            origin: { kind: 'direct', discussion: { ...origin, messageId: 'not-loaded' } } })], mode: 'replace', nextCursor: null });
    discussionOrigins.set(run.id, origin);
    const requested = createDeferred<void>();
    readPage.mockImplementation(async () => { requested.resolve(); return { runs: [run], metadataByRunId: {}, nextCursor: undefined }; });
    const hook = await renderHookState(() => useDiscussionManagedWorkflowRuns({ discussion: origin.discussion,
        accountLifetime: lifetime, messages: [{ id: 'question', producerV1: null }] }));
    await flushHookEffects({ cycles: 40 });
    expect(readPage).not.toHaveBeenCalled();
    await act(async () => { hook.getCurrent().onStarted({ run, admission: 'created' }); });
    await requested.promise;
    await flushHookEffects({ cycles: 40 });
    expect(hook.getCurrent().runs.map(value => value.id)).toEqual([run.id]);
    expect(readPage.mock.calls.map(([request]) => request.filter)).toEqual([expect.objectContaining({ runIds: [run.id] })]);
    await hook.unmount();
    const initialMessages: { id: string; producerV1: null }[] = [];
    const reopened = await renderHookState(({ messages }: { messages: { id: string; producerV1: null }[] }) => useDiscussionManagedWorkflowRuns({ discussion: origin.discussion,
        accountLifetime: lifetime, messages }), { initialProps: { messages: initialMessages } });
    await flushHookEffects({ cycles: 40 });
    await reopened.rerender({ messages: [{ id: 'question', producerV1: null }] });
    expect(reopened.getCurrent().runs.map(value => value.id)).toEqual([run.id]);
    expect(reopened.getCurrent().pending).toBe(false);
});

it('opens Discussion bands with their messages using one exact summary batch and no inventory pages', async () => {
    const { useDiscussionManagedWorkflowRuns } = await import('@/components/discussions/useDiscussionManagedWorkflowRuns');
    const { buildDiscussionTimelineItems } = await import('@/components/discussions/discussionTimelineProjection');
    const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!lifetime) throw new Error('Missing test Account lifetime');
    const run = createWorkflowRunSummaryFixture({ ownerAccountId: accountId, id: 'referenced-run', state: 'succeeded', origin: { kind: 'direct' } });
    discussionOrigins.set(run.id, { discussion: { serverId, discussionId: 'discussion-band' }, messageId: 'question', throughSeq: 1 });
    const messages = [
        { id: 'question', seq: 1, producerV1: null },
        { id: 'answer', seq: 2, producerV1: { v: 1 as const, kind: 'workflow' as const, runId: run.id,
            invocationRecordId: 'invocation', invocationAttempt: '1', execution: { kind: 'detached_run' as const, executionRunId: 'native-run' }, outcome: 'answer' as const } },
    ];
    const pending = createDeferred<WorkflowRunListPage>();
    readPage.mockImplementation(async ({ filter }) => filter?.runIds ? pending.promise : {
        runs: [], metadataByRunId: {}, nextCursor: undefined,
    });
    let previous: ReturnType<typeof buildDiscussionTimelineItems<typeof messages[number]>> = [];
    const commits: string[][] = [];
    const hook = await renderHookState(({ threadMessages }: { threadMessages: typeof messages }) => {
        const state = useDiscussionManagedWorkflowRuns({ discussion: { serverId, discussionId: 'discussion-band' },
            accountLifetime: lifetime, messages: threadMessages });
        const items = buildDiscussionTimelineItems({ serverId, discussionId: 'discussion-band', messages: threadMessages,
            subagents: [], readExecutionRunEntry: () => null, workflowRuns: state.runs,
            workflowRunsPending: state.pending, workflowRunAnswerIds: new Map([[run.id, ['answer']]]) }, previous);
        React.useLayoutEffect(() => {
            previous = items;
            commits.push(items.map(item => item.kind === 'human_message' ? item.message.id
                : item.kind === 'workflow_run' ? `run:${item.run.id}` : item.kind === 'workflow_run_end' ? `end:${item.run.id}` : 'reference'));
        }, [items]);
        return state;
    }, { initialProps: { threadMessages: messages } });
    await flushHookEffects({ cycles: 40 });
    expect(readPage.mock.calls.map(([request]) => request.filter)).toEqual([expect.objectContaining({ runIds: [run.id] })]);
    expect(commits.every(items => items.length === 0)).toBe(true);
    const loaded = waitForTestEvent(hook.subscribe, () => expect(hook.getCurrent().phase).toBe('loaded'));
    await act(async () => { pending.resolve({ runs: [run], metadataByRunId: {}, nextCursor: undefined }); });
    await loaded;
    await flushHookEffects({ cycles: 40 });
    const expected = ['question', `run:${run.id}`, 'answer', `end:${run.id}`];
    for (const items of commits.filter(items => items.length > 0)) expect(items).toEqual(expected);
    expect(commits.at(-1)).toEqual(expected);
    expect(hook.getCurrent().pending).toBe(false);
    expect(readPage).toHaveBeenCalledTimes(1);
    // Unrelated messages do not re-read the same exact Run ids.
    await hook.rerender({ threadMessages: [...messages, { id: 'unrelated', seq: 3, producerV1: null }] });
    await flushHookEffects({ cycles: 10 });
    expect(readPage).toHaveBeenCalledTimes(1);
    const foreign = createWorkflowRunSummaryFixture({ ...run, id: 'foreign-run', origin: { kind: 'direct', discussion: {
        discussion: { serverId, discussionId: 'elsewhere' }, messageId: 'question', throughSeq: 1,
    } } });
    const unanchored = createWorkflowRunSummaryFixture({ ...run, id: 'unanchored-run', origin: { kind: 'direct', discussion: {
        discussion: { serverId, discussionId: 'discussion-band' }, messageId: 'not-loaded', throughSeq: 1,
    } } });
    const items = buildDiscussionTimelineItems({ serverId, discussionId: 'discussion-band', messages,
        subagents: [], readExecutionRunEntry: () => null, workflowRuns: [...hook.getCurrent().runs, foreign, unanchored],
        workflowRunAnswerIds: new Map([[run.id, ['answer']]]) });
    expect(items.filter(item => item.kind === 'workflow_run').map(item => item.run.id)).toEqual([run.id]);
});

async function renderHook(sessionId: string | null = 'session-1', targetServerId: string | null = serverId, pending = false) {
    const { useSessionManagedWorkflowRuns } = await import('@/components/workflows/run/useContextManagedWorkflowRuns');
    const hook = await renderHookState(() => {
        probeRenders += 1;
        latest = useSessionManagedWorkflowRuns({ sessionId, serverId: targetServerId });
        return latest;
    });
    if (!pending) await waitForTestEvent(hook.subscribe, () => expect(hook.getCurrent().phase).not.toBe('loading'));
    return hook;
}

describe('useSessionManagedWorkflowRuns', () => {
    it('discovers Discussion Runs on demand through filtered continuations and the canonical Run store', async () => {
        const { useDiscussionManagedWorkflowRuns } = await import('@/components/discussions/useDiscussionManagedWorkflowRuns');
        const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime) throw new Error('missing_account_scope');
        const run = createWorkflowRunSummaryFixture({ ownerAccountId: accountId, id: 'discussion-run', state: 'running', origin: { kind: 'direct' } });
        discussionOrigins.set(run.id, { discussion: { serverId, discussionId: 'discussion-1' }, messageId: 'question-1', throughSeq: 1 });
        readPage.mockImplementation(async ({ filter }) => ({ runs: filter?.cursor ? [run] : [],
            metadataByRunId: {}, nextCursor: filter?.cursor ? undefined : 'filtered-next' }));
        const hook = await renderHookState(({ enabled }: { enabled: boolean }) => useDiscussionManagedWorkflowRuns({
            messages: [{ id: 'answer', producerV1: { v: 1, kind: 'workflow', runId: run.id, invocationRecordId: 'invocation', invocationAttempt: '1',
                execution: { kind: 'detached_run', executionRunId: 'native-run' }, outcome: 'answer' } }],
            discussion: { serverId, discussionId: 'discussion-1' }, accountLifetime: lifetime, enabled,
        }), { initialProps: { enabled: false } });
        expect(readPage).not.toHaveBeenCalled();
        expect(hook.getCurrent().phase).toBe('idle');
        await hook.rerender({ enabled: true });
        await flushHookEffects({ cycles: 40 });
        await waitForTestEvent(hook.subscribe, () => expect(hook.getCurrent().phase).toBe('loaded'));
        // The Action filters the opened accepted origin; private membership never reaches storage.
        expect(readPage.mock.calls.every(([request]) => request.filter?.originDiscussionId === undefined)).toBe(true);
        expect(hook.getCurrent().runs.map(value => value.id)).toEqual(['discussion-run']);
        expect(hook.getCurrent().supportsAnotherRoundByRunId?.[run.id]).toBe(true);
        expect(hook.getCurrent().callerAccessByRunId?.[run.id]).toEqual({ canEdit: true });
        expect(storage.getState().workflowRunsById[workflowRunStoreKey(run.id, lifetime.scope)]?.summary?.id).toBe(run.id);
    });
    it('keeps scope-unread Automation Runs unavailable instead of guessing membership from the client catalog', async () => {
        const { automationScopeSessionId: _unread, ...run } = createWorkflowRunSummaryFixture({ ownerAccountId: accountId,
            origin: { kind: 'automation', automationId: 'retired-automation', cause: AutomationRunCauseSchema.parse({
                kind: 'conversation', triggerId: 'retired-trigger', occurrenceKey: 'A'.repeat(43), occurredAt: 10,
            }) } });
        readPage.mockResolvedValue({ runs: [run], metadataByRunId: {}, nextCursor: undefined });
        await renderHook();
        expect(latest?.phase).toBe('failed');
        expect(latest?.refreshFailed).toBe(true);
        expect(latest?.runs).toEqual([]);
    });

    it.each([
        { kind: 'manual' as const, invokedAt: 10 },
        { kind: 'conversation' as const, occurrenceKey: 'A'.repeat(43), occurredAt: 10 },
        undefined,
    ])('keeps non-trigger Work readable without an irrelevant historical scope (%j)', async cause => {
        const { automationScopeSessionId: _unread, ...run } = createWorkflowRunSummaryFixture({ ownerAccountId: accountId,
            origin: { kind: 'automation', automationId: 'historical-automation', ...(cause ? { cause: AutomationRunCauseSchema.parse(cause) } : {}) } });
        readPage.mockResolvedValue({ runs: [run], metadataByRunId: {}, nextCursor: undefined });
        await renderHook();
        expect(latest?.phase).toBe('loaded');
        expect(latest?.runs.map(value => value.id)).toEqual([run.id]);
    });

    it('renews the flow definition, invocation window and exact wake after equal-Account retirement', async () => {
        const run = createWorkflowRunSummaryFixture({ id: 'flow-run', ownerAccountId: accountId, origin: { kind: 'direct' } });
        const held = createDeferred<unknown>();
        readStorage.mockImplementation(() => held.promise);
        const hook = await renderHookState(() => useSessionManagedWorkflowRunFlow(run.id, serverId));
        await flushHookEffects({ cycles: 40 });
        expect(hook.getCurrent()).toBeNull();
        const materialized = await materializeWorkflowAcceptedSnapshotV1({
            definition: createWorkflowDefinitionFixture({ blocks: [{ kind: 'wait', id: 'fresh-wait', document: { text: 'Continue', references: [], attachments: [] } }] }),
            admission: { kind: 'user' }, effects: { resolveTargetAvailability: async () => true },
            context: { source: { kind: 'inline' }, inputs: {}, machineId: run.machineId,
                executionTarget: { kind: 'session' }, workspaceTarget: { project: { machineId: run.machineId, directory: '/repo', checkoutRootPath: '/repo' } },
                origin: { kind: 'direct', ...(run.origin.originSessionId ? { originSessionId: run.origin.originSessionId } : {}) },
                authorization: { principal: { kind: 'host' } } },
        });
        if (!materialized.ok) throw new Error('fixture_materialization_failed');
        const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
            binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId: run.id }, acceptedSnapshot: materialized.snapshot }));
        let lifecycle: 'running' | 'completed' = 'running';
        readStorage.mockImplementation(async input => {
            if (input.operation === 'get') return { run, acceptedEnvelope, checkpointEnvelope: null, resultEnvelope: null,
            keyCensus: WorkflowRunRecipientCensusResponseV1Schema.parse({ runId: run.id, ownerAccountId: accountId, access: 'owner', encryptionMode: 'plain',
                dataEncryptionKey: null, callerDataEncryptionKey: null, recipients: [], visibleTeamId: null,
                ownerAccountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }) };
            const invocations = [createWorkflowInvocationIndexFixture({ id: 'root', runId: run.id }),
                createWorkflowInvocationIndexFixture({ id: 'child', runId: run.id, parentRecordId: 'root', sequence: '1', lifecycle })];
            return { parentRevision: lifecycle === 'running' ? 1 : 2, invocations,
                ...(input.progressEnvelopes === true ? { progressEnvelopesByInvocationId: Object.fromEntries(invocations.map(index => [index.id,
                    serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({ mode: 'plain',
                        binding: { v: 1, purpose: 'invocation_progress', accountId, runId: run.id, recordId: index.id,
                            sequence: index.sequence, parentRecordId: index.parentRecordId, memberOrdinal: index.memberOrdinal, attempt: index.attempt },
                        progress: { kind: 'happier.workflow-progress.v1', invocationPath: { blockId: index.parentRecordId === null ? '$root' : 'fresh-wait', scope: [] },
                            blockKind: index.parentRecordId === null ? 'root' : 'wait', attempt: index.attempt, logicalInvocationRecordId: index.id },
                    })),
                ])) } : {}),
            };
        });
        await act(async () => retireActiveServerAccountScopeLifetime());
        await waitForTestEvent(hook.subscribe, () => expect(hook.getCurrent()?.runStates.get('fresh-wait')?.map(state => state.lifecycle)).toEqual(['running']));
        expect(hook.getCurrent()?.projection.nodes.map(node => node.nodeId)).toContain('fresh-wait');
        expect(hook.getCurrent()?.runStates.get('fresh-wait')?.map(state => state.lifecycle)).toEqual(['running']);
        lifecycle = 'completed';
        await act(async () => publishHomeAccountChange(serverId, [`workflow-run:${run.id}`]));
        await waitForTestEvent(hook.subscribe, () => expect(hook.getCurrent()?.runStates.get('fresh-wait')?.map(state => state.lifecycle)).toEqual(['completed']));
        expect(hook.getCurrent()?.runStates.get('fresh-wait')?.map(state => state.lifecycle)).toEqual(['completed']);
        held.resolve({});
        await flushHookEffects({ cycles: 40 });
        expect(hook.getCurrent()?.projection.nodes.map(node => node.nodeId)).toContain('fresh-wait');
    });

    it.each(['pending', 'loaded'] as const)('renews a %s window and its wake after equal-Account retirement', async (phase) => {
        const stale = createWorkflowRunSummaryFixture({ id: 'stale', ownerAccountId: accountId,
            origin: { kind: 'direct', originSessionId: 'session-1' } });
        const pending = createDeferred<WorkflowRunListPage>();
        readPage.mockImplementation(async () => phase === 'pending' ? pending.promise
            : { runs: [stale], metadataByRunId: {}, nextCursor: undefined });
        const hook = await renderHook('session-1', serverId, phase === 'pending');
        expect(latest?.phase).toBe(phase === 'pending' ? 'loading' : 'loaded');
        const fresh = createWorkflowRunSummaryFixture({ ...stale, id: 'fresh' });
        readPage.mockResolvedValue({ runs: [fresh], metadataByRunId: {}, nextCursor: undefined });
        await act(async () => retireActiveServerAccountScopeLifetime());
        await flushHookEffects({ cycles: 40 });
        pending.resolve({ runs: [stale], metadataByRunId: {}, nextCursor: undefined });
        await waitForTestEvent(hook.subscribe, () => expect(latest?.runs.map(run => run.id)).toEqual([fresh.id]));
        expect(latest?.phase).toBe('loaded');
        expect(latest?.runs.map(run => run.id)).toEqual(['fresh']);
        const later = createWorkflowRunSummaryFixture({ ...fresh, id: 'after-wake' });
        readPage.mockResolvedValue({ runs: [later], metadataByRunId: {}, nextCursor: undefined });
        await act(async () => publishHomeAccountChange(serverId, ['workflow-run:after-wake']));
        await waitForTestEvent(hook.subscribe, () => expect(latest?.runs.map(run => run.id)).toEqual([later.id]));
        expect(latest?.runs.map(run => run.id)).toEqual(['after-wake']);
    });

    it('consumes complete summary continuations including held Runs before declaring Work membership loaded', async () => {
        const run = (id: string, state: 'running' | 'succeeded' | 'waiting_for_review') => createWorkflowRunSummaryFixture({
            id, state, ownerAccountId: accountId, origin: { kind: 'direct', originSessionId: 'session-1' },
        });
        const working = run('older-working', 'running');
        const held = { ...run('older-held', 'waiting_for_review'), attentionRequired: true, invocationAttentionRequired: true };
        readPage.mockImplementation(async ({ filter }) => {
            if (filter?.cursor === 'held-next') return { runs: [held], metadataByRunId: {}, nextCursor: undefined };
            if (filter?.cursor === 'working-next') return { runs: [working], metadataByRunId: {}, nextCursor: 'held-next' };
            return { runs: [run('recent-finished', 'succeeded')], metadataByRunId: {}, nextCursor: 'working-next' };
        });
        await renderHook();
        expect(latest?.phase).toBe('loaded');
        expect(latest?.runs.map(run => run.id)).toEqual(['recent-finished', 'older-working', 'older-held']);
        expect([...latest!.attentionRunIds]).toEqual(['older-held']);
        expect(Object.keys(storage.getState().workflowRunsById).sort()).toEqual(
            ['older-held', 'older-working', 'recent-finished'].map(id => workflowRunStoreKey(id, { serverId, accountId })).sort(),
        );
        expect(readPage.mock.calls.map(([request]) => request.filter)).toEqual([
            { originSessionId: 'session-1' },
            { originSessionId: 'session-1', cursor: 'working-next' },
            { originSessionId: 'session-1', cursor: 'held-next' },
        ]);
    });

    it('reflects a control settled through the shared Run row owner without asking the server again', async () => {
        const running = createWorkflowRunSummaryFixture({
            ownerAccountId: accountId,
            id: 'run-1', state: 'running', revision: 1, origin: { kind: 'direct', originSessionId: 'session-1' },
        });
        readPage.mockResolvedValue({ runs: [running],
            metadataByRunId: { 'run-1': { kind: 'available', value: { title: 'Nightly review' } } }, nextCursor: undefined });
        await renderHook();

        expect(latest?.phase).toBe('loaded');
        expect(latest?.runs.map((run) => [run.id, run.state])).toEqual([['run-1', 'running']]);
        expect(latest?.metadataByRunId?.['run-1']).toEqual({ kind: 'available', value: { title: 'Nightly review' } });
        expect(readPage).toHaveBeenCalledTimes(1);

        // The Run screen settles Pause into the one shared row owner.
        const { getStorage } = await import('@/sync/domains/state/storage');
        await act(async () => {
            getStorage().getState().upsertWorkflowRuns([
                workflowRunRowFromSummary({ ...running, state: 'paused', revision: 2 }),
            ]);
        });

        expect(latest?.runs.map((run) => [run.id, run.state])).toEqual([['run-1', 'paused']]);
        expect(latest?.metadataByRunId?.['run-1']).toEqual({ kind: 'available', value: { title: 'Nightly review' } });
        expect(readPage).toHaveBeenCalledTimes(1);
    });

    /**
     * A contextual Session surface is not a second place the feature can be
     * on. It answers the same canonical decision the dedicated Workflow routes
     * do and fails closed while that decision is unresolved, so a Home without
     * Workflows neither reads managed Runs nor links to them — while the
     * Session's ordinary one-shot Automations are untouched.
     */
    it.each([
        ['disabled', { status: 'ready', features: createRootLayoutFeaturesResponse({ features: { workflows: { enabled: false } } }) }],
        ['unknown', { status: 'unsupported', reason: 'invalid_payload' }],
        ['unresolved', { status: 'error', reason: 'network' }],
    ] as const)('reads no managed Run on a %s Workflows decision', async (_label, decision) => {
        primeServerFeaturesSnapshot({ serverId, snapshot: decision });
        readPage.mockResolvedValue({ runs: [], metadataByRunId: {}, nextCursor: undefined });

        await renderHook('session-1', serverId, true);

        expect(readPage).not.toHaveBeenCalled();
        expect(latest?.runs).toEqual([]);
        expect(latest?.phase).toBe(_label === 'unresolved' ? 'loading' : 'idle');
    });

    /**
     * Every Run this Account has read shares one map. A Session section that
     * read the map rerendered for every other Run's exact refresh — including
     * the ones a Run screen settles controls on while this transcript is open.
     */
    it('keeps an unrelated Account Run refresh out of this mounted Session section', async () => {
        const running = createWorkflowRunSummaryFixture({
            ownerAccountId: accountId,
            id: 'run-1', state: 'running', revision: 1, origin: { kind: 'direct', originSessionId: 'session-1' },
        });
        readPage.mockImplementation(async (params): Promise<WorkflowRunListPage> => (
            params.filter?.attention === 'required'
                ? { runs: [], metadataByRunId: {}, nextCursor: undefined }
                : {
                    runs: [running],
                    metadataByRunId: { 'run-1': { kind: 'available', value: { title: 'Nightly review' } } },
                    nextCursor: undefined,
                }
        ));
        await renderHook();
        expect(latest?.runs.map((run) => run.id)).toEqual(['run-1']);
        const rendersAfterLoad = probeRenders;

        const { getStorage } = await import('@/sync/domains/state/storage');
        // Another Session's Run refreshing in the one Account-scoped row owner.
        await act(async () => {
            getStorage().getState().upsertWorkflowRuns([workflowRunRowFromSummary(
                createWorkflowRunSummaryFixture({ id: 'run-elsewhere', state: 'succeeded', revision: 3 }),
            )]);
        });

        expect(probeRenders).toBe(rendersAfterLoad);
        expect(latest?.runs.map((run) => run.id)).toEqual(['run-1']);

        await act(async () => {
            getStorage().getState().upsertWorkflowRuns([workflowRunRowFromSummary(
                { ...running, state: 'paused', revision: 2 },
                { kind: 'available', value: { title: 'Nightly review (renamed)' } },
            )]);
        });

        expect(probeRenders).toBe(rendersAfterLoad + 1);
        expect(latest?.runs.map((run) => [run.id, run.state])).toEqual([['run-1', 'paused']]);
        expect(latest?.metadataByRunId?.['run-1'])
            .toEqual({ kind: 'available', value: { title: 'Nightly review (renamed)' } });
    });

    it('re-reads membership and attention on the Account-change wake the collection also observes', async () => {
        const running = createWorkflowRunSummaryFixture({
            ownerAccountId: accountId,
            id: 'run-1', state: 'running', revision: 1, origin: { kind: 'direct', originSessionId: 'session-1' },
        });
        readPage.mockResolvedValue({ runs: [running], metadataByRunId: {}, nextCursor: undefined });
        const hook = await renderHook();
        expect(latest?.attentionRunIds.has('run-1')).toBe(false);
        expect(readPage).toHaveBeenCalledTimes(1);

        // A later approval on an off-page invocation: the server's attention
        // summary is the only owner of that fact, and the wake is how the
        // client learns to ask again.
        readPage.mockResolvedValue({ runs: [{ ...running, revision: 2, attentionRequired: true, invocationAttentionRequired: true }],
            metadataByRunId: {}, nextCursor: undefined });
        await act(async () => {
            publishHomeAccountChange(serverId, ['workflow-run:run-1']);
        });
        await waitForTestEvent(hook.subscribe, () => expect(latest?.attentionRunIds.has(running.id)).toBe(true));

        expect(readPage).toHaveBeenCalledTimes(2);
        expect(latest?.phase).toBe('loaded');
        expect(latest?.attentionRunIds.has('run-1')).toBe(true);

        // Wakes about other Homes or unrelated entities do not refetch.
        await act(async () => {
            publishHomeAccountChange('server-b', ['workflow-run:run-1']);
            publishHomeAccountChange(serverId, ['session:other']);
        });
        await flushHookEffects({ cycles: 40 });
        expect(readPage).toHaveBeenCalledTimes(2);
    });

    it('discovers a newly admitted Run when its wake arrives during the initial empty membership read', async () => {
        const first = createDeferred<WorkflowRunListPage>();
        readPage.mockResolvedValue({ runs: [], metadataByRunId: {}, nextCursor: undefined });
        readPage.mockImplementationOnce(() => first.promise);
        const hook = await renderHook('session-1', serverId, true);
        expect(latest?.phase).toBe('loading');
        const started = createWorkflowRunSummaryFixture({ ownerAccountId: accountId, id: 'before-first-answer',
            origin: { kind: 'direct', originSessionId: 'session-1' } });
        readPage.mockImplementation(async ({ filter }) => ({ runs: filter?.attention ? [] : [started],
            metadataByRunId: {}, nextCursor: undefined }));
        await act(async () => { publishHomeAccountChange(serverId, [`workflow-run:${started.id}`]); });
        await flushHookEffects({ cycles: 40 });
        await act(async () => first.resolve({ runs: [], metadataByRunId: {}, nextCursor: undefined }));
        await waitForTestEvent(hook.subscribe, () => expect(latest?.runs.map(run => run.id)).toEqual([started.id]));
        expect(latest?.runs.map(run => run.id)).toEqual([started.id]);
    });

    /**
     * A later summary page can contain an actionable Run absent from the first
     * page. Its server-owned attention fact and body must both survive the
     * complete relation read and land in the shared Run row owner.
     */
    it('renders an actionable Run a later summary page contains', async () => {
        const onPage = createWorkflowRunSummaryFixture({
            ownerAccountId: accountId,
            id: 'run-on-page', state: 'running', revision: 1,
            origin: { kind: 'direct', originSessionId: 'session-1' },
        });
        const offPage = createWorkflowRunSummaryFixture({
            ownerAccountId: accountId,
            id: 'run-off-page', state: 'interrupted', revision: 4, attentionRequired: true, failureUnseen: true,
            origin: { kind: 'direct', originSessionId: 'session-1' },
        });
        readPage.mockImplementation(async (params): Promise<WorkflowRunListPage> => (
            params.filter?.cursor === 'actionable-next'
                ? {
                    runs: [offPage],
                    metadataByRunId: { 'run-off-page': { kind: 'available', value: { title: 'Release check' } } },
                    nextCursor: undefined,
                }
                : {
                    runs: [onPage],
                    metadataByRunId: { 'run-on-page': { kind: 'available', value: { title: 'Nightly review' } } },
                    nextCursor: 'actionable-next',
                }
        ));

        await renderHook();

        // Complete summaries retain server order across continuation pages.
        expect(latest?.runs.map((run) => run.id)).toEqual(['run-on-page', 'run-off-page']);
        expect(latest?.attentionRunIds.has('run-off-page')).toBe(true);
        expect(latest?.metadataByRunId?.['run-off-page'])
            .toEqual({ kind: 'available', value: { title: 'Release check' } });

        // The attention body landed in the one Account-scoped row owner, so the
        // exact Run route resolves the same body without another read.
        expect(Object.keys(storage.getState().workflowRunsById).sort())
            .toEqual(['run-off-page', 'run-on-page'].map(id => workflowRunStoreKey(id, { serverId, accountId })).sort());
        expect(readPage.mock.calls.map(([request]) => request.filter)).toEqual([
            { originSessionId: 'session-1' },
            { originSessionId: 'session-1', cursor: 'actionable-next' },
        ]);
    });

    it('keeps one attention-marked Run from one complete summary read', async () => {
        const shared = createWorkflowRunSummaryFixture({
            ownerAccountId: accountId,
            id: 'run-1', state: 'interrupted', revision: 2, attentionRequired: true, failureUnseen: true,
            origin: { kind: 'direct', originSessionId: 'session-1' },
        });
        readPage.mockImplementation(async () => ({
            runs: [shared], metadataByRunId: {}, nextCursor: undefined,
        }));

        await renderHook();

        expect(latest?.runs.map((run) => run.id)).toEqual(['run-1']);
        expect(latest?.attentionRunIds.has('run-1')).toBe(true);
        expect(readPage).toHaveBeenCalledTimes(1);
    });

    /**
     * A refresh that fails is not evidence the Session started nothing. The
     * window keeps the membership it already proved and reports the failure
     * separately, which is the package rule for hydrated content.
     */
    it('keeps last-known-good membership when a refresh fails and surfaces the failure separately', async () => {
        const running = createWorkflowRunSummaryFixture({
            ownerAccountId: accountId,
            id: 'run-1', state: 'running', revision: 1,
            origin: { kind: 'direct', originSessionId: 'session-1' },
        });
        readPage.mockImplementation(async (params) => (
            params.filter?.attention === 'required'
                ? { runs: [], metadataByRunId: {}, nextCursor: undefined }
                : { runs: [running], metadataByRunId: {}, nextCursor: undefined }
        ));
        const hook = await renderHook();
        expect(latest?.runs.map((run) => run.id)).toEqual(['run-1']);
        expect(latest?.refreshFailed).toBe(false);

        readPage.mockImplementation(async () => { throw new Error('offline'); });
        await act(async () => {
            publishHomeAccountChange(serverId, ['workflow-run:run-1']);
        });
        await waitForTestEvent(hook.subscribe, () => expect(latest?.refreshFailed).toBe(true));

        expect(latest?.phase).toBe('loaded');
        expect(latest?.refreshFailed).toBe(true);
        expect(latest?.runs.map((run) => run.id)).toEqual(['run-1']);
    });

    it('reports a first read that failed as failed, because nothing is known yet', async () => {
        readPage.mockImplementation(async () => { throw new Error('offline'); });

        await renderHook();

        expect(latest?.phase).toBe('failed');
        expect(latest?.refreshFailed).toBe(true);
        expect(latest?.runs).toEqual([]);
    });

    it("retires rows and refetches when the Account changes rather than showing another Account's Runs", async () => {
        const accountARun = createWorkflowRunSummaryFixture({
            ownerAccountId: accountId,
            id: 'run-a', state: 'running', revision: 1, origin: { kind: 'direct', originSessionId: 'session-1' },
        });
        readPage.mockImplementation(async () => ({ runs: [accountARun], metadataByRunId: {}, nextCursor: undefined }));
        const hook = await renderHook();
        expect(latest?.runs.map((run) => run.id)).toEqual(['run-a']);

        const accountBRun = createWorkflowRunSummaryFixture({
            ownerAccountId: 'account-b',
            id: 'run-b', state: 'succeeded', revision: 1, origin: { kind: 'direct', originSessionId: 'session-1' },
        });
        const accountB = createDeferred<WorkflowRunListPage>();
        readPage.mockImplementation(() => accountB.promise);
        await act(async () => {
            await home.switchAccount(serverId, 'account-b');
            storage.getState().activateProfileScope({ serverId, accountId: 'account-b' });
            publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        });
        // Nothing of Account A survives the switch, before B has answered.
        expect(latest?.runs).toEqual([]);
        accountB.resolve({ runs: [accountBRun], metadataByRunId: {}, nextCursor: undefined });
        await waitForTestEvent(hook.subscribe, () => expect(latest?.runs.map(run => run.id)).toEqual([accountBRun.id]));
        expect(latest?.runs.map((run) => run.id)).toEqual(['run-b']);
    });
});
