// Tooling aggregate. Product locale roots import only their locale payload.
import { homeSettingsTranslations as en } from './features/en';
import { homeSettingsTranslations as ca } from './features/ca';
import { homeSettingsTranslations as de } from './features/de';
import { homeSettingsTranslations as es } from './features/es';
import { homeSettingsTranslations as fr } from './features/fr';
import { homeSettingsTranslations as it } from './features/it';
import { homeSettingsTranslations as ja } from './features/ja';
import { homeSettingsTranslations as pl } from './features/pl';
import { homeSettingsTranslations as pt } from './features/pt';
import { homeSettingsTranslations as ru } from './features/ru';
import { homeSettingsTranslations as zh_Hans } from './features/zh-Hans';
import { homeSettingsTranslations as zh_Hant } from './features/zh-Hant';

export const homeSettingsTranslations = {
    ...en.homeSettingsTranslations,
    ...ca.homeSettingsTranslations,
    ...de.homeSettingsTranslations,
    ...es.homeSettingsTranslations,
    ...fr.homeSettingsTranslations,
    ...it.homeSettingsTranslations,
    ...ja.homeSettingsTranslations,
    ...pl.homeSettingsTranslations,
    ...pt.homeSettingsTranslations,
    ...ru.homeSettingsTranslations,
    ...zh_Hans.homeSettingsTranslations,
    ...zh_Hant.homeSettingsTranslations,
};
