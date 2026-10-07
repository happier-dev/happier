// Tooling aggregate. Product locale roots import only their locale payload.
import { workflowPluginTranslations as en } from './features/en';
import { workflowPluginTranslations as ca } from './features/ca';
import { workflowPluginTranslations as de } from './features/de';
import { workflowPluginTranslations as es } from './features/es';
import { workflowPluginTranslations as fr } from './features/fr';
import { workflowPluginTranslations as it } from './features/it';
import { workflowPluginTranslations as ja } from './features/ja';
import { workflowPluginTranslations as pl } from './features/pl';
import { workflowPluginTranslations as pt } from './features/pt';
import { workflowPluginTranslations as ru } from './features/ru';
import { workflowPluginTranslations as zh_Hans } from './features/zh-Hans';
import { workflowPluginTranslations as zh_Hant } from './features/zh-Hant';

export const workflowPluginTranslations = {
    ...en.workflowPluginTranslations,
    ...ca.workflowPluginTranslations,
    ...de.workflowPluginTranslations,
    ...es.workflowPluginTranslations,
    ...fr.workflowPluginTranslations,
    ...it.workflowPluginTranslations,
    ...ja.workflowPluginTranslations,
    ...pl.workflowPluginTranslations,
    ...pt.workflowPluginTranslations,
    ...ru.workflowPluginTranslations,
    ...zh_Hans.workflowPluginTranslations,
    ...zh_Hant.workflowPluginTranslations,
};
