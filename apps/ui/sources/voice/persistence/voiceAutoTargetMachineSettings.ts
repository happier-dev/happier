import { storage } from '@/sync/domains/state/storage';
import { normalizeNonEmptyString } from '@/voice/shared/normalizeNonEmptyString';
import { voiceSettingsParse } from '@/sync/domains/settings/voiceSettings';
import { accountSettingsScopeKeySuffix, type AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';
import { useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';

type VoiceTargetSettingsState = Readonly<{
    settings?: Readonly<{ voice?: unknown }>;
    settingsScope?: AccountSettingsScope | null;
}>;

export function readVoiceAutoTargetMachineId(state: VoiceTargetSettingsState): string | null {
    const target = voiceSettingsParse(state?.settings?.voice).executionMachine;
    if ((normalizeNonEmptyString(target?.mode) ?? 'auto') !== 'auto') return null;
    if (state.settingsScope) {
        const key = accountSettingsScopeKeySuffix(state.settingsScope);
        const memory = useVoiceTargetStore.getState().autoTargetMachineByScope;
        if (Object.hasOwn(memory, key)) return memory[key] ?? null;
    }
    return null;
}

export function persistVoiceAutoTargetMachineId(
    machineId: string | null,
    expectedSettingsScope: AccountSettingsScope | null,
): void {
    const normalizedMachineId = normalizeNonEmptyString(machineId);
    const state = storage.getState();
    if (!state?.settings?.voice) return;
    const voiceSettings = voiceSettingsParse(state.settings.voice);
    const executionMachine = voiceSettings.executionMachine;
    if ((normalizeNonEmptyString(executionMachine.mode) ?? 'auto') !== 'auto') return;
    const scope = expectedSettingsScope ?? state.settingsScope;
    if (!scope) return;
    useVoiceTargetStore.getState().rememberAutoTargetMachine(scope, normalizedMachineId);
}
