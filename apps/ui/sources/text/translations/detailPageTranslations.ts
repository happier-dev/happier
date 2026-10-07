// Tooling aggregate. Product locale roots import only their locale payload.
import { detailPageTranslations as en } from './features/en';
import { detailPageTranslations as ca } from './features/ca';
import { detailPageTranslations as de } from './features/de';
import { detailPageTranslations as es } from './features/es';
import { detailPageTranslations as fr } from './features/fr';
import { detailPageTranslations as it } from './features/it';
import { detailPageTranslations as ja } from './features/ja';
import { detailPageTranslations as pl } from './features/pl';
import { detailPageTranslations as pt } from './features/pt';
import { detailPageTranslations as ru } from './features/ru';
import { detailPageTranslations as zh_Hans } from './features/zh-Hans';
import { detailPageTranslations as zh_Hant } from './features/zh-Hant';

export const detailPageTranslations = {
    ...en.detailPageTranslations,
    ...ca.detailPageTranslations,
    ...de.detailPageTranslations,
    ...es.detailPageTranslations,
    ...fr.detailPageTranslations,
    ...it.detailPageTranslations,
    ...ja.detailPageTranslations,
    ...pl.detailPageTranslations,
    ...pt.detailPageTranslations,
    ...ru.detailPageTranslations,
    ...zh_Hans.detailPageTranslations,
    ...zh_Hant.detailPageTranslations,
};
