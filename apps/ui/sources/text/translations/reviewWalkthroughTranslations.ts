// Tooling aggregate. Product locale roots import only their locale payload.
import { reviewWalkthroughTranslations as en } from './features/en';
import { reviewWalkthroughTranslations as ca } from './features/ca';
import { reviewWalkthroughTranslations as de } from './features/de';
import { reviewWalkthroughTranslations as es } from './features/es';
import { reviewWalkthroughTranslations as fr } from './features/fr';
import { reviewWalkthroughTranslations as it } from './features/it';
import { reviewWalkthroughTranslations as ja } from './features/ja';
import { reviewWalkthroughTranslations as pl } from './features/pl';
import { reviewWalkthroughTranslations as pt } from './features/pt';
import { reviewWalkthroughTranslations as ru } from './features/ru';
import { reviewWalkthroughTranslations as zh_Hans } from './features/zh-Hans';
import { reviewWalkthroughTranslations as zh_Hant } from './features/zh-Hant';

export const reviewWalkthroughTranslations = {
    ...en.reviewWalkthroughTranslations,
    ...ca.reviewWalkthroughTranslations,
    ...de.reviewWalkthroughTranslations,
    ...es.reviewWalkthroughTranslations,
    ...fr.reviewWalkthroughTranslations,
    ...it.reviewWalkthroughTranslations,
    ...ja.reviewWalkthroughTranslations,
    ...pl.reviewWalkthroughTranslations,
    ...pt.reviewWalkthroughTranslations,
    ...ru.reviewWalkthroughTranslations,
    ...zh_Hans.reviewWalkthroughTranslations,
    ...zh_Hant.reviewWalkthroughTranslations,
};
