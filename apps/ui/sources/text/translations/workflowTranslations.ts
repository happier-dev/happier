// Tooling aggregate. Product locale roots import only their locale payload.
import { workflowTranslations as en } from './features/en';
import { workflowTranslations as ca } from './features/ca';
import { workflowTranslations as de } from './features/de';
import { workflowTranslations as es } from './features/es';
import { workflowTranslations as fr } from './features/fr';
import { workflowTranslations as it } from './features/it';
import { workflowTranslations as ja } from './features/ja';
import { workflowTranslations as pl } from './features/pl';
import { workflowTranslations as pt } from './features/pt';
import { workflowTranslations as ru } from './features/ru';
import { workflowTranslations as zh_Hans } from './features/zh-Hans';
import { workflowTranslations as zh_Hant } from './features/zh-Hant';
export type { WorkflowTranslations } from './workflowTranslations.shared';

export const workflowTranslations = {
    ...en.workflowTranslations,
    ...ca.workflowTranslations,
    ...de.workflowTranslations,
    ...es.workflowTranslations,
    ...fr.workflowTranslations,
    ...it.workflowTranslations,
    ...ja.workflowTranslations,
    ...pl.workflowTranslations,
    ...pt.workflowTranslations,
    ...ru.workflowTranslations,
    ...zh_Hans.workflowTranslations,
    ...zh_Hant.workflowTranslations,
};
