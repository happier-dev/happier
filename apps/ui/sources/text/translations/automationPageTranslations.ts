// Tooling aggregate. Product locale roots import only their locale payload.
import { automationPageTranslations as en } from './features/en';
import { automationPageTranslations as ca } from './features/ca';
import { automationPageTranslations as de } from './features/de';
import { automationPageTranslations as es } from './features/es';
import { automationPageTranslations as fr } from './features/fr';
import { automationPageTranslations as it } from './features/it';
import { automationPageTranslations as ja } from './features/ja';
import { automationPageTranslations as pl } from './features/pl';
import { automationPageTranslations as pt } from './features/pt';
import { automationPageTranslations as ru } from './features/ru';
import { automationPageTranslations as zh_Hans } from './features/zh-Hans';
import { automationPageTranslations as zh_Hant } from './features/zh-Hant';

export const automationPageTranslations = {
    ...en.automationPageTranslations,
    ...ca.automationPageTranslations,
    ...de.automationPageTranslations,
    ...es.automationPageTranslations,
    ...fr.automationPageTranslations,
    ...it.automationPageTranslations,
    ...ja.automationPageTranslations,
    ...pl.automationPageTranslations,
    ...pt.automationPageTranslations,
    ...ru.automationPageTranslations,
    ...zh_Hans.automationPageTranslations,
    ...zh_Hant.automationPageTranslations,
};
