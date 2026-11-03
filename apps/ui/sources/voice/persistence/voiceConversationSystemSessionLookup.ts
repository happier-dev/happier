import { readSystemSessionMetadataFromMetadata } from '@happier-dev/protocol/sessions/control/contract';
import {
    isVoiceConversationCustodySessionMetadata as isFullVoiceConversationCustodySessionMetadata,
} from '@happier-dev/protocol/voice/sessionBinding';

import { readExternalSessionLink } from '@/sync/domains/session/external/readExternalSessionLink';
import { readVoiceSessionOwnerMetadataFromState } from '@/voice/shared/readVoiceSessionOwnerMetadata';

export {
    isVoiceConversationSystemSessionMetadata,
    VOICE_CONVERSATION_SYSTEM_SESSION_KEY,
    VOICE_CONVERSATION_RETIRED_SYSTEM_SESSION_KEY,
    VOICE_CONVERSATION_LEGACY_SYSTEM_SESSION_KEY,
} from '@happier-dev/protocol/voice/sessionBinding';

/**
 * Activity custody includes retired Voice sessions while they still carry
 * actionable or unread state. Retirement prevents reuse; it must not strand
 * permissions or late results already owned by the session.
 */
export function isVoiceConversationCustodySessionMetadata(metadata: unknown): boolean {
    const systemSession = readSystemSessionMetadataFromMetadata({ metadata });
    if (systemSession) return isFullVoiceConversationCustodySessionMetadata(metadata);
    return typeof metadata === 'object' && metadata !== null
        && 'hiddenSystemSession' in metadata && metadata.hiddenSystemSession === true
        && 'systemSessionKind' in metadata && metadata.systemSessionKind === 'voice_custody';
}

export function resolveVoiceConversationSessionMetadataFromState(state: any, sessionId: string): unknown {
    return readVoiceSessionOwnerMetadataFromState(state, sessionId);
}

export function shouldRetireLegacyVoiceConversationSession(session: any): boolean {
    if (!session || typeof session !== 'object') return false;
    const metadata = 'metadata' in session ? session.metadata ?? null : session;
    return readExternalSessionLink(metadata) !== null;
}
