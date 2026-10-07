// Tooling aggregate. Product locale roots import only their locale payload.
import { workStatusTranslations as en } from './features/en';
import { workStatusTranslations as ca } from './features/ca';
import { workStatusTranslations as de } from './features/de';
import { workStatusTranslations as es } from './features/es';
import { workStatusTranslations as fr } from './features/fr';
import { workStatusTranslations as it } from './features/it';
import { workStatusTranslations as ja } from './features/ja';
import { workStatusTranslations as pl } from './features/pl';
import { workStatusTranslations as pt } from './features/pt';
import { workStatusTranslations as ru } from './features/ru';
import { workStatusTranslations as zh_Hans } from './features/zh-Hans';
import { workStatusTranslations as zh_Hant } from './features/zh-Hant';

export const workStatusTranslations = {
    ...en.workStatusTranslations,
    ...ca.workStatusTranslations,
    ...de.workStatusTranslations,
    ...es.workStatusTranslations,
    ...fr.workStatusTranslations,
    ...it.workStatusTranslations,
    ...ja.workStatusTranslations,
    ...pl.workStatusTranslations,
    ...pt.workStatusTranslations,
    ...ru.workStatusTranslations,
    ...zh_Hans.workStatusTranslations,
    ...zh_Hant.workStatusTranslations,
};
