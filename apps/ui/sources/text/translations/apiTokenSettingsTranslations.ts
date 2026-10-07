// Tooling aggregate. Product locale roots import only their locale payload.
import { apiTokenSettingsTranslations as en } from './features/en';
import { apiTokenSettingsTranslations as ca } from './features/ca';
import { apiTokenSettingsTranslations as de } from './features/de';
import { apiTokenSettingsTranslations as es } from './features/es';
import { apiTokenSettingsTranslations as fr } from './features/fr';
import { apiTokenSettingsTranslations as it } from './features/it';
import { apiTokenSettingsTranslations as ja } from './features/ja';
import { apiTokenSettingsTranslations as pl } from './features/pl';
import { apiTokenSettingsTranslations as pt } from './features/pt';
import { apiTokenSettingsTranslations as ru } from './features/ru';
import { apiTokenSettingsTranslations as zh_Hans } from './features/zh-Hans';
import { apiTokenSettingsTranslations as zh_Hant } from './features/zh-Hant';

export const apiTokenSettingsTranslations = {
    ...en.apiTokenSettingsTranslations,
    ...ca.apiTokenSettingsTranslations,
    ...de.apiTokenSettingsTranslations,
    ...es.apiTokenSettingsTranslations,
    ...fr.apiTokenSettingsTranslations,
    ...it.apiTokenSettingsTranslations,
    ...ja.apiTokenSettingsTranslations,
    ...pl.apiTokenSettingsTranslations,
    ...pt.apiTokenSettingsTranslations,
    ...ru.apiTokenSettingsTranslations,
    ...zh_Hans.apiTokenSettingsTranslations,
    ...zh_Hant.apiTokenSettingsTranslations,
};
