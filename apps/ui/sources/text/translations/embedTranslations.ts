// Tooling aggregate. Product locale roots import only their locale payload.
import { embedTranslations as en } from './features/en';
import { embedTranslations as ca } from './features/ca';
import { embedTranslations as de } from './features/de';
import { embedTranslations as es } from './features/es';
import { embedTranslations as fr } from './features/fr';
import { embedTranslations as it } from './features/it';
import { embedTranslations as ja } from './features/ja';
import { embedTranslations as pl } from './features/pl';
import { embedTranslations as pt } from './features/pt';
import { embedTranslations as ru } from './features/ru';
import { embedTranslations as zh_Hans } from './features/zh-Hans';
import { embedTranslations as zh_Hant } from './features/zh-Hant';

export const embedTranslations = {
    ...en.embedTranslations,
    ...ca.embedTranslations,
    ...de.embedTranslations,
    ...es.embedTranslations,
    ...fr.embedTranslations,
    ...it.embedTranslations,
    ...ja.embedTranslations,
    ...pl.embedTranslations,
    ...pt.embedTranslations,
    ...ru.embedTranslations,
    ...zh_Hans.embedTranslations,
    ...zh_Hant.embedTranslations,
};
