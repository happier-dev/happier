// Tooling aggregate. Product locale roots import only their locale payload.
import { embedSettingsTranslations as en } from './features/en';
import { embedSettingsTranslations as ca } from './features/ca';
import { embedSettingsTranslations as de } from './features/de';
import { embedSettingsTranslations as es } from './features/es';
import { embedSettingsTranslations as fr } from './features/fr';
import { embedSettingsTranslations as it } from './features/it';
import { embedSettingsTranslations as ja } from './features/ja';
import { embedSettingsTranslations as pl } from './features/pl';
import { embedSettingsTranslations as pt } from './features/pt';
import { embedSettingsTranslations as ru } from './features/ru';
import { embedSettingsTranslations as zh_Hans } from './features/zh-Hans';
import { embedSettingsTranslations as zh_Hant } from './features/zh-Hant';

export const embedSettingsTranslations = {
    ...en.embedSettingsTranslations,
    ...ca.embedSettingsTranslations,
    ...de.embedSettingsTranslations,
    ...es.embedSettingsTranslations,
    ...fr.embedSettingsTranslations,
    ...it.embedSettingsTranslations,
    ...ja.embedSettingsTranslations,
    ...pl.embedSettingsTranslations,
    ...pt.embedSettingsTranslations,
    ...ru.embedSettingsTranslations,
    ...zh_Hans.embedSettingsTranslations,
    ...zh_Hant.embedSettingsTranslations,
};
