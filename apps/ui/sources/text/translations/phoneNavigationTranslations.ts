// Tooling aggregate. Product locale roots import only their locale payload.
import { phoneNavigationTranslations as en } from './features/en';
import { phoneNavigationTranslations as ca } from './features/ca';
import { phoneNavigationTranslations as de } from './features/de';
import { phoneNavigationTranslations as es } from './features/es';
import { phoneNavigationTranslations as fr } from './features/fr';
import { phoneNavigationTranslations as it } from './features/it';
import { phoneNavigationTranslations as ja } from './features/ja';
import { phoneNavigationTranslations as pl } from './features/pl';
import { phoneNavigationTranslations as pt } from './features/pt';
import { phoneNavigationTranslations as ru } from './features/ru';
import { phoneNavigationTranslations as zh_Hans } from './features/zh-Hans';
import { phoneNavigationTranslations as zh_Hant } from './features/zh-Hant';

export const phoneNavigationTranslations = {
    ...en.phoneNavigationTranslations,
    ...ca.phoneNavigationTranslations,
    ...de.phoneNavigationTranslations,
    ...es.phoneNavigationTranslations,
    ...fr.phoneNavigationTranslations,
    ...it.phoneNavigationTranslations,
    ...ja.phoneNavigationTranslations,
    ...pl.phoneNavigationTranslations,
    ...pt.phoneNavigationTranslations,
    ...ru.phoneNavigationTranslations,
    ...zh_Hans.phoneNavigationTranslations,
    ...zh_Hant.phoneNavigationTranslations,
};
