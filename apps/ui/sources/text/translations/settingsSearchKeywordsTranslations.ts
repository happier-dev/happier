// Tooling aggregate. Product locale roots import only their locale payload.
import { settingsSearchKeywordsTranslations as en } from './features/en';
import { settingsSearchKeywordsTranslations as ca } from './features/ca';
import { settingsSearchKeywordsTranslations as de } from './features/de';
import { settingsSearchKeywordsTranslations as es } from './features/es';
import { settingsSearchKeywordsTranslations as fr } from './features/fr';
import { settingsSearchKeywordsTranslations as it } from './features/it';
import { settingsSearchKeywordsTranslations as ja } from './features/ja';
import { settingsSearchKeywordsTranslations as pl } from './features/pl';
import { settingsSearchKeywordsTranslations as pt } from './features/pt';
import { settingsSearchKeywordsTranslations as ru } from './features/ru';
import { settingsSearchKeywordsTranslations as zh_Hans } from './features/zh-Hans';
import { settingsSearchKeywordsTranslations as zh_Hant } from './features/zh-Hant';

export const settingsSearchKeywordsTranslations = {
    ...en.settingsSearchKeywordsTranslations,
    ...ca.settingsSearchKeywordsTranslations,
    ...de.settingsSearchKeywordsTranslations,
    ...es.settingsSearchKeywordsTranslations,
    ...fr.settingsSearchKeywordsTranslations,
    ...it.settingsSearchKeywordsTranslations,
    ...ja.settingsSearchKeywordsTranslations,
    ...pl.settingsSearchKeywordsTranslations,
    ...pt.settingsSearchKeywordsTranslations,
    ...ru.settingsSearchKeywordsTranslations,
    ...zh_Hans.settingsSearchKeywordsTranslations,
    ...zh_Hant.settingsSearchKeywordsTranslations,
};
