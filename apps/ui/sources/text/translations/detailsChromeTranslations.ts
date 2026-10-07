// Tooling aggregate. Product locale roots import only their locale payload.
import { detailsChromeTranslations as en } from './features/en';
import { detailsChromeTranslations as ca } from './features/ca';
import { detailsChromeTranslations as de } from './features/de';
import { detailsChromeTranslations as es } from './features/es';
import { detailsChromeTranslations as fr } from './features/fr';
import { detailsChromeTranslations as it } from './features/it';
import { detailsChromeTranslations as ja } from './features/ja';
import { detailsChromeTranslations as pl } from './features/pl';
import { detailsChromeTranslations as pt } from './features/pt';
import { detailsChromeTranslations as ru } from './features/ru';
import { detailsChromeTranslations as zh_Hans } from './features/zh-Hans';
import { detailsChromeTranslations as zh_Hant } from './features/zh-Hant';

export const detailsChromeTranslations = {
    ...en.detailsChromeTranslations,
    ...ca.detailsChromeTranslations,
    ...de.detailsChromeTranslations,
    ...es.detailsChromeTranslations,
    ...fr.detailsChromeTranslations,
    ...it.detailsChromeTranslations,
    ...ja.detailsChromeTranslations,
    ...pl.detailsChromeTranslations,
    ...pt.detailsChromeTranslations,
    ...ru.detailsChromeTranslations,
    ...zh_Hans.detailsChromeTranslations,
    ...zh_Hant.detailsChromeTranslations,
};
