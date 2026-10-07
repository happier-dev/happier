// Tooling aggregate. Product locale roots import only their locale payload.
import { scmComparisonTranslations as en } from './features/en';
import { scmComparisonTranslations as ca } from './features/ca';
import { scmComparisonTranslations as de } from './features/de';
import { scmComparisonTranslations as es } from './features/es';
import { scmComparisonTranslations as fr } from './features/fr';
import { scmComparisonTranslations as it } from './features/it';
import { scmComparisonTranslations as ja } from './features/ja';
import { scmComparisonTranslations as pl } from './features/pl';
import { scmComparisonTranslations as pt } from './features/pt';
import { scmComparisonTranslations as ru } from './features/ru';
import { scmComparisonTranslations as zh_Hans } from './features/zh-Hans';
import { scmComparisonTranslations as zh_Hant } from './features/zh-Hant';

export const scmComparisonTranslations = {
    ...en.scmComparisonTranslations,
    ...ca.scmComparisonTranslations,
    ...de.scmComparisonTranslations,
    ...es.scmComparisonTranslations,
    ...fr.scmComparisonTranslations,
    ...it.scmComparisonTranslations,
    ...ja.scmComparisonTranslations,
    ...pl.scmComparisonTranslations,
    ...pt.scmComparisonTranslations,
    ...ru.scmComparisonTranslations,
    ...zh_Hans.scmComparisonTranslations,
    ...zh_Hant.scmComparisonTranslations,
};
