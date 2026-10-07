// Tooling aggregate. Product locale roots import only their locale payload.
import { walkthroughStartTranslations as en } from './features/en';
import { walkthroughStartTranslations as ca } from './features/ca';
import { walkthroughStartTranslations as de } from './features/de';
import { walkthroughStartTranslations as es } from './features/es';
import { walkthroughStartTranslations as fr } from './features/fr';
import { walkthroughStartTranslations as it } from './features/it';
import { walkthroughStartTranslations as ja } from './features/ja';
import { walkthroughStartTranslations as pl } from './features/pl';
import { walkthroughStartTranslations as pt } from './features/pt';
import { walkthroughStartTranslations as ru } from './features/ru';
import { walkthroughStartTranslations as zh_Hans } from './features/zh-Hans';
import { walkthroughStartTranslations as zh_Hant } from './features/zh-Hant';

export const walkthroughStartTranslations = {
    ...en.walkthroughStartTranslations,
    ...ca.walkthroughStartTranslations,
    ...de.walkthroughStartTranslations,
    ...es.walkthroughStartTranslations,
    ...fr.walkthroughStartTranslations,
    ...it.walkthroughStartTranslations,
    ...ja.walkthroughStartTranslations,
    ...pl.walkthroughStartTranslations,
    ...pt.walkthroughStartTranslations,
    ...ru.walkthroughStartTranslations,
    ...zh_Hans.walkthroughStartTranslations,
    ...zh_Hant.walkthroughStartTranslations,
};
