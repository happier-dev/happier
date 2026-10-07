// Tooling aggregate. Product locale roots import only their locale payload.
import { boardsTranslations as en } from './features/en';
import { boardsTranslations as ca } from './features/ca';
import { boardsTranslations as de } from './features/de';
import { boardsTranslations as es } from './features/es';
import { boardsTranslations as fr } from './features/fr';
import { boardsTranslations as it } from './features/it';
import { boardsTranslations as ja } from './features/ja';
import { boardsTranslations as pl } from './features/pl';
import { boardsTranslations as pt } from './features/pt';
import { boardsTranslations as ru } from './features/ru';
import { boardsTranslations as zh_Hans } from './features/zh-Hans';
import { boardsTranslations as zh_Hant } from './features/zh-Hant';

export const boardsTranslations = {
    ...en.boardsTranslations,
    ...ca.boardsTranslations,
    ...de.boardsTranslations,
    ...es.boardsTranslations,
    ...fr.boardsTranslations,
    ...it.boardsTranslations,
    ...ja.boardsTranslations,
    ...pl.boardsTranslations,
    ...pt.boardsTranslations,
    ...ru.boardsTranslations,
    ...zh_Hans.boardsTranslations,
    ...zh_Hant.boardsTranslations,
};
