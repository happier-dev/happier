import { describe, expect, it } from 'vitest';
import { WorkflowProgressEnvelopeV1Schema } from '@happier-dev/protocol';

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
    formatWorkflowWorkspaceSourceLabel,
    isObservedCompletionTransition,
    projectWorkflowInvocationRecovery,
} from './workflowRunDetailPresentation';

describe('managed workflow Run presentation', () => {
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
        expect(describeWorkflowRunState('interrupted').variant).toBe('warning');
        expect(describeWorkflowInvocationLifecycle('waiting_for_approval').variant).toBe('warning');
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

    it('says an active Run lost contact only while its Machine is known unreachable', () => {
        const coverage = summarizeWorkflowInvocationCoverage([], { kindsByInvocationId: new Map(), historyComplete: false });
        const running = createWorkflowRunSummaryFixture({ state: 'running' });
        expect(formatWorkflowRunOutcomeSentence({
            run: running, coverage, machine: { name: 'Mac Studio', reachable: false },
        })).toBe(t('workflows.run.machineUnavailable', { machine: 'Mac Studio' }));
        expect(formatWorkflowRunOutcomeSentence({
            run: running, coverage, machine: { name: 'Mac Studio', reachable: true },
        })).toBe(formatWorkflowRunOutcomeSentence({ run: running, coverage }));
        // A settled Run's outcome is not about the Machine any more.
        const done = createWorkflowRunSummaryFixture({ state: 'succeeded' });
        expect(formatWorkflowRunOutcomeSentence({
            run: done, coverage, machine: { name: 'Mac Studio', reachable: false },
        })).toBe(formatWorkflowRunOutcomeSentence({ run: done, coverage }));
    });
});
