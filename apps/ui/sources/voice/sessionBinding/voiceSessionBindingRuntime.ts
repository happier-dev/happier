import { storage } from '@/sync/domains/state/storage';
import { sync } from '@/sync/sync';

import { ensureVoiceConversationBindingResolution } from './resolveVoiceConversationSessionId';
import { writeVoiceConversationBindingMetadata } from './voiceConversationBindingMetadata';
import { createVoiceSessionBindingManager } from './voiceSessionBindingManager';
import { appendVoiceTargetSessionSwitchNote } from './voiceSessionTargetAnnotations';

export const voiceSessionBindingManager = createVoiceSessionBindingManager({
  resolveBinding: ({ adapterId, controlSessionId, requestedTargetSessionId }) =>
    ensureVoiceConversationBindingResolution({
      providerId: adapterId,
      controlSessionId,
      requestedTargetSessionId,
      settings: storage.getState().settings,
    }),
  persistBinding: async (binding) => {
    await sync.patchSessionMetadataWithRetry(binding.conversationSessionId, (metadata: any) =>
      writeVoiceConversationBindingMetadata(metadata, binding),
    );
  },
  appendTargetSwitchNote: appendVoiceTargetSessionSwitchNote,
});
