import { storage } from '@/sync/domains/state/storage';
import { normalizeNonEmptyString } from '@/voice/shared/normalizeNonEmptyString';

export function readVoiceAutoTargetMachineId(state: any): string | null {
    const agentCfg: any = state?.settings?.voice?.adapters?.local_conversation?.agent ?? {};
    if ((agentCfg?.machineTargetMode ?? 'auto') !== 'auto') return null;
    return normalizeNonEmptyString(agentCfg?.autoTargetMachineId);
}

export function persistVoiceAutoTargetMachineId(machineId: string | null): void {
    const normalizedMachineId = normalizeNonEmptyString(machineId);
    const state: any = storage.getState();
    const voiceSettings = state?.settings?.voice ?? null;
    const localConversation = voiceSettings?.adapters?.local_conversation ?? null;
    const agent = localConversation?.agent ?? null;
    if (!voiceSettings || !localConversation || !agent) return;
    if ((agent.machineTargetMode ?? 'auto') !== 'auto') return;
    if (normalizeNonEmptyString(agent.autoTargetMachineId) === normalizedMachineId) return;

    state.applySettingsLocal?.({
        voice: {
            ...voiceSettings,
            adapters: {
                ...voiceSettings.adapters,
                local_conversation: {
                    ...localConversation,
                    agent: {
                        ...agent,
                        autoTargetMachineId: normalizedMachineId,
                    },
                },
            },
        },
    });
}
