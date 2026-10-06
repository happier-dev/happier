import { z } from 'zod';
import type { SettingStorageBinding } from '@/components/settings/catalog/settingDeclarations';
import type { VoiceSettings } from '@/sync/domains/settings/voiceSettings';

const choiceSchema = z.string().trim().min(1);

/** Same Automatic/reset and fixed-target intent used by the existing machine picker. */
export function applyVoiceExecutionMachineChoice(voice: VoiceSettings, choice: string): VoiceSettings {
    const machineId = choiceSchema.parse(choice);
    return {
        ...voice,
        executionMachine: machineId === 'auto'
            ? { mode: 'auto', machineId: null }
            : { ...voice.executionMachine, mode: 'fixed', machineId },
    };
}

export const voiceExecutionMachineBinding: SettingStorageBinding = {
    scope: 'account', kind: 'owner', access: 'read_write',
    read: (settings) => settings.voice.executionMachine.mode === 'fixed' ? settings.voice.executionMachine.machineId : 'auto',
    parse: (value) => {
        const parsed = choiceSchema.safeParse(value);
        return parsed.success ? { success: true, value: parsed.data } : { success: false };
    },
    mutate: (settings, value) => ({ voice: applyVoiceExecutionMachineChoice(settings.voice, choiceSchema.parse(value)) }),
};
