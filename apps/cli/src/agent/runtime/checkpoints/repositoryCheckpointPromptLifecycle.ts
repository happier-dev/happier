import type { ToolNormalizationProtocol, TurnChangeSet } from '@happier-dev/protocol';

import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { ACPMessageData, ACPProvider } from '@/api/session/sessionMessageTypes';
import { emitCanonicalTurnDiffTool } from '@/agent/runtime/emitCanonicalTurnDiffTool';
import type { PromptLoopCheckpointLifecycle } from '@/agent/runtime/runPermissionModePromptLoop';
import type { ScmBackendContext } from '@/scm/types';
import { buildRepositoryCheckpointRefs, projectRepositoryCheckpointTurnChangeSet } from '@/scm/checkpoints';
import { gitCheckpointAdapter, resolveGitCheckpointBackendContext } from '@/scm/checkpoints/gitCheckpointAdapter';
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

async function emitCheckpointTurnChangeSet(input: Readonly<{
    session: ApiSessionClient;
    provider: ACPProvider;
    protocol: ToolNormalizationProtocol;
    turnChangeSet: TurnChangeSet;
}>): Promise<void> {
    const messages: Array<Readonly<{ body: ACPMessageData; localId: string }>> = [];
    emitCanonicalTurnDiffTool({
        turnChangeSet: input.turnChangeSet,
        protocol: input.protocol,
        rawToolName: 'RepositoryCheckpointDiff',
        sendToolCall: ({ toolName, input: toolInput, callId }) => {
            const resolvedCallId = callId ?? `repository-checkpoint-${input.turnChangeSet.turnId}`;
            messages.push({
                body: {
                    type: 'tool-call',
                    id: resolvedCallId,
                    callId: resolvedCallId,
                    name: toolName,
                    input: toolInput,
                },
                localId: `${resolvedCallId}:tool-call`,
            });
            return resolvedCallId;
        },
        sendToolResult: ({ callId, output }) => {
            messages.push({
                body: {
                    type: 'tool-result',
                    id: callId,
                    callId,
                    output,
                },
                localId: `${callId}:tool-result`,
            });
        },
    });
    for (const message of messages) {
        await input.session.enqueueAgentMessageCommitted(
            input.provider,
            message.body,
            {
                localId: message.localId,
                provenance: { kind: 'non_dependent', source: 'external' },
            },
        );
    }
}

export function createRepositoryCheckpointPromptLifecycle(params: Readonly<{
    session: ApiSessionClient;
    runtimeDirectory: string;
    provider: ACPProvider;
    protocol: ToolNormalizationProtocol;
    attributionRegistry?: WorktreeAttributionRegistry;
    sessionIsNew?: boolean;
}>): PromptLoopCheckpointLifecycle {
    const initialSessionId = params.session.sessionId;
    const bindingsByMessageId = new Map<string, ActiveCheckpointBinding>();
    const attributionRegistry = params.attributionRegistry ?? defaultWorktreeAttributionRegistry;

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
        const checkpointOnlyTurnChangeSet = projectRepositoryCheckpointTurnChangeSet({
            providerTurnChangeSet: {
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
            scopeId: input.binding.scopeId,
            startRef: input.startRef,
            finalRef: input.finalRef,
        });
        if (input.binding.repoRoot) {
            try {
                await retainRepositoryCheckpointTurnEvidence({ cwd: input.binding.repoRoot, scopeId: input.binding.scopeId, turnChangeSet: checkpointOnlyTurnChangeSet });
            } catch (error) {
                logger.debug('Repository turn checkpoint retention unavailable (non-fatal)', error);
            }
        }
        await emitCheckpointTurnChangeSet({
            session: params.session,
            provider: params.provider,
            protocol: params.protocol,
            turnChangeSet: checkpointOnlyTurnChangeSet,
        });
    }

    return {
        async onBeforePromptDispatch({ messageId }) {
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
                    sessionIsNew: params.sessionIsNew === true && params.session.sessionId === initialSessionId });
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
        },
        async onTurnStarted({ messageId, turnId, sequence }) {
            const binding = bindingsByMessageId.get(messageId);
            if (!binding) return;
            const refs = buildRepositoryCheckpointRefs({
                scopeId: binding.scopeId,
                messageId,
                turnId,
            });
            let nextBinding: ActiveCheckpointBinding = { ...binding, refs, startSequence: sequence };
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
            const aliased = await gitCheckpointAdapter.alias({
                context: binding.context,
                sourceRef: refs.messageStart,
                targetRef: refs.turnStart,
            });
            if (!aliased.success) {
                bindingsByMessageId.set(messageId, {
                    ...nextBinding,
                    receipts: appendReceipts(nextBinding.receipts, aliased.receipts),
                    unavailableReason: aliased.reason,
                    unavailableError: aliased.error,
                });
                logger.debug('Repository turn-start checkpoint alias unavailable (non-fatal)', aliased);
                return;
            }
            nextBinding = {
                ...nextBinding,
                receipts: appendReceipts(nextBinding.receipts, aliased.receipts),
            };
            bindingsByMessageId.set(messageId, nextBinding);
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
            try {
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
}
