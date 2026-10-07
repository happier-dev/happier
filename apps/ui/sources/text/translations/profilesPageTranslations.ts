// Tooling aggregate. Product locale roots import only their locale payload.
import { profilesPageTranslations as en } from './features/en';
import { profilesPageTranslations as ca } from './features/ca';
import { profilesPageTranslations as de } from './features/de';
import { profilesPageTranslations as es } from './features/es';
import { profilesPageTranslations as fr } from './features/fr';
import { profilesPageTranslations as it } from './features/it';
import { profilesPageTranslations as ja } from './features/ja';
import { profilesPageTranslations as pl } from './features/pl';
import { profilesPageTranslations as pt } from './features/pt';
import { profilesPageTranslations as ru } from './features/ru';
import { profilesPageTranslations as zh_Hans } from './features/zh-Hans';
import { profilesPageTranslations as zh_Hant } from './features/zh-Hant';

export const profilesPageTranslations = {
    ...en.profilesPageTranslations,
    ...ca.profilesPageTranslations,
    ...de.profilesPageTranslations,
    ...es.profilesPageTranslations,
    ...fr.profilesPageTranslations,
    ...it.profilesPageTranslations,
    ...ja.profilesPageTranslations,
    ...pl.profilesPageTranslations,
    ...pt.profilesPageTranslations,
    ...ru.profilesPageTranslations,
    ...zh_Hans.profilesPageTranslations,
    ...zh_Hant.profilesPageTranslations,
};
