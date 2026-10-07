// Tooling aggregate. Product locale roots import only their locale payload.
import { voiceProviderPrivacyTranslations as en } from './features/en';
import { voiceProviderPrivacyTranslations as ca } from './features/ca';
import { voiceProviderPrivacyTranslations as de } from './features/de';
import { voiceProviderPrivacyTranslations as es } from './features/es';
import { voiceProviderPrivacyTranslations as fr } from './features/fr';
import { voiceProviderPrivacyTranslations as it } from './features/it';
import { voiceProviderPrivacyTranslations as ja } from './features/ja';
import { voiceProviderPrivacyTranslations as pl } from './features/pl';
import { voiceProviderPrivacyTranslations as pt } from './features/pt';
import { voiceProviderPrivacyTranslations as ru } from './features/ru';
import { voiceProviderPrivacyTranslations as zh_Hans } from './features/zh-Hans';
import { voiceProviderPrivacyTranslations as zh_Hant } from './features/zh-Hant';

export const voiceProviderPrivacyTranslations = {
    ...en.voiceProviderPrivacyTranslations,
    ...ca.voiceProviderPrivacyTranslations,
    ...de.voiceProviderPrivacyTranslations,
    ...es.voiceProviderPrivacyTranslations,
    ...fr.voiceProviderPrivacyTranslations,
    ...it.voiceProviderPrivacyTranslations,
    ...ja.voiceProviderPrivacyTranslations,
    ...pl.voiceProviderPrivacyTranslations,
    ...pt.voiceProviderPrivacyTranslations,
    ...ru.voiceProviderPrivacyTranslations,
    ...zh_Hans.voiceProviderPrivacyTranslations,
    ...zh_Hant.voiceProviderPrivacyTranslations,
};
