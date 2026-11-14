import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDeferred, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { createWorkflowDefinitionFixture, createWorkflowInvocationIndexFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { WorkflowRunRecipientCensusResponseV1Schema } from '@happier-dev/protocol/workflows/workflowRunKeyV1';
import { WorkflowProgressEnvelopeV1Schema } from '@happier-dev/protocol/workflows/workflowProgressV1';
import { sealWorkflowProgressStoredEnvelopeV1, serializeWorkflowStoredContentEnvelopeV1 } from '@happier-dev/protocol/workflows/workflowStoredContentV1';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable, publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { workflowRunStoreKey } from '@/sync/store/domains/workflowRuns';
import { WORKFLOW_CONDITION_UNSET } from '../presentation/workflowConditionRules';
const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
installDisconnectedServerSocketBoundary();
beforeAll(loadSyncSingletonForTests);
const { storage } = await import('@/sync/domains/state/storageStore');
const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
const { useWorkflowReferenceDefinition } = await import('../presentation/useWorkflowReferenceDefinition');
const { useWorkflowRunRolePrefill } = await import('../run/useWorkflowRunRolePrefill');
const { useWorkflowRunVisibility } = await import('../run/useWorkflowRunVisibility');
const { useWorkflowTestRunPresentation } = await import('../editor/useWorkflowTestRunPresentation');
const { useWorkflowInlineRunInvocations } = await import('../run/useWorkflowInlineRunControls');
const { createWorkflowDefinition } = await import('@/sync/domains/workflows/workflowDefinitionActions');
const route = '/v3/automations/runs/workflow-storage';
let serverId: string;
const sourceArtifactId = '00000000-0000-4000-8000-000000000001';
const runId = '00000000-0000-4000-8000-000000000002';
let previous = storage.getState();
let applied = getAppliedActiveServerSnapshot();
let available = isAppliedActiveServerRuntimeAvailable();

beforeEach(async () => {
    previous = storage.getState();
    applied = getAppliedActiveServerSnapshot();
    available = isAppliedActiveServerRuntimeAvailable();
    await home.reset();
    serverId = await home.addHome({ name: 'Recovery Home', serverUrl: 'https://workflow-recovery.test', accountId: 'recovery-account' });
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
    storage.setState({ profileScope: { serverId, accountId: 'recovery-account' } });
    home.answer(serverId, '/v3/automations', { body: { automations: [], nextCursor: null } });
    home.answer(serverId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture() });
});
afterEach(async () => {
    await standardCleanup();
    retireActiveServerAccountScopeLifetime();
    await home.reset();
    storage.setState(previous);
    publishAppliedActiveServerSnapshot(applied, available);
});

function invocationPage(index: ReturnType<typeof createWorkflowInvocationIndexFixture>, parentRevision: number) {
    const progress = WorkflowProgressEnvelopeV1Schema.parse({ kind: 'happier.workflow-progress.v1', blockKind: 'step',
        invocationPath: { blockId: 'analyze', scope: [] }, attempt: index.attempt, logicalInvocationRecordId: index.id });
    const envelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({ mode: 'plain',
        binding: { v: 1, purpose: 'invocation_progress', accountId: 'recovery-account', runId,
            recordId: index.id, sequence: index.sequence, parentRecordId: index.parentRecordId,
            memberOrdinal: index.memberOrdinal, attempt: index.attempt }, progress }));
    const keyCensus = WorkflowRunRecipientCensusResponseV1Schema.parse({ runId, ownerAccountId: 'recovery-account', access: 'owner',
        encryptionMode: 'plain', dataEncryptionKey: null, callerDataEncryptionKey: null, visibleTeamId: null, recipients: [],
        ownerAccountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null } });
    return { invocations: [index], parentRevision, keyCensus, progressEnvelopesByInvocationId: { [index.id]: envelope } };
}

