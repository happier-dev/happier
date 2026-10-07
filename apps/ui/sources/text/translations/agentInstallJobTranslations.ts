// Tooling aggregate. Product locale roots import only their locale payload.
import { agentInstallJobTranslations as en } from './features/en';
import { agentInstallJobTranslations as ca } from './features/ca';
import { agentInstallJobTranslations as de } from './features/de';
import { agentInstallJobTranslations as es } from './features/es';
import { agentInstallJobTranslations as fr } from './features/fr';
import { agentInstallJobTranslations as it } from './features/it';
import { agentInstallJobTranslations as ja } from './features/ja';
import { agentInstallJobTranslations as pl } from './features/pl';
import { agentInstallJobTranslations as pt } from './features/pt';
import { agentInstallJobTranslations as ru } from './features/ru';
import { agentInstallJobTranslations as zh_Hans } from './features/zh-Hans';
import { agentInstallJobTranslations as zh_Hant } from './features/zh-Hant';

export const agentInstallJobTranslations = {
    ...en.agentInstallJobTranslations,
    ...ca.agentInstallJobTranslations,
    ...de.agentInstallJobTranslations,
    ...es.agentInstallJobTranslations,
    ...fr.agentInstallJobTranslations,
    ...it.agentInstallJobTranslations,
    ...ja.agentInstallJobTranslations,
    ...pl.agentInstallJobTranslations,
    ...pt.agentInstallJobTranslations,
    ...ru.agentInstallJobTranslations,
    ...zh_Hans.agentInstallJobTranslations,
    ...zh_Hant.agentInstallJobTranslations,
};
