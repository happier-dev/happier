// Tooling aggregate. Product locale roots import only their locale payload.
import { externalSessionSettingsTranslations as en } from './features/en';
import { externalSessionSettingsTranslations as ca } from './features/ca';
import { externalSessionSettingsTranslations as de } from './features/de';
import { externalSessionSettingsTranslations as es } from './features/es';
import { externalSessionSettingsTranslations as fr } from './features/fr';
import { externalSessionSettingsTranslations as it } from './features/it';
import { externalSessionSettingsTranslations as ja } from './features/ja';
import { externalSessionSettingsTranslations as pl } from './features/pl';
import { externalSessionSettingsTranslations as pt } from './features/pt';
import { externalSessionSettingsTranslations as ru } from './features/ru';
import { externalSessionSettingsTranslations as zh_Hans } from './features/zh-Hans';
import { externalSessionSettingsTranslations as zh_Hant } from './features/zh-Hant';

export const externalSessionSettingsTranslations = {
    ...en.externalSessionSettingsTranslations,
    ...ca.externalSessionSettingsTranslations,
    ...de.externalSessionSettingsTranslations,
    ...es.externalSessionSettingsTranslations,
    ...fr.externalSessionSettingsTranslations,
    ...it.externalSessionSettingsTranslations,
    ...ja.externalSessionSettingsTranslations,
    ...pl.externalSessionSettingsTranslations,
    ...pt.externalSessionSettingsTranslations,
    ...ru.externalSessionSettingsTranslations,
    ...zh_Hans.externalSessionSettingsTranslations,
    ...zh_Hant.externalSessionSettingsTranslations,
};
