// Tooling aggregate. Product locale roots import only their locale payload.
import { voiceReadinessTranslations as en } from './features/en';
import { voiceReadinessTranslations as ca } from './features/ca';
import { voiceReadinessTranslations as de } from './features/de';
import { voiceReadinessTranslations as es } from './features/es';
import { voiceReadinessTranslations as fr } from './features/fr';
import { voiceReadinessTranslations as it } from './features/it';
import { voiceReadinessTranslations as ja } from './features/ja';
import { voiceReadinessTranslations as pl } from './features/pl';
import { voiceReadinessTranslations as pt } from './features/pt';
import { voiceReadinessTranslations as ru } from './features/ru';
import { voiceReadinessTranslations as zh_Hans } from './features/zh-Hans';
import { voiceReadinessTranslations as zh_Hant } from './features/zh-Hant';

export const voiceReadinessTranslations = {
    ...en.voiceReadinessTranslations,
    ...ca.voiceReadinessTranslations,
    ...de.voiceReadinessTranslations,
    ...es.voiceReadinessTranslations,
    ...fr.voiceReadinessTranslations,
    ...it.voiceReadinessTranslations,
    ...ja.voiceReadinessTranslations,
    ...pl.voiceReadinessTranslations,
    ...pt.voiceReadinessTranslations,
    ...ru.voiceReadinessTranslations,
    ...zh_Hans.voiceReadinessTranslations,
    ...zh_Hant.voiceReadinessTranslations,
};
