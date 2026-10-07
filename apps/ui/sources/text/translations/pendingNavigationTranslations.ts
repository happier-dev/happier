// Tooling aggregate. Product locale roots import only their locale payload.
import { pendingNavigationTranslations as en } from './features/en';
import { pendingNavigationTranslations as ca } from './features/ca';
import { pendingNavigationTranslations as de } from './features/de';
import { pendingNavigationTranslations as es } from './features/es';
import { pendingNavigationTranslations as fr } from './features/fr';
import { pendingNavigationTranslations as it } from './features/it';
import { pendingNavigationTranslations as ja } from './features/ja';
import { pendingNavigationTranslations as pl } from './features/pl';
import { pendingNavigationTranslations as pt } from './features/pt';
import { pendingNavigationTranslations as ru } from './features/ru';
import { pendingNavigationTranslations as zh_Hans } from './features/zh-Hans';
import { pendingNavigationTranslations as zh_Hant } from './features/zh-Hant';

export const pendingNavigationTranslations = {
    ...en.pendingNavigationTranslations,
    ...ca.pendingNavigationTranslations,
    ...de.pendingNavigationTranslations,
    ...es.pendingNavigationTranslations,
    ...fr.pendingNavigationTranslations,
    ...it.pendingNavigationTranslations,
    ...ja.pendingNavigationTranslations,
    ...pl.pendingNavigationTranslations,
    ...pt.pendingNavigationTranslations,
    ...ru.pendingNavigationTranslations,
    ...zh_Hans.pendingNavigationTranslations,
    ...zh_Hant.pendingNavigationTranslations,
};
