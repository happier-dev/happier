// Tooling aggregate. Product locale roots import only their locale payload.
import { sessionFollowTranslations as en } from './features/en';
import { sessionFollowTranslations as ca } from './features/ca';
import { sessionFollowTranslations as de } from './features/de';
import { sessionFollowTranslations as es } from './features/es';
import { sessionFollowTranslations as fr } from './features/fr';
import { sessionFollowTranslations as it } from './features/it';
import { sessionFollowTranslations as ja } from './features/ja';
import { sessionFollowTranslations as pl } from './features/pl';
import { sessionFollowTranslations as pt } from './features/pt';
import { sessionFollowTranslations as ru } from './features/ru';
import { sessionFollowTranslations as zh_Hans } from './features/zh-Hans';
import { sessionFollowTranslations as zh_Hant } from './features/zh-Hant';

export const sessionFollowTranslations = {
    ...en.sessionFollowTranslations,
    ...ca.sessionFollowTranslations,
    ...de.sessionFollowTranslations,
    ...es.sessionFollowTranslations,
    ...fr.sessionFollowTranslations,
    ...it.sessionFollowTranslations,
    ...ja.sessionFollowTranslations,
    ...pl.sessionFollowTranslations,
    ...pt.sessionFollowTranslations,
    ...ru.sessionFollowTranslations,
    ...zh_Hans.sessionFollowTranslations,
    ...zh_Hant.sessionFollowTranslations,
};
