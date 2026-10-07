// Tooling aggregate. Product locale roots import only their locale payload.
import { sessionListFilterTranslations as en } from './features/en';
import { sessionListFilterTranslations as ca } from './features/ca';
import { sessionListFilterTranslations as de } from './features/de';
import { sessionListFilterTranslations as es } from './features/es';
import { sessionListFilterTranslations as fr } from './features/fr';
import { sessionListFilterTranslations as it } from './features/it';
import { sessionListFilterTranslations as ja } from './features/ja';
import { sessionListFilterTranslations as pl } from './features/pl';
import { sessionListFilterTranslations as pt } from './features/pt';
import { sessionListFilterTranslations as ru } from './features/ru';
import { sessionListFilterTranslations as zh_Hans } from './features/zh-Hans';
import { sessionListFilterTranslations as zh_Hant } from './features/zh-Hant';

export const sessionListFilterTranslations = {
    ...en.sessionListFilterTranslations,
    ...ca.sessionListFilterTranslations,
    ...de.sessionListFilterTranslations,
    ...es.sessionListFilterTranslations,
    ...fr.sessionListFilterTranslations,
    ...it.sessionListFilterTranslations,
    ...ja.sessionListFilterTranslations,
    ...pl.sessionListFilterTranslations,
    ...pt.sessionListFilterTranslations,
    ...ru.sessionListFilterTranslations,
    ...zh_Hans.sessionListFilterTranslations,
    ...zh_Hant.sessionListFilterTranslations,
};
