// Tooling aggregate. Product locale roots import only their locale payload.
import { personalHomeDecisionTranslations as en } from './features/en';
import { personalHomeDecisionTranslations as ca } from './features/ca';
import { personalHomeDecisionTranslations as de } from './features/de';
import { personalHomeDecisionTranslations as es } from './features/es';
import { personalHomeDecisionTranslations as fr } from './features/fr';
import { personalHomeDecisionTranslations as it } from './features/it';
import { personalHomeDecisionTranslations as ja } from './features/ja';
import { personalHomeDecisionTranslations as pl } from './features/pl';
import { personalHomeDecisionTranslations as pt } from './features/pt';
import { personalHomeDecisionTranslations as ru } from './features/ru';
import { personalHomeDecisionTranslations as zh_Hans } from './features/zh-Hans';
import { personalHomeDecisionTranslations as zh_Hant } from './features/zh-Hant';
export type { PersonalHomeDecisionTranslation } from './personalHomeDecisionTranslations.shared';

export const personalHomeDecisionTranslations = {
    ...en.personalHomeDecisionTranslations,
    ...ca.personalHomeDecisionTranslations,
    ...de.personalHomeDecisionTranslations,
    ...es.personalHomeDecisionTranslations,
    ...fr.personalHomeDecisionTranslations,
    ...it.personalHomeDecisionTranslations,
    ...ja.personalHomeDecisionTranslations,
    ...pl.personalHomeDecisionTranslations,
    ...pt.personalHomeDecisionTranslations,
    ...ru.personalHomeDecisionTranslations,
    ...zh_Hans.personalHomeDecisionTranslations,
    ...zh_Hant.personalHomeDecisionTranslations,
};
