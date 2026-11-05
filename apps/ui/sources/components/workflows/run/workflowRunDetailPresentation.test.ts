import { describe, expect, it } from 'vitest';
import { WorkflowProgressEnvelopeV1Schema, WORKFLOW_RUN_STATES_V1 } from '@happier-dev/protocol/workflows/workflowProgressV1';
import { WorkflowDefinitionV1Schema } from '@happier-dev/protocol/workflows/workflowV1';
import type { WorkflowRunInvocationIndexV1 } from '@happier-dev/protocol';
import { projectWorkflowInvocationStructure } from './workflowInvocationStructure';
import { projectWorkflowFlow } from '../flow/workflowFlowProjection';
import { createWorkflowRunReleaseScene } from '@/dev/testkit/render/workflowRunDesignScene';

import {
    createWorkflowInvocationIndexFixture,
    createWorkflowRunSummaryFixture,
} from '@/dev/testkit/fixtures/workflowRunFixtures';

import {
    describeWorkflowInvocationLifecycle,
    describeWorkflowRunState,
    isTerminalWorkflowRunState,
    summarizeWorkflowInvocationCoverage,
} from '@/components/workflows/presentation/workflowLifecyclePresentation';

import { t } from '@/text';

import {
    canOfferWorkflowInvocationReattach,
    describeWorkflowInvocationCause,
    formatWorkflowRunOutcomeLabel,
    formatWorkflowRunOutcomeSentence,
    formatWorkflowRunOutcomeLine,
    formatWorkflowRunConsequenceSentence,
    formatWorkflowWorkspaceSourceLabel,
    isObservedCompletionTransition,
    projectWorkflowInvocationRecovery,
    projectWorkflowRunFailure,
    selectWorkflowRunFailureInvocation,
    formatWorkflowRunFailureCauseLine,
} from './workflowRunDetailPresentation';

