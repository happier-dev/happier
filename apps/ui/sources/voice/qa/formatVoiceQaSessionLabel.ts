import { getVoiceContextFormatterPrefs } from '@/voice/context/voiceContextPrefs';
import type { VoiceContextFormatterPrefs } from '@/voice/context/contextFormatters';
import { resolveVoiceSessionLabel } from '@/voice/context/resolveVoiceSessionLabel';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';

function normalizeSessionId(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

export function createVoiceQaFormatterPrefs(settings: unknown): VoiceContextFormatterPrefs {
    return getVoiceContextFormatterPrefs({ settings });
}

export function formatVoiceQaSessionLabel(
    sessionId: string | null | undefined,
    prefs: VoiceContextFormatterPrefs,
    options: Readonly<{
        emptyLabel: string;
        globalLabel: string;
        fallbackLabel: string;
    }>,
): string {
    const normalizedSessionId = normalizeSessionId(sessionId);
    if (!normalizedSessionId) return options.emptyLabel;
    if (normalizedSessionId === VOICE_AGENT_GLOBAL_SESSION_ID) return options.globalLabel;
    return resolveVoiceSessionLabel(normalizedSessionId, prefs, { fallbackLabel: options.fallbackLabel });
}
