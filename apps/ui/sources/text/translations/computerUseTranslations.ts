// Tooling aggregate. Product locale roots import only their locale payload.
import { computerUseTranslations as en } from './features/en';
import { computerUseTranslations as ca } from './features/ca';
import { computerUseTranslations as de } from './features/de';
import { computerUseTranslations as es } from './features/es';
import { computerUseTranslations as fr } from './features/fr';
import { computerUseTranslations as it } from './features/it';
import { computerUseTranslations as ja } from './features/ja';
import { computerUseTranslations as pl } from './features/pl';
import { computerUseTranslations as pt } from './features/pt';
import { computerUseTranslations as ru } from './features/ru';
import { computerUseTranslations as zh_Hans } from './features/zh-Hans';
import { computerUseTranslations as zh_Hant } from './features/zh-Hant';

export const computerUseTranslations = {
    ...en.computerUseTranslations,
    ...ca.computerUseTranslations,
    ...de.computerUseTranslations,
    ...es.computerUseTranslations,
    ...fr.computerUseTranslations,
    ...it.computerUseTranslations,
    ...ja.computerUseTranslations,
    ...pl.computerUseTranslations,
    ...pt.computerUseTranslations,
    ...ru.computerUseTranslations,
    ...zh_Hans.computerUseTranslations,
    ...zh_Hant.computerUseTranslations,
};
