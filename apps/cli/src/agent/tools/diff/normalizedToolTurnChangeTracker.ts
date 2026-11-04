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
    private activeTurnId: string | null = null;
    private activeAgentTurnId: string | null = null;
    private activeStartSequence: number | null = null;
    private toolActivityObserved = false;

    get hasToolActivity(): boolean {
        return this.toolActivityObserved;
    }

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

    beginTurn(params: Readonly<{
        turnId?: string;
        agentTurnId?: string | null;
        sequence?: number;
    }> = {}): void {
        this.activeTurnOrdinal += 1;
        this.toolActivityObserved = false;
        this.pendingByCallId.clear();
        this.collector.beginTurn();
        this.hasActiveTurn = true;
        this.activeTurnId = params.turnId ?? null;
        this.activeAgentTurnId = params.agentTurnId ?? null;
        this.activeStartSequence = params.sequence ?? null;
    }

    observeAgentTurnId(agentTurnId: string): void {
        this.activeAgentTurnId = agentTurnId;
    }

    resetTurn(): void {
        this.toolActivityObserved = false;
        this.pendingByCallId.clear();
        this.collector.beginTurn();
        this.hasActiveTurn = false;
        this.activeTurnId = null;
        this.activeAgentTurnId = null;
        this.activeStartSequence = null;
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
        this.toolActivityObserved = true;
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
                        agentTurnId: this.activeAgentTurnId,
                        providerMessageId: params.callId,
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
                agentTurnId: this.activeAgentTurnId,
                providerMessageId: params.callId,
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
                agentTurnId: this.activeAgentTurnId,
                providerMessageId: params.callId,
                description: pending.description,
            });
            return;
        }

        this.collector.observeCanonicalDiff({
            files: pending.files.map((file) => ({
                ...file,
                agentTurnId: file.agentTurnId ?? this.activeAgentTurnId,
                providerMessageId: file.providerMessageId ?? params.callId,
            })),
            turnMetadata: pending.turnMetadata,
        });
    }

    observeFileEdit(params: Readonly<{
        editId: string;
        filePath: string;
        diff?: string;
        oldContent?: string;
        newContent?: string;
        description?: string;
        parentToolUseId?: string | null;
    }>): void {
        if (typeof params.parentToolUseId === 'string' && params.parentToolUseId.trim().length > 0) {
            return;
        }
        this.ensureTurnStarted();
        this.toolActivityObserved = true;
        if (typeof params.oldContent === 'string' && typeof params.newContent === 'string') {
            this.collector.observeTextDiff({
                filePath: params.filePath,
                oldText: params.oldContent,
                newText: params.newContent,
                source: 'provider_native',
                confidence: 'exact',
                agentTurnId: this.activeAgentTurnId,
                providerMessageId: params.editId,
                ...(params.description ? { description: params.description } : {}),
            });
            return;
        }
        const exactDiff = typeof params.diff === 'string' && params.diff.trim().length > 0
            ? params.diff
            : null;
        this.collector.observeUnifiedDiff({
            filePath: params.filePath,
            unifiedDiff: exactDiff ?? buildPlaceholderUnifiedDiff(params.filePath, params.description ?? 'File edit'),
            source: 'provider_native',
            confidence: exactDiff ? 'exact' : 'best_effort',
            agentTurnId: this.activeAgentTurnId,
            providerMessageId: params.editId,
            ...(params.description ? { description: params.description } : {}),
        });
    }

    completeTurn(params: Readonly<{
        sessionId: string;
        status: TurnChangeSet['status'];
        turnId?: string;
        agentTurnId?: string | null;
        sequence?: number;
    }>): TurnChangeSet | null {
        if (!this.hasActiveTurn) {
            return null;
        }
        const turnOrdinal = Math.max(this.activeTurnOrdinal, 1);
        const agentTurnId = params.agentTurnId ?? this.activeAgentTurnId;
        if (agentTurnId) this.activeAgentTurnId = agentTurnId;
        this.pendingByCallId.clear();
        const turnChangeSet = this.collector.flushTurn({
            sessionId: params.sessionId,
            turnId: params.turnId ?? this.activeTurnId ?? `${this.turnIdPrefix}-${turnOrdinal}`,
            seqRange: {
                startSeqInclusive: this.activeStartSequence ?? turnOrdinal,
                endSeqInclusive: params.sequence ?? this.activeStartSequence ?? turnOrdinal,
            },
            status: params.status,
            agentTurnId: this.activeAgentTurnId,
        });
        this.hasActiveTurn = false;
        this.activeTurnId = null;
        this.activeAgentTurnId = null;
        this.activeStartSequence = null;
        return turnChangeSet;
    }
}
