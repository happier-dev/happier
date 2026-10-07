// Tooling aggregate. Product locale roots import only their locale payload.
import { workflowRunCompositionTranslations as en } from './features/en';
import { workflowRunCompositionTranslations as ca } from './features/ca';
import { workflowRunCompositionTranslations as de } from './features/de';
import { workflowRunCompositionTranslations as es } from './features/es';
import { workflowRunCompositionTranslations as fr } from './features/fr';
import { workflowRunCompositionTranslations as it } from './features/it';
import { workflowRunCompositionTranslations as ja } from './features/ja';
import { workflowRunCompositionTranslations as pl } from './features/pl';
import { workflowRunCompositionTranslations as pt } from './features/pt';
import { workflowRunCompositionTranslations as ru } from './features/ru';
import { workflowRunCompositionTranslations as zh_Hans } from './features/zh-Hans';
import { workflowRunCompositionTranslations as zh_Hant } from './features/zh-Hant';

export const workflowRunCompositionTranslations = {
    ...en.workflowRunCompositionTranslations,
    ...ca.workflowRunCompositionTranslations,
    ...de.workflowRunCompositionTranslations,
    ...es.workflowRunCompositionTranslations,
    ...fr.workflowRunCompositionTranslations,
    ...it.workflowRunCompositionTranslations,
    ...ja.workflowRunCompositionTranslations,
    ...pl.workflowRunCompositionTranslations,
    ...pt.workflowRunCompositionTranslations,
    ...ru.workflowRunCompositionTranslations,
    ...zh_Hans.workflowRunCompositionTranslations,
    ...zh_Hant.workflowRunCompositionTranslations,
};
