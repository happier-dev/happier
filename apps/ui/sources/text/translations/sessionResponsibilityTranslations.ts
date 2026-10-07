// Tooling aggregate. Product locale roots import only their locale payload.
import { sessionResponsibilityTranslations as en } from './features/en';
import { sessionResponsibilityTranslations as ca } from './features/ca';
import { sessionResponsibilityTranslations as de } from './features/de';
import { sessionResponsibilityTranslations as es } from './features/es';
import { sessionResponsibilityTranslations as fr } from './features/fr';
import { sessionResponsibilityTranslations as it } from './features/it';
import { sessionResponsibilityTranslations as ja } from './features/ja';
import { sessionResponsibilityTranslations as pl } from './features/pl';
import { sessionResponsibilityTranslations as pt } from './features/pt';
import { sessionResponsibilityTranslations as ru } from './features/ru';
import { sessionResponsibilityTranslations as zh_Hans } from './features/zh-Hans';
import { sessionResponsibilityTranslations as zh_Hant } from './features/zh-Hant';

export const sessionResponsibilityTranslations = {
    ...en.sessionResponsibilityTranslations,
    ...ca.sessionResponsibilityTranslations,
    ...de.sessionResponsibilityTranslations,
    ...es.sessionResponsibilityTranslations,
    ...fr.sessionResponsibilityTranslations,
    ...it.sessionResponsibilityTranslations,
    ...ja.sessionResponsibilityTranslations,
    ...pl.sessionResponsibilityTranslations,
    ...pt.sessionResponsibilityTranslations,
    ...ru.sessionResponsibilityTranslations,
    ...zh_Hans.sessionResponsibilityTranslations,
    ...zh_Hant.sessionResponsibilityTranslations,
};
