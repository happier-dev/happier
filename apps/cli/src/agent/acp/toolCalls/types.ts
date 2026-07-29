export type AcpToolObservationSource =
    | 'tool_call'
    | 'tool_call_update'
    | 'permission'
    | 'terminalize_turn';

export type AcpToolLifecycleStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export type AcpToolObservationPatch = Readonly<{
    title?: string | null;
    kind?: string | null;
    status?: string | null;
    rawInput?: unknown;
    rawOutput?: unknown;
    content?: readonly unknown[] | null;
    locations?: readonly unknown[] | null;
    error?: unknown;
}>;

export type AcpToolObservation = Readonly<{
    sessionId: string;
    turnId: string;
    sidechainId: string | null;
    toolCallId: string;
    revision: number;
    observedAtMs: number;
    source: AcpToolObservationSource;
    patch: AcpToolObservationPatch;
    semanticName?: string | null;
}>;

export type AcpToolIdentity = Readonly<{
    /** Exact, length-delimited in-memory correlation key. Never persist or log this value. */
    correlationKey: string;
    callLocalId: string;
    resultLocalId: string;
}>;

export type MergedAcpToolCall = Readonly<{
    sessionId: string;
    turnId: string;
    sidechainId: string | null;
    toolCallId: string;
    localId: string;
    resultLocalId: string;
    toolName: string;
    title?: string;
    kind?: string;
    status: AcpToolLifecycleStatus;
    rawInput?: unknown;
    content?: readonly unknown[];
    locations?: readonly unknown[];
    observedAtMs: number;
}>;

export type MergedAcpToolResult = Readonly<{
    sessionId: string;
    turnId: string;
    sidechainId: string | null;
    toolCallId: string;
    localId: string;
    callLocalId: string;
    toolName: string;
    status: Extract<AcpToolLifecycleStatus, 'completed' | 'failed' | 'cancelled'>;
    rawOutput?: unknown;
    error?: unknown;
    isError: boolean;
    observedAtMs: number;
}>;

export type AcpToolAccumulatorEmission =
    | Readonly<{ kind: 'progress'; call: MergedAcpToolCall; revision: number }>
    | Readonly<{
        kind: 'terminal';
        call: MergedAcpToolCall;
        result: MergedAcpToolResult | null;
        /** True when this emission owns the first result publication or a material stable-ID revision. */
        publishResult: boolean;
        revision: number;
    }>
    | Readonly<{
        kind: 'late-enrichment';
        call: MergedAcpToolCall;
        result: MergedAcpToolResult | null;
        /** True for a first result or a materially changed stable-ID result revision. */
        publishResult: boolean;
        revision: number;
    }>
    | Readonly<{ kind: 'ignored'; reason: 'duplicate' | 'stale' | 'closed-beyond-tombstone' }>;

export type TerminalizeAcpToolTurnInput = Readonly<{
    sessionId: string;
    turnId: string;
    sidechainId?: string | null;
    status: Extract<AcpToolLifecycleStatus, 'completed' | 'failed' | 'cancelled'>;
    revision: number;
    observedAtMs: number;
}>;

export type AcpToolCallAccumulatorOptions = Readonly<{
    maxActiveRecords?: number;
    maxTombstones?: number;
    tombstoneTtlMs?: number;
    maxClosedTurns?: number;
}>;
