// Tooling aggregate. Product locale roots import only their locale payload.
import { sessionHomeFreshnessTranslations as en } from './features/en';
import { sessionHomeFreshnessTranslations as ca } from './features/ca';
import { sessionHomeFreshnessTranslations as de } from './features/de';
import { sessionHomeFreshnessTranslations as es } from './features/es';
import { sessionHomeFreshnessTranslations as fr } from './features/fr';
import { sessionHomeFreshnessTranslations as it } from './features/it';
import { sessionHomeFreshnessTranslations as ja } from './features/ja';
import { sessionHomeFreshnessTranslations as pl } from './features/pl';
import { sessionHomeFreshnessTranslations as pt } from './features/pt';
import { sessionHomeFreshnessTranslations as ru } from './features/ru';
import { sessionHomeFreshnessTranslations as zh_Hans } from './features/zh-Hans';
import { sessionHomeFreshnessTranslations as zh_Hant } from './features/zh-Hant';

export const sessionHomeFreshnessTranslations = {
    ...en.sessionHomeFreshnessTranslations,
    ...ca.sessionHomeFreshnessTranslations,
    ...de.sessionHomeFreshnessTranslations,
    ...es.sessionHomeFreshnessTranslations,
    ...fr.sessionHomeFreshnessTranslations,
    ...it.sessionHomeFreshnessTranslations,
    ...ja.sessionHomeFreshnessTranslations,
    ...pl.sessionHomeFreshnessTranslations,
    ...pt.sessionHomeFreshnessTranslations,
    ...ru.sessionHomeFreshnessTranslations,
    ...zh_Hans.sessionHomeFreshnessTranslations,
    ...zh_Hant.sessionHomeFreshnessTranslations,
};
