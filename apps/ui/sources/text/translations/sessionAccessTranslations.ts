// Tooling aggregate. Product locale roots import only their locale payload.
import { sessionAccessTranslations as en } from './features/en';
import { sessionAccessTranslations as ca } from './features/ca';
import { sessionAccessTranslations as de } from './features/de';
import { sessionAccessTranslations as es } from './features/es';
import { sessionAccessTranslations as fr } from './features/fr';
import { sessionAccessTranslations as it } from './features/it';
import { sessionAccessTranslations as ja } from './features/ja';
import { sessionAccessTranslations as pl } from './features/pl';
import { sessionAccessTranslations as pt } from './features/pt';
import { sessionAccessTranslations as ru } from './features/ru';
import { sessionAccessTranslations as zh_Hans } from './features/zh-Hans';
import { sessionAccessTranslations as zh_Hant } from './features/zh-Hant';

export const sessionAccessTranslations = {
    ...en.sessionAccessTranslations,
    ...ca.sessionAccessTranslations,
    ...de.sessionAccessTranslations,
    ...es.sessionAccessTranslations,
    ...fr.sessionAccessTranslations,
    ...it.sessionAccessTranslations,
    ...ja.sessionAccessTranslations,
    ...pl.sessionAccessTranslations,
    ...pt.sessionAccessTranslations,
    ...ru.sessionAccessTranslations,
    ...zh_Hans.sessionAccessTranslations,
    ...zh_Hant.sessionAccessTranslations,
};
