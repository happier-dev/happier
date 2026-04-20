import { randomUUID } from 'node:crypto';

import { emitCanonicalTurnDiffTool } from '@/agent/runtime/emitCanonicalTurnDiffTool';
import { TurnChangeSetCollector } from '@/agent/tools/diff/turnChangeSetCollector';
import type { CodexAppServerStreamUpdate } from '@/backends/codex/appServer/streamEventBridge';
import { normalizePatchInputRecord } from '@happier-dev/protocol/tools/v2';

type CodexTurnDiffSession = Readonly<{
    sendCodexMessage: (body: unknown) => void;
    sessionId?: string | null;
}>;

export function createCodexAppServerTurnDiffProjector(params: Readonly<{
    session: CodexTurnDiffSession;
    readLastObservedMessageSeq: () => number;
}>) {
    const collector = new TurnChangeSetCollector({
        provider: 'codex',
        snapshotUnifiedDiff: true,
    });

    return {
        beginTurn(): void {
            collector.beginTurn();
        },

        observeStreamUpdate(update: CodexAppServerStreamUpdate, context: Readonly<{
            sidechainId: string | null;
            activeTurnId: string | null;
        }>): boolean {
            if (update.type !== 'turn-diff-updated') {
                return false;
            }
            if (context.sidechainId) {
                return true;
            }
            if (update.turnId && context.activeTurnId && update.turnId !== context.activeTurnId) {
                return true;
            }
            collector.observeUnifiedDiffSnapshot({
                unifiedDiff: update.unifiedDiff,
                source: 'provider_native',
                confidence: 'exact',
            });
            return true;
        },

        observeFileChangeToolCall(input: unknown): void {
            const normalizedInput = input && typeof input === 'object' && !Array.isArray(input)
                ? normalizePatchInputRecord(input as Record<string, unknown>)
                : null;
            const changes = normalizedInput?.changes;
            if (changes && typeof changes === 'object' && !Array.isArray(changes)) {
                collector.observePatchChanges({
                    changes: changes as Record<string, unknown>,
                    source: 'provider_tool',
                    confidence: 'strong',
                });
            }
        },

        emitCompletedTurn(paramsForTurn: Readonly<{
            threadId: string;
            turnId: string;
            completedTurnStartSeqInclusive: number;
        }>): void {
            const turnChangeSet = collector.flushTurn({
                sessionId: params.session.sessionId ?? paramsForTurn.threadId,
                turnId: paramsForTurn.turnId,
                seqRange: {
                    startSeqInclusive: paramsForTurn.completedTurnStartSeqInclusive,
                    endSeqInclusive: params.readLastObservedMessageSeq(),
                },
                status: 'completed',
            });
            if (!turnChangeSet) {
                return;
            }
            emitCanonicalTurnDiffTool({
                turnChangeSet,
                protocol: 'codex',
                rawToolName: 'CodexDiff',
                sendToolCall: ({ toolName, input, callId }) => {
                    const resolvedCallId = callId ?? randomUUID();
                    params.session.sendCodexMessage({
                        type: 'tool-call',
                        name: toolName,
                        callId: resolvedCallId,
                        input,
                        id: randomUUID(),
                    });
                    return resolvedCallId;
                },
                sendToolResult: ({ callId, output }) => {
                    params.session.sendCodexMessage({
                        type: 'tool-call-result',
                        callId,
                        output,
                        id: randomUUID(),
                    });
                },
            });
        },
    };
}
