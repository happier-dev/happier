// Tooling aggregate. Product locale roots import only their locale payload.
import { sessionEmbeddedTranslations as en } from './features/en';
import { sessionEmbeddedTranslations as ca } from './features/ca';
import { sessionEmbeddedTranslations as de } from './features/de';
import { sessionEmbeddedTranslations as es } from './features/es';
import { sessionEmbeddedTranslations as fr } from './features/fr';
import { sessionEmbeddedTranslations as it } from './features/it';
import { sessionEmbeddedTranslations as ja } from './features/ja';
import { sessionEmbeddedTranslations as pl } from './features/pl';
import { sessionEmbeddedTranslations as pt } from './features/pt';
import { sessionEmbeddedTranslations as ru } from './features/ru';
import { sessionEmbeddedTranslations as zh_Hans } from './features/zh-Hans';
import { sessionEmbeddedTranslations as zh_Hant } from './features/zh-Hant';

export const sessionEmbeddedTranslations = {
    ...en.sessionEmbeddedTranslations,
    ...ca.sessionEmbeddedTranslations,
    ...de.sessionEmbeddedTranslations,
    ...es.sessionEmbeddedTranslations,
    ...fr.sessionEmbeddedTranslations,
    ...it.sessionEmbeddedTranslations,
    ...ja.sessionEmbeddedTranslations,
    ...pl.sessionEmbeddedTranslations,
    ...pt.sessionEmbeddedTranslations,
    ...ru.sessionEmbeddedTranslations,
    ...zh_Hans.sessionEmbeddedTranslations,
    ...zh_Hant.sessionEmbeddedTranslations,
};
