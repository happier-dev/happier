import { storage } from '@/sync/domains/state/storage';

export function invalidatePersistentVoiceTranscript(): number | null {
    const state: any = storage.getState();
    const transcriptCfg = state?.settings?.voice?.adapters?.local_conversation?.agent?.transcript ?? null;
    if (transcriptCfg?.persistenceMode !== 'persistent') return null;
    if (typeof state?.applySettingsLocal !== 'function') return null;

    const currentEpochRaw = Number(transcriptCfg.epoch ?? 0);
    const currentEpoch = Number.isFinite(currentEpochRaw) && currentEpochRaw >= 0 ? Math.floor(currentEpochRaw) : 0;
    const nextEpoch = currentEpoch + 1;

    state.applySettingsLocal({
        voice: {
            adapters: {
                local_conversation: {
                    agent: {
                        transcript: {
                            epoch: nextEpoch,
                        },
                    },
                },
            },
        },
    });

    return nextEpoch;
}
