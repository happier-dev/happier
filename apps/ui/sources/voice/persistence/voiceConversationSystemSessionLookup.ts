import { readSystemSessionMetadataFromMetadata } from '@happier-dev/protocol';

import { readDirectSessionLink } from '@/sync/domains/session/external/readDirectSessionLink';
import { resolveSessionListPreferredSessionMetadataFromState } from '@/sync/domains/session/listing/sessionListLookupState';

export const VOICE_CONVERSATION_SYSTEM_SESSION_KEY = 'voice_conversation';
export const VOICE_CONVERSATION_RETIRED_SYSTEM_SESSION_KEY = 'voice_conversation_retired';

export type VoiceConversationSystemSessionCandidate = Readonly<{
    session: any;
    sessionId: string;
    metadata: unknown;
    updatedAt: number;
    legacyLinked: boolean;
    reusable: boolean;
}>;

export function isVoiceConversationSystemSessionMetadata(metadata: unknown): boolean {
    const systemSession = readSystemSessionMetadataFromMetadata({ metadata });
    const key = String(systemSession?.key ?? '').trim();
    return systemSession?.hidden === true && key === VOICE_CONVERSATION_SYSTEM_SESSION_KEY;
}

export function resolveVoiceConversationSessionMetadataFromState(state: any, sessionId: string): unknown {
    return resolveSessionListPreferredSessionMetadataFromState(state, sessionId) ?? state?.sessions?.[sessionId]?.metadata ?? null;
}

export function shouldRetireLegacyVoiceConversationSession(session: any): boolean {
    if (!session || typeof session !== 'object') return false;
    const metadata = 'metadata' in session ? session.metadata ?? null : session;
    return readDirectSessionLink(metadata) !== null;
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
