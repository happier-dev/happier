// Tooling aggregate. Product locale roots import only their locale payload.
import { actionFamilyTranslations as en } from './features/en';
import { actionFamilyTranslations as ca } from './features/ca';
import { actionFamilyTranslations as de } from './features/de';
import { actionFamilyTranslations as es } from './features/es';
import { actionFamilyTranslations as fr } from './features/fr';
import { actionFamilyTranslations as it } from './features/it';
import { actionFamilyTranslations as ja } from './features/ja';
import { actionFamilyTranslations as pl } from './features/pl';
import { actionFamilyTranslations as pt } from './features/pt';
import { actionFamilyTranslations as ru } from './features/ru';
import { actionFamilyTranslations as zh_Hans } from './features/zh-Hans';
import { actionFamilyTranslations as zh_Hant } from './features/zh-Hant';

export const actionFamilyTranslations = {
    ...en.actionFamilyTranslations,
    ...ca.actionFamilyTranslations,
    ...de.actionFamilyTranslations,
    ...es.actionFamilyTranslations,
    ...fr.actionFamilyTranslations,
    ...it.actionFamilyTranslations,
    ...ja.actionFamilyTranslations,
    ...pl.actionFamilyTranslations,
    ...pt.actionFamilyTranslations,
    ...ru.actionFamilyTranslations,
    ...zh_Hans.actionFamilyTranslations,
    ...zh_Hant.actionFamilyTranslations,
};
