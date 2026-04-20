import { voiceTranscriptProjector as projector } from './VoiceTranscriptProjector';
import type { VoiceTranscriptEvent, VoiceTranscriptTurn } from './voiceTranscriptEvents';

export type { VoiceTranscriptEvent, VoiceTranscriptTurn } from './voiceTranscriptEvents';

function normalizeText(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Readonly<Record<string, unknown>>;
}

function readGenericRole(payload: Readonly<Record<string, unknown>>): 'user' | 'agent' | null {
    const source = normalizeText(payload.source)?.toLowerCase();
    const role = normalizeText(payload.role)?.toLowerCase();

    if (source === 'user' || role === 'user') return 'user';
    if (source === 'ai' || source === 'agent' || role === 'assistant' || role === 'agent') return 'agent';
    return null;
}

function readNumber(value: unknown): number | null {
    const numeric = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(numeric) ? numeric : null;
}

function readTurnRole(value: unknown): VoiceTranscriptTurn['role'] | null {
    return value === 'user' || value === 'assistant' ? value : null;
}

function readVoiceTranscriptTurn(payload: Readonly<Record<string, unknown>>): VoiceTranscriptTurn | null {
    const rawTurn = readRecord(payload.turn);
    if (!rawTurn) return null;

    const epoch = readNumber(rawTurn.epoch);
    const ts = readNumber(rawTurn.ts);
    const role = readTurnRole(rawTurn.role);
    const voiceAgentId = normalizeText(rawTurn.voiceAgentId);
    if (epoch === null || ts === null || !role || !voiceAgentId) return null;

    return {
        epoch,
        role,
        ts,
        voiceAgentId,
        runId: normalizeText(rawTurn.runId) ?? normalizeText(payload.runId),
        streamId: normalizeText(rawTurn.streamId) ?? normalizeText(payload.streamId),
        requestId: normalizeText(rawTurn.requestId) ?? normalizeText(payload.requestId),
    };
}

function readVoiceTranscriptEvent(value: unknown): VoiceTranscriptEvent | null {
    return readRecord(value) as VoiceTranscriptEvent | null;
}

export function appendVoiceConversationUserText(params: Readonly<{
    conversationSessionId: string;
    text: string;
    turn?: VoiceTranscriptTurn | null;
}>): void {
    projector.projectUserText(params);
}

export function appendVoiceConversationAssistantText(params: Readonly<{
    conversationSessionId: string;
    text: string;
    turn?: VoiceTranscriptTurn | null;
}>): void {
    projector.projectAssistantText(params);
}

export function appendVoiceConversationNoteText(params: Readonly<{
    conversationSessionId: string;
    text: string;
}>): void {
    projector.projectNoteText(params);
}

export function projectRealtimeVoiceTranscriptEvent(params: Readonly<{
    conversationSessionId: string | null;
    payload: unknown;
}>): void {
    const conversationSessionId = normalizeText(params.conversationSessionId);
    if (!conversationSessionId) return;
    const payload = readVoiceTranscriptEvent(params.payload);
    if (!payload) return;
    const payloadRecord = payload as Readonly<Record<string, unknown>>;
    const payloadType = normalizeText(payloadRecord.type);
    const turn = readVoiceTranscriptTurn(payloadRecord);

    if (payloadType === 'user_transcript') {
        const userTranscriptionEvent = readRecord(payloadRecord.user_transcription_event);
        const text = normalizeText(userTranscriptionEvent?.user_transcript ?? payloadRecord.user_transcript ?? payloadRecord.transcript);
        if (!text) return;
        appendVoiceConversationUserText({ conversationSessionId, text, turn });
        return;
    }

    if (payloadType === 'agent_response') {
        const agentResponseEvent = readRecord(payloadRecord.agent_response_event);
        const text = normalizeText(agentResponseEvent?.agent_response ?? payloadRecord.agent_response ?? payloadRecord.transcript);
        if (!text) return;
        appendVoiceConversationAssistantText({ conversationSessionId, text, turn });
        return;
    }

    if (payloadType === 'agent_response_correction') {
        const correctionEvent = readRecord(payloadRecord.agent_response_correction_event);
        const text = normalizeText(
            correctionEvent?.corrected_agent_response ?? payloadRecord.corrected_agent_response,
        );
        if (!text) return;
        appendVoiceConversationNoteText({
            conversationSessionId,
            text: `Agent response corrected: ${text}`,
        });
        return;
    }

    if (payloadType === 'client_tool_call') {
        const toolCall = readRecord(payloadRecord.client_tool_call);
        const toolName = normalizeText(toolCall?.tool_name ?? payloadRecord.tool_name);
        if (!toolName) return;
        appendVoiceConversationNoteText({
            conversationSessionId,
            text: `Tool call: ${toolName}`,
        });
        return;
    }

    if (payloadType === 'agent_tool_response') {
        const toolResponse = readRecord(payloadRecord.agent_tool_response);
        const toolName = normalizeText(toolResponse?.tool_name ?? payloadRecord.tool_name);
        if (!toolName) return;
        const isError = toolResponse?.is_error === true || payloadRecord.is_error === true;
        appendVoiceConversationNoteText({
            conversationSessionId,
            text: `Tool result: ${toolName} ${isError ? 'failed' : 'succeeded'}`,
        });
        return;
    }

    const genericText = normalizeText(payloadRecord.message ?? payloadRecord.text ?? payloadRecord.transcript);
    const genericRole = readGenericRole(payloadRecord);
    if (!genericText || !genericRole) return;

    if (genericRole === 'user') {
        appendVoiceConversationUserText({ conversationSessionId, text: genericText, turn });
        return;
    }

    appendVoiceConversationAssistantText({ conversationSessionId, text: genericText, turn });
}
