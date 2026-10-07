// Tooling aggregate. Product locale roots import only their locale payload.
import { settingsOverviewTranslations as en } from './features/en';
import { settingsOverviewTranslations as ca } from './features/ca';
import { settingsOverviewTranslations as de } from './features/de';
import { settingsOverviewTranslations as es } from './features/es';
import { settingsOverviewTranslations as fr } from './features/fr';
import { settingsOverviewTranslations as it } from './features/it';
import { settingsOverviewTranslations as ja } from './features/ja';
import { settingsOverviewTranslations as pl } from './features/pl';
import { settingsOverviewTranslations as pt } from './features/pt';
import { settingsOverviewTranslations as ru } from './features/ru';
import { settingsOverviewTranslations as zh_Hans } from './features/zh-Hans';
import { settingsOverviewTranslations as zh_Hant } from './features/zh-Hant';

export const settingsOverviewTranslations = {
    ...en.settingsOverviewTranslations,
    ...ca.settingsOverviewTranslations,
    ...de.settingsOverviewTranslations,
    ...es.settingsOverviewTranslations,
    ...fr.settingsOverviewTranslations,
    ...it.settingsOverviewTranslations,
    ...ja.settingsOverviewTranslations,
    ...pl.settingsOverviewTranslations,
    ...pt.settingsOverviewTranslations,
    ...ru.settingsOverviewTranslations,
    ...zh_Hans.settingsOverviewTranslations,
    ...zh_Hant.settingsOverviewTranslations,
};
