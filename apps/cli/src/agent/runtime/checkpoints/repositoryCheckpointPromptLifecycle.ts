import { randomUUID } from 'node:crypto';
import type { CheckpointCodeRollbackRequest, CheckpointCodeRollbackResult, ToolNormalizationProtocol, TurnChangeSet } from '@happier-dev/protocol';

import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { ACPProvider } from '@/api/session/sessionMessageTypes';
import { publishRuntimeTurnChangeSet, RuntimeTranscriptRequiredAdmissionError, type RuntimeTurnChangeSetPublication } from '@/agent/runtime/session/transcripts/projectRuntimeTranscriptEvent';
import type { PromptLoopCheckpointLifecycle } from '@/agent/runtime/runPermissionModePromptLoop';
import type { ScmBackendContext } from '@/scm/types';
import { buildRepositoryCheckpointRefs, projectRepositoryCheckpointTurnChangeSet } from '@/scm/checkpoints';
import { createGitCheckpointRollbackDependencies, gitCheckpointAdapter, resolveGitCheckpointBackendContext } from '@/scm/checkpoints/gitCheckpointAdapter';
import { executeCheckpointCodeRollback } from '@/scm/checkpoints/rollback';
import { retainRepositoryCheckpointInitialEvidence, retainRepositoryCheckpointTurnEvidence } from '@/scm/checkpoints/sessionEvidence';
import type {
    RepositoryCheckpointAttributionScope,
    RepositoryCheckpointDiffBaseRefSource,
    RepositoryCheckpointDiffResult,
    RepositoryCheckpointReceipt,
    RepositoryCheckpointRefs,
    RepositoryCheckpointTurnProjectionUnavailableReason,
} from '@/scm/checkpoints';
import { logger } from '@/ui/logger';
import { defaultWorktreeAttributionRegistry } from './worktreeAttributionRegistry';
import type { WorktreeAttributionInterval, WorktreeAttributionRegistry } from './worktreeAttributionRegistry';

type ActiveCheckpointBinding = Readonly<{
    scopeId: string;
    context?: ScmBackendContext;
    repoRoot?: string;
    refs: RepositoryCheckpointRefs;
    receipts: readonly RepositoryCheckpointReceipt[];
    unavailableReason?: RepositoryCheckpointTurnProjectionUnavailableReason;
    unavailableError?: string;
    attributionInterval?: WorktreeAttributionInterval;
    startSequence?: number;
    finalSequence?: number;
    turnId?: string;
    publication?: RuntimeTurnChangeSetPublication;
}>;

type RepositoryCheckpointPromptLifecycle = PromptLoopCheckpointLifecycle & Readonly<{
    publishTurnChangeSet: (publication: RuntimeTurnChangeSetPublication) => Promise<void>;
}>;

function buildScopeId(params: Readonly<{
    sessionId: string;
    repoRoot: string;
}>): string {
    return `${params.sessionId}:${params.repoRoot}`;
}

async function resolveGitCheckpointContext(input: Readonly<{
    runtimeDirectory: string;
    sessionId: string;
}>): Promise<ActiveCheckpointBinding> {
    const context = await resolveGitCheckpointBackendContext({
        cwd: input.runtimeDirectory,
        workingDirectory: input.runtimeDirectory,
    });
    const unavailableBinding = (reason: RepositoryCheckpointTurnProjectionUnavailableReason, message: string): ActiveCheckpointBinding => ({
        scopeId: buildScopeId({
            sessionId: input.sessionId,
            repoRoot: input.runtimeDirectory,
        }),
        refs: buildRepositoryCheckpointRefs({
            scopeId: buildScopeId({
                sessionId: input.sessionId,
                repoRoot: input.runtimeDirectory,
            }),
        }),
        receipts: [],
        unavailableReason: reason,
        unavailableError: message,
    });
    if (!context) {
        return unavailableBinding('not_repo', 'Repository checkpoint capture is unavailable outside a source-control repository.');
    }
    if (context.detection.mode !== '.git') {
        return unavailableBinding('unsupported_scm', 'Repository checkpoint capture is currently available for Git repositories only.');
    }
    if (!context.detection.rootPath) {
        return unavailableBinding('missing_repo_root', 'Repository checkpoint capture requires a resolved Git repository root.');
    }
    const scopeId = buildScopeId({
        sessionId: input.sessionId,
        repoRoot: context.detection.rootPath,
    });
    return {
        scopeId,
        context,
        repoRoot: context.detection.rootPath,
        refs: buildRepositoryCheckpointRefs({
            scopeId,
        }),
        receipts: [],
    };
}

