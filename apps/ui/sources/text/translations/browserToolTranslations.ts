// Tooling aggregate. Product locale roots import only their locale payload.
import { browserToolTranslations as en } from './features/en';
import { browserToolTranslations as ca } from './features/ca';
import { browserToolTranslations as de } from './features/de';
import { browserToolTranslations as es } from './features/es';
import { browserToolTranslations as fr } from './features/fr';
import { browserToolTranslations as it } from './features/it';
import { browserToolTranslations as ja } from './features/ja';
import { browserToolTranslations as pl } from './features/pl';
import { browserToolTranslations as pt } from './features/pt';
import { browserToolTranslations as ru } from './features/ru';
import { browserToolTranslations as zh_Hans } from './features/zh-Hans';
import { browserToolTranslations as zh_Hant } from './features/zh-Hant';

export const browserToolTranslations = {
    ...en.browserToolTranslations,
    ...ca.browserToolTranslations,
    ...de.browserToolTranslations,
    ...es.browserToolTranslations,
    ...fr.browserToolTranslations,
    ...it.browserToolTranslations,
    ...ja.browserToolTranslations,
    ...pl.browserToolTranslations,
    ...pt.browserToolTranslations,
    ...ru.browserToolTranslations,
    ...zh_Hans.browserToolTranslations,
    ...zh_Hant.browserToolTranslations,
};
