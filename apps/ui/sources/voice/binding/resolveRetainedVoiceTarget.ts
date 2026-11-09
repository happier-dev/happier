import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import { resolveVoiceAgentSessionFromState } from '@/voice/agent/voiceAgentRunState';

/** Implicit continuation may retain a coding target until that Session is archived. */
export function resolveRetainedVoiceTarget(target: SessionAddress | null): SessionAddress | null {
    if (!target) return null;
    const session = resolveVoiceAgentSessionFromState(target);
    return session?.active === false || session?.archivedAt != null ? null : target;
}
