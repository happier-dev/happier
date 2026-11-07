import { readLocalConversationVoiceSettings, voiceSettingsParse } from '@/sync/domains/settings/voiceSettings';
import { createUiSessionSpawnUserAttemptId } from '@/sync/domains/session/spawn/spawnSessionNonce';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';

import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { storage } from '@/sync/domains/state/storage';
import { readVoiceConversationHistory } from '@/voice/history/voiceConversationHistory';
import { readVoiceSessionOwnerMetadataFromState } from '@/voice/shared/readVoiceSessionOwnerMetadata';
import { resolveVoiceExecutionMachineSelectionFromState } from '@/voice/settings/executionMachine';
import type { VoiceConversationSelection } from './voiceConversationBindingTypes';

/** Default Start and passive Global readers share the Account Session-list identity. */
export function readLastVoiceConversationAddress(machineId?: string): SessionAddress | null {
    const scope = getActiveServerAccountScope();
    if (!scope) return null;
    const state = storage.getState();
    return readVoiceConversationHistory(state, { serverId: scope.serverId })
        .conversations.find(conversation => conversation.canContinue !== false
            && (machineId === undefined
                || readVoiceSessionOwnerMetadataFromState(state, conversation.address)?.machineId === machineId))?.address ?? null;
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
        // Implicit continuation consumes the same Machine as readiness and new
        // Home creation. An explicitly chosen conversation above keeps its owner.
        const executionMachine = resolveVoiceExecutionMachineSelectionFromState({
            ...storage.getState(), settings: input.settings,
        });
        const address = executionMachine.kind === 'none' ? null : readLastVoiceConversationAddress(executionMachine.machineId);
        if (address) return { kind: 'continue', conversationSessionAddress: address };
    }
    return { kind: 'new', creationKey: createUiSessionSpawnUserAttemptId() };
}
