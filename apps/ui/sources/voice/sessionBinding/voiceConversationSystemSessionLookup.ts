import { readSystemSessionMetadataFromMetadata } from '@happier-dev/protocol';

import { readDirectSessionLink } from '@/sync/domains/session/directSessions/readDirectSessionLink';

export const VOICE_CONVERSATION_SYSTEM_SESSION_KEY = 'voice_conversation';
export const VOICE_CONVERSATION_RETIRED_SYSTEM_SESSION_KEY = 'voice_conversation_retired';
export const VOICE_CARRIER_LEGACY_SYSTEM_SESSION_KEY = 'voice_carrier';

export function isVoiceConversationSystemSessionMetadata(metadata: unknown): boolean {
    const systemSession = readSystemSessionMetadataFromMetadata({ metadata });
    const key = String(systemSession?.key ?? '');
    return (
        systemSession?.hidden === true
        && (key === VOICE_CONVERSATION_SYSTEM_SESSION_KEY || key === VOICE_CARRIER_LEGACY_SYSTEM_SESSION_KEY)
    );
}

function shouldRetireLegacyVoiceConversationSession(session: any): boolean {
    if (!session || typeof session !== 'object') return false;
    return readDirectSessionLink(session.metadata ?? null) !== null;
}

function isReusableVoiceConversationRuntimeSession(session: any): boolean {
    if (!session || typeof session !== 'object') return false;
    return session.active === true;
}

export function findReusableVoiceConversationRuntimeSessionId(state: any): string | null {
    const sessionsObj = state?.sessions ?? {};
    let best: { id: string; updatedAt: number } | null = null;

    for (const session of Object.values(sessionsObj) as any[]) {
        if (!session || typeof session.id !== 'string') continue;
        if (!isVoiceConversationSystemSessionMetadata(session.metadata ?? null)) continue;
        if (shouldRetireLegacyVoiceConversationSession(session)) continue;
        if (!isReusableVoiceConversationRuntimeSession(session)) continue;

        const updatedAt = typeof session.updatedAt === 'number' && Number.isFinite(session.updatedAt) ? session.updatedAt : 0;
        if (!best || updatedAt > best.updatedAt || (updatedAt === best.updatedAt && session.id < best.id)) {
            best = { id: session.id, updatedAt };
        }
    }

    return best?.id ?? null;
}

export function findVoiceConversationSessionId(state: any): string | null {
    const sessionsObj = state?.sessions ?? {};
    let best: { id: string; updatedAt: number } | null = null;

    for (const session of Object.values(sessionsObj) as any[]) {
        if (!session || typeof session.id !== 'string') continue;
        if (!isVoiceConversationSystemSessionMetadata(session.metadata ?? null)) continue;
        if (shouldRetireLegacyVoiceConversationSession(session)) continue;

        const updatedAt = typeof session.updatedAt === 'number' && Number.isFinite(session.updatedAt) ? session.updatedAt : 0;
        if (!best || updatedAt > best.updatedAt || (updatedAt === best.updatedAt && session.id < best.id)) {
            best = { id: session.id, updatedAt };
        }
    }

    return best?.id ?? null;
}
