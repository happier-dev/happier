// Tooling aggregate. Product locale roots import only their locale payload.
import { sessionCollaborationTranslations as en } from './features/en';
import { sessionCollaborationTranslations as ca } from './features/ca';
import { sessionCollaborationTranslations as de } from './features/de';
import { sessionCollaborationTranslations as es } from './features/es';
import { sessionCollaborationTranslations as fr } from './features/fr';
import { sessionCollaborationTranslations as it } from './features/it';
import { sessionCollaborationTranslations as ja } from './features/ja';
import { sessionCollaborationTranslations as pl } from './features/pl';
import { sessionCollaborationTranslations as pt } from './features/pt';
import { sessionCollaborationTranslations as ru } from './features/ru';
import { sessionCollaborationTranslations as zh_Hans } from './features/zh-Hans';
import { sessionCollaborationTranslations as zh_Hant } from './features/zh-Hant';

export const sessionCollaborationTranslations = {
    ...en.sessionCollaborationTranslations,
    ...ca.sessionCollaborationTranslations,
    ...de.sessionCollaborationTranslations,
    ...es.sessionCollaborationTranslations,
    ...fr.sessionCollaborationTranslations,
    ...it.sessionCollaborationTranslations,
    ...ja.sessionCollaborationTranslations,
    ...pl.sessionCollaborationTranslations,
    ...pt.sessionCollaborationTranslations,
    ...ru.sessionCollaborationTranslations,
    ...zh_Hans.sessionCollaborationTranslations,
    ...zh_Hant.sessionCollaborationTranslations,
};
