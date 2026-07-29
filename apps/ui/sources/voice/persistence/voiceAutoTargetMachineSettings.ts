import { storage } from '@/sync/domains/state/storage';
import { normalizeNonEmptyString } from '@/voice/shared/normalizeNonEmptyString';
import { voiceSettingsParse } from '@/sync/domains/settings/voiceSettings';

export function readVoiceAutoTargetMachineId(state: any): string | null {
    const target = voiceSettingsParse(state?.settings?.voice).executionMachine;
    if ((normalizeNonEmptyString(target?.mode) ?? 'auto') !== 'auto') return null;
    return normalizeNonEmptyString(target?.autoMachineId);
}

export function persistVoiceAutoTargetMachineId(machineId: string | null): void {
    const normalizedMachineId = normalizeNonEmptyString(machineId);
    const state: any = storage.getState();
    if (!state?.settings?.voice) return;
    const voiceSettings = voiceSettingsParse(state.settings.voice);
    const executionMachine = voiceSettings.executionMachine;
    if ((normalizeNonEmptyString(executionMachine.mode) ?? 'auto') !== 'auto') return;
    if (normalizeNonEmptyString(executionMachine.autoMachineId) === normalizedMachineId) return;

    state.applySettingsLocal?.({
        voice: {
            ...voiceSettings,
            executionMachine: {
                ...executionMachine,
                autoMachineId: normalizedMachineId,
            },
        },
    });
}
