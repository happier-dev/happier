// Tooling aggregate. Product locale roots import only their locale payload.
import { workflowActionTranslations as en } from './features/en';
import { workflowActionTranslations as ca } from './features/ca';
import { workflowActionTranslations as de } from './features/de';
import { workflowActionTranslations as es } from './features/es';
import { workflowActionTranslations as fr } from './features/fr';
import { workflowActionTranslations as it } from './features/it';
import { workflowActionTranslations as ja } from './features/ja';
import { workflowActionTranslations as pl } from './features/pl';
import { workflowActionTranslations as pt } from './features/pt';
import { workflowActionTranslations as ru } from './features/ru';
import { workflowActionTranslations as zh_Hans } from './features/zh-Hans';
import { workflowActionTranslations as zh_Hant } from './features/zh-Hant';

export const workflowActionTranslations = {
    ...en.workflowActionTranslations,
    ...ca.workflowActionTranslations,
    ...de.workflowActionTranslations,
    ...es.workflowActionTranslations,
    ...fr.workflowActionTranslations,
    ...it.workflowActionTranslations,
    ...ja.workflowActionTranslations,
    ...pl.workflowActionTranslations,
    ...pt.workflowActionTranslations,
    ...ru.workflowActionTranslations,
    ...zh_Hans.workflowActionTranslations,
    ...zh_Hant.workflowActionTranslations,
};
