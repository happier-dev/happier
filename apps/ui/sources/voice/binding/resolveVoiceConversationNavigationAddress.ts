import type { SessionAddress } from '@/sync/domains/session/sessionAddress';

import type { VoiceSessionBinding } from './voiceConversationBindingTypes';

/** Null names Voice History for a targetless runtime attempt, not an unqualified Session route. */
export function resolveVoiceConversationNavigationAddress(
    binding: Pick<VoiceSessionBinding, 'lifetime' | 'targetSessionAddress' | 'conversationSessionAddress'>,
): SessionAddress | null {
    return binding.lifetime === 'runtime_attempt'
        ? binding.targetSessionAddress
        : binding.conversationSessionAddress;
}
