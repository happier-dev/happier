import type {
    AgentMessageHandler,
    SessionId,
    StartSessionResult,
} from '@/agent/core';

export type AcpRuntimeTurnCompletedStopReason = 'end_turn' | 'max_tokens' | 'max_turn_requests';

export type AcpRuntimeTurnOutcome =
    | { kind: 'completed'; stopReason: AcpRuntimeTurnCompletedStopReason }
    | { kind: 'aborted'; stopReason: 'cancelled' }
    | { kind: 'refused'; stopReason: 'refusal' }
    | { kind: 'failed'; error: Error }
    | { kind: 'timed_out'; capMs: number };

export interface CatalogAcpBackend {
    startSession(initialPrompt?: string): Promise<StartSessionResult>;
    loadSession?(sessionId: SessionId): Promise<StartSessionResult>;
    loadSessionWithReplayCapture?(sessionId: SessionId): Promise<StartSessionResult & { replay: unknown[] }>;
    forkSession?(params: Readonly<{ sessionId: SessionId; cwd?: string }>): Promise<StartSessionResult>;
    sendPrompt(sessionId: SessionId, prompt: string): Promise<void>;
    compactContext?(sessionId: SessionId, command: string): Promise<void>;
    sendSteerPrompt?(sessionId: SessionId, prompt: string): Promise<void>;
    cancel(sessionId: SessionId): Promise<void>;
    onMessage(handler: AgentMessageHandler): void;
    offMessage?(handler: AgentMessageHandler): void;
    waitForResponseComplete?(timeoutMs?: number | null): Promise<AcpRuntimeTurnOutcome | void>;
    dispose(): Promise<void>;
}

export interface AcpRuntimeBackend extends CatalogAcpBackend {
    setSessionMode?: (sessionId: string, modeId: string) => Promise<void>;
    setSessionModel?: (sessionId: string, modelId: string) => Promise<void>;
    setSessionConfigOption?: (
        sessionId: string,
        configId: string,
        value: string | number | boolean | null,
    ) => Promise<unknown>;
}

export type AcpReplayBackend = Readonly<Pick<CatalogAcpBackend, 'dispose' | 'loadSessionWithReplayCapture'>>;

export type AcpProbeBackend = Readonly<
    Pick<CatalogAcpBackend, 'dispose' | 'startSession'> & Partial<{
        getSessionModelState: () => { availableModels?: unknown } | null;
        getSessionModeState: () => { availableModes?: unknown } | null;
        getSessionConfigOptionsState: () => unknown;
    }>
>;