function appendReceipts(
    existing: readonly RepositoryCheckpointReceipt[],
    next: readonly RepositoryCheckpointReceipt[],
): readonly RepositoryCheckpointReceipt[] {
    return [...existing, ...next];
}

export function createRepositoryCheckpointCodeRollback(params: Readonly<{
    session: Pick<ApiSessionClient, 'sessionId'>;
    runtimeDirectory: string;
}>): (request: CheckpointCodeRollbackRequest) => Promise<CheckpointCodeRollbackResult> {
    return async (request) => {
        if (request.sessionId !== params.session.sessionId) {
            return {
                status: 'unavailable', changedPaths: [], skippedPaths: [],
                receipts: ['checkpoint.rollback_aborted'], diagnostics: ['checkpoint_rollback_session_mismatch'],
            };
        }
        const binding = await resolveGitCheckpointContext({
            runtimeDirectory: params.runtimeDirectory,
            sessionId: params.session.sessionId,
        });
        if (!binding.context) {
            return {
                status: 'unavailable', changedPaths: [], skippedPaths: [],
                receipts: ['checkpoint.rollback_aborted'],
                diagnostics: [binding.unavailableReason ?? 'not_repo', binding.unavailableError ?? 'Repository checkpoint rollback is unavailable.'],
            };
        }
        return await executeCheckpointCodeRollback({
            request,
            conversationRollbackSupported: false,
            deps: createGitCheckpointRollbackDependencies({ context: binding.context, rollbackId: randomUUID() }),
        });
    };
}

function buildUnavailableDiffResult(input: Readonly<{
    reason: RepositoryCheckpointTurnProjectionUnavailableReason;
    error: string;
    baseRefSource: RepositoryCheckpointDiffBaseRefSource;
    attributionScope: RepositoryCheckpointAttributionScope;
    receipts: readonly RepositoryCheckpointReceipt[];
}>): RepositoryCheckpointDiffResult {
    return {
        success: false,
        kind: 'unavailable',
        reason: input.reason,
        error: input.error,
        baseRefSource: input.baseRefSource,
        contentConfidence: 'unavailable',
        attributionScope: input.attributionScope,
        receipts: input.receipts,
    };
}

