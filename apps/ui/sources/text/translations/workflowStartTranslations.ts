// Tooling aggregate. Product locale roots import only their locale payload.
import { workflowStartTranslations as en } from './features/en';
import { workflowStartTranslations as ca } from './features/ca';
import { workflowStartTranslations as de } from './features/de';
import { workflowStartTranslations as es } from './features/es';
import { workflowStartTranslations as fr } from './features/fr';
import { workflowStartTranslations as it } from './features/it';
import { workflowStartTranslations as ja } from './features/ja';
import { workflowStartTranslations as pl } from './features/pl';
import { workflowStartTranslations as pt } from './features/pt';
import { workflowStartTranslations as ru } from './features/ru';
import { workflowStartTranslations as zh_Hans } from './features/zh-Hans';
import { workflowStartTranslations as zh_Hant } from './features/zh-Hant';

export const workflowStartTranslations = {
    ...en.workflowStartTranslations,
    ...ca.workflowStartTranslations,
    ...de.workflowStartTranslations,
    ...es.workflowStartTranslations,
    ...fr.workflowStartTranslations,
    ...it.workflowStartTranslations,
    ...ja.workflowStartTranslations,
    ...pl.workflowStartTranslations,
    ...pt.workflowStartTranslations,
    ...ru.workflowStartTranslations,
    ...zh_Hans.workflowStartTranslations,
    ...zh_Hant.workflowStartTranslations,
};
