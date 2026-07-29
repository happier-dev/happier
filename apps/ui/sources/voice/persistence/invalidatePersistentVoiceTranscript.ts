import { storage } from '@/sync/domains/state/storage';
import { normalizeNonEmptyString } from '@/voice/shared/normalizeNonEmptyString';
import {
    readLocalConversationVoiceSettings,
    voiceSettingsParse,
    writeLocalConversationVoiceSettings,
} from '@/sync/domains/settings/voiceSettings';

export function invalidatePersistentVoiceTranscript(): number | null {
    const state: any = storage.getState();
    const voice = voiceSettingsParse(state?.settings?.voice);
    const localConversation = readLocalConversationVoiceSettings(voice);
    const transcriptCfg = localConversation.agent.transcript;
    if (normalizeNonEmptyString(transcriptCfg?.persistenceMode) !== 'persistent') return null;
    if (typeof state?.applySettingsLocal !== 'function') return null;

    const currentEpochRaw = Number(transcriptCfg.epoch ?? 0);
    const currentEpoch = Number.isFinite(currentEpochRaw) && currentEpochRaw >= 0 ? Math.floor(currentEpochRaw) : 0;
    const nextEpoch = currentEpoch + 1;

    state.applySettingsLocal({
        voice: writeLocalConversationVoiceSettings(voice, {
            ...localConversation,
            agent: {
                ...localConversation.agent,
                transcript: {
                    ...localConversation.agent.transcript,
                    epoch: nextEpoch,
                },
            },
        }),
    });

    return nextEpoch;
}
