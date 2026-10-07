// Tooling aggregate. Product locale roots import only their locale payload.
import { homeAddTranslations as en } from './features/en';
import { homeAddTranslations as ca } from './features/ca';
import { homeAddTranslations as de } from './features/de';
import { homeAddTranslations as es } from './features/es';
import { homeAddTranslations as fr } from './features/fr';
import { homeAddTranslations as it } from './features/it';
import { homeAddTranslations as ja } from './features/ja';
import { homeAddTranslations as pl } from './features/pl';
import { homeAddTranslations as pt } from './features/pt';
import { homeAddTranslations as ru } from './features/ru';
import { homeAddTranslations as zh_Hans } from './features/zh-Hans';
import { homeAddTranslations as zh_Hant } from './features/zh-Hant';

export const homeAddTranslations = {
    ...en.homeAddTranslations,
    ...ca.homeAddTranslations,
    ...de.homeAddTranslations,
    ...es.homeAddTranslations,
    ...fr.homeAddTranslations,
    ...it.homeAddTranslations,
    ...ja.homeAddTranslations,
    ...pl.homeAddTranslations,
    ...pt.homeAddTranslations,
    ...ru.homeAddTranslations,
    ...zh_Hans.homeAddTranslations,
    ...zh_Hant.homeAddTranslations,
};
