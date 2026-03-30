function normalizeErrorCode(error: unknown): string | null {
    if (!error || typeof error !== 'object') return null;
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' && code.trim().length > 0 ? code.trim() : null;
}

function normalizeErrorMessage(error: unknown): string | null {
    if (error instanceof Error && error.message.trim().length > 0) return error.message.trim();
    if (typeof error === 'string' && error.trim().length > 0) return error.trim();
    return null;
}

export function formatVoiceQaErrorMessage(error: unknown, fallbackMessage: string): string {
    const errorCode = normalizeErrorCode(error);
    if (errorCode === 'VOICE_CONVERSATION_TARGET_MISSING') {
        return 'No local session or machine is available to start global local voice. Open or create a local session first, or enter a Session ID override.';
    }

    const errorMessage = normalizeErrorMessage(error);
    if (errorMessage === 'voice_qa_local_agent_requires_local_conversation_agent_mode') {
        return 'Local QA requires Local voice with conversation mode set to Agent.';
    }

    if (errorMessage === 'voice_conversation_session_target_missing') {
        return 'The selected local session or machine is unavailable for local voice. Open or create another local session, or reconnect the target machine daemon.';
    }

    return errorMessage ?? fallbackMessage;
}
