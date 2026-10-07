// Tooling aggregate. Product locale roots import only their locale payload.
import { workflowRunListTranslations as en } from './features/en';
import { workflowRunListTranslations as ca } from './features/ca';
import { workflowRunListTranslations as de } from './features/de';
import { workflowRunListTranslations as es } from './features/es';
import { workflowRunListTranslations as fr } from './features/fr';
import { workflowRunListTranslations as it } from './features/it';
import { workflowRunListTranslations as ja } from './features/ja';
import { workflowRunListTranslations as pl } from './features/pl';
import { workflowRunListTranslations as pt } from './features/pt';
import { workflowRunListTranslations as ru } from './features/ru';
import { workflowRunListTranslations as zh_Hans } from './features/zh-Hans';
import { workflowRunListTranslations as zh_Hant } from './features/zh-Hant';

export const workflowRunListTranslations = {
    ...en.workflowRunListTranslations,
    ...ca.workflowRunListTranslations,
    ...de.workflowRunListTranslations,
    ...es.workflowRunListTranslations,
    ...fr.workflowRunListTranslations,
    ...it.workflowRunListTranslations,
    ...ja.workflowRunListTranslations,
    ...pl.workflowRunListTranslations,
    ...pt.workflowRunListTranslations,
    ...ru.workflowRunListTranslations,
    ...zh_Hans.workflowRunListTranslations,
    ...zh_Hant.workflowRunListTranslations,
};
