import { usePathname } from '@/components/appShell/workspace/destinationRoute';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import type { SettingRef } from '@/components/settings/catalog/settingDeclarations';
import { VOICE_CONVERSATIONS_SETTINGS, VOICE_DICTATION_SETTINGS } from './voiceSettingsDeclarations';

export function getVoiceLocalNeuralSttSettingRefs(settings: Readonly<Record<string, SettingRef>>) {
    return Object.entries(settings).filter(([id]) => id.startsWith('stt') && id !== 'sttProvider').map(([, setting]) => setting);
}

const dictationSttSettings = {
    ...VOICE_DICTATION_SETTINGS.settings,
    sttLanguage: VOICE_DICTATION_SETTINGS.settings.language,
};

/** Shared recognizer rows retain the identity of the intent page that renders them. */
export function useVoiceSttPurpose(): 'dictation' | 'conversation' {
    return usePathname() === SETTINGS_ROUTES.voiceDictation ? 'dictation' : 'conversation';
}

export function useVoiceSttSettingRefs() {
    return useVoiceSttPurpose() === 'dictation'
        ? dictationSttSettings
        : VOICE_CONVERSATIONS_SETTINGS.settings;
}
