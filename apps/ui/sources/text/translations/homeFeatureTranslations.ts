// Tooling aggregate. Product locale roots import only their locale payload.
import { homeFeatureTranslations as en } from './features/en';
import { homeFeatureTranslations as ca } from './features/ca';
import { homeFeatureTranslations as de } from './features/de';
import { homeFeatureTranslations as es } from './features/es';
import { homeFeatureTranslations as fr } from './features/fr';
import { homeFeatureTranslations as it } from './features/it';
import { homeFeatureTranslations as ja } from './features/ja';
import { homeFeatureTranslations as pl } from './features/pl';
import { homeFeatureTranslations as pt } from './features/pt';
import { homeFeatureTranslations as ru } from './features/ru';
import { homeFeatureTranslations as zh_Hans } from './features/zh-Hans';
import { homeFeatureTranslations as zh_Hant } from './features/zh-Hant';

export const homeFeatureTranslations = {
    ...en.homeFeatureTranslations,
    ...ca.homeFeatureTranslations,
    ...de.homeFeatureTranslations,
    ...es.homeFeatureTranslations,
    ...fr.homeFeatureTranslations,
    ...it.homeFeatureTranslations,
    ...ja.homeFeatureTranslations,
    ...pl.homeFeatureTranslations,
    ...pt.homeFeatureTranslations,
    ...ru.homeFeatureTranslations,
    ...zh_Hans.homeFeatureTranslations,
    ...zh_Hant.homeFeatureTranslations,
};
