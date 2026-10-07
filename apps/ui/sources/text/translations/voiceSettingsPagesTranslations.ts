// Tooling aggregate. Product locale roots import only their locale payload.
import { voiceSettingsPagesTranslations as en } from './features/en';
import { voiceSettingsPagesTranslations as ca } from './features/ca';
import { voiceSettingsPagesTranslations as de } from './features/de';
import { voiceSettingsPagesTranslations as es } from './features/es';
import { voiceSettingsPagesTranslations as fr } from './features/fr';
import { voiceSettingsPagesTranslations as it } from './features/it';
import { voiceSettingsPagesTranslations as ja } from './features/ja';
import { voiceSettingsPagesTranslations as pl } from './features/pl';
import { voiceSettingsPagesTranslations as pt } from './features/pt';
import { voiceSettingsPagesTranslations as ru } from './features/ru';
import { voiceSettingsPagesTranslations as zh_Hans } from './features/zh-Hans';
import { voiceSettingsPagesTranslations as zh_Hant } from './features/zh-Hant';

export const voiceSettingsPagesTranslations = {
    ...en.voiceSettingsPagesTranslations,
    ...ca.voiceSettingsPagesTranslations,
    ...de.voiceSettingsPagesTranslations,
    ...es.voiceSettingsPagesTranslations,
    ...fr.voiceSettingsPagesTranslations,
    ...it.voiceSettingsPagesTranslations,
    ...ja.voiceSettingsPagesTranslations,
    ...pl.voiceSettingsPagesTranslations,
    ...pt.voiceSettingsPagesTranslations,
    ...ru.voiceSettingsPagesTranslations,
    ...zh_Hans.voiceSettingsPagesTranslations,
    ...zh_Hant.voiceSettingsPagesTranslations,
};
