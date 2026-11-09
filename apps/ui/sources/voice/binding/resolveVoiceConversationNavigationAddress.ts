import type { SessionAddress } from '@/sync/domains/session/sessionAddress';

import type { VoiceSessionBinding } from './voiceConversationBindingTypes';

/** Direct-media calls prefer their coding target and otherwise open their retained transcript carrier. */
export function resolveVoiceConversationNavigationAddress(
    binding: Pick<VoiceSessionBinding, 'lifetime' | 'targetSessionAddress' | 'conversationSessionAddress'>,
): SessionAddress | null {
    return binding.lifetime === 'runtime_attempt'
        ? binding.targetSessionAddress ?? binding.conversationSessionAddress
        : binding.conversationSessionAddress;
}
