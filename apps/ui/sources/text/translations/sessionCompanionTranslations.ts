// Tooling aggregate. Product locale roots import only their locale payload.
import { sessionCompanionTranslations as en } from './features/en';
import { sessionCompanionTranslations as ca } from './features/ca';
import { sessionCompanionTranslations as de } from './features/de';
import { sessionCompanionTranslations as es } from './features/es';
import { sessionCompanionTranslations as fr } from './features/fr';
import { sessionCompanionTranslations as it } from './features/it';
import { sessionCompanionTranslations as ja } from './features/ja';
import { sessionCompanionTranslations as pl } from './features/pl';
import { sessionCompanionTranslations as pt } from './features/pt';
import { sessionCompanionTranslations as ru } from './features/ru';
import { sessionCompanionTranslations as zh_Hans } from './features/zh-Hans';
import { sessionCompanionTranslations as zh_Hant } from './features/zh-Hant';

export const sessionCompanionTranslations = {
    ...en.sessionCompanionTranslations,
    ...ca.sessionCompanionTranslations,
    ...de.sessionCompanionTranslations,
    ...es.sessionCompanionTranslations,
    ...fr.sessionCompanionTranslations,
    ...it.sessionCompanionTranslations,
    ...ja.sessionCompanionTranslations,
    ...pl.sessionCompanionTranslations,
    ...pt.sessionCompanionTranslations,
    ...ru.sessionCompanionTranslations,
    ...zh_Hans.sessionCompanionTranslations,
    ...zh_Hant.sessionCompanionTranslations,
};
