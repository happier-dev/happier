// Tooling aggregate. Product locale roots import only their locale payload.
import { walkthroughSavedTranslations as en } from './features/en';
import { walkthroughSavedTranslations as ca } from './features/ca';
import { walkthroughSavedTranslations as de } from './features/de';
import { walkthroughSavedTranslations as es } from './features/es';
import { walkthroughSavedTranslations as fr } from './features/fr';
import { walkthroughSavedTranslations as it } from './features/it';
import { walkthroughSavedTranslations as ja } from './features/ja';
import { walkthroughSavedTranslations as pl } from './features/pl';
import { walkthroughSavedTranslations as pt } from './features/pt';
import { walkthroughSavedTranslations as ru } from './features/ru';
import { walkthroughSavedTranslations as zh_Hans } from './features/zh-Hans';
import { walkthroughSavedTranslations as zh_Hant } from './features/zh-Hant';

export const walkthroughSavedTranslations = {
    ...en.walkthroughSavedTranslations,
    ...ca.walkthroughSavedTranslations,
    ...de.walkthroughSavedTranslations,
    ...es.walkthroughSavedTranslations,
    ...fr.walkthroughSavedTranslations,
    ...it.walkthroughSavedTranslations,
    ...ja.walkthroughSavedTranslations,
    ...pl.walkthroughSavedTranslations,
    ...pt.walkthroughSavedTranslations,
    ...ru.walkthroughSavedTranslations,
    ...zh_Hans.walkthroughSavedTranslations,
    ...zh_Hant.walkthroughSavedTranslations,
};
