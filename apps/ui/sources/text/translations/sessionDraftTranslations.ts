// Tooling aggregate. Product locale roots import only their locale payload.
import { sessionDraftTranslations as en } from './features/en';
import { sessionDraftTranslations as ca } from './features/ca';
import { sessionDraftTranslations as de } from './features/de';
import { sessionDraftTranslations as es } from './features/es';
import { sessionDraftTranslations as fr } from './features/fr';
import { sessionDraftTranslations as it } from './features/it';
import { sessionDraftTranslations as ja } from './features/ja';
import { sessionDraftTranslations as pl } from './features/pl';
import { sessionDraftTranslations as pt } from './features/pt';
import { sessionDraftTranslations as ru } from './features/ru';
import { sessionDraftTranslations as zh_Hans } from './features/zh-Hans';
import { sessionDraftTranslations as zh_Hant } from './features/zh-Hant';

export const sessionDraftTranslations = {
    ...en.sessionDraftTranslations,
    ...ca.sessionDraftTranslations,
    ...de.sessionDraftTranslations,
    ...es.sessionDraftTranslations,
    ...fr.sessionDraftTranslations,
    ...it.sessionDraftTranslations,
    ...ja.sessionDraftTranslations,
    ...pl.sessionDraftTranslations,
    ...pt.sessionDraftTranslations,
    ...ru.sessionDraftTranslations,
    ...zh_Hans.sessionDraftTranslations,
    ...zh_Hant.sessionDraftTranslations,
};