describe('managed workflow Run presentation', () => {
    it('says what an interrupted Run stopped on and that finished work is retained, never the bare word (H3)', () => {
        const run = createWorkflowRunSummaryFixture({ state: 'interrupted' });
        const coverage = summarizeWorkflowInvocationCoverage([], { kindsByInvocationId: new Map(), historyComplete: false });
        expect(formatWorkflowRunOutcomeSentence({ run, coverage, failure: { step: 'For each issue' } }))
            .toBe('For each issue was interrupted. Completed work is retained.');
        expect(formatWorkflowRunOutcomeSentence({ run, coverage })).toBe('Completed work is retained.');
    });
    it('never assigns a failure cause from later Machine reachability (R5 03:42–04:58 / 10:28)', () => {
        const run = createWorkflowRunSummaryFixture({ state: 'failed', finishedAt: '2026-10-19T04:58:00.000Z' });
        const invocation = createWorkflowInvocationIndexFixture({ lifecycle: 'failed', createdAt: '2026-10-19T03:42:00.000Z',
            updatedAt: '2026-10-19T04:58:00.000Z' });
        const lastSeenAt = Date.parse('2026-10-19T10:28:00.000Z');
        const recovery = projectWorkflowInvocationRecovery({ run, invocation, progress: null, machineHomeDirectory: null,
            machine: { name: 'Review box', reachable: false, lastSeenAt } });
        expect(recovery.failureCause).toEqual({ kind: 'cause_not_recorded' });
        expect(recovery.unavailableMachine).toEqual({ name: 'Review box', lastSeenAt });
        expect(formatWorkflowRunFailureCauseLine({ invocationId: invocation.id, step: null, recovery }))
            .toBe(t('workflows.recovery.causeNotRecorded'));
        const online = projectWorkflowInvocationRecovery({ run, invocation, progress: null, machineHomeDirectory: null,
            machine: { name: 'Review box', reachable: true, lastSeenAt } });
        expect(online.failureCause).toEqual(recovery.failureCause);
        for (const lifecycle of ['completed', 'running', 'needs_attention', 'outcome_uncertain'] as const) {
            expect(projectWorkflowInvocationRecovery({ run, invocation: { ...invocation, lifecycle }, progress: null,
                machineHomeDirectory: null, machine: { name: 'Review box', reachable: false, lastSeenAt } }).failureCause).toBeNull();
        }
        // Even contact lost before the Run ended proves only current availability, never its cause.
        expect(projectWorkflowInvocationRecovery({ run, invocation, progress: null, machineHomeDirectory: null,
            machine: { name: 'Review box', reachable: false, lastSeenAt: Date.parse(invocation.createdAt) - 1 } }).failureCause)
            .toEqual(recovery.failureCause);
    });
    it('does not replace authoritative empty or unresolved failure discovery with a different loaded failure', () => {
        const loaded = createWorkflowInvocationIndexFixture({ lifecycle: 'failed' });
        const structure = new Map([[loaded.id, { invocationId: loaded.id, nodeId: 'work', blockId: 'work',
            isFrame: false, occurrence: [], coverageKind: 'executable' as const }]]);
        expect(selectWorkflowRunFailureInvocation({ invocations: [loaded], structure, firstFailedInvocationId: null })).toBeNull();
        expect(selectWorkflowRunFailureInvocation({ invocations: [loaded], structure, firstFailedInvocationId: 'off-page' })).toBeNull();
    });
    it.each([1_900_000_000_000, null])('projects the reachable Z16 design fixture with its reported reset (%s)', resetAtMs => {
        const run = createWorkflowRunSummaryFixture({ state: 'failed', workflowCustodyState: 'settled' });
        const scene = createWorkflowRunReleaseScene({ runId: run.id, rootId: 'root', holdId: 'hold', failed: true, usageLimitResetAtMs: resetAtMs });
        const failed = scene.rows.find(row => row.progress?.reason?.runtimeIssueV1?.code === 'usage_limit')!;
        const invocations = scene.rows.map(row => row.index);
        const structure = projectWorkflowInvocationStructure({ definition: scene.definition, invocations,
            progressByInvocationId: new Map(scene.rows.flatMap(row => row.progress ? [[row.index.id, row.progress] as const] : [])) });
        const presentation = projectWorkflowRunFailure({ run, invocation: failed.index, progress: failed.progress,
            structure, projection: projectWorkflowFlow(scene.definition), machineHomeDirectory: null });
        expect(presentation).toMatchObject({ invocationId: failed.index.id, step: { name: 'Publish summary', ordinal: '7' },
            recovery: { canReattach: false, canRetrySameConversation: false, canRetryFreshAgent: false,
                failureCause: { kind: 'reported_failure', message: 'Usage limit reached', runtimeIssue: { usageLimit: { resetAtMs } } } } });
        if (resetAtMs === null) expect(presentation?.recovery.failureCause).toMatchObject({ reset: null });
        // The page's one cause line: the step's number, the provider's words, and only a reported reset.
        const line = formatWorkflowRunFailureCauseLine(presentation!);
        const reset = presentation?.recovery.failureCause?.kind === 'reported_failure' ? presentation.recovery.failureCause.reset : null;
        expect(line).toBe(resetAtMs === null ? `${t('workflows.run.stepNumber', { ordinal: '7' })} · Usage limit reached`
            : `${t('workflows.run.stepNumber', { ordinal: '7' })} · Usage limit reached · ${reset}`);
        if (resetAtMs !== null) expect(reset).toBeTruthy();
        expect(projectWorkflowRunFailure({ run: { ...run, id: 'another-run' }, invocation: failed.index, progress: failed.progress,
            structure, projection: projectWorkflowFlow(scene.definition), machineHomeDirectory: null })).toBeNull();
    });
    it('keeps a structural failure unrecorded without blaming its completed child or current Machine (R4)', () => {
        const run = createWorkflowRunSummaryFixture({ state: 'failed', workflowCustodyState: 'settled' });
        const root = createWorkflowInvocationIndexFixture({ id: 'root', lifecycle: 'failed' });
        const child = createWorkflowInvocationIndexFixture({ id: 'child', lifecycle: 'completed', parentRecordId: root.id, sequence: '1' });
        const definition = WorkflowDefinitionV1Schema.parse({ version: 1, inputs: [], defaults: {}, blocks: [
            { kind: 'wait', id: 'check', name: 'Review release readiness', document: { text: 'Ready?', references: [], attachments: [] } },
        ] });
        const params = { run, invocation: root, progress: null, machineHomeDirectory: null,
            machine: { name: 'Build box', reachable: false, lastSeenAt: 1791633660000 },
            structure: projectWorkflowInvocationStructure({ definition, invocations: [root, child] }), projection: projectWorkflowFlow(definition) };
        expect(projectWorkflowRunFailure(params)).toMatchObject({ invocationId: root.id, step: null,
            recovery: { failureCause: { kind: 'cause_not_recorded' } } });
        expect(projectWorkflowRunFailure({ ...params, invocation: child })).toBeNull();
        expect(formatWorkflowRunFailureCauseLine(projectWorkflowRunFailure(params)!))
            .toBe(t('workflows.recovery.causeNotRecorded'));
    });
    it.each([1_900_000_000_000, null])('presents the source runtime issue and only a reported reset (%s)', resetAtMs => {
        const run = createWorkflowRunSummaryFixture({ state: 'interrupted' });
        const invocation = createWorkflowInvocationIndexFixture({ lifecycle: 'failed' });
        const progress = WorkflowProgressEnvelopeV1Schema.parse({ kind: 'happier.workflow-progress.v1', blockKind: 'step',
            invocationPath: { blockId: 'work', scope: [] }, attempt: '0', logicalInvocationRecordId: invocation.id,
            reason: { code: 'session_input_failed', message: 'Current turn failed', runtimeIssueV1: {
                v: 1, scope: 'primary_session', status: 'failed', code: 'usage_limit', source: 'usage_limit', occurredAt: 100,
                sanitizedPreview: 'Usage limit reached',
                usageLimit: { v: 1, resetAtMs, retryAfterMs: null, quotaScope: 'account', recoverability: 'wait' },
            } } });
        const presentation = projectWorkflowInvocationRecovery({ run, invocation, progress, machineHomeDirectory: null });
        expect(presentation.failureCause).toMatchObject({ kind: 'reported_failure', message: 'Usage limit reached',
            runtimeIssue: progress.reason?.runtimeIssueV1,
            ...(resetAtMs === null ? { reset: null } : { reset: expect.stringContaining('2030') }) });
    });
    it('keeps every persisted outcome stable across competing Machine observations', () => {
        const coverage = { observedLeafCounts: { completed: 0, failed: 0, attention: 0 }, coverage: 'complete' as const, knownFailure: false };
        for (const state of WORKFLOW_RUN_STATES_V1) {
            const run = createWorkflowRunSummaryFixture({ state, workflowCustodyState: 'settled' });
            const sentence = formatWorkflowRunOutcomeSentence({ run, coverage });
            for (const reachable of [false, true, false, true]) {
                expect(formatWorkflowRunOutcomeSentence({ run, coverage, machine: { name: 'Build box', reachable } })).toBe(sentence);
            }
        }
    });
    it('exposes reported failure and lost-contact time without inventing recovery choices', () => {
        const run = createWorkflowRunSummaryFixture({ state: 'interrupted' });
        const invocation = createWorkflowInvocationIndexFixture({ lifecycle: 'failed' });
        const progress = WorkflowProgressEnvelopeV1Schema.parse({ kind: 'happier.workflow-progress.v1', blockKind: 'step',
            invocationPath: { blockId: 'a', scope: [] }, attempt: '0', logicalInvocationRecordId: invocation.id,
            timing: { startedAt: '2026-10-10T12:00:00.000Z', finishedAt: '2026-10-10T12:01:00.000Z' },
            reason: { code: 'agent_failed', message: 'Agent exited before producing a result' } });
        const recovery = projectWorkflowInvocationRecovery({ run, invocation, progress, machineHomeDirectory: null,
            machine: { name: 'Build box', reachable: false, lastSeenAt: 1791633660000 } });
        expect(recovery).toMatchObject({
            failureCause: { kind: 'reported_failure', blockKind: 'step', code: 'agent_failed', message: 'Agent exited before producing a result', at: '2026-10-10T12:01:00.000Z' },
            unavailableMachine: { name: 'Build box', lastSeenAt: 1791633660000 },
            canReattach: false, canRetrySameConversation: false, canRetryFreshAgent: false, canContinuePrepared: false,
        });
        expect(projectWorkflowInvocationRecovery({ run, invocation, progress: { ...progress, reason: undefined }, machineHomeDirectory: null,
            machine: { name: 'Build box', reachable: false, lastSeenAt: 1791633660000 } }).failureCause)
            .toMatchObject({ kind: 'cause_not_recorded' });
        expect(projectWorkflowInvocationRecovery({ run, invocation: { ...invocation, lifecycle: 'completed' }, progress,
            machineHomeDirectory: null, machine: { name: 'Build box', reachable: false } }).failureCause).toBeNull();
        expect(projectWorkflowInvocationRecovery({ run, invocation, progress, machineHomeDirectory: null,
            machine: { name: 'Build box', reachable: false, lastSeenAt: 0 } }).unavailableMachine)
            .toEqual({ name: 'Build box', lastSeenAt: null });
    });
    it.each([
        ['ECONNABORTED', 'timeout of 30000ms exceeded', 'workflows.recovery.agentTimedOut'],
        ['ETIMEDOUT', 'connect ETIMEDOUT 10.0.0.4:443', 'workflows.recovery.agentTimedOut'],
        ['ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:3013', 'workflows.recovery.agentUnreachable'],
        ['ECONNRESET', 'socket hang up', 'workflows.recovery.agentConnectionLost'],
    ] as const)('says a recorded %s in words on the cause line and keeps the raw message for step detail', (code, message, key) => {
        const run = createWorkflowRunSummaryFixture({ state: 'interrupted' });
        const invocation = createWorkflowInvocationIndexFixture({ lifecycle: 'failed' });
        const progress = WorkflowProgressEnvelopeV1Schema.parse({ kind: 'happier.workflow-progress.v1', blockKind: 'step',
            invocationPath: { blockId: 'a', scope: [] }, attempt: '0', logicalInvocationRecordId: invocation.id,
            reason: { code, message } });
        const recovery = projectWorkflowInvocationRecovery({ run, invocation, progress, machineHomeDirectory: null });
        expect(recovery.failureCause).toMatchObject({ kind: 'reported_failure', code, message, headline: t(key) });
        expect(formatWorkflowRunFailureCauseLine({ invocationId: invocation.id, step: { name: 'Draft', ordinal: '1' }, recovery }))
            .toBe(`${t('workflows.run.stepNumber', { ordinal: '1' })} · ${t(key)}`);
        // An unrecognized code keeps the message its producer recorded.
        const other = projectWorkflowInvocationRecovery({ run, invocation, machineHomeDirectory: null,
            progress: { ...progress, reason: { code: 'agent_failed', message: 'Agent exited before producing a result' } } });
        expect(other.failureCause).toMatchObject({ headline: 'Agent exited before producing a result' });
    });
    it('keeps Stop pending until physical custody settles, even after the parent is cancelled', () => {
        const coverage = { observedLeafCounts: { completed: 1, failed: 0, attention: 5 }, coverage: 'complete' as const, knownFailure: false };
        const run = createWorkflowRunSummaryFixture({ state: 'cancelled', workflowCustodyState: 'pending', stepProgress: { completed: 1, total: 5 } });
        expect(formatWorkflowRunOutcomeSentence({ run, coverage })).toBe(t('workflows.run.stopping'));
        expect(formatWorkflowRunOutcomeLabel({ state: run.state, workflowCustodyState: run.workflowCustodyState, coverage })).toBe(t('workflows.run.stopping'));
        expect(formatWorkflowRunOutcomeSentence({ run: { ...run, workflowCustodyState: 'settled' }, coverage })).toBe(t('workflows.run.stoppedCount', { completed: 1, total: 5 }));
    });
    it('describes the persisted conversation refusal through the one problem owner', () => {
        const progress = WorkflowProgressEnvelopeV1Schema.parse({ kind: 'happier.workflow-progress.v1', blockKind: 'step',
            invocationPath: { blockId: 'a', scope: [] }, attempt: '0', logicalInvocationRecordId: 'inv-1',
            reason: { code: 'workflow_conversation_unavailable', details: { code: 'workflow_conversation_unavailable',
                reason: 'connectedServices', expected: { kind: 'object', ids: ['profile-1'] }, observed: { kind: 'unset' } } } });
        expect(describeWorkflowInvocationCause({ lifecycle: 'failed', reasonCode: progress.reason!.code,
            reasonDetails: progress.reason!.details, blockLabel: 'Review' }))
            .toBe(t('workflows.problem.conversationChecks.connectedServices'));
    });
    it('uses authored progress rather than repeated runtime attempts for completion counts', () => {
        const coverage = { observedLeafCounts: { completed: 7, failed: 0, attention: 0 }, coverage: 'complete' as const, knownFailure: false };
        const run = createWorkflowRunSummaryFixture({ state: 'succeeded', stepProgress: { completed: 3, total: 3 } });
        expect(formatWorkflowRunOutcomeSentence({ run, coverage })).toBe(t('workflows.run.completedCount', { count: 3 }));
        expect(formatWorkflowRunOutcomeSentence({ run: { ...run, stepProgress: null }, coverage })).toBe(t('workflows.runState.succeeded'));
    });
    it('says how far a stopped Run got rather than the bare state word (DESIGN-15 R9)', () => {
        const coverage = { observedLeafCounts: { completed: 1, failed: 0, attention: 0 }, coverage: 'complete' as const, knownFailure: false };
        const run = createWorkflowRunSummaryFixture({ state: 'cancelled', workflowCustodyState: 'settled', stepProgress: { completed: 1, total: 5 } });
        expect(formatWorkflowRunOutcomeSentence({ run, coverage })).toBe(t('workflows.run.stoppedCount', { completed: 1, total: 5 }));
        // The count is the server's projection, so a partly loaded history still states it.
        expect(formatWorkflowRunOutcomeSentence({ run, coverage, historyComplete: false })).toBe(t('workflows.run.stoppedCount', { completed: 1, total: 5 }));
        expect(formatWorkflowRunOutcomeSentence({ run: { ...run, stepProgress: null }, coverage })).toBe(t('workflows.runState.cancelled'));
    });
    it('describes a claimed continuation and an accepted Stop from their current facts', () => {
        const coverage = { observedLeafCounts: { completed: 1, failed: 0, attention: 0 }, coverage: 'complete' as const, knownFailure: false };
        const run = createWorkflowRunSummaryFixture({ state: 'claimed' });
        expect(formatWorkflowRunOutcomeSentence({ run, coverage })).toBe(t('workflows.runState.running'));
        expect(formatWorkflowRunOutcomeSentence({ run, coverage, cancelRequested: true })).toBe(t('workflows.run.stopping'));
        expect(formatWorkflowRunOutcomeLabel({ state: 'claimed', coverage, cancelRequested: true })).toBe(t('workflows.run.stopping'));
    });
    it('names only live independent lanes and their frozen join, without promising advancement while paused or failed', () => {
        const step = (id: string, name: string) => ({ kind: 'step', id, name,
            document: { text: name, references: [], attachments: [] }, input: [], result: { kind: 'text' } });
        const definition = WorkflowDefinitionV1Schema.parse({ version: 1, inputs: [], defaults: {}, blocks: [
            { kind: 'parallel', id: 'lanes', failurePolicy: 'collect_outcomes', branches: [
                { id: 'changelog', name: 'Changelog', blocks: [step('write', 'Write changelog')] },
                { id: 'issues', name: 'Issues', blocks: [step('check', 'Check issues')] },
                { id: 'tests', name: 'Tests', blocks: [step('test', 'Run tests')] },
            ] }, step('review', 'Review the release'),
        ] });
        const row = (id: string, parentRecordId: string | null, memberOrdinal: string,
            lifecycle: WorkflowRunInvocationIndexV1['lifecycle']) =>
            createWorkflowInvocationIndexFixture({ id, parentRecordId, memberOrdinal, lifecycle });
        const invocations = [row('root', null, '0', 'running'), row('parallel', 'root', '0', 'running'),
            row('changelog', 'parallel', '0', 'running'), row('issues', 'parallel', '1', 'running'), row('tests', 'parallel', '2', 'running'),
            row('write', 'changelog', '0', 'waiting_for_review'), row('check', 'issues', '0', 'running'), row('test', 'tests', '0', 'running')];
        const run = createWorkflowRunSummaryFixture({ state: 'running' });
        const params = { run, definition, invocations, historyComplete: true,
            structure: projectWorkflowInvocationStructure({ definition, invocations }) };
        expect(formatWorkflowRunConsequenceSentence(params)).toBe('Issues and Tests keep going. Review the release starts when all 3 lanes finish.');
        expect(formatWorkflowRunConsequenceSentence({ ...params, historyComplete: false })).toBe('Issues and Tests keep going.');
        expect(formatWorkflowRunConsequenceSentence({ ...params, run: { ...run, state: 'paused' } })).toBeNull();
        expect(formatWorkflowRunConsequenceSentence({ ...params, machineReachable: false })).toBeNull();
        expect(formatWorkflowRunConsequenceSentence({ ...params, definition: null })).toBeNull();
        const stopped = invocations.map(row => row.id === 'test' ? { ...row, lifecycle: 'completed' as const } : row);
        expect(formatWorkflowRunConsequenceSentence({ ...params, invocations: stopped })).toBe('Issues keeps going. Review the release starts when all 3 lanes finish.');
        const failed = stopped.map(row => row.id === 'write' ? { ...row, lifecycle: 'failed' as const } : row);
        const failStop = { ...definition, blocks: definition.blocks.map(block => block.kind === 'parallel'
            ? { ...block, failurePolicy: 'fail_stop' as const } : block) };
        expect(formatWorkflowRunConsequenceSentence({ ...params, invocations: failed, definition: failStop })).toBeNull();
        const noLiveWork = stopped.map(row => row.id === 'check' ? { ...row, lifecycle: 'waiting_for_approval' as const } : row);
        expect(formatWorkflowRunConsequenceSentence({ ...params, invocations: noLiveWork })).toBeNull();
    });
    it('names the failed step and retained work without an attention row or complete history', () => {
        const run = createWorkflowRunSummaryFixture({ state: 'failed' });
        const coverage = summarizeWorkflowInvocationCoverage([], { kindsByInvocationId: new Map(), historyComplete: false });
        expect(formatWorkflowRunOutcomeSentence({ run, coverage, historyComplete: false,
            failure: { step: 'Publish summary' },
        })).toBe('Publish summary failed. Completed work is kept.');
        expect(formatWorkflowRunOutcomeSentence({ run, coverage })).toBe('Completed work is kept.');
        expect(formatWorkflowRunOutcomeSentence({ run: { ...run, state: 'cancelled', workflowCustodyState: 'settled' }, coverage,
            failure: { step: 'Publish summary' },
        })).toBe(t('workflows.runState.cancelled'));
    });
    it('offers an explicit engine replacement only for a stopped unavailable step with settled custody', () => {
        const run = createWorkflowRunSummaryFixture({ state: 'failed', workflowCustodyState: 'settled' });
        const invocation = createWorkflowInvocationIndexFixture({ lifecycle: 'failed' });
        const progress = WorkflowProgressEnvelopeV1Schema.parse({
            kind: 'happier.workflow-progress.v1' as const,
            invocationPath: { blockId: 'analyze', scope: [] },
            blockKind: 'step' as const,
            attempt: '0', logicalInvocationRecordId: invocation.id,
            reason: { code: 'target_unavailable' as const },
        });
        const project = (overrides: Partial<Parameters<typeof projectWorkflowInvocationRecovery>[0]> = {}) =>
            projectWorkflowInvocationRecovery({ run, invocation, progress, machineHomeDirectory: null, ...overrides });
        expect(project().canRunWithAnotherAgent).toBe(true);
        expect(project({ run: { ...run, workflowCustodyState: 'pending' } }).canRunWithAnotherAgent).toBe(false);
        expect(project({ progress: { ...progress, blockKind: 'action' } }).canRunWithAnotherAgent).toBe(false);
        expect(project({ invocation: { ...invocation, lifecycle: 'running' } }).canRunWithAnotherAgent).toBe(false);
        expect(project({ progress: { ...progress, reason: { code: 'workspace_missing' } } }).canRunWithAnotherAgent).toBe(false);
        expect(project({ progress: null }).canRunWithAnotherAgent).toBe(false);
    });

    it('keeps parent state and invocation lifecycle as separate vocabularies', () => {
        // `interrupted` exists only on the parent; `waiting_for_approval` only
        // on an invocation. Neither mapper may accept the other's value.
        expect(describeWorkflowRunState('interrupted').variant).toBe('attention');
        expect(describeWorkflowInvocationLifecycle('waiting_for_approval').variant).toBe('attention');
        expect(describeWorkflowRunState('paused').variant).toBe('neutral');
        // `queued` and `claimed` are the incumbent Automation parent states the
        // workflow enum extends; they are not an invocation lifecycle.
        expect(describeWorkflowRunState('queued').variant).toBe('neutral');
        expect(describeWorkflowInvocationLifecycle('superseded').variant).toBe('neutral');
    });

    it('reads a structurally successful Run with failed children as done with failures', () => {
        const label = formatWorkflowRunOutcomeLabel({
            state: 'succeeded',
            coverage: { observedLeafCounts: { completed: 3, failed: 1, attention: 0 }, coverage: 'complete', knownFailure: true },
        });

        // Never "all passed" because the container structurally completed.
        expect(label).not.toBe(formatWorkflowRunOutcomeLabel({
            state: 'succeeded',
            coverage: { observedLeafCounts: { completed: 4, failed: 0, attention: 0 }, coverage: 'complete', knownFailure: false },
        }));
    });

    it('does not hide known failures merely because other history pages are missing', () => {
        expect(formatWorkflowRunOutcomeLabel({
            state: 'succeeded',
            coverage: { observedLeafCounts: { completed: 1, failed: 1, attention: 0 }, coverage: 'partial', knownFailure: true },
            historyComplete: false,
        })).toBe(t('workflows.runState.completed_with_failures'));
    });

    it('classifies terminal states exactly', () => {
        expect(isTerminalWorkflowRunState('succeeded')).toBe(true);
        expect(isTerminalWorkflowRunState('outcome_uncertain')).toBe(true);
        // Boundary paused and interrupted remain recoverable, not terminal.
        expect(isTerminalWorkflowRunState('paused')).toBe(false);
        expect(isTerminalWorkflowRunState('interrupted')).toBe(false);
    });

    it('fires the completion moment only on an observed nonterminal to success transition', () => {
        expect(isObservedCompletionTransition({ previousState: 'running', nextState: 'succeeded' })).toBe(true);
        // First render of an already finished Run, and re-entry, must not replay it.
        expect(isObservedCompletionTransition({ previousState: null, nextState: 'succeeded' })).toBe(false);
        expect(isObservedCompletionTransition({ previousState: 'succeeded', nextState: 'succeeded' })).toBe(false);
        // A terminal failure is not the success moment.
        expect(isObservedCompletionTransition({ previousState: 'running', nextState: 'failed' })).toBe(false);
    });

    it('describes a direct Run without inventing a Session it does not have', () => {
        const withoutSession = createWorkflowRunSummaryFixture({ origin: { kind: 'direct' } });
        const withSession = createWorkflowRunSummaryFixture({
            origin: { kind: 'direct', originSessionId: 'session-1' },
        });

        expect(withoutSession.origin.kind).toBe('direct');
        expect(withSession.origin).toMatchObject({ originSessionId: 'session-1' });
    });

    it('offers reattach only for a canonically surviving selected input', () => {
        const run = createWorkflowRunSummaryFixture({
            state: 'interrupted',
            availability: {   },
        });
        const execution = {
            kind: 'session' as const,
            sessionId: 'session-1',
            localInputId: 'input-1',
        };
        const unavailable = { kind: 'unavailable' as const, reason: 'invocation_not_recoverable' as const };

        expect(canOfferWorkflowInvocationReattach({
            run,
            invocation: createWorkflowInvocationIndexFixture({ lifecycle: 'running' }),
            progress: {
                kind: 'happier.workflow-progress.v1',
                invocationPath: { blockId: 'analyze', scope: [] },
                blockKind: 'step',
                attempt: '0',
                logicalInvocationRecordId: 'invocation-1',
                execution,
            },
            recoveryAvailability: { restoreWorkspace: { kind: 'unavailable' as const, reason: 'recovery_not_prepared' as const },
                reattach: { kind: 'available' }, retry: unavailable,
                continueSameConversation: unavailable, continueFreshAgent: unavailable,
            },
        })).toBe(true);

        // Recovery availability also covers continuation with a stopped input;
        // it must not be treated as evidence that the old input can reattach.
        expect(canOfferWorkflowInvocationReattach({
            run,
            invocation: createWorkflowInvocationIndexFixture({ lifecycle: 'failed' }),
            progress: {
                kind: 'happier.workflow-progress.v1',
                invocationPath: { blockId: 'analyze', scope: [] },
                blockKind: 'step',
                attempt: '0',
                logicalInvocationRecordId: 'invocation-1',
                execution,
            },
            recoveryAvailability: { restoreWorkspace: { kind: 'unavailable' as const, reason: 'recovery_not_prepared' as const },
                reattach: unavailable, retry: { kind: 'available', causalInvocationIds: ['invocation-1'] },
                continueSameConversation: unavailable, continueFreshAgent: unavailable,
            },
        })).toBe(false);

        // Fresh-agent continuation starts a different execution. It never
        // proves the old input survived and therefore cannot expose Reattach.
        expect(canOfferWorkflowInvocationReattach({
            run: createWorkflowRunSummaryFixture({
                state: 'interrupted',
                availability: {   },
            }),
            invocation: createWorkflowInvocationIndexFixture({ lifecycle: 'running' }),
            progress: {
                kind: 'happier.workflow-progress.v1',
                invocationPath: { blockId: 'analyze', scope: [] },
                blockKind: 'step',
                attempt: '0',
                logicalInvocationRecordId: 'invocation-1',
                execution,
            },
            recoveryAvailability: { restoreWorkspace: { kind: 'unavailable' as const, reason: 'recovery_not_prepared' as const },
                reattach: unavailable, retry: unavailable,
                continueSameConversation: unavailable, continueFreshAgent: { kind: 'available' },
            },
        })).toBe(false);
    });

    it('projects recovery actions from the exact selected row instead of broad Run availability', () => {
        const run = createWorkflowRunSummaryFixture({
            state: 'interrupted',
            availability: {



                inspectExecution: true,
            },
        });
        const progress = {
            kind: 'happier.workflow-progress.v1' as const,
            invocationPath: { blockId: 'analyze', scope: [] },
            blockKind: 'step' as const,
            attempt: '0',
            logicalInvocationRecordId: 'invocation-1',
            execution: { kind: 'session' as const, sessionId: 'session-1', localInputId: 'input-1' },
            workspace: {
                descriptor: {
                    machineId: 'machine-1',
                    directory: '/Users/alice/project',
                    checkoutRootPath: '/Users/alice/project',
                    workspaceRefId: 'workspace-1',
                    checkout: { kind: 'git_worktree' as const, branchName: 'workflow/analyze' },
                },
            },
        };
        const unavailable = { kind: 'unavailable' as const, reason: 'invocation_not_recoverable' as const };

        const active = projectWorkflowInvocationRecovery({
            run,
            invocation: createWorkflowInvocationIndexFixture({ lifecycle: 'running' }),
            progress,
            recoveryAvailability: { restoreWorkspace: { kind: 'unavailable' as const, reason: 'recovery_not_prepared' as const },
                reattach: { kind: 'available' }, retry: unavailable,
                continueSameConversation: unavailable, continueFreshAgent: unavailable,
            },
            machineHomeDirectory: '/Users/alice',
        });
        expect(active).toMatchObject({
            canInspectExecution: true,
            canReattach: true,
            canRetrySameConversation: false,
            canRetryFreshAgent: false,
            waitingForStop: false,
            workspaceUnavailable: false,
            workspace: {
                directory: '/Users/alice/project',
                displayDirectory: '~/project',
                workspaceRefId: 'workspace-1',
                branchName: 'workflow/analyze',
            },
            unavailableReasons: {
                retry: 'invocation_not_recoverable',
                continueSameConversation: 'invocation_not_recoverable',
            },
        });

        const stopped = projectWorkflowInvocationRecovery({
            run,
            invocation: createWorkflowInvocationIndexFixture({ id: 'selected', parentRecordId: 'parent', lifecycle: 'failed' }),
            progress: { ...progress, execution: undefined },
            recoveryAvailability: { restoreWorkspace: { kind: 'unavailable' as const, reason: 'recovery_not_prepared' as const },
                reattach: unavailable, retry: { kind: 'available', causalInvocationIds: ['selected'] },
                continueSameConversation: unavailable, continueFreshAgent: { kind: 'available' },
            },
            machineHomeDirectory: '/Users/alice',
            invocationHistoryComplete: true,
            invocations: [
                createWorkflowInvocationIndexFixture({ id: 'selected', parentRecordId: 'parent', lifecycle: 'failed' }),
                createWorkflowInvocationIndexFixture({ id: 'waiting', parentRecordId: 'parent', lifecycle: 'pending' }),
                createWorkflowInvocationIndexFixture({ id: 'other-parent', parentRecordId: null, lifecycle: 'pending' }),
            ],
        });
        expect(stopped).toMatchObject({
            canInspectExecution: false,
            canReattach: false,
            canRetrySameConversation: false,
            canRetryFreshAgent: true,
            retryCausalInvocationIds: ['selected'],
            remainingNotStartedSiblingCount: 1,
        });

        // Run-level retry availability never makes an unrelated completed row retryable.
        expect(projectWorkflowInvocationRecovery({
            run,
            invocation: createWorkflowInvocationIndexFixture({ lifecycle: 'completed' }),
            progress,
            recoveryAvailability: { restoreWorkspace: { kind: 'unavailable' as const, reason: 'recovery_not_prepared' as const },
                reattach: unavailable, retry: unavailable,
                continueSameConversation: unavailable, continueFreshAgent: unavailable,
            },
            machineHomeDirectory: '/Users/alice',
        })).toMatchObject({ canRetrySameConversation: false, canRetryFreshAgent: false });
    });

    it('offers each retry conversation only when its exact owner decision permits it', () => {
        const unavailable = { kind: 'unavailable' as const, reason: 'recovery_not_prepared' as const };
        const params = {
            run: createWorkflowRunSummaryFixture({ state: 'interrupted' }),
            invocation: createWorkflowInvocationIndexFixture({ lifecycle: 'failed' }),
            progress: null,
            machineHomeDirectory: null,
        };

        expect(projectWorkflowInvocationRecovery({
            ...params,
            recoveryAvailability: { restoreWorkspace: { kind: 'unavailable' as const, reason: 'recovery_not_prepared' as const },
                reattach: unavailable,
                retry: { kind: 'available', causalInvocationIds: ['invocation-1'] },
                continueSameConversation: { kind: 'available' },
                continueFreshAgent: unavailable,
            },
        })).toMatchObject({ canRetrySameConversation: true, canRetryFreshAgent: false });
        expect(projectWorkflowInvocationRecovery({
            ...params,
            recoveryAvailability: { restoreWorkspace: { kind: 'unavailable' as const, reason: 'recovery_not_prepared' as const },
                reattach: unavailable,
                retry: unavailable,
                continueSameConversation: { kind: 'available' },
                continueFreshAgent: { kind: 'available' },
            },
        })).toMatchObject({ canRetrySameConversation: false, canRetryFreshAgent: false });
    });

    /**
     * The real `workflow.run.invocations.get` answers a failed Action, or an interrupted root, If or loop
     * frame, with Retry available and both Agent-conversation choices `recovery_not_prepared`. Retry for
     * these is an ordinary repeat of the original input, never a conversation choice (RV-FIX208-A1).
     */
    it.each([
        ['a failed Action', 'action', 'failed'],
        ['an interrupted root', 'root', 'needs_attention'],
        ['an interrupted If frame', 'if', 'failed'],
        ['an interrupted loop frame', 'loop', 'failed'],
        ['a failed workflow call', 'workflow', 'failed'],
    ] as const)('offers a plain Retry for %s with the returned causal set and no conversation choice', (_label, blockKind, lifecycle) => {
        const notPrepared = { kind: 'unavailable' as const, reason: 'recovery_not_prepared' as const };
        const causalInvocationIds = ['parent-frame', 'selected'];
        const presentation = projectWorkflowInvocationRecovery({
            run: createWorkflowRunSummaryFixture({ state: 'interrupted' }),
            invocation: createWorkflowInvocationIndexFixture({ id: 'selected', lifecycle }),
            progress: WorkflowProgressEnvelopeV1Schema.parse({
                kind: 'happier.workflow-progress.v1', blockKind, attempt: '0', logicalInvocationRecordId: 'selected',
                invocationPath: { blockId: blockKind === 'root' ? '$root' : 'projector', scope: [] },
            }),
            recoveryAvailability: {
                reattach: { kind: 'unavailable', reason: 'invocation_not_recoverable' },
                retry: { kind: 'available', causalInvocationIds },
                continueSameConversation: notPrepared, continueFreshAgent: notPrepared, restoreWorkspace: notPrepared,
            },
            machineHomeDirectory: null,
        });
        expect(presentation).toMatchObject({
            canRetry: true,
            canRetrySameConversation: false,
            canRetryFreshAgent: false,
            retryCausalInvocationIds: causalInvocationIds,
        });
    });

    it('keeps an Agent step on its conversation choices and withholds a plain Retry from it', () => {
        const available = { kind: 'available' as const };
        const notPrepared = { kind: 'unavailable' as const, reason: 'recovery_not_prepared' as const };
        const presentation = projectWorkflowInvocationRecovery({
            run: createWorkflowRunSummaryFixture({ state: 'interrupted' }),
            invocation: createWorkflowInvocationIndexFixture({ id: 'selected', lifecycle: 'failed' }),
            progress: WorkflowProgressEnvelopeV1Schema.parse({
                kind: 'happier.workflow-progress.v1', blockKind: 'step', attempt: '0', logicalInvocationRecordId: 'selected',
                invocationPath: { blockId: 'analyze', scope: [] },
            }),
            recoveryAvailability: {
                reattach: { kind: 'unavailable', reason: 'invocation_not_recoverable' },
                retry: { kind: 'available', causalInvocationIds: ['selected'] },
                continueSameConversation: notPrepared, continueFreshAgent: available, restoreWorkspace: notPrepared,
            },
            machineHomeDirectory: null,
        });
        expect(presentation).toMatchObject({ canRetry: false, canRetryFreshAgent: true, canRetrySameConversation: false });
    });

    it.each(['action', 'if', 'loop'] as const)('offers no Retry for a %s whose owner answer is unavailable', blockKind => {
        const notRecoverable = { kind: 'unavailable' as const, reason: 'invocation_not_recoverable' as const };
        const presentation = projectWorkflowInvocationRecovery({
            run: createWorkflowRunSummaryFixture({ state: 'interrupted' }),
            invocation: createWorkflowInvocationIndexFixture({ id: 'selected', lifecycle: 'completed' }),
            progress: WorkflowProgressEnvelopeV1Schema.parse({
                kind: 'happier.workflow-progress.v1', blockKind, attempt: '0', logicalInvocationRecordId: 'selected',
                invocationPath: { blockId: 'projector', scope: [] },
            }),
            recoveryAvailability: {
                reattach: notRecoverable, retry: notRecoverable, continueSameConversation: notRecoverable,
                continueFreshAgent: notRecoverable, restoreWorkspace: notRecoverable,
            },
            machineHomeDirectory: null,
        });
        expect(presentation).toMatchObject({ canRetry: false, retryCausalInvocationIds: [] });
    });

    it('offers a prepared continuation only for its exact eligible conversation', () => {
        const unavailable = { kind: 'unavailable' as const, reason: 'recovery_not_prepared' as const };
        const params = {
            run: createWorkflowRunSummaryFixture({ state: 'interrupted' }),
            invocation: createWorkflowInvocationIndexFixture({ lifecycle: 'failed' }),
            progress: {
                kind: 'happier.workflow-progress.v1' as const,
                invocationPath: { blockId: 'analyze', scope: [] },
                blockKind: 'step' as const,
                attempt: '0',
                logicalInvocationRecordId: 'invocation-1',
                recovery: { conversation: 'same_conversation' as const, input: { kind: 'original' as const } },
            },
            machineHomeDirectory: null,
            recoveryAvailability: { restoreWorkspace: { kind: 'unavailable' as const, reason: 'recovery_not_prepared' as const },
                reattach: unavailable, retry: unavailable,
                continueSameConversation: unavailable, continueFreshAgent: { kind: 'available' as const },
            },
        };

        expect(projectWorkflowInvocationRecovery(params).canContinuePrepared).toBe(false);
        expect(projectWorkflowInvocationRecovery({
            ...params,
            progress: { ...params.progress, recovery: { ...params.progress.recovery, conversation: 'fresh_agent' } },
        }).canContinuePrepared).toBe(true);
        expect(projectWorkflowInvocationRecovery({ ...params, progress: null }).canContinuePrepared).toBe(false);
    });

    it('keeps possibly active work blocked and treats a missing workspace as a distinct recovery fact', () => {
        const run = createWorkflowRunSummaryFixture({
            state: 'interrupted',
            workflowCustodyState: 'pending',
            availability: {    },
        });
        const projection = projectWorkflowInvocationRecovery({
            run,
            invocation: createWorkflowInvocationIndexFixture({ lifecycle: 'outcome_uncertain' }),
            progress: {
                kind: 'happier.workflow-progress.v1',
                invocationPath: { blockId: 'analyze', scope: [] },
                blockKind: 'step', attempt: '0', logicalInvocationRecordId: 'invocation-1',
                reason: { code: 'workspace_unavailable' },
            },
            machineHomeDirectory: null,
        });

        expect(projection).toMatchObject({
            waitingForStop: true,
            workspaceUnavailable: true,
            workspace: null,
            canReattach: false,
            canRetrySameConversation: false,
            canRetryFreshAgent: false,
        });

        expect(projectWorkflowInvocationRecovery({
            run,
            invocation: createWorkflowInvocationIndexFixture({ lifecycle: 'failed' }),
            progress: {
                kind: 'happier.workflow-progress.v1',
                invocationPath: { blockId: 'analyze', scope: [] },
                blockKind: 'step', attempt: '0', logicalInvocationRecordId: 'invocation-1',
                reason: { code: 'conversation_workspace_mismatch' },
            },
            machineHomeDirectory: null,
        })).toMatchObject({ workspaceUnavailable: true, canRetrySameConversation: false });
    });

    it('offers workspace restoration only from the exact owner decision', () => {
        const invocation = createWorkflowInvocationIndexFixture({ lifecycle: 'failed' });
        const restorableProgress = {
            kind: 'happier.workflow-progress.v1' as const,
            invocationPath: { blockId: 'analyze', scope: [] },
            blockKind: 'step' as const,
            attempt: '0',
            logicalInvocationRecordId: invocation.id,
            reason: { code: 'workspace_unavailable' },
            workspace: {
                creationIntent: {
                    kind: 'git_worktree' as const,
                    sourceDirectory: '/Users/alice/project',
                    baseRef: 'a'.repeat(40),
                    displayName: 'workflow-analyze',
                    branchMode: 'new' as const,
                },
                descriptor: {
                    machineId: 'machine-1',
                    directory: '/Users/alice/project/.worktrees/workflow-analyze',
                    checkoutRootPath: '/Users/alice/project/.worktrees/workflow-analyze',
                    checkout: { kind: 'git_worktree' as const, branchName: 'workflow-analyze' },
                },
            },
        };
        const run = createWorkflowRunSummaryFixture({
            state: 'interrupted',
            availability: { restoreWorkspace: true },
        });
        const unavailable = { kind: 'unavailable' as const, reason: 'stop_pending' as const };
        const recoveryAvailability = {
            reattach: unavailable, retry: unavailable,
            continueSameConversation: unavailable, continueFreshAgent: unavailable,
            restoreWorkspace: { kind: 'available' as const },
        };

        expect(projectWorkflowInvocationRecovery({
            run, invocation, progress: restorableProgress, recoveryAvailability,
            machineHomeDirectory: '/Users/alice',
        }).canRestoreWorkspace).toBe(true);
        expect(projectWorkflowInvocationRecovery({
            run, invocation, progress: restorableProgress,
            recoveryAvailability: { ...recoveryAvailability, restoreWorkspace: unavailable },
            machineHomeDirectory: '/Users/alice',
        }).canRestoreWorkspace).toBe(false);
        expect(projectWorkflowInvocationRecovery({
            run, invocation, progress: restorableProgress,
            recoveryAvailability: undefined,
            machineHomeDirectory: '/Users/alice',
        }).canRestoreWorkspace).toBe(false);
    });

    /**
     * D4 offers exactly one of two things. Restoring resumes the same Run and
     * keeps its completed work; a reviewed new whole Run repeats it. Offering
     * both at once asked the person to choose between recovering and repeating
     * without saying that one of them was strictly better.
     */
    it('offers a reviewed new Run only when same-Run restoration is impossible', () => {
        const invocation = createWorkflowInvocationIndexFixture({ lifecycle: 'failed' });
        const restorableProgress = {
            kind: 'happier.workflow-progress.v1' as const,
            invocationPath: { blockId: 'analyze', scope: [] },
            blockKind: 'step' as const,
            attempt: '0',
            logicalInvocationRecordId: invocation.id,
            reason: { code: 'workspace_unavailable' },
            workspace: {
                creationIntent: {
                    kind: 'git_worktree' as const,
                    sourceDirectory: '/Users/alice/project',
                    baseRef: 'a'.repeat(40),
                    displayName: 'workflow-analyze',
                    branchMode: 'new' as const,
                },
                descriptor: {
                    machineId: 'machine-1',
                    directory: '/Users/alice/project/.worktrees/workflow-analyze',
                    checkoutRootPath: '/Users/alice/project/.worktrees/workflow-analyze',
                    checkout: { kind: 'git_worktree' as const, branchName: 'workflow-analyze' },
                },
            },
        };
        const run = createWorkflowRunSummaryFixture({
            state: 'interrupted',
            // Settled custody is exactly the state in which both offers were
            // live together: nothing is waiting for a stop to be confirmed.
            workflowCustodyState: 'settled',
            availability: { restoreWorkspace: true },
        });
        const unavailable = { kind: 'unavailable' as const, reason: 'workspace_unavailable' as const };
        const recoveryAvailability = {
            reattach: unavailable, retry: unavailable,
            continueSameConversation: unavailable, continueFreshAgent: unavailable,
            restoreWorkspace: { kind: 'available' as const },
        };

        const restorable = projectWorkflowInvocationRecovery({
            run, invocation, progress: restorableProgress, recoveryAvailability,
            machineHomeDirectory: '/Users/alice',
        });
        expect(restorable).toMatchObject({ canRestoreWorkspace: true, canStartReviewedNewRun: false });

        // No restoration producer: the only truthful offer left is a reviewed
        // new whole Run.
        const unrestorable = projectWorkflowInvocationRecovery({
            run,
            invocation,
            progress: { ...restorableProgress, workspace: { descriptor: restorableProgress.workspace.descriptor } },
            recoveryAvailability: { ...recoveryAvailability, restoreWorkspace: unavailable },
            machineHomeDirectory: '/Users/alice',
        });
        expect(unrestorable).toMatchObject({ canRestoreWorkspace: false, canStartReviewedNewRun: true });

        // Every workspace-unavailable reason reaches the same pair of offers.
        expect(projectWorkflowInvocationRecovery({
            run,
            invocation,
            progress: {
                ...restorableProgress,
                reason: { code: 'source_workspace_unavailable' },
                workspace: { descriptor: restorableProgress.workspace.descriptor },
            },
            recoveryAvailability: { ...recoveryAvailability, restoreWorkspace: unavailable },
            machineHomeDirectory: '/Users/alice',
        })).toMatchObject({ canRestoreWorkspace: false, canStartReviewedNewRun: true });
    });

    it('withholds the reviewed new Run while the previous input may still be running', () => {
        const run = createWorkflowRunSummaryFixture({
            state: 'interrupted',
            workflowCustodyState: 'pending',
            availability: { restoreWorkspace: true },
        });

        const projection = projectWorkflowInvocationRecovery({
            run,
            invocation: createWorkflowInvocationIndexFixture({ lifecycle: 'outcome_uncertain' }),
            progress: {
                kind: 'happier.workflow-progress.v1',
                invocationPath: { blockId: 'analyze', scope: [] },
                blockKind: 'step', attempt: '0', logicalInvocationRecordId: 'invocation-1',
                reason: { code: 'workspace_unavailable' },
            },
            machineHomeDirectory: null,
        });

        expect(projection).toMatchObject({
            waitingForStop: true,
            canRestoreWorkspace: false,
            canStartReviewedNewRun: false,
        });
    });

    it('offers no reviewed new Run when the workspace is fine', () => {
        expect(projectWorkflowInvocationRecovery({
            run: createWorkflowRunSummaryFixture({ state: 'interrupted' }),
            invocation: createWorkflowInvocationIndexFixture({ lifecycle: 'failed' }),
            progress: null,
            machineHomeDirectory: null,
        })).toMatchObject({ workspaceUnavailable: false, canStartReviewedNewRun: false });
    });

    it('projects the exact source invocation identity for iteration-safe workspace display', () => {
        const progress = {
            kind: 'happier.workflow-progress.v1' as const,
            invocationPath: { blockId: 'implement', scope: [] },
            blockKind: 'step' as const,
            attempt: '0',
            logicalInvocationRecordId: 'invocation-2',
            workspace: { descriptor: {
                machineId: 'machine-1',
                directory: '/worktrees/implement',
                checkoutRootPath: '/worktrees/implement',
                sourceInvocation: {
                    producer: { blockId: 'analyze', scope: { kind: 'current' as const } },
                    invocationRecordId: 'inv-analyze-iteration-7',
                },
            } },
        };

        expect(projectWorkflowInvocationRecovery({
            run: createWorkflowRunSummaryFixture(),
            invocation: createWorkflowInvocationIndexFixture(),
            progress,
            machineHomeDirectory: null,
        }).workspace).toMatchObject({
            sourceBlockId: 'analyze',
            sourceInvocationRecordId: 'inv-analyze-iteration-7',
        });
        expect(formatWorkflowWorkspaceSourceLabel('Analyze', 'inv-analyze-iteration-7'))
            .toBe('Analyze · inv-analyze-iteration-7');
    });

    /**
     * A waiting or skipped row states its cause from the canonical facts only:
     * the lifecycle and the coordinator's closed reason code. Anything else
     * states nothing rather than a guess.
     */
    it('states a waiting or skipped cause only from its canonical facts', () => {
        expect(describeWorkflowInvocationCause({
            lifecycle: 'skipped', reasonCode: 'condition_false', blockLabel: 'Analyze',
        })).toBe(t('workflows.condition.skippedReason', { block: 'Analyze' }));
        expect(describeWorkflowInvocationCause({
            lifecycle: 'waiting_for_capacity', reasonCode: null, blockLabel: 'Analyze',
        })).toBe(t('workflows.run.capacityOccupied'));
        // A skip for another reason, or one whose block cannot be named, says nothing invented.
        expect(describeWorkflowInvocationCause({
            lifecycle: 'skipped', reasonCode: 'something_else', blockLabel: 'Analyze',
        })).toBeNull();
        expect(describeWorkflowInvocationCause({
            lifecycle: 'skipped', reasonCode: 'condition_false', blockLabel: null,
        })).toBeNull();
        expect(describeWorkflowInvocationCause({
            lifecycle: 'running', reasonCode: null, blockLabel: 'Analyze',
        })).toBeNull();
    });

    /**
     * An uncertain step says what that means for its kind (07 §6.2): an Agent step may already have
     * changed the workspace, an Action may have run without Happier getting its answer. A plain failed
     * step keeps stating nothing invented.
     */
    it('states an uncertain step by its kind and never for a plain failed step', () => {
        expect(describeWorkflowInvocationCause({
            lifecycle: 'outcome_uncertain', reasonCode: 'workflow_startup_owner_absent', blockKind: 'step', blockLabel: 'ONE',
        })).toBe(t('workflows.recovery.uncertainEffects', { block: 'ONE' }));
        expect(describeWorkflowInvocationCause({
            lifecycle: 'outcome_uncertain', reasonCode: null, blockKind: 'action', blockLabel: 'Open pull request',
        })).toBe(t('workflows.recovery.uncertainAction', { action: 'Open pull request' }));
        expect(describeWorkflowInvocationCause({
            lifecycle: 'failed', reasonCode: 'workflow_startup_owner_absent', blockKind: 'step', blockLabel: 'ONE',
        })).toBeNull();
        // A block that cannot be named is not guessed at.
        expect(describeWorkflowInvocationCause({
            lifecycle: 'outcome_uncertain', reasonCode: null, blockKind: 'step', blockLabel: null,
        })).toBeNull();
    });

    it('keeps Machine availability separate from the canonical Run outcome', () => {
        const coverage = summarizeWorkflowInvocationCoverage([], { kindsByInvocationId: new Map(), historyComplete: false });
        const running = createWorkflowRunSummaryFixture({ state: 'running' });
        expect(formatWorkflowRunOutcomeSentence({
            run: running, coverage, machine: { name: 'Mac Studio', reachable: false },
        })).toBe(formatWorkflowRunOutcomeSentence({ run: running, coverage }));
        expect(formatWorkflowRunOutcomeSentence({
            run: running, coverage, machine: { name: 'Mac Studio', reachable: true },
        })).toBe(formatWorkflowRunOutcomeSentence({ run: running, coverage }));
        // A settled Run's outcome is not about the Machine any more.
        const done = createWorkflowRunSummaryFixture({ state: 'succeeded' });
        expect(formatWorkflowRunOutcomeSentence({
            run: done, coverage, machine: { name: 'Mac Studio', reachable: false },
        })).toBe(formatWorkflowRunOutcomeSentence({ run: done, coverage }));
    });

    it('uses the Wait detail sentence for the default step name without repeating the state', () => {
        const run = createWorkflowRunSummaryFixture({ state: 'waiting_for_review' });
        const coverage = summarizeWorkflowInvocationCoverage([], { kindsByInvocationId: new Map(), historyComplete: false });
        expect(formatWorkflowRunOutcomeSentence({ run, coverage, attention: {
            step: t('workflows.page.blocks.waitTitle'), waitForYou: true,
        } })).toBe(t('workflows.review.waitBody'));
        // The parked Run's word already says it waits ("Waiting for you —"), so the sentence only names the step.
        expect(formatWorkflowRunOutcomeSentence({ run, coverage, attention: {
            step: 'Check the release', waitForYou: true,
        } })).toBe(t('workflows.run.attentionParkedSentence', { step: 'Check the release' }));
        // A Run still working elsewhere leads with "Running", so the sentence says what waits (lab run-A).
        expect(formatWorkflowRunOutcomeSentence({ run: { ...run, state: 'running' }, coverage, attention: {
            step: 'Write changelog', waitForYou: false,
        } })).toBe(t('workflows.run.attentionReviewSentence', { step: 'Write changelog' }));
    });

    it('says only that a parked Run waits until its held step is known (DESIGN-16 D10)', () => {
        const run = createWorkflowRunSummaryFixture({ state: 'waiting_for_review' });
        const coverage = summarizeWorkflowInvocationCoverage([], { kindsByInvocationId: new Map(), historyComplete: false });
        const word = formatWorkflowRunOutcomeLabel({ state: run.state, coverage, inAttentionWindow: false });
        const line = formatWorkflowRunOutcomeLine({ word, sentence: formatWorkflowRunOutcomeSentence({ run, coverage, attention: null }) });
        // One idea once, with no step to name yet: never "Waiting for your review — Needs you".
        expect(line).toBe(t('workflows.review.waitTitle'));
    });

    it('presents a claimed Run with a known hold through attention while preserving terminal parent authority', () => {
        const coverage = { observedLeafCounts: { completed: 0, failed: 0, attention: 1 }, coverage: 'complete' as const, knownFailure: false };
        expect(describeWorkflowRunState('claimed', { inAttentionWindow: true }))
            .toMatchObject({ state: 'claimed', variant: 'attention', marker: { kind: 'icon', icon: 'hand' }, terminal: false });
        expect(describeWorkflowRunState('running', { inAttentionWindow: true }).marker.kind).toBe('activity');
        expect(formatWorkflowRunOutcomeLabel({ state: 'claimed', coverage, inAttentionWindow: true, waitingOnlyForYou: true }))
            .toBe(t('workflows.review.waitTitle'));
        expect(formatWorkflowRunOutcomeSentence({ run: createWorkflowRunSummaryFixture({ state: 'claimed' }),
            coverage, attention: { step: 'Check the release', waitForYou: true } }))
            .toBe(t('workflows.run.attentionParkedSentence', { step: 'Check the release' }));
        expect(formatWorkflowRunOutcomeLabel({ state: 'claimed', coverage: {
            ...coverage, observedLeafCounts: { completed: 1, failed: 0, attention: 0 },
        } })).toBe(t('workflows.runState.running'));
    });

    it('describes known Agent review attention without parking concurrent work or guessing a terminal parent', () => {
        const coverage = { observedLeafCounts: { completed: 0, failed: 0, attention: 1 }, coverage: 'partial' as const, knownFailure: false };
        // The public attention window is membership evidence; a review hold is
        // not a Wait-for-you block and does not make a running parent parked.
        for (const state of ['queued', 'claimed'] as const) {
            expect(formatWorkflowRunOutcomeLabel({ state, coverage, inAttentionWindow: true, waitingOnlyForYou: false }))
                .toBe(t('workflows.runState.waiting_for_review'));
        }
        expect(formatWorkflowRunOutcomeLabel({ state: 'running', coverage, inAttentionWindow: true }))
            .toBe(t('workflows.runState.running'));
        expect(formatWorkflowRunOutcomeLabel({ state: 'succeeded', coverage, inAttentionWindow: true }))
            .toBe(t('workflows.runState.succeeded'));
    });
});