export function createRepositoryCheckpointPromptLifecycle(params: Readonly<{
    session: ApiSessionClient;
    runtimeDirectory: string;
    provider: ACPProvider;
    protocol: ToolNormalizationProtocol;
    attributionRegistry?: WorktreeAttributionRegistry;
    sessionIsNew?: boolean;
}>): RepositoryCheckpointPromptLifecycle {
    const initialSessionId = params.session.sessionId;
    const bindingsByMessageId = new Map<string, ActiveCheckpointBinding>();
    const attributionRegistry = params.attributionRegistry ?? defaultWorktreeAttributionRegistry;
    // One foreground turn is admitted at a time. Terminal publication joins its
    // capture and turn-start alias, including a reply that finishes before capture.
    let checkpointPreparation: Promise<void> = Promise.resolve();

    function endAttributionInterval(binding: ActiveCheckpointBinding): void {
        if (binding.attributionInterval) {
            attributionRegistry.end(binding.attributionInterval);
        }
    }

    function resolveAttributionScope(binding: ActiveCheckpointBinding): RepositoryCheckpointAttributionScope {
        return binding.attributionInterval
            ? attributionRegistry.resolveAttributionScope(binding.attributionInterval)
            : 'unknown';
    }

    async function emitProjectedDiff(input: Readonly<{
        binding: ActiveCheckpointBinding;
        turnId: string;
        status: TurnChangeSet['status'];
        checkpointDiff: RepositoryCheckpointDiffResult;
        startRef?: string;
        finalRef?: string;
    }>): Promise<void> {
        const turnChangeSet = projectRepositoryCheckpointTurnChangeSet({
            providerTurnChangeSet: input.binding.publication?.turnChangeSet ?? {
                sessionId: params.session.sessionId,
                turnId: input.turnId,
                // Capture runtime chronology before asynchronous Git work/publication. Both
                // checkpoint and normalized tool evidence consume the same runtime event sequence.
                seqRange: {
                    startSeqInclusive: input.binding.startSequence ?? input.binding.finalSequence ?? 0,
                    endSeqInclusive: input.binding.finalSequence ?? input.binding.startSequence ?? 0,
                },
                status: input.status,
                files: [],
                provider: 'scm:git',
                derivedAt: Date.now(),
            },
            checkpointDiff: input.checkpointDiff,
            repoRootPath: input.binding.repoRoot ?? params.runtimeDirectory,
            scopeId: input.binding.scopeId,
            startRef: input.startRef,
            finalRef: input.finalRef,
        });
        if (input.binding.repoRoot) {
            try {
                await retainRepositoryCheckpointTurnEvidence({ cwd: input.binding.repoRoot, scopeId: input.binding.scopeId, turnChangeSet });
            } catch (error) {
                logger.debug('Repository turn checkpoint retention unavailable (non-fatal)', error);
            }
        }
        await publishRuntimeTurnChangeSet({
            session: params.session,
            provider: params.provider,
            protocol: params.protocol,
            ...input.binding.publication,
            eventKind: input.binding.publication?.eventKind ?? 'turn-final',
            turnChangeSet,
        });
    }

    const lifecycle: RepositoryCheckpointPromptLifecycle = {
        async publishTurnChangeSet(publication) {
            await checkpointPreparation;
            for (const [messageId, binding] of bindingsByMessageId) {
                if (binding.turnId !== publication.turnChangeSet.turnId) continue;
                bindingsByMessageId.set(messageId, { ...binding, publication });
                // Keep the combined durable write inside the original native terminal
                // projection: a refused transcript write must still fail that turn.
                await lifecycle.onTurnFinal?.({ messageId, turnId: publication.turnChangeSet.turnId,
                    status: publication.turnChangeSet.status, sequence: publication.turnChangeSet.seqRange.endSeqInclusive });
                return;
            }
            // Native turns without a dispatched prompt have no checkpoint binding to join.
            await publishRuntimeTurnChangeSet({ ...publication, session: params.session, provider: params.provider, protocol: params.protocol });
        },
        onBeforePromptDispatch({ messageId }) {
            const capture = (async () => {
                const context = await resolveGitCheckpointContext({
                    runtimeDirectory: params.runtimeDirectory,
                    sessionId: params.session.sessionId,
                });
                const refs = buildRepositoryCheckpointRefs({
                    scopeId: context.scopeId,
                    messageId,
                });
                let binding: ActiveCheckpointBinding = { ...context, refs };
                if (context.repoRoot) {
                    binding = {
                        ...binding,
                        attributionInterval: attributionRegistry.begin({
                            repoRoot: context.repoRoot,
                            intervalId: `${params.session.sessionId}:${messageId}`,
                        }),
                    };
                }
                bindingsByMessageId.set(messageId, binding);
                const messageStart = refs.messageStart;
                if (!messageStart || !binding.context) return;
                const captured = await gitCheckpointAdapter.capture({
                    context: binding.context,
                    checkpointRef: messageStart,
                });
                try {
                    await retainRepositoryCheckpointInitialEvidence({ cwd: binding.repoRoot ?? params.runtimeDirectory,
                        scopeId: binding.scopeId, checkpointRef: messageStart, captured,
                        sessionIsNew: params.sessionIsNew === true && params.session.sessionId === initialSessionId,
                        readEarliestPromptLocalId: () => params.session.fetchEarliestCommittedUserMessageLocalId() });
                } catch (error) {
                    logger.debug('Repository initial checkpoint retention unavailable (non-fatal)', error);
                }
                if (!captured.success) {
                    bindingsByMessageId.set(messageId, {
                        ...binding,
                        receipts: appendReceipts(binding.receipts, captured.receipts),
                        unavailableReason: captured.reason,
                        unavailableError: captured.error,
                    });
                    logger.debug('Repository message-start checkpoint unavailable (non-fatal)', captured);
                    return;
                }
                bindingsByMessageId.set(messageId, {
                    ...binding,
                    receipts: appendReceipts(binding.receipts, captured.receipts),
                });
            })();
            checkpointPreparation = capture.catch(() => undefined);
            return capture;
        },
        onTurnStarted({ messageId, turnId, sequence }) {
            const started = checkpointPreparation.then(async () => {
                const binding = bindingsByMessageId.get(messageId);
                if (!binding) return;
                const refs = buildRepositoryCheckpointRefs({
                    scopeId: binding.scopeId,
                    messageId,
                    turnId,
                });
                const nextBinding: ActiveCheckpointBinding = { ...binding, refs, turnId, startSequence: sequence };
                bindingsByMessageId.set(messageId, nextBinding);
                if (binding.unavailableReason || !binding.context) return;
                if (!refs.messageStart || !refs.turnStart) {
                    bindingsByMessageId.set(messageId, {
                        ...nextBinding,
                        unavailableReason: 'missing_source',
                        unavailableError: 'Checkpoint alias source ref is unavailable.',
                    });
                    return;
                }
                try {
                    const aliased = await gitCheckpointAdapter.alias({ context: binding.context, sourceRef: refs.messageStart, targetRef: refs.turnStart });
                    const current = bindingsByMessageId.get(messageId);
                    if (!current) return;
                    bindingsByMessageId.set(messageId, { ...current,
                        receipts: appendReceipts(current.receipts, aliased.receipts),
                        ...(!aliased.success ? { unavailableReason: aliased.reason, unavailableError: aliased.error } : {}),
                    });
                    if (!aliased.success) logger.debug('Repository turn-start checkpoint alias unavailable (non-fatal)', aliased);
                } catch (error) {
                    const current = bindingsByMessageId.get(messageId);
                    if (current) bindingsByMessageId.set(messageId, { ...current, unavailableReason: 'command_failed',
                        unavailableError: 'Repository turn-start checkpoint alias failed.' });
                    logger.debug('Repository turn-start checkpoint alias failed (non-fatal)', error);
                }
            });
            checkpointPreparation = started.catch(() => undefined);
            return started;
        },
        async onTurnFinal({ messageId, turnId, status, sequence }) {
            const activeBinding = bindingsByMessageId.get(messageId);
            bindingsByMessageId.delete(messageId);
            if (!activeBinding) return;
            const binding: ActiveCheckpointBinding = { ...activeBinding, finalSequence: sequence };
            let capturedAttributionScope: RepositoryCheckpointAttributionScope | null = null;
            /**
             * Close the capture interval exactly once, at the boundary where no further checkpoint
             * content can be captured: a peer that begins during the final capture still affects the
             * captured bytes, while a peer that begins during the asynchronous diff/publication does
             * not. The snapshot is a local value, so later idempotent cleanup cannot erase it.
             */
            const snapshotAttributionScope = (activeBinding: ActiveCheckpointBinding): RepositoryCheckpointAttributionScope => {
                if (capturedAttributionScope === null) {
                    capturedAttributionScope = resolveAttributionScope(activeBinding);
                    endAttributionInterval(activeBinding);
                }
                return capturedAttributionScope;
            };
            const refs = buildRepositoryCheckpointRefs({
                scopeId: binding.scopeId,
                messageId,
                turnId,
            });
            const baseRef = binding.refs.turnStart ?? binding.refs.messageStart;
            const baseRefSource: RepositoryCheckpointDiffBaseRefSource = binding.unavailableReason
                ? 'unavailable'
                : binding.refs.turnStart
                    ? 'turn_start'
                    : binding.refs.messageStart
                        ? 'message_start'
                        : 'unavailable';
            try {
                // With no tool activity the repository diff can only describe other
                // writers. Keep the captured baseline for rewind, without a recap.
                if (binding.publication?.hasToolActivity === false) return;
                if (binding.unavailableReason || !binding.context) {
                    await emitProjectedDiff({
                        binding,
                        turnId,
                        status,
                        checkpointDiff: buildUnavailableDiffResult({
                            reason: binding.unavailableReason ?? 'not_repo',
                            error: binding.unavailableError ?? 'Repository checkpoint evidence is unavailable.',
                            baseRefSource,
                            attributionScope: snapshotAttributionScope(binding),
                            receipts: binding.receipts,
                        }),
                        startRef: baseRef?.ref,
                        finalRef: refs.turnFinal?.ref,
                    });
                    return;
                }
                if (!refs.turnFinal) return;
                const finalized = await gitCheckpointAdapter.capture({
                    context: binding.context,
                    checkpointRef: refs.turnFinal,
                });
                const attributionScope = snapshotAttributionScope(binding);
                const receiptsAfterFinal = appendReceipts(binding.receipts, finalized.receipts);
                if (!finalized.success) {
                    await emitProjectedDiff({
                        binding,
                        turnId,
                        status,
                        checkpointDiff: buildUnavailableDiffResult({
                            reason: finalized.reason,
                            error: finalized.error,
                            baseRefSource,
                            attributionScope,
                            receipts: receiptsAfterFinal,
                        }),
                        startRef: baseRef?.ref,
                        finalRef: refs.turnFinal.ref,
                    });
                    logger.debug('Repository turn-final checkpoint unavailable (non-fatal)', finalized);
                    return;
                }
                if (!baseRef || baseRefSource === 'unavailable') {
                    await emitProjectedDiff({
                        binding,
                        turnId,
                        status,
                        checkpointDiff: buildUnavailableDiffResult({
                            reason: 'missing_base',
                            error: 'Checkpoint diff base ref is unavailable.',
                            baseRefSource: 'unavailable',
                            attributionScope,
                            receipts: receiptsAfterFinal,
                        }),
                        finalRef: refs.turnFinal.ref,
                    });
                    return;
                }
                const diff = await gitCheckpointAdapter.diff({
                    context: binding.context,
                    baseRef,
                    finalRef: refs.turnFinal,
                    baseRefSource,
                    attributionScope,
                });
                const checkpointDiff: RepositoryCheckpointDiffResult = diff.success
                    ? {
                        ...diff,
                        attributionScope,
                        receipts: appendReceipts(receiptsAfterFinal, diff.receipts),
                    }
                    : {
                        ...diff,
                        attributionScope,
                        receipts: appendReceipts(receiptsAfterFinal, diff.receipts),
                    };
                if (!diff.success) {
                    logger.debug('Repository checkpoint diff unavailable (non-fatal)', diff);
                }
                await emitProjectedDiff({
                    binding,
                    turnId,
                    status,
                    checkpointDiff,
                    startRef: baseRef.ref,
                    finalRef: refs.turnFinal.ref,
                });
            } catch (error) {
                if (error instanceof RuntimeTranscriptRequiredAdmissionError) throw error;
                logger.debug('Repository final checkpoint projection failed (non-fatal)', error);
                await emitProjectedDiff({ binding, turnId, status, startRef: baseRef?.ref, finalRef: refs.turnFinal?.ref,
                    checkpointDiff: buildUnavailableDiffResult({ reason: 'capture_failed',
                        error: 'Repository final checkpoint projection failed.', baseRefSource,
                        attributionScope: snapshotAttributionScope(binding), receipts: binding.receipts }) });
            } finally {
                endAttributionInterval(binding);
            }
        },
        onTurnAbortedBeforeStart({ messageId }) {
            const binding = bindingsByMessageId.get(messageId);
            bindingsByMessageId.delete(messageId);
            if (binding) endAttributionInterval(binding);
        },
        onSessionEnd() {
            for (const binding of bindingsByMessageId.values()) {
                endAttributionInterval(binding);
            }
            bindingsByMessageId.clear();
        },
    };
    return lifecycle;
}
