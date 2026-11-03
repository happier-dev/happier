import { readLocalConversationVoiceSettings, voiceSettingsParse } from '@/sync/domains/settings/voiceSettings';
import { createUiSessionSpawnUserAttemptId } from '@/sync/domains/session/spawn/spawnSessionNonce';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';

import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { storage } from '@/sync/domains/state/storage';
import { readVoiceConversationHistory } from '@/voice/history/voiceConversationHistory';
import type { VoiceConversationSelection } from './voiceConversationBindingTypes';

/** Default Start and passive Global readers share the Account Session-list identity. */
export function readLastVoiceConversationAddress(): SessionAddress | null {
    const scope = getActiveServerAccountScope();
    if (!scope) return null;
    return readVoiceConversationHistory(storage.getState(), { serverId: scope.serverId })
        .conversations.find(conversation => conversation.canContinue !== false)?.address ?? null;
}

/** One policy owner for ordinary binding and provider-owned Global acquisition. */
export function resolveVoiceConversationSelection(input: Readonly<{
    settings: Readonly<{ voice?: unknown }>;
    conversationSelection?: VoiceConversationSelection;
    requestedConversationSessionAddress?: SessionAddress | null;
}>): VoiceConversationSelection {
    if (input.conversationSelection) return input.conversationSelection;
    if (input.requestedConversationSessionAddress) {
        return { kind: 'continue', conversationSessionAddress: input.requestedConversationSessionAddress };
    }
    if (readLocalConversationVoiceSettings(voiceSettingsParse(input.settings.voice)).agent.rootSessionPolicy === 'continue') {
        const address = readLastVoiceConversationAddress();
        if (address) return { kind: 'continue', conversationSessionAddress: address };
    }
    return { kind: 'new', creationKey: createUiSessionSpawnUserAttemptId() };
}
