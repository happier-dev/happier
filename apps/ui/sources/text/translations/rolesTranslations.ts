// Tooling aggregate. Product locale roots import only their locale payload.
import { rolesTranslations as en } from './features/en';
import { rolesTranslations as ca } from './features/ca';
import { rolesTranslations as de } from './features/de';
import { rolesTranslations as es } from './features/es';
import { rolesTranslations as fr } from './features/fr';
import { rolesTranslations as it } from './features/it';
import { rolesTranslations as ja } from './features/ja';
import { rolesTranslations as pl } from './features/pl';
import { rolesTranslations as pt } from './features/pt';
import { rolesTranslations as ru } from './features/ru';
import { rolesTranslations as zh_Hans } from './features/zh-Hans';
import { rolesTranslations as zh_Hant } from './features/zh-Hant';

export const rolesTranslations = {
    ...en.rolesTranslations,
    ...ca.rolesTranslations,
    ...de.rolesTranslations,
    ...es.rolesTranslations,
    ...fr.rolesTranslations,
    ...it.rolesTranslations,
    ...ja.rolesTranslations,
    ...pl.rolesTranslations,
    ...pt.rolesTranslations,
    ...ru.rolesTranslations,
    ...zh_Hans.rolesTranslations,
    ...zh_Hant.rolesTranslations,
};
