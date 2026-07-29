import { storage } from '@/sync/domains/state/storage';
import { sync } from '@/sync/sync';
import { getVoiceAdapterRegistry } from '@/voice/session/voiceAdapterRegistry';

import { appendVoiceTargetSessionSwitchNote } from './appendVoiceTargetSessionSwitchNote';
import { createVoiceSessionBindingManager } from './voiceConversationBindingManager';
import { ensureVoiceConversationBindingResolution } from './resolveVoiceConversationBindingResolution';
import { voiceConversationBindingResolver } from './VoiceConversationBindingResolver';
import { writeVoiceConversationBindingMetadata } from './voiceConversationBindingMetadata';

export const voiceSessionBindingManager = createVoiceSessionBindingManager({
    resolveBinding: ({ adapterId, controlSessionId, requestedTargetSessionId }) =>
        ensureVoiceConversationBindingResolution({
            providerId: adapterId,
            controlSessionId,
            requestedTargetSessionId,
            settings: storage.getState().settings,
        }),
    resolveExistingBindingByConversationSessionId: (conversationSessionId) =>
        voiceConversationBindingResolver.resolveByConversationSessionId({ conversationSessionId }),
    resolveConversationTargeting: (adapterId) =>
        getVoiceAdapterRegistry().get(adapterId)?.conversationTargeting ?? 'route_target',
    persistBinding: async (binding) => {
        await sync.patchSessionMetadataWithRetry(binding.conversationSessionId, (metadata: any) =>
            writeVoiceConversationBindingMetadata(metadata, binding),
        );
    },
    appendTargetSwitchNote: appendVoiceTargetSessionSwitchNote,
});
