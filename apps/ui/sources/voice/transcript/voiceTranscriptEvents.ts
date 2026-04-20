export type VoiceTranscriptTurn = Readonly<{
    epoch: number;
    role: 'user' | 'assistant';
    ts: number;
    voiceAgentId: string;
    runId?: string | null;
    streamId?: string | null;
    requestId?: string | null;
}>;

type VoiceTranscriptTurnCarrier = Readonly<{
    turn?: VoiceTranscriptTurn | null;
    runId?: string | null;
    streamId?: string | null;
    requestId?: string | null;
}>;

export type VoiceUserTranscriptEvent = VoiceTranscriptTurnCarrier & Readonly<{
    type: 'user_transcript';
    user_transcription_event?: Readonly<{
        user_transcript?: string;
        event_id?: string | number;
    }>;
    user_transcript?: string;
    transcript?: string;
}>;

export type VoiceAgentResponseEvent = VoiceTranscriptTurnCarrier & Readonly<{
    type: 'agent_response';
    agent_response_event?: Readonly<{
        agent_response?: string;
        event_id?: string | number;
    }>;
    agent_response?: string;
    transcript?: string;
}>;

export type VoiceAgentResponseCorrectionEvent = Readonly<{
    type: 'agent_response_correction';
    agent_response_correction_event?: Readonly<{
        original_agent_response?: string;
        corrected_agent_response?: string;
        event_id?: string | number;
    }>;
    corrected_agent_response?: string;
}>;

export type VoiceClientToolCallEvent = Readonly<{
    type: 'client_tool_call';
    client_tool_call?: Readonly<{
        tool_name?: string;
        tool_call_id?: string;
        parameters?: unknown;
        event_id?: string | number;
    }>;
    tool_name?: string;
}>;

export type VoiceAgentToolResponseEvent = Readonly<{
    type: 'agent_tool_response';
    agent_tool_response?: Readonly<{
        tool_name?: string;
        tool_call_id?: string;
        tool_type?: string;
        is_error?: boolean;
        is_called?: boolean;
        event_id?: string | number;
    }>;
    tool_name?: string;
    is_error?: boolean;
}>;

export type VoiceGenericTranscriptEvent = VoiceTranscriptTurnCarrier & Readonly<{
    source?: string;
    role?: string;
    message?: string;
    text?: string;
    transcript?: string;
}>;

export type VoiceTranscriptEvent =
    | VoiceUserTranscriptEvent
    | VoiceAgentResponseEvent
    | VoiceAgentResponseCorrectionEvent
    | VoiceClientToolCallEvent
    | VoiceAgentToolResponseEvent
    | VoiceGenericTranscriptEvent;
