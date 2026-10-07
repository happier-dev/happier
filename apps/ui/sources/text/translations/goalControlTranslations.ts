// Tooling aggregate. Product locale roots import only their locale payload.
import { goalControlTranslations as en } from './features/en';
import { goalControlTranslations as ca } from './features/ca';
import { goalControlTranslations as de } from './features/de';
import { goalControlTranslations as es } from './features/es';
import { goalControlTranslations as fr } from './features/fr';
import { goalControlTranslations as it } from './features/it';
import { goalControlTranslations as ja } from './features/ja';
import { goalControlTranslations as pl } from './features/pl';
import { goalControlTranslations as pt } from './features/pt';
import { goalControlTranslations as ru } from './features/ru';
import { goalControlTranslations as zh_Hans } from './features/zh-Hans';
import { goalControlTranslations as zh_Hant } from './features/zh-Hant';

export const goalControlTranslations = {
    ...en.goalControlTranslations,
    ...ca.goalControlTranslations,
    ...de.goalControlTranslations,
    ...es.goalControlTranslations,
    ...fr.goalControlTranslations,
    ...it.goalControlTranslations,
    ...ja.goalControlTranslations,
    ...pl.goalControlTranslations,
    ...pt.goalControlTranslations,
    ...ru.goalControlTranslations,
    ...zh_Hans.goalControlTranslations,
    ...zh_Hant.goalControlTranslations,
};
