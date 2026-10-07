// Tooling aggregate. Product locale roots import only their locale payload.
import { runPageTranslations as en } from './features/en';
import { runPageTranslations as ca } from './features/ca';
import { runPageTranslations as de } from './features/de';
import { runPageTranslations as es } from './features/es';
import { runPageTranslations as fr } from './features/fr';
import { runPageTranslations as it } from './features/it';
import { runPageTranslations as ja } from './features/ja';
import { runPageTranslations as pl } from './features/pl';
import { runPageTranslations as pt } from './features/pt';
import { runPageTranslations as ru } from './features/ru';
import { runPageTranslations as zh_Hans } from './features/zh-Hans';
import { runPageTranslations as zh_Hant } from './features/zh-Hant';

export const runPageTranslations = {
    ...en.runPageTranslations,
    ...ca.runPageTranslations,
    ...de.runPageTranslations,
    ...es.runPageTranslations,
    ...fr.runPageTranslations,
    ...it.runPageTranslations,
    ...ja.runPageTranslations,
    ...pl.runPageTranslations,
    ...pt.runPageTranslations,
    ...ru.runPageTranslations,
    ...zh_Hans.runPageTranslations,
    ...zh_Hant.runPageTranslations,
};