describe('Workflow sibling read recovery', () => {
    it.each(['editor', 'inline', 'conditional'] as const)('%s reads only changed invocation facts on a wake and preserves complete demanded outputs', async surface => {
        const step = { kind: 'step' as const, id: 'analyze',
            document: { text: 'Analyze', references: [], attachments: [] }, input: [], result: { kind: 'text' as const } };
        const definition = createWorkflowDefinitionFixture({ blocks: surface === 'conditional'
            ? [{ kind: 'if', id: 'choice', when: WORKFLOW_CONDITION_UNSET, then: [step],
                otherwise: [{ ...step, id: 'other' }] }] : [step] });
        let indices = Array.from({ length: 24 }, (_, index) => createWorkflowInvocationIndexFixture({ runId,
            id: `invocation-${index}`, sequence: String(index), parentRecordId: index === 0 ? null
                : surface === 'conditional' && index > 1 ? 'invocation-1' : 'invocation-0',
            attempt: String(Math.max(0, index - (surface === 'conditional' ? 2 : 1))),
            lifecycle: index === 0 || surface === 'conditional' && index === 1 || index === 23 ? 'completed' : 'superseded', contentRevision: '1' }));
        const output = 'Complete, untruncated output. '.repeat(800).trim();
        const keyCensus = invocationPage(indices[0]!, 2).keyCensus;
        const reads: { indices: number; bodies: number }[] = [];
        home.answer(serverId, route, { select: raw => {
            const input = raw as { cursor?: string; invocationId?: string; knownContentRevisions?: Record<string, string>; progressEnvelopes?: boolean };
            const matches = indices.filter(index => input.invocationId ? index.id === input.invocationId
                : input.knownContentRevisions?.[index.id] !== index.contentRevision);
            const offset = Number(input.cursor ?? 0);
            const selected = matches.slice(offset, offset + 8);
            reads.push({ indices: selected.length, bodies: input.progressEnvelopes ? selected.length : 0 });
            const bodies = !input.progressEnvelopes ? [] : selected.map(index => {
                const conditional = surface === 'conditional' && index.id === 'invocation-1';
                const root = index.parentRecordId === null;
                const progress = WorkflowProgressEnvelopeV1Schema.parse({ kind: 'happier.workflow-progress.v1', blockKind: root ? 'root' : conditional ? 'if' : 'step',
                    invocationPath: { blockId: root ? '$root' : conditional ? 'choice' : 'analyze', scope: [] }, attempt: index.attempt,
                    logicalInvocationRecordId: root || conditional ? index.id : surface === 'conditional' ? 'invocation-2' : 'invocation-1', result: output,
                    ...(index.attempt === '0' ? {} : { previousAttemptRecordId: `invocation-${Number(index.sequence) - 1}` }),
                    ...(conditional ? { container: { kind: 'if', selected: 'then', nextBlockOrdinal: '1' } } : {}) });
                return [index.id, serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({ mode: 'plain',
                    binding: { v: 1, purpose: 'invocation_progress', accountId: 'recovery-account', runId,
                        recordId: index.id, sequence: index.sequence, parentRecordId: index.parentRecordId,
                        memberOrdinal: index.memberOrdinal, attempt: index.attempt }, progress }))] as const;
            });
            return { body: { invocations: selected, parentRevision: 2,
                ...(offset + selected.length < matches.length ? { nextCursor: String(offset + selected.length) } : {}),
                ...(input.progressEnvelopes ? { keyCensus,
                    progressEnvelopesByInvocationId: Object.fromEntries(bodies.map(([id, envelope]) => [id, envelope])) } : {}) } };
        } });
        const lifetime = { scope: { serverId, accountId: 'recovery-account' }, isCurrent: () => true,
            onRetire: () => ({ dispose() {} }) };
        function Reader(props: Readonly<{ opened: boolean }>) {
            const presentation = useWorkflowTestRunPresentation({ runId: surface === 'inline' ? null : runId, definition, editable: true });
            const inline = useWorkflowInlineRunInvocations({ runIds: surface === 'inline' ? [runId] : [], accountLifetime: lifetime, enabled: props.opened });
            return surface !== 'inline' ? <>{props.opened ? presentation.step?.('analyze')?.footer : null}</>
                : <>{inline.byRunId.get(runId)?.at(-1)?.progress.result as string | undefined}</>;
        }
        const screen = await renderScreen(<Reader opened={false} />);
        if (surface !== 'inline') {
            await waitForHomeGovernance(() => expect(storage.getState().workflowRunInvocationsByRunId[workflowRunStoreKey(runId)]?.history.invocationIds).toHaveLength(indices.length));
            expect(reads.reduce((total, read) => total + read.bodies, 0)).toBe(0);
        } else expect(reads).toEqual([]);
        await act(async () => screen.update(<Reader opened />));
        await waitForHomeGovernance(() => expect(screen.getTextContent().includes(output)).toBe(true));
        expect(reads.reduce((total, read) => total + read.bodies, 0)).toBe(surface === 'inline' ? indices.length : surface === 'conditional' ? 2 : 1);
        const before = reads.length;
        indices = indices.map((index, position) => position === indices.length - 1 ? { ...index, contentRevision: '2' } : index);
        await act(async () => publishHomeAccountChange(serverId, [`workflow-run:${runId}`]));
        await waitForHomeGovernance(() => expect(storage.getState().workflowRunInvocationsByRunId[workflowRunStoreKey(runId)]
            ?.factsById[indices.at(-1)!.id]?.opened?.index.contentRevision).toBe('2'));
        expect(reads.slice(before).reduce((total, read) => total + read.bodies, 0)).toBe(1);
        expect(reads.slice(before).filter(read => read.bodies === 0).reduce((total, read) => total + read.indices, 0))
            .toBe(surface === 'inline' ? 0 : 1);
        expect(screen.getTextContent().includes(output)).toBe(true);
        expect(storage.getState().workflowRunInvocationsByRunId[workflowRunStoreKey(runId)]?.history.invocationIds).toHaveLength(indices.length);
        expect(storage.getState().workflowRunInvocationsByRunId[workflowRunStoreKey(runId)]?.history.nextCursor).toBeNull();
        const unchanged = reads.length;
        await act(async () => publishHomeAccountChange(serverId, [`workflow-run:${runId}`]));
        await waitForHomeGovernance(() => expect(reads.length).toBeGreaterThan(unchanged));
        expect(reads.slice(unchanged).reduce((total, read) => total + read.indices + read.bodies, 0)).toBe(0);
    });

    it('replaces a retired Role-prefill read without waiting for its old response', async () => {
        const retired = createDeferred<void>();
        home.answer(serverId, route, { respondAfter: retired.promise, body: { runs: [], acceptedEnvelopesByRunId: {}, keyCensusByRunId: {} } });
        const hook = await renderHook(() => useWorkflowRunRolePrefill(sourceArtifactId));
        expect(hook.getCurrent().status).toBe('loading');
        await waitForHomeGovernance(() => expect(home.requestsFor(route)).toHaveLength(1));
        home.answer(serverId, route, { body: { runs: [], acceptedEnvelopesByRunId: {}, keyCensusByRunId: {} } });
        await act(async () => retireActiveServerAccountScopeLifetime());
        await waitForHomeGovernance(() => expect(hook.getCurrent().status).toBe('ready'));
        expect(hook.getCurrent().overrides).toEqual([]);
        await act(async () => retired.resolve());
        expect(hook.getCurrent().overrides).toEqual([]);
    });

    it('replaces retired grant visibility and saved-reference reads together', async () => {
        const definition = createWorkflowDefinitionFixture({ blocks: [{ kind: 'wait', id: 'wait', document: { text: 'Continue', references: [], attachments: [] } }] });
        await createWorkflowDefinition({ definitionId: sourceArtifactId, definition, metadata: { title: 'Saved' } });
        const hook = await renderHook(() => ({
            reference: useWorkflowReferenceDefinition(sourceArtifactId),
            visibility: useWorkflowRunVisibility(sourceArtifactId),
        }));
        await waitForHomeGovernance(() => {
            expect(hook.getCurrent().reference.definition).toEqual(definition);
            expect(hook.getCurrent().visibility.status).toBe('ready');
        });
        await act(async () => retireActiveServerAccountScopeLifetime());
        await waitForHomeGovernance(() => {
            expect(hook.getCurrent().reference.definition).toEqual(definition);
            expect(hook.getCurrent().visibility.status).toBe('ready');
        });
    });

    it('renews the editor Test-run read and its subsequent Home wake', async () => {
        const invocation = createWorkflowInvocationIndexFixture({ runId, id: '00000000-0000-4000-8000-000000000003', lifecycle: 'running', sequence: '1' });
        const retired = createDeferred<void>();
        home.answer(serverId, route, { respondAfter: retired.promise, body: invocationPage(invocation, 1) });
        await renderHook(() => useWorkflowTestRunPresentation({ runId, definition: createWorkflowDefinitionFixture(), editable: true }));
        await waitForHomeGovernance(() => expect(home.requestsFor(route)).toHaveLength(1));
        home.answer(serverId, route, { body: invocationPage(invocation, 1) });
        await act(async () => retireActiveServerAccountScopeLifetime());
        await waitForHomeGovernance(() => expect(storage.getState().workflowRunInvocationsByRunId[workflowRunStoreKey(runId)]?.factsById[invocation.id]?.lifecycle).toBe('running'));
        const completed = createWorkflowInvocationIndexFixture({ ...invocation, lifecycle: 'completed', sequence: '2', contentRevision: '2' });
        home.answer(serverId, route, { body: invocationPage(completed, 2) });
        await act(async () => publishHomeAccountChange(serverId, [`workflow-run:${runId}`]));
        await waitForHomeGovernance(() => expect(storage.getState().workflowRunInvocationsByRunId[workflowRunStoreKey(runId)]?.factsById[invocation.id]?.lifecycle).toBe('completed'));
        await act(async () => retired.resolve());
        expect(storage.getState().workflowRunInvocationsByRunId[workflowRunStoreKey(runId)]?.factsById[invocation.id]?.lifecycle).toBe('completed');
    });
});
