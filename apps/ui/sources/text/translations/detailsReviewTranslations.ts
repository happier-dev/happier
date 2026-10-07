// Tooling aggregate. Product locale roots import only their locale payload.
import { detailsReviewTranslations as en } from './features/en';
import { detailsReviewTranslations as ca } from './features/ca';
import { detailsReviewTranslations as de } from './features/de';
import { detailsReviewTranslations as es } from './features/es';
import { detailsReviewTranslations as fr } from './features/fr';
import { detailsReviewTranslations as it } from './features/it';
import { detailsReviewTranslations as ja } from './features/ja';
import { detailsReviewTranslations as pl } from './features/pl';
import { detailsReviewTranslations as pt } from './features/pt';
import { detailsReviewTranslations as ru } from './features/ru';
import { detailsReviewTranslations as zh_Hans } from './features/zh-Hans';
import { detailsReviewTranslations as zh_Hant } from './features/zh-Hant';

export const detailsReviewTranslations = {
    ...en.detailsReviewTranslations,
    ...ca.detailsReviewTranslations,
    ...de.detailsReviewTranslations,
    ...es.detailsReviewTranslations,
    ...fr.detailsReviewTranslations,
    ...it.detailsReviewTranslations,
    ...ja.detailsReviewTranslations,
    ...pl.detailsReviewTranslations,
    ...pt.detailsReviewTranslations,
    ...ru.detailsReviewTranslations,
    ...zh_Hans.detailsReviewTranslations,
    ...zh_Hant.detailsReviewTranslations,
};
