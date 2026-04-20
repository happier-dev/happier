import { describe, expect, it } from 'vitest';

import { VOICE_MACHINE_ERROR_TRANSLATION_KEYS } from '@/voice/runtime/machine/voiceMachineErrorCopy';

import { ca } from './translations/ca';
import { en } from './translations/en';
import { es } from './translations/es';
import { it as itLocale } from './translations/it';
import { ja } from './translations/ja';
import { pl } from './translations/pl';
import { pt } from './translations/pt';
import { ru } from './translations/ru';
import { zhHans } from './translations/zh-Hans';
import { zhHant } from './translations/zh-Hant';

type VoiceMachineErrorKey = keyof typeof VOICE_MACHINE_ERROR_TRANSLATION_KEYS;

type VoiceTranslationLocale = Readonly<{
    settingsVoice: Readonly<{
        local: Readonly<{
            machineErrors: Readonly<Record<VoiceMachineErrorKey, string>>;
        }>;
    }>;
}>;

const supportedLocales = [
    { code: 'en', root: en },
    { code: 'ru', root: ru },
    { code: 'pl', root: pl },
    { code: 'es', root: es },
    { code: 'it', root: itLocale },
    { code: 'pt', root: pt },
    { code: 'ca', root: ca },
    { code: 'zh-Hans', root: zhHans },
    { code: 'zh-Hant', root: zhHant },
    { code: 'ja', root: ja },
] satisfies ReadonlyArray<Readonly<{ code: string; root: VoiceTranslationLocale }>>;

describe('voice machine error translations', () => {
    it('keeps machine error labels present in every supported locale', () => {
        for (const { code, root } of supportedLocales) {
            const machineErrors = root.settingsVoice?.local?.machineErrors;
            if (!machineErrors) {
                throw new Error(`${code}: settingsVoice.local.machineErrors is missing`);
            }
            for (const key of Object.keys(VOICE_MACHINE_ERROR_TRANSLATION_KEYS) as VoiceMachineErrorKey[]) {
                expect(machineErrors[key], `${code}.${key}`).toEqual(expect.any(String));
                expect(machineErrors[key].trim(), `${code}.${key}`).not.toHaveLength(0);
            }
        }
    });
});
