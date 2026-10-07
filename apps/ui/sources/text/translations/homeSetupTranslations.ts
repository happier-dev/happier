// Tooling aggregate. Product locale roots import only their locale payload.
import { homeSetupTranslations as en } from './features/en';
import { homeSetupTranslations as ca } from './features/ca';
import { homeSetupTranslations as de } from './features/de';
import { homeSetupTranslations as es } from './features/es';
import { homeSetupTranslations as fr } from './features/fr';
import { homeSetupTranslations as it } from './features/it';
import { homeSetupTranslations as ja } from './features/ja';
import { homeSetupTranslations as pl } from './features/pl';
import { homeSetupTranslations as pt } from './features/pt';
import { homeSetupTranslations as ru } from './features/ru';
import { homeSetupTranslations as zh_Hans } from './features/zh-Hans';
import { homeSetupTranslations as zh_Hant } from './features/zh-Hant';

export const homeSetupTranslations = {
    ...en.homeSetupTranslations,
    ...ca.homeSetupTranslations,
    ...de.homeSetupTranslations,
    ...es.homeSetupTranslations,
    ...fr.homeSetupTranslations,
    ...it.homeSetupTranslations,
    ...ja.homeSetupTranslations,
    ...pl.homeSetupTranslations,
    ...pt.homeSetupTranslations,
    ...ru.homeSetupTranslations,
    ...zh_Hans.homeSetupTranslations,
    ...zh_Hant.homeSetupTranslations,
};
