import type {
    AgentMessageHandler,
    SessionId,
} from '@/agent/core/AgentMessage';
import type { StartSessionResult } from '@/agent/core/AgentTypes';
import type { ListSessionsResponse } from '@agentclientprotocol/sdk';
import type { AcpTurnCompletedStopReason, AcpTurnOutcome } from '../turn/outcome';

export type AcpRuntimeTurnCompletedStopReason = AcpTurnCompletedStopReason;

export type AcpRuntimeTurnOutcome = AcpTurnOutcome;

export type AcpPromptSubmissionSettledResult =
    | { kind: 'accepted_by_prompt_response' }
    | { kind: 'accepted_by_correlated_provider_effect' }
    | { kind: 'effect_observed_without_prompt_response' }
    | { kind: 'rejected_before_effect'; error: Error }
    | { kind: 'effect_may_have_occurred'; error: Error };

export type AcpPromptSubmissionResult =
    | AcpPromptSubmissionSettledResult
    | {
        kind: 'submitted_to_transport';
        settlement: Promise<AcpPromptSubmissionSettledResult>;
    };

export interface CatalogAcpBackend {
    startSession(): Promise<StartSessionResult>;
    loadSession?(sessionId: SessionId): Promise<StartSessionResult>;
    loadSessionWithReplayCapture?(sessionId: SessionId): Promise<StartSessionResult & { replay: unknown[] }>;
    forkSession?(params: Readonly<{ sessionId: SessionId; cwd?: string }>): Promise<StartSessionResult>;
    listSessions?(params?: Readonly<{ cwd?: string; cursor?: string }>): Promise<ListSessionsResponse>;
    closeSession?(sessionId: SessionId): Promise<void>;
    deleteSession?(sessionId: SessionId): Promise<void>;
    requestExtension?<Response = unknown, Params = unknown>(
        method: string,
        params?: Params,
        options?: Readonly<{ signal?: AbortSignal; timeoutMs?: number }>,
    ): Promise<Response>;
    sendPrompt(sessionId: SessionId, prompt: string): Promise<AcpPromptSubmissionResult>;
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
        getSessionModelConfigOptionId: () => string | null;
        setSessionConfigOption: (sessionId: SessionId, configId: string, value: string) => Promise<unknown>;
    }>
>;
