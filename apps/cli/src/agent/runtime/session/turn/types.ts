import type { ACPMessageData, ACPProvider } from '@/api/session/sessionMessageTypes';
import type {
    PrimaryTurnStatusV1,
    SessionRuntimeIssueV1,
} from '@happier-dev/protocol';

export type SessionTurnTerminalStatus = Exclude<PrimaryTurnStatusV1, 'in_progress'>;

export type SessionTurnHandle = Readonly<{
    turnId: string;
    provider?: string;
    providerTurnId?: string;
}>;

export type SessionTurnTranscriptAnchorsInput = Readonly<{
    startUserMessageSeq?: number | null;
    userMessageSeqs?: readonly number[];
    startSeqInclusive?: number | null;
    endSeqInclusive?: number | null;
} & Record<string, unknown>>;

export type BeginTurnInput = Readonly<{
    provider?: string | null;
    providerTurnId?: string | null;
    transcriptAnchors?: SessionTurnTranscriptAnchorsInput;
    observedAt?: number;
}>;

export type AttachProviderTurnIdInput = Readonly<{
    provider?: string | null;
    providerTurnId: string;
    observedAt?: number;
}>;

export type AppendTranscriptAnchorsInput = Readonly<{
    turnId?: string | null;
    provider?: string | null;
    providerTurnId?: string | null;
    observedAt?: number;
    transcriptAnchors: SessionTurnTranscriptAnchorsInput;
}>;

export type TouchActiveTurnInput = Readonly<{
    provider?: string | null;
    providerTurnId?: string | null;
    observedAt?: number;
    force?: boolean;
}>;

export type CompleteTurnInput = Readonly<{
    provider?: string | null;
    providerTurnId?: string | null;
    observedAt?: number;
}>;

export type FailTurnInput = Readonly<{
    provider?: string | null;
    providerTurnId?: string | null;
    issue?: SessionRuntimeIssueV1 | null;
    observedAt?: number;
    /**
     * Session-scoped failures (host death, readiness timeout) can occur with no
     * active turn. Opting in allocates a session-owned turn and immediately
     * fails it so the issue is surfaced instead of silently dropped.
     */
    allocateWhenIdle?: boolean;
    /** Repeated observers may reuse the last failure until a new turn begins. */
    suppressUntrustedDuplicate?: boolean;
    /** Accepted terminal evidence, available before its durable write settles. */
    onFailureTurn?: (failure: Readonly<{ turnId: string; issue: SessionRuntimeIssueV1 }>) => void;
}>;

export type CancelTurnInput = Readonly<{
    provider?: string | null;
    providerTurnId?: string | null;
    observedAt?: number;
}>;

export type EndSessionInput = Readonly<{
    observedAt?: number;
}>;

export type MarkRollbackEligibleInput = Readonly<{
    turnId: string;
    provider?: string | null;
    transcriptAnchors?: SessionTurnTranscriptAnchorsInput;
    observedAt?: number;
}>;

export type MarkRolledBackInput = Readonly<{
    turnId: string;
    provider?: string | null;
    observedAt?: number;
}>;

export type SessionTurnLifecycle = Readonly<{
    beginTurn(input: BeginTurnInput): Promise<SessionTurnHandle>;
    attachProviderTurnId(input: AttachProviderTurnIdInput): Promise<void>;
    appendTranscriptAnchors(input: AppendTranscriptAnchorsInput): Promise<void>;
    touchActiveTurn(input?: TouchActiveTurnInput): Promise<void>;
    completeTurn(input?: CompleteTurnInput): Promise<void>;
    failTurn(input: FailTurnInput): Promise<void>;
    cancelTurn(input?: CancelTurnInput): Promise<void>;
    endSession(input?: EndSessionInput): Promise<void>;
    markRollbackEligible(input: MarkRollbackEligibleInput): Promise<void>;
    markRolledBack(input: MarkRolledBackInput): Promise<void>;
    hasActiveTurn(): boolean;
}>;

export type ObserveAcpLifecycleMarkerResult = Readonly<{
    body: ACPMessageData;
    pendingWrite: Promise<void> | null;
}>;

export type SessionTurnLifecycleController = SessionTurnLifecycle & Readonly<{
    /** Release local observation resources without settling the active turn. */
    dispose(): void;
    observeAcpLifecycleMarker(input: Readonly<{
        provider: ACPProvider;
        body: ACPMessageData;
    }>): ObserveAcpLifecycleMarkerResult;
    /**
     * Notify the turn stall watch that a provider message event arrived. Must be
     * driven by provider message backflow only — never the keepalive/touch path
     * (presence stays fresh through provider stalls and would blind the watch).
     */
    observeProviderTurnEvent(): void;
}>;

export type SessionTurnLifecycleControllerWithActiveTurnWitness =
    SessionTurnLifecycleController & Readonly<{
        getActiveTurnId(): string | null;
    }>;
