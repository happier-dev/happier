// Tooling aggregate. Product locale roots import only their locale payload.
import { sessionBoardTranslations as en } from './features/en';
import { sessionBoardTranslations as ca } from './features/ca';
import { sessionBoardTranslations as de } from './features/de';
import { sessionBoardTranslations as es } from './features/es';
import { sessionBoardTranslations as fr } from './features/fr';
import { sessionBoardTranslations as it } from './features/it';
import { sessionBoardTranslations as ja } from './features/ja';
import { sessionBoardTranslations as pl } from './features/pl';
import { sessionBoardTranslations as pt } from './features/pt';
import { sessionBoardTranslations as ru } from './features/ru';
import { sessionBoardTranslations as zh_Hans } from './features/zh-Hans';
import { sessionBoardTranslations as zh_Hant } from './features/zh-Hant';

export const sessionBoardTranslations = {
    ...en.sessionBoardTranslations,
    ...ca.sessionBoardTranslations,
    ...de.sessionBoardTranslations,
    ...es.sessionBoardTranslations,
    ...fr.sessionBoardTranslations,
    ...it.sessionBoardTranslations,
    ...ja.sessionBoardTranslations,
    ...pl.sessionBoardTranslations,
    ...pt.sessionBoardTranslations,
    ...ru.sessionBoardTranslations,
    ...zh_Hans.sessionBoardTranslations,
    ...zh_Hant.sessionBoardTranslations,
};
