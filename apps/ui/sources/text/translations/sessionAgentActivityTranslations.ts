// Tooling aggregate. Product locale roots import only their locale payload.
import { sessionAgentActivityTranslations as en } from './features/en';
import { sessionAgentActivityTranslations as ca } from './features/ca';
import { sessionAgentActivityTranslations as de } from './features/de';
import { sessionAgentActivityTranslations as es } from './features/es';
import { sessionAgentActivityTranslations as fr } from './features/fr';
import { sessionAgentActivityTranslations as it } from './features/it';
import { sessionAgentActivityTranslations as ja } from './features/ja';
import { sessionAgentActivityTranslations as pl } from './features/pl';
import { sessionAgentActivityTranslations as pt } from './features/pt';
import { sessionAgentActivityTranslations as ru } from './features/ru';
import { sessionAgentActivityTranslations as zh_Hans } from './features/zh-Hans';
import { sessionAgentActivityTranslations as zh_Hant } from './features/zh-Hant';

export const sessionAgentActivityTranslations = {
    ...en.sessionAgentActivityTranslations,
    ...ca.sessionAgentActivityTranslations,
    ...de.sessionAgentActivityTranslations,
    ...es.sessionAgentActivityTranslations,
    ...fr.sessionAgentActivityTranslations,
    ...it.sessionAgentActivityTranslations,
    ...ja.sessionAgentActivityTranslations,
    ...pl.sessionAgentActivityTranslations,
    ...pt.sessionAgentActivityTranslations,
    ...ru.sessionAgentActivityTranslations,
    ...zh_Hans.sessionAgentActivityTranslations,
    ...zh_Hant.sessionAgentActivityTranslations,
};
