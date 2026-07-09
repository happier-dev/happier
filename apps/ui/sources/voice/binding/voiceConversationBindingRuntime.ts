import { storage } from '@/sync/domains/state/storage';
import { sync } from '@/sync/sync';

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
    persistBinding: async (binding) => {
        await sync.patchSessionMetadataWithRetry(binding.conversationSessionId, (metadata: any) =>
            writeVoiceConversationBindingMetadata(metadata, binding),
        );
    },
    appendTargetSwitchNote: appendVoiceTargetSessionSwitchNote,
});
