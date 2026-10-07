// Tooling aggregate. Product locale roots import only their locale payload.
import { sessionPageTranslations as en } from './features/en';
import { sessionPageTranslations as ca } from './features/ca';
import { sessionPageTranslations as de } from './features/de';
import { sessionPageTranslations as es } from './features/es';
import { sessionPageTranslations as fr } from './features/fr';
import { sessionPageTranslations as it } from './features/it';
import { sessionPageTranslations as ja } from './features/ja';
import { sessionPageTranslations as pl } from './features/pl';
import { sessionPageTranslations as pt } from './features/pt';
import { sessionPageTranslations as ru } from './features/ru';
import { sessionPageTranslations as zh_Hans } from './features/zh-Hans';
import { sessionPageTranslations as zh_Hant } from './features/zh-Hant';

export const sessionPageTranslations = {
    ...en.sessionPageTranslations,
    ...ca.sessionPageTranslations,
    ...de.sessionPageTranslations,
    ...es.sessionPageTranslations,
    ...fr.sessionPageTranslations,
    ...it.sessionPageTranslations,
    ...ja.sessionPageTranslations,
    ...pl.sessionPageTranslations,
    ...pt.sessionPageTranslations,
    ...ru.sessionPageTranslations,
    ...zh_Hans.sessionPageTranslations,
    ...zh_Hant.sessionPageTranslations,
};
