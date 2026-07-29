import { readSystemSessionMetadataFromMetadata } from '@happier-dev/protocol';

import { readExternalSessionLink } from '@/sync/domains/session/external/readExternalSessionLink';
import { readVoiceSessionOwnerMetadataFromState } from '@/voice/shared/readVoiceSessionOwnerMetadata';

export const VOICE_CONVERSATION_SYSTEM_SESSION_KEY = 'voice_conversation';
export const VOICE_CONVERSATION_RETIRED_SYSTEM_SESSION_KEY = 'voice_conversation_retired';
/**
 * Released stable/preview Voice sessions used this marker. Keep this reader
 * only while those releases remain inside the supported upgrade window; every
 * successful ensure rewrites the session to `voice_conversation`.
 */
export const VOICE_CONVERSATION_LEGACY_SYSTEM_SESSION_KEY = 'voice_carrier';

export type VoiceConversationSystemSessionCandidate = Readonly<{
    session: any;
    sessionId: string;
    metadata: unknown;
    updatedAt: number;
    legacyLinked: boolean;
    legacySystemKey: boolean;
    reusable: boolean;
}>;

export function isVoiceConversationSystemSessionMetadata(metadata: unknown): boolean {
    const systemSession = readSystemSessionMetadataFromMetadata({ metadata });
    const key = String(systemSession?.key ?? '').trim();
    return systemSession?.hidden === true
        && (
            key === VOICE_CONVERSATION_SYSTEM_SESSION_KEY
            || key === VOICE_CONVERSATION_LEGACY_SYSTEM_SESSION_KEY
        );
}

/**
 * Activity custody includes retired Voice sessions while they still carry
 * actionable or unread state. Retirement prevents reuse; it must not strand
 * permissions or late results already owned by the session.
 */
export function isVoiceConversationCustodySessionMetadata(metadata: unknown): boolean {
    const systemSession = readSystemSessionMetadataFromMetadata({ metadata });
    const key = String(systemSession?.key ?? '').trim();
    return systemSession?.hidden === true
        && (
            key === VOICE_CONVERSATION_SYSTEM_SESSION_KEY
            || key === VOICE_CONVERSATION_LEGACY_SYSTEM_SESSION_KEY
            || key === VOICE_CONVERSATION_RETIRED_SYSTEM_SESSION_KEY
        );
}

function hasLegacyVoiceConversationSystemSessionKey(metadata: unknown): boolean {
    const systemSession = readSystemSessionMetadataFromMetadata({ metadata });
    return systemSession?.hidden === true
        && String(systemSession.key ?? '').trim() === VOICE_CONVERSATION_LEGACY_SYSTEM_SESSION_KEY;
}

export function resolveVoiceConversationSessionMetadataFromState(state: any, sessionId: string): unknown {
    return readVoiceSessionOwnerMetadataFromState(state, sessionId);
}

export function shouldRetireLegacyVoiceConversationSession(session: any): boolean {
    if (!session || typeof session !== 'object') return false;
    const metadata = 'metadata' in session ? session.metadata ?? null : session;
    return readExternalSessionLink(metadata) !== null;
}

export function isReusableVoiceConversationRuntimeSession(session: any): boolean {
    if (!session || typeof session !== 'object') return false;
    return session.active === true;
}

function buildVoiceConversationSystemSessionCandidate(
    state: any,
    session: any,
): VoiceConversationSystemSessionCandidate | null {
    if (!session || typeof session.id !== 'string') return null;
    const metadata = resolveVoiceConversationSessionMetadataFromState(state, session.id);
    if (!isVoiceConversationSystemSessionMetadata(metadata)) return null;

    return {
        session,
        sessionId: session.id,
        metadata,
        updatedAt: typeof session.updatedAt === 'number' && Number.isFinite(session.updatedAt) ? session.updatedAt : 0,
        legacyLinked: shouldRetireLegacyVoiceConversationSession({ metadata }),
        legacySystemKey: hasLegacyVoiceConversationSystemSessionKey(metadata),
        reusable: isReusableVoiceConversationRuntimeSession(session),
    };
}

export function listVoiceConversationSystemSessions(
    state: any,
): ReadonlyArray<VoiceConversationSystemSessionCandidate> {
    const sessionsObj = state?.sessions ?? {};
    const candidates: VoiceConversationSystemSessionCandidate[] = [];

    for (const session of Object.values(sessionsObj) as any[]) {
        const candidate = buildVoiceConversationSystemSessionCandidate(state, session);
        if (!candidate) continue;
        candidates.push(candidate);
    }

    return candidates;
}

export function findPreferredVoiceConversationSystemSession(
    state: any,
    predicate?: (candidate: VoiceConversationSystemSessionCandidate) => boolean,
): VoiceConversationSystemSessionCandidate | null {
    let best: VoiceConversationSystemSessionCandidate | null = null;

    for (const candidate of listVoiceConversationSystemSessions(state)) {
        if (predicate && !predicate(candidate)) continue;
        if (
            !best
            || candidate.updatedAt > best.updatedAt
            || (candidate.updatedAt === best.updatedAt && candidate.sessionId < best.sessionId)
        ) {
            best = candidate;
        }
    }

    return best;
}

export function findReusableVoiceConversationRuntimeSessionId(state: any): string | null {
    return findPreferredVoiceConversationSystemSession(
        state,
        (candidate) => !candidate.legacyLinked && candidate.reusable,
    )?.sessionId ?? null;
}

export function findVoiceConversationSessionId(state: any): string | null {
    return findPreferredVoiceConversationSystemSession(
        state,
        (candidate) => !candidate.legacyLinked,
    )?.sessionId ?? null;
}
