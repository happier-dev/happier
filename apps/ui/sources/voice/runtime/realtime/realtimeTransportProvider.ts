import type { VoiceSessionConfig } from '@/realtime/types';
import type { VoiceSessionSnapshot } from '@/voice/session/types';

export type RealtimeConversationHandle = Readonly<{
    startSession: (config: unknown) => Promise<unknown>;
    endSession: () => Promise<void>;
    getId?: () => string | null;
    setMicMuted?: (muted: boolean) => void;
    sendUserMessage: (message: string) => void;
    sendContextualUpdate: (update: string) => void;
}>;

export type RealtimeTransportProviderSessionState = Readonly<{
    billingMode: 'happier' | 'byo';
    expiresAtMs: number | null;
    leaseId: string | null;
}>;

export type PreparedRealtimeSessionStart = Readonly<{
    sessionConfig: VoiceSessionConfig;
    sessionState: RealtimeTransportProviderSessionState;
}>;

export type RealtimeTransportProvider = Readonly<{
    adapterId: string;
    buildConversationStartConfig: (args: Readonly<{
        config: VoiceSessionConfig;
        settings: unknown;
    }>) => unknown;
    handleProviderConnected: () => void;
    handleProviderDiagnosticsError: (reason: string) => void;
    handleProviderDisconnected: () => void;
    handleProviderMessage: (args: Readonly<{
        controlSessionId: string | null;
        payload: unknown;
    }>) => void;
    handleSessionEnded: () => Promise<void>;
    handleSessionStarted: (args: Readonly<{
        controlSessionId: string;
        conversationId: string;
        preparedStart: PreparedRealtimeSessionStart;
    }>) => void;
    isSelectedProvider: (settings: unknown) => boolean;
    prepareSessionStart: (args: Readonly<{
        controlSessionId: string;
        initialContext?: string;
        requestedTargetSessionId: string | null;
        retryAfterPaywall: boolean;
        settings: unknown;
        signal: AbortSignal;
        textOnly: boolean;
    }>) => Promise<PreparedRealtimeSessionStart | null>;
    resetActiveSession: () => void;
    resolveConversationId: (args: Readonly<{
        handle: RealtimeConversationHandle;
        rawConversationId: unknown;
    }>) => string | null;
    resolveProviderMode: (mode: string) => VoiceSessionSnapshot['mode'];
}>;
