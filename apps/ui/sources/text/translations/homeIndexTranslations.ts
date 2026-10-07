// Tooling aggregate. Product locale roots import only their locale payload.
import { homeIndexTranslations as en } from './features/en';
import { homeIndexTranslations as ca } from './features/ca';
import { homeIndexTranslations as de } from './features/de';
import { homeIndexTranslations as es } from './features/es';
import { homeIndexTranslations as fr } from './features/fr';
import { homeIndexTranslations as it } from './features/it';
import { homeIndexTranslations as ja } from './features/ja';
import { homeIndexTranslations as pl } from './features/pl';
import { homeIndexTranslations as pt } from './features/pt';
import { homeIndexTranslations as ru } from './features/ru';
import { homeIndexTranslations as zh_Hans } from './features/zh-Hans';
import { homeIndexTranslations as zh_Hant } from './features/zh-Hant';

export const homeIndexTranslations = {
    ...en.homeIndexTranslations,
    ...ca.homeIndexTranslations,
    ...de.homeIndexTranslations,
    ...es.homeIndexTranslations,
    ...fr.homeIndexTranslations,
    ...it.homeIndexTranslations,
    ...ja.homeIndexTranslations,
    ...pl.homeIndexTranslations,
    ...pt.homeIndexTranslations,
    ...ru.homeIndexTranslations,
    ...zh_Hans.homeIndexTranslations,
    ...zh_Hant.homeIndexTranslations,
};
