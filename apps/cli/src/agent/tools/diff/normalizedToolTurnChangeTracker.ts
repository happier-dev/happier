import type { TurnChangeSet } from '@happier-dev/protocol';

import { TurnChangeSetCollector } from './turnChangeSetCollector';
import {
    buildPlaceholderUnifiedDiff,
    derivePendingNormalizedToolChange,
} from './derivePendingNormalizedToolChange';
import type {
    NormalizedToolChangeResult,
    NormalizedToolFileMutation,
    PendingNormalizedToolChange,
} from './normalizedToolChangeTypes';

function resolveTextMutation(params: Readonly<{
    pending: Extract<PendingNormalizedToolChange, { kind: 'placeholder-diff' }>;
    mutation: NormalizedToolFileMutation;
}>): Readonly<{
    filePath: string;
    oldText: string;
    newText: string;
}> | null {
    if (typeof params.mutation.newText !== 'string') return null;
    return {
        filePath:
            typeof params.mutation.filePath === 'string' && params.mutation.filePath.trim().length > 0
                ? params.mutation.filePath
                : params.pending.filePath,
        oldText: typeof params.mutation.oldText === 'string' ? params.mutation.oldText : '',
        newText: params.mutation.newText,
    };
}

export class NormalizedToolTurnChangeTracker {
    private readonly collector: TurnChangeSetCollector;
    private readonly pendingByCallId = new Map<string, PendingNormalizedToolChange>();
    private activeTurnOrdinal = 0;
    private hasActiveTurn = false;
    private readonly turnIdPrefix: string;

    constructor(params: Readonly<{
        provider: string;
        turnIdPrefix?: string;
    }>) {
        this.collector = new TurnChangeSetCollector({ provider: params.provider });
        this.turnIdPrefix = params.turnIdPrefix ?? `${params.provider}-turn`;
    }

    private ensureTurnStarted(): void {
        if (this.hasActiveTurn) return;
        this.beginTurn();
    }

    beginTurn(): void {
        this.activeTurnOrdinal += 1;
        this.pendingByCallId.clear();
        this.collector.beginTurn();
        this.hasActiveTurn = true;
    }

    resetTurn(): void {
        this.pendingByCallId.clear();
        this.collector.beginTurn();
        this.hasActiveTurn = false;
    }

    observeToolCall(params: Readonly<{
        callId: string;
        toolName: string;
        args: Record<string, unknown>;
        parentToolUseId?: string | null;
    }>): void {
        if (typeof params.parentToolUseId === 'string' && params.parentToolUseId.trim().length > 0) {
            return;
        }
        this.ensureTurnStarted();
        const pending = derivePendingNormalizedToolChange(params.toolName, params.args);
        if (!pending) return;
        this.pendingByCallId.set(params.callId, pending);
    }

    observeToolResult(params: Readonly<{
        callId: string;
        isError: boolean;
        result?: NormalizedToolChangeResult;
    }>): void {
        const pending = this.pendingByCallId.get(params.callId);
        if (!pending) return;
        this.pendingByCallId.delete(params.callId);
        if (params.isError) return;

        if (pending.kind === 'placeholder-diff') {
            const mutation = params.result?.fileMutation;
            if (mutation) {
                const textMutation = resolveTextMutation({ pending, mutation });
                if (textMutation) {
                    this.collector.observeTextDiff({
                        filePath: textMutation.filePath,
                        oldText: textMutation.oldText,
                        newText: textMutation.newText,
                        source: 'provider_tool',
                        confidence: 'exact',
                        description: pending.description,
                    });
                    return;
                }
            }
        }

        if (pending.kind === 'text-diff') {
            this.collector.observeTextDiff({
                filePath: pending.filePath,
                oldText: pending.oldText,
                newText: pending.newText,
                source: 'provider_tool',
                confidence: 'exact',
                ...(pending.description ? { description: pending.description } : {}),
            });
            return;
        }

        if (pending.kind === 'placeholder-diff') {
            this.collector.observeUnifiedDiff({
                filePath: pending.filePath,
                unifiedDiff: buildPlaceholderUnifiedDiff(pending.filePath, pending.description),
                source: 'provider_tool',
                confidence: 'best_effort',
                description: pending.description,
            });
            return;
        }

        for (const file of pending.files) {
            if (typeof file.oldText === 'string' && typeof file.newText === 'string') {
                this.collector.observeTextDiff({
                    filePath: file.filePath,
                    oldText: file.oldText,
                    newText: file.newText,
                    source: 'provider_tool',
                    confidence: 'exact',
                    ...(file.description ? { description: file.description } : {}),
                });
                continue;
            }

            if (typeof file.unifiedDiff === 'string' && file.unifiedDiff.trim().length > 0) {
                this.collector.observeUnifiedDiff({
                    filePath: file.filePath,
                    unifiedDiff: file.unifiedDiff,
                    source: 'provider_tool',
                    confidence: 'exact',
                    ...(file.description ? { description: file.description } : {}),
                });
                continue;
            }

            this.collector.observeUnifiedDiff({
                filePath: file.filePath,
                unifiedDiff: buildPlaceholderUnifiedDiff(file.filePath, file.description ?? 'Diff'),
                source: 'provider_tool',
                confidence: 'best_effort',
                description: file.description ?? 'Diff',
            });
        }
    }

    completeTurn(params: Readonly<{
        sessionId: string;
        status: TurnChangeSet['status'];
    }>): TurnChangeSet | null {
        if (!this.hasActiveTurn) {
            return null;
        }
        const turnOrdinal = Math.max(this.activeTurnOrdinal, 1);
        this.pendingByCallId.clear();
        const turnChangeSet = this.collector.flushTurn({
            sessionId: params.sessionId,
            turnId: `${this.turnIdPrefix}-${turnOrdinal}`,
            seqRange: {
                startSeqInclusive: turnOrdinal,
                endSeqInclusive: turnOrdinal,
            },
            status: params.status,
        });
        this.hasActiveTurn = false;
        return turnChangeSet;
    }
}
