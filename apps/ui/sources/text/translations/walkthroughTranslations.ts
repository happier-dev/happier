// Tooling aggregate. Product locale roots import only their locale payload.
import { walkthroughTranslations as en } from './features/en';
import { walkthroughTranslations as ca } from './features/ca';
import { walkthroughTranslations as de } from './features/de';
import { walkthroughTranslations as es } from './features/es';
import { walkthroughTranslations as fr } from './features/fr';
import { walkthroughTranslations as it } from './features/it';
import { walkthroughTranslations as ja } from './features/ja';
import { walkthroughTranslations as pl } from './features/pl';
import { walkthroughTranslations as pt } from './features/pt';
import { walkthroughTranslations as ru } from './features/ru';
import { walkthroughTranslations as zh_Hans } from './features/zh-Hans';
import { walkthroughTranslations as zh_Hant } from './features/zh-Hant';

export const walkthroughTranslations = {
    ...en.walkthroughTranslations,
    ...ca.walkthroughTranslations,
    ...de.walkthroughTranslations,
    ...es.walkthroughTranslations,
    ...fr.walkthroughTranslations,
    ...it.walkthroughTranslations,
    ...ja.walkthroughTranslations,
    ...pl.walkthroughTranslations,
    ...pt.walkthroughTranslations,
    ...ru.walkthroughTranslations,
    ...zh_Hans.walkthroughTranslations,
    ...zh_Hant.walkthroughTranslations,
};
